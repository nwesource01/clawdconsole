const fs = require('fs');
const path = require('path');

const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');
const basicAuth = require('basic-auth');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');
const dns = require('dns');
const { execFile } = require('child_process');

const PORT = process.env.PORT ? Number(process.env.PORT) : 21337;
const BUILD = '2026-02-28.18';

// Telemetry (opt-in): open-source installs can optionally ping a hosted collector.
const TELEMETRY_OPT_IN = String(process.env.TELEMETRY_OPT_IN || '').trim() === '1';
const TELEMETRY_BASE_URL = (process.env.TELEMETRY_BASE_URL || 'https://app.clawdconsole.com').replace(/\/$/, '');
const TELEMETRY_INSTALL_URL = process.env.TELEMETRY_INSTALL_URL || (TELEMETRY_BASE_URL + '/api/telemetry/v1/install');
const TELEMETRY_DAILY_URL = process.env.TELEMETRY_DAILY_URL || (TELEMETRY_BASE_URL + '/api/telemetry/v1/daily');
const TELEMETRY_INTERVAL_HOURS = Math.max(1, Number(process.env.TELEMETRY_INTERVAL_HOURS || 24));

// Clawdbot Gateway (for agent bridge)
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:18789';
const CONSOLE_SESSION_KEY = process.env.CONSOLE_SESSION_KEY || 'claw-console';
const DATA_DIR = process.env.DATA_DIR || '/home/master/clawd/console-data';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MSG_FILE = path.join(DATA_DIR, 'messages.jsonl');
const WORK_FILE = path.join(DATA_DIR, 'worklog.jsonl');
// Minimal ongoing transcript (tiny JSONL; appended on every user + bot msg)
const TRANSCRIPT_FILE = path.join(DATA_DIR, 'transcript.jsonl');
// Scheduled reports log
const SCHED_FILE = path.join(DATA_DIR, 'scheduled.jsonl');

// Telemetry local state
const INSTALL_FILE = path.join(DATA_DIR, 'install.json');
const TELEMETRY_STATE_FILE = path.join(DATA_DIR, 'telemetry-state.json');

// Telemetry collector logs (only used on the hosted collector)
const TELEMETRY_FILE = path.join(DATA_DIR, 'telemetry.jsonl');

// Custom quick buttons (server-side persistence)
const BUTTONS_FILE = path.join(DATA_DIR, 'buttons.json');

const AUTH_USER = process.env.AUTH_USER || 'nwesource';
const AUTH_PASS = process.env.AUTH_PASS || '';

// lightweight session cookie so browser fetch() works reliably
const SESS_COOKIE = 'claw_console_sess';
const sessions = new Map(); // token -> expiresAtMs
const SESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function parseCookies(req) {
  const header = (req.headers.cookie || '').toString();
  const out = {};
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join('=') || '');
  }
  return out;
}

function newToken() {
  return 'sess_' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
ensureDir(DATA_DIR);
ensureDir(UPLOAD_DIR);

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(filePath, obj) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function ensureInstallId() {
  const cur = readJson(INSTALL_FILE, null);
  if (cur && cur.installId) return cur;
  const installId = (crypto.randomUUID ? crypto.randomUUID() : ('iid_' + crypto.randomBytes(16).toString('hex')));
  const out = { installId, createdAt: new Date().toISOString() };
  writeJson(INSTALL_FILE, out);
  return out;
}

function readTelemetryState() {
  return readJson(TELEMETRY_STATE_FILE, { lastInstallAt: null, lastDailyAt: null, lastErr: null });
}
function writeTelemetryState(patch) {
  const cur = readTelemetryState();
  const next = { ...cur, ...patch };
  writeJson(TELEMETRY_STATE_FILE, next);
  return next;
}

function loadGatewayToken() {
  // Best-effort: read from Clawdbot config file on this box.
  try {
    const raw = fs.readFileSync('/root/.clawdbot/clawdbot.json', 'utf8');
    const cfg = JSON.parse(raw);
    const tok = cfg?.gateway?.auth?.token;
    return (typeof tok === 'string' && tok.trim()) ? tok.trim() : null;
  } catch {
    return null;
  }
}

function appendJsonl(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function appendTranscriptLine(role, msg, extra = null) {
  try {
    const t = msg?.ts || new Date().toISOString();
    const r = role;
    const i = msg?.id || undefined;
    const x = (msg?.text || '').toString().replace(/\r\n/g, '\n');
    const atts = Array.isArray(msg?.attachments) ? msg.attachments : [];
    const a = atts.map(v => v && v.url).filter(Boolean);

    // Tiny keys to keep the file small.
    // base: { t: timestamp, r: role, i?: id, x: text, a?: [attachmentUrls] }
    let obj = a.length ? { t, r, x, a } : { t, r, x };
    if (i) obj.i = i;
    if (extra && typeof extra === 'object') obj = Object.assign(obj, extra);
    fs.appendFileSync(TRANSCRIPT_FILE, JSON.stringify(obj) + '\n', 'utf8');
  } catch {
    // best-effort; never break chat
  }
}

function rewriteTranscript(mapper) {
  // Rewrite transcript.jsonl with a mapper(obj) => obj | null.
  // - return null to drop a line
  // - return obj to keep (possibly modified)
  // Best-effort and safe: if anything fails, leave transcript untouched.
  try {
    if (!fs.existsSync(TRANSCRIPT_FILE)) return { ok: true, removed: 0, updated: 0 };
    const src = fs.readFileSync(TRANSCRIPT_FILE, 'utf8');
    const lines = src.split('\n');

    let removed = 0;
    let updated = 0;
    const out = [];

    for (const line of lines) {
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { obj = null; }
      if (!obj || typeof obj !== 'object') { out.push(line); continue; }

      const before = JSON.stringify(obj);
      const next = mapper(obj);
      if (next === null) {
        removed++;
        continue;
      }
      const after = JSON.stringify(next);
      if (after !== before) updated++;
      out.push(after);
    }

    const tmp = TRANSCRIPT_FILE + '.tmp';
    fs.writeFileSync(tmp, out.join('\n') + (out.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, TRANSCRIPT_FILE);
    return { ok: true, removed, updated };
  } catch (e) {
    return { ok: false, removed: 0, updated: 0, error: String(e) };
  }
}

function scrubTranscriptBy(predicate) {
  // Back-compat wrapper for deletes.
  return rewriteTranscript((obj) => predicate(obj) ? null : obj);
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

const CLAWDPUB_SOP_FILE = path.join(__dirname, '..', 'clawdpub', 'ClawdPub_SOP.md');
function readSopSnippet(maxChars = 2400) {
  try {
    if (!fs.existsSync(CLAWDPUB_SOP_FILE)) return 'ClawdPub SOP not found yet.';
    const raw = fs.readFileSync(CLAWDPUB_SOP_FILE, 'utf8');
    const text = raw.trim();
    return text.length > maxChars ? (text.slice(0, maxChars).trimEnd() + '\n\n…(open full SOP)') : text;
  } catch (e) {
    return 'Failed to read SOP: ' + String(e);
  }
}

function readLastJsonl(filePath, limit = 50) {
  try {
    const txt = fs.readFileSync(filePath, 'utf8');
    const lines = txt.trim().split('\n').filter(Boolean);
    const slice = lines.slice(-limit);
    return slice.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

const app = express();
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: false, // keep it simple for now
}));
app.use(morgan('combined'));

app.use(express.json({ limit: '1mb' }));

// Auth middleware
app.use((req, res, next) => {
  // allow health check + public demo + static assets without auth
  if (req.path === '/healthz') return next();
  if (req.path === '/demo' || req.path.startsWith('/demo/')) return next();
  if (req.path === '/favicon.ico' || req.path.startsWith('/static/')) return next();

  // allow telemetry collector endpoints without auth (hosted collector)
  if (req.path.startsWith('/api/telemetry/v1/')) return next();

  // 1) session cookie
  const cookies = parseCookies(req);
  const tok = cookies[SESS_COOKIE];
  if (tok) {
    const exp = sessions.get(tok);
    if (exp && exp > Date.now()) {
      return next();
    }
  }

  // 2) basic auth fallback
  if (!AUTH_PASS) {
    return res.status(500).type('text/plain').send('AUTH_PASS not set on server');
  }

  const creds = basicAuth(req);
  if (!creds || creds.name !== AUTH_USER || creds.pass !== AUTH_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="Clawd Console"');
    return res.status(401).type('text/plain').send('Auth required');
  }

  // set session cookie so fetch() works without Authorization header
  const token = newToken();
  sessions.set(token, Date.now() + SESS_TTL_MS);
  res.setHeader('Set-Cookie', `${SESS_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(SESS_TTL_MS/1000)}; HttpOnly; Secure; SameSite=Strict`);

  return next();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// --- ClawdName (domain availability v0: DNS heuristics) ---
const DOMAIN_CACHE_TTL_MS = 10 * 60 * 1000;
const domainCache = new Map(); // domain -> { at, res }

function normalizeDomain(s){
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
}

async function checkDomainDns(domain){
  const d = normalizeDomain(domain);
  if (!d || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return { domain: d, status: 'invalid', reason: 'Invalid domain' };

  const cached = domainCache.get(d);
  if (cached && (Date.now() - cached.at) < DOMAIN_CACHE_TTL_MS) return { ...cached.res, cached: true };

  const startedAt = Date.now();
  const p = dns.promises;

  // Heuristic:
  // - SOA/NS existence strongly implies registered+delegated.
  // - ENOTFOUND implies likely available.
  // - SERVFAIL/REFUSED/etc -> unknown.
  // - Some taken domains may have no NS (rare) → we still might mark unknown.
  try {
    try {
      const soa = await p.resolveSoa(d);
      const res = { domain: d, status: 'taken', reason: 'SOA present', ms: Date.now() - startedAt };
      domainCache.set(d, { at: Date.now(), res });
      return res;
    } catch (e) {
      // continue
      const code = e && e.code;
      if (code && !['ENODATA','ENOTFOUND','SERVFAIL','REFUSED','ETIMEOUT','EAI_AGAIN'].includes(code)) {
        // unknown error type, keep going
      }
    }

    try {
      const ns = await p.resolveNs(d);
      if (Array.isArray(ns) && ns.length) {
        const res = { domain: d, status: 'taken', reason: 'NS present', ms: Date.now() - startedAt };
        domainCache.set(d, { at: Date.now(), res });
        return res;
      }
    } catch (e) {
      const code = e && e.code;
      if (code === 'ENOTFOUND') {
        const res = { domain: d, status: 'likely_available', reason: 'No DNS record (ENOTFOUND)', ms: Date.now() - startedAt };
        domainCache.set(d, { at: Date.now(), res });
        return res;
      }
      if (code === 'ENODATA') {
        // domain exists but no NS? treat as unknown
        const res = { domain: d, status: 'unknown', reason: 'No NS data (ENODATA)', ms: Date.now() - startedAt };
        domainCache.set(d, { at: Date.now(), res });
        return res;
      }
      if (code && ['SERVFAIL','REFUSED','ETIMEOUT','EAI_AGAIN'].includes(code)) {
        const res = { domain: d, status: 'unknown', reason: 'DNS ' + code, ms: Date.now() - startedAt };
        domainCache.set(d, { at: Date.now(), res });
        return res;
      }
      const res = { domain: d, status: 'unknown', reason: 'DNS error', code: code || null, ms: Date.now() - startedAt };
      domainCache.set(d, { at: Date.now(), res });
      return res;
    }

    // If SOA/NS didn't resolve but also didn't ENOTFOUND, call it unknown.
    const res = { domain: d, status: 'unknown', reason: 'Inconclusive DNS', ms: Date.now() - startedAt };
    domainCache.set(d, { at: Date.now(), res });
    return res;
  } catch (e) {
    const res = { domain: d, status: 'unknown', reason: 'Exception: ' + String(e), ms: Date.now() - startedAt };
    domainCache.set(d, { at: Date.now(), res });
    return res;
  }
}

app.post('/api/name/check', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const domains = Array.isArray(req.body?.domains) ? req.body.domains : [];
  const uniq = Array.from(new Set(domains.map(normalizeDomain).filter(Boolean))).slice(0, 200);

  // simple concurrency limit
  const results = [];
  const CONC = Math.max(1, Math.min(16, Number(process.env.NAMECHECK_CONCURRENCY || 8)));
  let i = 0;
  async function worker(){
    while (i < uniq.length){
      const idx = i++;
      const d = uniq[idx];
      const r = await checkDomainDns(d);
      results[idx] = r;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, uniq.length || 1) }, worker));

  res.json({ ok: true, results });
});

app.get('/name', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('text/html; charset=utf-8').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ClawdName</title>
  <style>
    :root{ --bg:#0b0f1a; --card:#11182a; --text:#e7e7e7; --muted: rgba(231,231,231,.70); --border: rgba(231,231,231,.12); --teal:#22c6c6; }
    body{margin:0; font-family: system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background: var(--bg); color: var(--text)}
    .wrap{max-width: 1200px; margin:0 auto; padding: 16px;}
    .top{display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; align-items:baseline}
    h1{margin:0; font-size:18px}
    .muted{color:var(--muted)}
    .card{border:1px solid var(--border); border-radius:14px; background: rgba(255,255,255,.03); padding:14px; margin-top:12px}
    textarea,input,select{width:100%; padding:10px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.14); background:#0d1426; color:var(--text); font-size:14px; font-family: inherit}
    textarea{min-height:110px; max-height:300px}
    .row{display:flex; gap:10px; flex-wrap:wrap; align-items:center}
    .btn{border:1px solid rgba(34,198,198,.40); background: rgba(34,198,198,.10); color: rgba(231,231,231,.92); border-radius: 12px; padding:10px 12px; cursor:pointer}
    .btn:hover{border-color: rgba(34,198,198,.65)}
    table{width:100%; border-collapse: collapse; margin-top:12px; font-size:13px}
    th,td{padding:10px 8px; border-bottom:1px solid rgba(255,255,255,.08); text-align:left; vertical-align:top}
    .pill{display:inline-flex; padding:3px 8px; border-radius:999px; font-size:12px; border:1px solid rgba(255,255,255,.14)}
    .p-ok{border-color: rgba(124,255,178,.40); background: rgba(124,255,178,.10)}
    .p-bad{border-color: rgba(255,120,120,.35); background: rgba(255,120,120,.10)}
    .p-unk{border-color: rgba(231,231,231,.18); background: rgba(231,231,231,.06)}
    .p-inv{border-color: rgba(255,200,120,.35); background: rgba(255,200,120,.10)}
    .mini{border:1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.05); color: rgba(231,231,231,.86); border-radius: 10px; padding:6px 8px; cursor:pointer; font-size:12px}
    .mini:hover{background: rgba(255,255,255,.08)}
    code{color: rgba(231,231,231,.90)}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1>ClawdName</h1>
        <div class="muted">Domain availability (v0). DNS heuristic: <b>taken</b> if SOA/NS exists; <b>likely available</b> if ENOTFOUND; otherwise <b>unknown</b>.</div>
      </div>
      <a class="btn" href="/" style="text-decoration:none;">Back to Console</a>
    </div>

    <div class="card">
      <div class="row">
        <div style="flex:1; min-width: 260px;">
          <div class="muted" style="margin-bottom:6px;">Business names (one per line)</div>
          <textarea id="names" placeholder="InfraClawd\nNameProbe\nClawdName\n..."></textarea>
        </div>
        <div style="width:260px;">
          <div class="muted" style="margin-bottom:6px;">TLDs (comma-separated)</div>
          <input id="tlds" value=".com,.io,.ai,.app" />
          <div class="muted" style="margin:10px 0 6px;">Max variants per name</div>
          <input id="variants" value="8" />
          <div class="row" style="margin-top:10px; justify-content:space-between;">
            <button class="btn" id="run" type="button">Check</button>
            <button class="mini" id="clear" type="button">Clear</button>
          </div>
        </div>
      </div>

      <div class="muted" id="status" style="margin-top:10px;"></div>
      <div id="out"></div>
    </div>
  </div>

<script>
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function slugifyName(name){
    return String(name||'').trim().toLowerCase()
      .replace(/&/g,' and ')
      .replace(/[^a-z0-9\s-]/g,'')
      .replace(/\s+/g,'-')
      .replace(/-+/g,'-')
      .replace(/^-/,'').replace(/-$/,'');
  }

  function variantsFor(name, maxN){
    const base = slugifyName(name);
    const raw = String(name||'').trim().toLowerCase().replace(/[^a-z0-9]/g,'');
    const out = [];
    const push = (s) => { if (s && !out.includes(s)) out.push(s); };
    push(raw);
    push(base.replace(/-/g,''));
    push(base);
    if (raw) {
      push('get' + raw);
      push(raw + 'hq');
      push(raw + 'app');
      push('try' + raw);
    }
    return out.slice(0, Math.max(1, maxN||8));
  }

  function buildDomains(){
    const names = String($('names').value||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    const tlds = String($('tlds').value||'').split(',').map(s=>s.trim()).filter(Boolean).map(t => t.startsWith('.')?t:('.'+t));
    const maxV = Math.max(1, Math.min(30, Number($('variants').value||8)));

    const domains = [];
    for (const n of names){
      for (const v of variantsFor(n, maxV)){
        for (const t of tlds){
          domains.push(v + t);
        }
      }
    }
    return Array.from(new Set(domains)).slice(0, 800);
  }

  function pill(status){
    if (status === 'taken') return '<span class="pill p-bad">taken</span>';
    if (status === 'likely_available') return '<span class="pill p-ok">likely available</span>';
    if (status === 'invalid') return '<span class="pill p-inv">invalid</span>';
    return '<span class="pill p-unk">unknown</span>';
  }

  async function run(){
    const domains = buildDomains();
    $('status').textContent = 'Checking ' + domains.length + ' domains…';
    $('out').innerHTML = '';

    let res, txt, j;
    try {
      res = await fetch('/api/name/check', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        credentials:'include',
        body: JSON.stringify({ domains })
      });
      txt = await res.text();
      try { j = JSON.parse(txt); } catch { j = null; }
    } catch (e) {
      $('status').textContent = 'Request failed: ' + String(e);
      return;
    }

    if (!res.ok || !j || !j.ok) {
      if (res.status === 401) {
        $('status').innerHTML = 'Auth required. Open <a href="/" style="color:var(--teal)">/</a> and log in, then come back and retry.';
      } else {
        $('status').textContent = 'Failed (' + res.status + '): ' + String((txt||'').slice(0,160));
      }
      return;
    }

    const rows = (j.results || []);
    const avail = rows.filter(r => r && r.status === 'likely_available');
    const taken = rows.filter(r => r && r.status === 'taken');
    const unk = rows.filter(r => r && (r.status === 'unknown' || r.status === 'invalid'));

    $('status').innerHTML = 'Done. ' +
      '<b>' + avail.length + '</b> likely available • ' +
      '<b>' + taken.length + '</b> taken • ' +
      '<b>' + unk.length + '</b> unknown/invalid.';

    const html = '<table>'
      + '<thead><tr><th>Domain</th><th>Status</th><th>Evidence</th><th></th></tr></thead>'
      + '<tbody>'
      + rows.map(r => {
        const copy = '<button class="mini" data-copy="' + esc(r.domain) + '">Copy</button>';
        return '<tr>'
          + '<td><code>' + esc(r.domain) + '</code></td>'
          + '<td>' + pill(r.status) + (r.cached ? ' <span class="muted">(cached)</span>' : '') + '</td>'
          + '<td class="muted">' + esc(r.reason || '') + (r.code ? (' (' + esc(r.code) + ')') : '') + '</td>'
          + '<td>' + copy + '</td>'
          + '</tr>';
      }).join('')
      + '</tbody></table>';

    $('out').innerHTML = html;
    Array.from(document.querySelectorAll('button[data-copy]')).forEach(b => {
      b.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(b.getAttribute('data-copy')||''); b.textContent = 'Copied'; setTimeout(()=>b.textContent='Copy', 900); } catch {}
      });
    });
  }

  $('run').addEventListener('click', run);
  $('clear').addEventListener('click', () => { $('names').value=''; $('out').innerHTML=''; $('status').textContent=''; $('names').focus(); });
</script>
</body>
</html>`);
});

// --- Public demo (no auth) ---
const DEMO_MESSAGES = [
  { t: '2026-02-28T00:00:00.000Z', r: 'user', x: 'Build a landing page for Clawd Console and show me the iteration trail.' },
  { t: '2026-02-28T00:00:05.000Z', r: 'assistant', x: 'Draft v1 shipped. Next: tighten hero, add pricing, and a demo environment. DEL created for iteration steps.', d: ['Draft hero + CTA', 'Add modules section', 'Add pricing ($19/seat/year)', 'Create demo route (no outbound)', 'Wire waitlist form'] },
  { t: '2026-02-28T00:00:12.000Z', r: 'assistant', x: 'Uploaded screenshot mockups. You can paste images here too (demo shows the UI affordance).', a: [{ name: 'mock.png', url: '#', mime: 'image/png' }] },
  { t: '2026-02-28T00:00:20.000Z', r: 'user', x: 'Now revise the hero copy to be sharper and more specific.' },
  { t: '2026-02-28T00:00:26.000Z', r: 'assistant', x: 'Revision v2: “Productivity amplification for Clawdbots. Multi-version workflows with visible deltas, jobs, commits, and publishing.”' },
];

const DEMO_DEL = {
  lists: [
    { title: 'Landing Page Iteration', items: [
      { text: 'Write v1 copy', done: true },
      { text: 'Add modules positioning', done: true },
      { text: 'Add pricing + trial framing', done: true },
      { text: 'Add demo environment', done: false },
    ] }
  ],
  activeIndex: 0,
};

app.get('/demo', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Clawd Console — Demo</title>
  <meta name="robots" content="noindex" />
  <link rel="stylesheet" href="/static/demo.css" />
</head>
<body>
  <div class="top">
    <div class="badge">DEMO</div>
    <div class="title">Clawd Console</div>
    <div class="sub">Safe playground • no integrations • no outbound messaging</div>
    <a class="link" href="/" target="_blank" rel="noopener">Open app</a>
  </div>
  <div class="wrap">
    <div class="card" id="left">
      <div class="h">Transcript</div>
      <div class="muted">Seeded example showing iteration + DEL visibility.</div>
      <div id="chat"></div>
      <div class="composer">
        <textarea id="msg" placeholder="Demo mode: typing is allowed, sending is disabled."></textarea>
        <button id="send" disabled>Send</button>
      </div>
      <div class="muted" style="margin-top:10px">Tip: in the real app you can paste images into chat.</div>
    </div>

    <div class="card" id="right">
      <div class="h">DEL workflow</div>
      <div class="muted">Paid productivity feature (shown here as a preview).</div>
      <div id="del"></div>
      <div class="hr"></div>
      <div class="h">Modules</div>
      <ul class="ul">
        <li><b>ClawdSOP</b> — processitized SOP builds</li>
        <li><b>ClawdBuild</b> — layered app delivery</li>
        <li><b>ClawdJobs</b> — scheduled training + automation</li>
        <li><b>ClawdPub</b> — iterative client/public pages</li>
        <li><b>ClawdPM</b> — project manager layer</li>
      </ul>
      <div class="hr"></div>
      <div class="cta">
        <div class="muted">Want hosted access?</div>
        <a class="btn" href="https://clawdconsole.com/#waitlist" rel="noopener">Join waitlist</a>
      </div>
    </div>
  </div>

  <script src="/static/demo.js"></script>
</body>
</html>`);
});

app.get('/demo/api/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, demo: true, build: BUILD, serverTime: new Date().toISOString() });
});

app.get('/demo/api/messages', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, demo: true, messages: DEMO_MESSAGES });
});

app.get('/demo/api/del', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, demo: true, state: DEMO_DEL });
});

app.get('/api/status', (req, res) => {
  const forwardedFor = (req.headers['x-forwarded-for'] || '').toString();
  const clientIp = forwardedFor.split(',')[0].trim() || req.socket.remoteAddress || null;
  res.json({
    ok: true,
    service: 'claw-console',
    build: BUILD,
    inFlight: !!runState.inFlight,
    serverTime: new Date().toISOString(),
    hostname: require('os').hostname(),
    serverBind: '127.0.0.1',
    clientIp,
  });
});

app.get('/api/run', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, state: runState });
});

app.get('/clawdpub/sop', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const txt = readSopSnippet(200000);
  res.type('text/plain; charset=utf-8').send(txt);
});

app.get('/adminonly', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('text/html; charset=utf-8').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CC Admin</title>
  <meta name="robots" content="noindex" />
  <style>
    :root {
      --bg: #0b0f1a;
      --card: #11182a;
      --card2: #0f1526;
      --text: #e7e7e7;
      --muted: rgba(231,231,231,0.7);
      --border: rgba(231,231,231,0.12);
      --accent: #9ad0ff;
    }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; line-height: 1.35; background: var(--bg); color: var(--text); }
    a { color: var(--accent); }
    .wrap { display:grid; grid-template-columns: 260px 1fr; min-height:100vh; }
    .side { border-right: 1px solid var(--border); background: rgba(17,24,42,0.65); padding: 14px; }
    .main { padding: 14px; }
    .brand { display:flex; gap:10px; align-items:center; margin-bottom: 12px; }
    .logo { width:34px; height:34px; border-radius:10px; background:#1a2744; border:1px solid var(--border); display:flex; align-items:center; justify-content:center; font-weight:900; color: var(--accent); }
    .btxt b { display:block; font-size:14px; }
    .btxt span { display:block; font-size:12px; color: var(--muted); }

    .tabbtn { width:100%; text-align:left; padding:10px 12px; border-radius: 12px; border:1px solid var(--border); background: rgba(255,255,255,0.04); color: var(--text); cursor:pointer; }
    .tabbtn:hover { background: rgba(255,255,255,0.06); }

    .card { border: 1px solid var(--border); border-radius: 14px; padding: 14px; background: var(--card); box-shadow: 0 10px 25px rgba(0,0,0,0.25); }
    .muted { color: var(--muted); font-size: 13px; }
    code { background: rgba(255,255,255,0.08); padding:2px 6px; border-radius:6px; }
    ul { margin: 10px 0 0 18px; color: rgba(231,231,231,0.88); }
  </style>
</head>
<body>
  <div class="wrap">
    <aside class="side">
      <div class="brand">
        <div class="logo">C</div>
        <div class="btxt"><b>CC Admin</b><span>adminonly</span></div>
      </div>

      <button id="admTabSitemap" class="tabbtn" type="button">Sitemap</button>
      <button id="admTabAdoption" class="tabbtn" type="button" style="margin-top:10px;">Adoption</button>
      <button id="admTabCRM" class="tabbtn" type="button" style="margin-top:10px;">CRM</button>
      <div class="muted" style="margin-top:10px;">Default tab: Sitemap</div>
    </aside>

    <main class="main">
      <div id="admPanelSitemap" class="card">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:baseline; flex-wrap:wrap;">
          <h1 style="margin:0; font-size:18px;">Sitemap</h1>
          <div class="muted">Public surfaces + operator surfaces</div>
        </div>

        <h2 style="margin:14px 0 6px; font-size:14px;">Public marketing</h2>
        <ul>
          <li><a href="https://clawdconsole.com/" target="_blank" rel="noopener">https://clawdconsole.com/</a> (live)</li>
          <li><a href="https://clawdconsole.com/v.101/" target="_blank" rel="noopener">https://clawdconsole.com/v.101/</a> (previous live)</li>
          <li><a href="https://clawdconsole.com/v2/" target="_blank" rel="noopener">https://clawdconsole.com/v2/</a> (draft)</li>
        </ul>

        <h2 style="margin:14px 0 6px; font-size:14px;">Public demo</h2>
        <ul>
          <li><a href="https://demo.clawdconsole.com/" target="_blank" rel="noopener">https://demo.clawdconsole.com/</a> (redirects to <code>/demo</code>)</li>
        </ul>

        <h2 style="margin:14px 0 6px; font-size:14px;">Operator app (auth)</h2>
        <ul>
          <li><a href="https://app.clawdconsole.com/" target="_blank" rel="noopener">https://app.clawdconsole.com/</a></li>
          <li><a href="https://app.clawdconsole.com/transcript" target="_blank" rel="noopener">/transcript</a></li>
          <li><a href="https://app.clawdconsole.com/publish" target="_blank" rel="noopener">/publish</a></li>
          <li><a href="https://app.clawdconsole.com/clawdpub/sop" target="_blank" rel="noopener">/clawdpub/sop</a></li>
          <li><a href="https://app.clawdconsole.com/adminonly" target="_blank" rel="noopener">/adminonly</a> (admin)</li>
        </ul>

        <div class="muted" style="margin-top:14px;">Note: keep truly-sensitive surfaces behind auth. This page is behind auth (basic/session).</div>
      </div>

      <div id="admPanelAdoption" class="card" style="display:none;">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:baseline; flex-wrap:wrap;">
          <h1 style="margin:0; font-size:18px;">Adoption</h1>
          <div class="muted">Tracking installs and Clawd Console usage</div>
        </div>

        <div class="muted" style="margin-top:8px;">Source: <code>${DATA_DIR}/adoption.json</code></div>

        <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap; align-items:center;">
          <button id="adoptRefresh" class="tabbtn" type="button" style="width:auto;">Refresh</button>
          <span class="muted" id="adoptSaved"></span>
        </div>

        <div style="display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 12px;">
          <div style="border:1px solid rgba(255,255,255,0.10); border-radius:14px; padding:12px; background: rgba(255,255,255,0.03);">
            <div class="muted">Total installs</div>
            <div style="font-weight:900; font-size:26px; margin-top:6px;" id="adoptTotal">—</div>
            <div class="muted" style="margin-top:6px;">(Clawdbot + Moltbot + Console)</div>
          </div>
          <div style="border:1px solid rgba(255,255,255,0.10); border-radius:14px; padding:12px; background: rgba(255,255,255,0.03);">
            <div class="muted">Clawdbot installs</div>
            <div style="font-weight:900; font-size:26px; margin-top:6px;" id="adoptClawdbot">—</div>
          </div>
          <div style="border:1px solid rgba(255,255,255,0.10); border-radius:14px; padding:12px; background: rgba(255,255,255,0.03);">
            <div class="muted">Clawd Console installs</div>
            <div style="font-weight:900; font-size:26px; margin-top:6px;" id="adoptConsole">—</div>
            <div class="muted" style="margin-top:6px;">Console adoption rate: <span id="adoptRate">—</span></div>
          </div>
        </div>

        <div style="margin-top:12px;" class="muted">Edit counts (manual for now):</div>
        <div class="row" style="gap:10px; margin-top:8px; align-items:flex-end;">
          <div style="flex:1; min-width:180px;">
            <div class="muted">Clawdbot</div>
            <input id="adoptInClawdbot" type="number" min="0" style="width:100%; padding:10px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.14); background:#0d1426; color:var(--text)" />
          </div>
          <div style="flex:1; min-width:180px;">
            <div class="muted">Moltbot</div>
            <input id="adoptInMoltbot" type="number" min="0" style="width:100%; padding:10px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.14); background:#0d1426; color:var(--text)" />
          </div>
          <div style="flex:1; min-width:180px;">
            <div class="muted">Clawd Console</div>
            <input id="adoptInConsole" type="number" min="0" style="width:100%; padding:10px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.14); background:#0d1426; color:var(--text)" />
          </div>
          <button id="adoptSave" class="tabbtn" type="button" style="width:auto;">Save</button>
        </div>

        <div class="muted" style="margin-top:10px;">Next: wire opt-in telemetry (anonymous install id + console ping) so these numbers auto-populate.</div>
      </div>

      <div id="admPanelCRM" class="card" style="display:none;">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:baseline; flex-wrap:wrap;">
          <h1 style="margin:0; font-size:18px;">CRM</h1>
          <div class="muted">Waitlist submissions (popup)</div>
        </div>
        <div class="muted" style="margin-top:8px;">Source: <code>${DATA_DIR}/crm.jsonl</code></div>
        <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap; align-items:center;">
          <button id="crmRefresh" class="tabbtn" type="button" style="width:auto;">Refresh</button>
          <span class="muted" id="crmCount"></span>
        </div>
        <div id="crmList" style="margin-top:10px; background: rgba(0,0,0,0.12); border: 1px solid rgba(255,255,255,0.10); border-radius: 12px; padding: 10px; max-height: 70vh; overflow:auto;"></div>
      </div>

      <div class="muted" style="margin-top:12px;">More admin tabs coming.</div>
    </main>
  </div>

  <script src="/static/adminonly.js"></script>
</body>
</html>`);
});

const ADOPTION_FILE = path.join(DATA_DIR, 'adoption.json');
function readAdoption(){
  try {
    if (!fs.existsSync(ADOPTION_FILE)) return { clawdbot: 0, moltbot: 0, console: 0, updatedAt: null };
    const j = JSON.parse(fs.readFileSync(ADOPTION_FILE, 'utf8'));
    return {
      clawdbot: Number(j.clawdbot || 0),
      moltbot: Number(j.moltbot || 0),
      console: Number(j.console || 0),
      updatedAt: j.updatedAt || null,
    };
  } catch {
    return { clawdbot: 0, moltbot: 0, console: 0, updatedAt: null };
  }
}
function writeAdoption(a){
  try {
    const out = {
      clawdbot: Math.max(0, Number(a.clawdbot || 0)),
      moltbot: Math.max(0, Number(a.moltbot || 0)),
      console: Math.max(0, Number(a.console || 0)),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(ADOPTION_FILE, JSON.stringify(out, null, 2), 'utf8');
    return out;
  } catch {
    return null;
  }
}

app.get('/api/adoption', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, adoption: readAdoption() });
});

app.post('/api/adoption', (req, res) => {
  const body = req.body || {};
  const saved = writeAdoption(body);
  if (!saved) return res.status(500).json({ ok: false, error: 'write_failed' });
  logWork('adoption.updated', saved);
  res.json({ ok: true, adoption: saved });
});

// --- Telemetry collector (hosted) ---
function appendTelemetry(kind, payload, req){
  try {
    const rec = {
      ts: new Date().toISOString(),
      kind,
      installId: payload && typeof payload.installId === 'string' ? payload.installId : null,
      createdAt: payload && payload.createdAt ? payload.createdAt : null,
      appVersion: payload && payload.appVersion ? payload.appVersion : null,
      build: payload && payload.build ? payload.build : null,
      platform: payload && payload.platform ? payload.platform : null,
      // do not persist IP/user-agent beyond what your reverse-proxy logs already have
    };
    fs.appendFileSync(TELEMETRY_FILE, JSON.stringify(rec) + '\n', 'utf8');
    logWork('telemetry.received', { kind, installId: rec.installId });
  } catch {}
}

const telemetrySeen = new Map(); // key -> lastTsMs (tiny in-memory rate limit)
function telemetryRateLimit(req){
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const key = ip + '|' + String(req.path || '');
  const now = Date.now();
  const last = telemetrySeen.get(key) || 0;
  if (now - last < 2000) return false;
  telemetrySeen.set(key, now);
  return true;
}

app.post('/api/telemetry/v1/install', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!telemetryRateLimit(req)) return res.status(429).json({ ok: false, error: 'rate_limited' });
  appendTelemetry('install', req.body || {}, req);
  res.json({ ok: true });
});

app.post('/api/telemetry/v1/daily', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!telemetryRateLimit(req)) return res.status(429).json({ ok: false, error: 'rate_limited' });
  appendTelemetry('daily', req.body || {}, req);
  res.json({ ok: true });
});

app.get('/api/telemetry/v1/stats', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // keep this behind auth by not adding it to the auth bypass list
  // (it will require auth because it doesn't start with /api/telemetry/v1/ in the bypass? It does.
  // To keep it protected, we won't ship this route unauthenticated; admin can read file locally.)
  res.status(404).json({ ok: false, error: 'not_enabled' });
});

app.get('/api/repo/commits', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 60)));
  const repoDir = __dirname; // this console repo

  try {
    const args = ['-C', repoDir, 'log', '--date=iso', `-n`, String(limit), '--pretty=format:%H|%ad|%D|%s'];
    const out = await new Promise((resolve, reject) => {
      execFile('git', args, { timeout: 5000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message || err)));
        resolve(String(stdout || ''));
      });
    });

    const commits = out.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
      const [hash, date, refs, subject] = line.split('|');
      return {
        hash: hash || '',
        date: (date || '').replace(' +0000', 'Z'),
        refs: (refs || '').trim(),
        subject: subject || ''
      };
    });

    res.json({ ok: true, repoDir, commits });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

function readButtons(){
  const fallback = { updatedAt: null, buttons: [] };
  try {
    const j = readJson(BUTTONS_FILE, fallback);
    if (!j || !Array.isArray(j.buttons)) return fallback;
    return {
      updatedAt: j.updatedAt || null,
      buttons: j.buttons.filter(b => b && b.label && b.text).slice(0, 50)
    };
  } catch {
    return fallback;
  }
}
function writeButtons(buttons){
  const safe = (Array.isArray(buttons) ? buttons : [])
    .filter(b => b && typeof b.label === 'string' && typeof b.text === 'string')
    .map(b => ({
      label: String(b.label).trim().slice(0, 32),
      text: String(b.text).trim().slice(0, 4000),
      createdAt: b.createdAt || new Date().toISOString(),
    }))
    .filter(b => b.label && b.text)
    .slice(-50);

  const out = { updatedAt: new Date().toISOString(), buttons: safe };
  writeJson(BUTTONS_FILE, out);
  return out;
}

app.get('/api/buttons', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, ...readButtons() });
});

app.post('/api/buttons', (req, res) => {
  const body = req.body || {};
  const buttons = Array.isArray(body.buttons) ? body.buttons : null;
  if (!buttons) return res.status(400).json({ ok: false, error: 'Expected {buttons: []}' });
  const saved = writeButtons(buttons);
  logWork('buttons.saved', { count: saved.buttons.length });
  res.json({ ok: true, ...saved });
});

app.get('/api/build', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, build: BUILD });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeBase = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `${stamp}__${safeBase}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).type('text/plain').send('No file');
  const urlPath = `/uploads/${encodeURIComponent(req.file.filename)}`;
  logWork('upload.saved', { filename: req.file.filename, mime: req.file.mimetype, size: req.file.size });
  res.json({
    ok: true,
    filename: req.file.filename,
    url: urlPath,
    mime: req.file.mimetype,
    size: req.file.size,
  });
});

app.get('/api/messages', (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
  res.json({ ok: true, messages: readLastJsonl(MSG_FILE, limit) });
});

// --- Dynamic Execution List (DEL) ---
const DE_FILE = path.join(DATA_DIR, 'dynamic-exec.json');
function loadDEState() {
  try {
    if (!fs.existsSync(DE_FILE)) return { lists: [], activeIndex: -1 };
    const j = JSON.parse(fs.readFileSync(DE_FILE, 'utf8'));
    if (j && Array.isArray(j.lists)) return { lists: j.lists, activeIndex: Number(j.activeIndex ?? (j.lists.length - 1)) };
    // legacy single-list migration
    if (j && j.items) return { lists: [j], activeIndex: 0 };
    return { lists: [], activeIndex: -1 };
  } catch {
    return { lists: [], activeIndex: -1 };
  }
}
function saveDEState(state) {
  try {
    fs.writeFileSync(DE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch {}
}
function currentDE(state) {
  if (!state) return null;
  const i = Number(state.activeIndex);
  if (!Number.isFinite(i) || i < 0 || i >= state.lists.length) return null;
  return state.lists[i];
}

function extractChecklist(text) {
  let t = String(text || '');
  // Strip PLAN MODE header if present.
  t = t.replace(/^\s*PLAN MODE\s*\n+/i, '');

  // 1) Bullet/numbered list detection
  const lines = t.split(/\r?\n/);
  const bulletItems = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // - foo, * foo, 1. foo, 1) foo, [ ] foo
    const m = line.match(/^(-|\*|\d+[\.)]|\[\s?\])\s+(.*)$/);
    if (m && m[2]) bulletItems.push(m[2].trim());
  }
  if (bulletItems.length >= 3) return bulletItems;

  // 2) Multi-request detector for free-form paragraphs.
  const norm = t.replace(/\s+/g, ' ').trim();
  if (!norm) return null;

  // Split into sentences first so periods act as natural separators.
  // This prevents the extractor from grabbing random fragments when the user writes multiple sentences.
  const sentences = norm
    .split(/(?<=[.?!])\s+/)
    .map(s => s.trim())
    .filter(Boolean);

  // Action verbs that usually indicate a distinct checklist item.
  // NOTE: we intentionally do NOT include conversational prefixes like "let's"/"please" here.
  const keywords = /\b(?:trigger|add|make|build|fix|change|update|move|remove|drop|ditch|rename|swap|create|set)\b\s*/i;

  const rawParts = [];
  for (const s0 of (sentences.length ? sentences : [norm])) {
    const s = s0.trim();
    if (!s) continue;

    const matches = [...s.matchAll(new RegExp(keywords.source, 'ig'))];
    const cleanSentence = s
      .replace(/^[\s,]*(?:okay|ok|ya|yeah|yep|so|alright)\b\s*/i, '')
      .replace(/^[\s,]*(?:let's|lets|please)\b\s*/i, '')
      .replace(/^[\s,]*just\b\s*/i, '')
      .replace(/[.?!]\s*$/, '')
      .trim();

    // If there's only one (or zero) action keyword in the sentence, keep the whole sentence.
    // This preserves the verb ("drop", "change", etc.) and avoids fragment items.
    if (matches.length <= 1) {
      rawParts.push(cleanSentence);
      continue;
    }

    // Otherwise, split into multiple items around action keywords.
    const parts = s
      .split(keywords)
      .map(x => x.trim())
      .filter(Boolean)
      .map(x => x.replace(/^(to\s+)/i, '').trim())
      .map(x => x.replace(/[.?!]\s*$/, '').trim());
    rawParts.push(...parts);
  }

  // Filter out useless fragments (especially praise / filler).
  const noise = new Set([
    'great','nice','cool','awesome','perfect','love','love it','amazing','and','or','ok','okay','yep','yes','no','thanks','thank you',
    'dont',"don't"
  ]);

  // If a fragment starts with "For <subject>," carry it into the next item.
  let pendingPrefix = '';

  const out = [];
  const seen = new Set();

  for (let p of rawParts) {
    if (!p) continue;
    const low = p.toLowerCase().replace(/[^a-z0-9\s',-]/g, '').trim();
    if (!low) continue;
    if (noise.has(low)) continue;

    // Drop short praise-only fragments like "ya that's really nice".
    if (low.length < 22 && /(nice|great|awesome|love|amazing|perfect)/i.test(p) && !/(add|make|fix|change|update|move|remove|drop|rename|swap|create|set)/i.test(p)) continue;

    if (low.length < 6) continue;

    // capture "For X," prefix if it's basically just a prefix
    const m = p.match(/^(For\s+[^,]{2,60},)\s*(.*)$/i);
    if (m) {
      const prefix = m[1].trim();
      const rest = (m[2] || '').trim();
      if (!rest) {
        pendingPrefix = prefix;
        continue;
      }
      p = prefix + ' ' + rest;
    }

    if (pendingPrefix) {
      // only prepend if it isn't already a For-prefix
      if (!/^for\s+[^,]{2,60},/i.test(p)) p = pendingPrefix + ' ' + p;
      pendingPrefix = '';
    }

    const item = p.length > 180 ? (p.slice(0, 180).trim() + '…') : p;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out.length >= 3 ? out.slice(0, 15) : null;
}

app.get('/api/de', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const state = loadDEState();

  // normalize completion flags
  for (const l of state.lists) {
    if (!l || !Array.isArray(l.items)) continue;
    l.completed = !!l.completed || l.items.every(it => it.done);
  }
  saveDEState(state);

  const active = currentDE(state);
  res.json({ ok: true, state: { lists: state.lists, activeIndex: state.activeIndex }, active });
});

app.post('/api/de/active', (req, res) => {
  const { dir } = req.body || {}; // -1 or +1
  const state = loadDEState();
  if (!state.lists.length) return res.json({ ok: true, state, active: null });
  const d = Number(dir) || 0;
  let i = Number(state.activeIndex);
  if (!Number.isFinite(i)) i = state.lists.length - 1;
  i = Math.max(0, Math.min(state.lists.length - 1, i + d));
  state.activeIndex = i;
  saveDEState(state);
  const active = currentDE(state);
  broadcast({ type: 'de_state', state, active });
  res.json({ ok: true, state, active });
});

app.post('/api/de/toggle', (req, res) => {
  const { listId, idx, done } = req.body || {};
  const state = loadDEState();
  const list = state.lists.find(l => l && l.id === listId) || currentDE(state);
  if (!list || !Array.isArray(list.items)) return res.status(404).json({ ok: false, error: 'No active DEL' });

  const wasCompleted = !!list.completed;

  const i = Number(idx);
  if (!Number.isFinite(i) || i < 0 || i >= list.items.length) return res.status(400).json({ ok: false, error: 'Bad idx' });
  list.items[i].done = (done === undefined) ? !list.items[i].done : !!done;
  list.updatedAt = new Date().toISOString();

  // universal completion behavior: treat list as completed if all items done.
  list.completed = list.items.every(it => it.done);

  // Training log: when a list becomes completed, capture before/after.
  if (!wasCompleted && list.completed) appendClawdListTraining(list);

  saveDEState(state);
  const active = currentDE(state);
  broadcast({ type: 'de_state', state, active });
  res.json({ ok: true, state, active });
});

app.post('/api/de/mark-all', (req, res) => {
  const { listId } = req.body || {};
  const state = loadDEState();
  const list = state.lists.find(l => l && l.id === listId) || currentDE(state);
  if (!list || !Array.isArray(list.items)) return res.status(404).json({ ok: false, error: 'No active DEL' });

  const wasCompleted = !!list.completed;

  for (const it of list.items) it.done = true;
  list.completed = true;
  list.updatedAt = new Date().toISOString();

  if (!wasCompleted) appendClawdListTraining(list);

  saveDEState(state);
  const active = currentDE(state);
  broadcast({ type: 'de_state', state, active });
  res.json({ ok: true, state, active });
});

app.post('/api/de/delete', (req, res) => {
  const { listId } = req.body || {};
  const state = loadDEState();
  const doomed = state.lists.find(l => l && l.id === listId) || null;

  const before = state.lists.length;
  state.lists = state.lists.filter(l => l && l.id !== listId);
  if (state.activeIndex >= state.lists.length) state.activeIndex = state.lists.length - 1;
  saveDEState(state);

  // If a DEL list is deleted, also remove its appearance from the transcript.
  // We match either:
  //  - transcript line has `de` pointing to listId
  //  - transcript line has `i` matching the list's source message id (where the checklist came from)
  let scrub = { ok: true, removed: 0 };
  if (doomed) {
    const srcMsgId = doomed.sourceMsgId || null;
    scrub = scrubTranscriptBy((obj) => {
      if (obj && obj.de && obj.de === listId) return true;
      if (srcMsgId && obj && obj.i && obj.i === srcMsgId) return true;
      return false;
    });
    logWork('transcript.scrub.del', { listId, srcMsgId, scrubOk: scrub.ok, removed: scrub.removed });
  }

  const active = currentDE(state);
  broadcast({ type: 'de_state', state, active });
  res.json({ ok: true, removed: before - state.lists.length, scrub, state, active });
});

app.post('/api/de/item/delete', (req, res) => {
  const { listId, idx } = req.body || {};
  const state = loadDEState();
  const list = state.lists.find(l => l && l.id === listId);
  if (!list || !Array.isArray(list.items)) return res.status(404).json({ ok: false, error: 'List not found' });
  const i = Number(idx);
  if (!Number.isFinite(i) || i < 0 || i >= list.items.length) return res.status(400).json({ ok: false, error: 'Bad idx' });

  const removedItem = list.items[i];
  const removedText = (removedItem && removedItem.text) ? String(removedItem.text) : '';

  list.items.splice(i, 1);
  list.updatedAt = new Date().toISOString();
  list.completed = list.items.length ? list.items.every(it => it.done) : true;
  saveDEState(state);

  // If a DEL item is deleted, scrub it from the transcript list snapshot for that DEL.
  // We ONLY remove it from the transcript's `d` array (the checklist snapshot), not the entire message.
  let scrub = { ok: true, removed: 0, updated: 0 };
  if (removedText) {
    scrub = rewriteTranscript((obj) => {
      if (!obj || obj.de !== listId) return obj;
      if (!Array.isArray(obj.d)) return obj;
      const beforeLen = obj.d.length;
      obj.d = obj.d.filter(it => it && it.t !== removedText);
      // If empty, drop the field for cleanliness.
      if (!obj.d.length) delete obj.d;
      // If unchanged, no-op.
      if (obj.d && obj.d.length === beforeLen) return obj;
      return obj;
    });
    logWork('transcript.scrub.del_item', { listId, idx: i, removedText, scrubOk: scrub.ok, removed: scrub.removed, updated: scrub.updated });
  }

  const active = currentDE(state);
  broadcast({ type: 'de_state', state, active });
  res.json({ ok: true, scrub, state, active });
});

const CRM_FILE = path.join(DATA_DIR, 'crm.jsonl');

// ClawdList training log: before (source user msg) -> after (final completed list)
const CLAWDLIST_TRAIN_FILE = path.join(DATA_DIR, 'clawdlist-training.jsonl');

function findMsgTextById(id) {
  try {
    if (!id || !fs.existsSync(MSG_FILE)) return '';
    const txt = fs.readFileSync(MSG_FILE, 'utf8');
    const lines = txt.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (!l) continue;
      try {
        const obj = JSON.parse(l);
        if (obj && obj.id === id) return String(obj.text || '');
      } catch {}
    }
    return '';
  } catch {
    return '';
  }
}

function appendClawdListTraining(list) {
  try {
    if (!list || !list.id || !Array.isArray(list.items)) return;
    const before = findMsgTextById(list.sourceMsgId);
    const payload = {
      t: new Date().toISOString(),
      listId: list.id,
      sourceMsgId: list.sourceMsgId || null,
      before,
      after: list.items.map(it => ({ text: String(it.text || ''), done: !!it.done })),
      updatedAt: list.updatedAt || null,
      createdAt: list.createdAt || null,
    };
    fs.appendFileSync(CLAWDLIST_TRAIN_FILE, JSON.stringify(payload) + '\n', 'utf8');
    logWork('clawdlist.training.append', { listId: list.id, sourceMsgId: list.sourceMsgId || null, beforeLen: (before || '').length, items: list.items.length });
  } catch (e) {
    logWork('clawdlist.training.error', { error: String(e) });
  }
}

function appendCrm(obj) {
  try { fs.appendFileSync(CRM_FILE, JSON.stringify(obj) + '\n', 'utf8'); } catch {}
}
function readCrm(limit = 2000) {
  try {
    if (!fs.existsSync(CRM_FILE)) return [];
    const txt = fs.readFileSync(CRM_FILE, 'utf8');
    const lines = txt.trim().split('\n').filter(Boolean);
    const slice = lines.slice(-limit);
    return slice.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

app.post('/api/crm/lead', (req, res) => {
  // CORS: allow marketing site to post leads.
  const origin = String(req.headers.origin || '');
  if (origin === 'https://clawdconsole.com' || origin === 'https://www.clawdconsole.com') {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const { name, email, source } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  if (!em || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return res.status(400).json({ ok: false, error: 'Valid email required' });

  const nm = String(name || '').trim().slice(0, 120);
  const entry = {
    id: 'lead_' + Math.random().toString(16).slice(2) + Date.now().toString(16),
    ts: new Date().toISOString(),
    name: nm || null,
    email: em,
    source: String(source || '').slice(0, 200) || null,
    ip: (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || null),
    ua: String(req.headers['user-agent'] || '').slice(0, 300) || null,
    ref: String(req.headers['referer'] || '').slice(0, 400) || null,
  };

  appendCrm(entry);
  logWork('crm.lead', { email: em, source: entry.source });
  return res.json({ ok: true });
});

app.options('/api/crm/lead', (req, res) => {
  const origin = String(req.headers.origin || '');
  if (origin === 'https://clawdconsole.com' || origin === 'https://www.clawdconsole.com') {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).send('');
});

app.get('/api/crm/leads', (req, res) => {
  // Auth protected by default middleware.
  const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 1000)));
  const leads = readCrm(limit);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, leads });
});

app.get('/api/worklog', (req, res) => {
  const limit = Math.max(1, Math.min(300, Number(req.query.limit || 100)));
  res.json({ ok: true, entries: readLastJsonl(WORK_FILE, limit) });
});

app.get('/api/scheduled', (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, entries: readLastJsonl(SCHED_FILE, limit) });
});

app.post('/api/scheduled/add', (req, res) => {
  const { kind, title, instructions, report } = req.body || {};
  if (typeof kind !== 'string') return res.status(400).json({ ok: false, error: 'kind required' });
  const entry = {
    id: 'sch_' + Math.random().toString(16).slice(2) + Date.now().toString(16),
    ts: new Date().toISOString(),
    kind,
    title: typeof title === 'string' ? title : kind,
    instructions: typeof instructions === 'string' ? instructions : '',
    report: typeof report === 'string' ? report : '',
  };
  appendJsonl(SCHED_FILE, entry);
  broadcast({ type: 'scheduled', entry });
  res.json({ ok: true, entry });
});

app.get('/api/transcript/raw', (req, res) => {
  // Raw tiny JSONL transcript.
  try {
    const txt = fs.existsSync(TRANSCRIPT_FILE) ? fs.readFileSync(TRANSCRIPT_FILE, 'utf8') : '';
    res.setHeader('Cache-Control', 'no-store');
    return res.type('text/plain; charset=utf-8').send(txt);
  } catch (e) {
    return res.status(500).type('text/plain').send('Failed to read transcript: ' + String(e));
  }
});

app.get('/api/transcript/search', (req, res) => {
  // Best-effort: read file and filter in memory. Good enough for modest logs.
  const q = (req.query.q || '').toString().toLowerCase().trim();
  const role = (req.query.role || '').toString().trim(); // "user" | "assistant" | ""
  const days = Number(req.query.days || 0) || 0; // 0 = all
  const hasList = (req.query.hasList || '').toString() === '1';
  const order = ((req.query.order || 'asc').toString().toLowerCase() === 'desc') ? 'desc' : 'asc';
  const offset = Math.max(0, Number(req.query.offset || 0) || 0);
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 200) || 200));

  const sinceMs = days > 0 ? (Date.now() - (days * 24 * 60 * 60 * 1000)) : 0;

  try {
    const txt = fs.existsSync(TRANSCRIPT_FILE) ? fs.readFileSync(TRANSCRIPT_FILE, 'utf8') : '';
    const lines = txt.split('\n').filter(Boolean);

    // If order=desc, scan from newest to oldest.
    const scan = (order === 'desc') ? lines.slice().reverse() : lines;

    const items = [];
    let seen = 0;

    for (const line of scan) {
      let obj;
      try { obj = JSON.parse(line); } catch { obj = null; }
      if (!obj || typeof obj !== 'object') continue;

      if (role && obj.r !== role) continue;
      if (hasList && !obj.d) continue;

      if (sinceMs) {
        const t = Date.parse(obj.t || '');
        if (Number.isFinite(t) && t < sinceMs) continue;
      }

      const hay = ((obj.x || '') + ' ' + (obj.r || '') + ' ' + (obj.t || '')).toString().toLowerCase();
      if (q && !hay.includes(q)) continue;

      if (seen++ < offset) continue;
      items.push(obj);
      if (items.length >= limit) break;
    }

    const done = (seen - offset) <= items.length;
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, q, role, days, hasList, order, offset, limit, items, done });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Failed to search transcript: ' + String(e) });
  }
});

app.get('/transcript', (req, res) => {
  res.type('text/html; charset=utf-8').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ClawdScript</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background: #0b1020; color: #e8eefc; margin: 0; }
    a { color: #9ad0ff; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 18px; }
    .top { display:flex; gap: 10px; flex-wrap: wrap; align-items:center; justify-content: space-between; }
    .card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.10); border-radius: 14px; padding: 14px; }
    .row { display:flex; gap: 10px; flex-wrap: wrap; align-items:center; }
    input { background:#0d1426; border:1px solid rgba(255,255,255,0.12); color:#e8eefc; border-radius: 10px; padding: 10px 12px; min-width: 320px; }
    button { background:#14213f; border:1px solid rgba(255,255,255,0.12); color:#e8eefc; border-radius: 10px; padding: 10px 12px; cursor:pointer; }
    .tbtn { background:#0d1426; }
    .tbtn.active { background:#14213f; border-color: rgba(154,208,255,0.55); }
    #hasListBtn.on { background:#1f8f4a; border-color: rgba(255,255,255,0.18); }
    button:disabled { opacity:0.5; cursor: default; }
    .muted { color: rgba(255,255,255,0.65); font-size: 12px; }
    .t_row { margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.08); }
    .t_top { display:flex; gap: 10px; flex-wrap: wrap; align-items: center; justify-content: space-between; }
    .t_meta { font-size: 12px; color: rgba(255,255,255,0.65); }
    .t_ts { color: rgba(255,255,255,0.75); }
    .t_user { color: #22c6c6; font-weight: 800; }
    .t_agent { color: #b46cff; font-weight: 800; }
    .t_text { margin: 8px 0 8px 0; white-space: pre-wrap; background: rgba(0,0,0,0.12); border: 1px solid rgba(255,255,255,0.08); padding: 10px; border-radius: 12px; }
    .t_actions { display:flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .t_atts { margin-top: 8px; display:flex; gap: 10px; flex-wrap: wrap; font-size: 12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="row" style="justify-content: space-between; width: 100%;">
        <div class="row" style="gap:10px; align-items:center;">
          <div style="width:36px;height:36px;border-radius:10px;background:rgba(34,198,198,.10);border:1px solid rgba(34,198,198,.35);display:flex;align-items:center;justify-content:center;">
            <svg width="24" height="24" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Clawd Console">
              <path d="M46 18H26c-4.4 0-8 3.6-8 8v12c0 4.4 3.6 8 8 8H46" stroke="rgba(34,198,198,.95)" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
              <rect x="26" y="23" width="16" height="8" rx="4" fill="rgba(34,198,198,.22)" stroke="rgba(34,198,198,.55)" stroke-width="2"/>
              <rect x="26" y="35" width="16" height="8" rx="4" fill="rgba(34,198,198,.12)" stroke="rgba(34,198,198,.40)" stroke-width="2"/>
              <path d="M46 28l8 4-8 4" stroke="rgba(34,198,198,.95)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div>
            <div style="font-weight:900; font-size: 18px;">ClawdScript</div>
            <div class="muted">Build: <span id="t_build">(loading)</span> • Raw: <a href="/api/transcript/raw" target="_blank" rel="noopener">download jsonl</a></div>
          </div>
        </div>
      </div>
      <div class="row" style="gap:8px; justify-content: space-between; width: 100%;">
        <div class="row" style="gap:8px;">
          <button class="tbtn" data-role="" id="roleAll" type="button">All</button>
          <button class="tbtn" data-role="user" id="roleUser" type="button">Charles</button>
          <button class="tbtn" data-role="assistant" id="roleAgent" type="button">Clawdio</button>
        </div>
      </div>
      <div class="row" style="margin-top:10px; justify-content: space-between; width: 100%;">
        <div class="row" style="gap:8px; flex: 1;">
          <input id="t_q" placeholder="Search text (press Enter)" style="flex:1; min-width: 260px;" />
          <button id="t_search" type="button">Search</button>
        </div>
        <div class="row" style="gap:8px; justify-content:flex-end;">
          <button class="tbtn" data-days="0" id="daysAll" type="button">All time</button>
          <button class="tbtn" data-days="1" id="days1" type="button">24h</button>
          <button class="tbtn" data-days="7" id="days7" type="button">7d</button>
          <button class="tbtn" data-days="30" id="days30" type="button">30d</button>
          <button class="tbtn" id="hasListBtn" type="button">List</button>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top: 14px;">
      <div class="row" style="justify-content: space-between;">
        <div class="row" style="gap:10px; align-items:center;">
          <div class="muted" id="t_status">Idle</div>
          <button id="t_order" type="button" class="tbtn" title="Toggle order">⇅</button>
        </div>
        <button id="t_more" type="button">Load more</button>
      </div>
      <div id="t_list"></div>
    </div>
  </div>
  <script src="/static/transcript.js"></script>
</body>
</html>`);
});

const PM_FILE = path.join(DATA_DIR, 'pm.json');
function readPM(){
  const fallback = {
    updatedAt: null,
    columns: [
      { id: 'p0', title: 'Projects', cards: [
        { id: 'c1', title: 'Clawdbot Clone Spinup', body: 'Spin up a fresh Clawdbot/Moltbot box reliably.', priority: 'high', createdAt: new Date().toISOString() },
        { id: 'c2', title: 'Clawdbot Install Revision', body: 'Make install easier (target: < 30 minutes, not 6 hours).', priority: 'ultra', createdAt: new Date().toISOString() },
        { id: 'c3', title: 'Manage ClawdConsole Open Source Branch', body: 'Keep OSS repo clean, reviewed, tagged releases.', priority: 'normal', createdAt: new Date().toISOString() },
        { id: 'c4', title: 'Test ClawdConsole on New Box (Validation)', body: 'Install + run on a clean box; verify docs + defaults.', priority: 'planning', createdAt: new Date().toISOString() },
      ]},
      { id: 'p1', title: 'Backlog', cards: [] },
      { id: 'p2', title: 'Doing', cards: [] },
      { id: 'p3', title: 'Done', cards: [] },
    ]
  };
  return readJson(PM_FILE, fallback);
}
function writePM(pm){
  const out = pm && Array.isArray(pm.columns) ? pm : readPM();
  out.updatedAt = new Date().toISOString();
  writeJson(PM_FILE, out);
  return out;
}

app.get('/api/pm', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, pm: readPM() });
});

app.post('/api/pm', (req, res) => {
  const pm = req.body && req.body.pm;
  const saved = writePM(pm);
  logWork('pm.saved', { cols: saved.columns?.length || 0 });
  res.json({ ok: true, pm: saved });
});

// Generate to-dos for a PM card using the connected Gateway model.
const PM_SESSION_KEY = process.env.PM_SESSION_KEY || 'clawdpm';
app.post('/api/pm/generate-todos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!gw.connected) return res.status(409).json({ ok: false, error: 'Gateway not connected' });

  const title = String(req.body?.title || '').trim();
  const body = String(req.body?.body || '').trim();
  if (!title) return res.status(400).json({ ok: false, error: 'Missing title' });

  const prompt = [
    'PLAN MODE',
    'Generate a concise execution checklist for this card goal.',
    'Rules:',
    '- Output ONLY a bullet list (one item per line) using "- ".',
    '- 6 to 14 items.',
    '- Each item should be an actionable verb phrase.',
    '',
    'Card title: ' + title,
    body ? ('Card details: ' + body) : ''
  ].filter(Boolean).join('\n');

  try {
    const runId = 'pm_' + Date.now().toString(16);
    await gwSendReq('chat.send', {
      sessionKey: PM_SESSION_KEY,
      idempotencyKey: runId,
      message: prompt,
      deliver: false,
    });

    const startedAt = Date.now();
    let lastTxt = '';
    while (Date.now() - startedAt < 45_000) {
      await new Promise(r => setTimeout(r, 900));
      const payload = await gwSendReq('chat.history', { sessionKey: PM_SESSION_KEY, limit: 30 });
      const messages = payload?.messages;
      if (!Array.isArray(messages)) continue;
      const assistants = messages
        .map(m => (m && m.message) ? m.message : m)
        .filter(m => m && m.role === 'assistant');
      const latest = assistants[assistants.length - 1];
      const txt = extractTextFromGatewayMessage(latest);
      if (!txt || txt === lastTxt) continue;
      lastTxt = txt;

      let items = extractChecklist(txt) || [];
      if (!items.length) {
        // fallback: take bullet-looking lines
        items = String(txt).split(/\r?\n/).map(l => l.trim()).filter(l => /^-\s+/.test(l)).map(l => l.replace(/^[-*]\s+/, '').trim());
      }
      items = items.filter(Boolean).slice(0, 20);

      const todos = items.map(t => ({ id: 't_' + crypto.randomBytes(8).toString('hex'), text: t, done: false }));
      return res.json({ ok: true, todos });
    }

    return res.status(504).json({ ok: false, error: 'Timeout waiting for model' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/pm', (req, res) => {
  res.type('text/html; charset=utf-8').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ClawdPM</title>
  <style>
    :root { --bg:#0b0f1a; --card:#11182a; --text:#e7e7e7; --muted: rgba(231,231,231,.70); --border: rgba(231,231,231,.12); --teal:#22c6c6; }
    body{margin:0; font-family: system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background: var(--bg); color: var(--text)}
    .wrap{max-width: 1600px; margin:0 auto; padding: 16px;}
    .top{display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; align-items:baseline}
    .top h1{margin:0; font-size:18px}
    .muted{color:var(--muted)}
    .board{display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-top: 12px; align-items:start}
    .col{border:1px solid var(--border); border-radius:14px; background: rgba(255,255,255,.03); overflow:hidden}
    .colHead{padding:12px 12px; border-bottom:1px solid rgba(255,255,255,.08); display:flex; justify-content:space-between; align-items:center}
    .colHead b{font-size:14px}
    .colActions{display:flex; gap:8px; align-items:center}
    .mini2{border:1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.05); color: rgba(231,231,231,.86); border-radius: 10px; padding:6px 8px; cursor:pointer; font-size:12px}
    .mini2:hover{background: rgba(255,255,255,.08)}
    .addBtn{border:1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.04); color: rgba(231,231,231,.85); border-radius: 999px; padding:6px 10px; cursor:pointer; font-size:12px}
    .addBtn:hover{background: rgba(255,255,255,.07)}

    .cardRow{display:flex; justify-content:space-between; gap:8px; align-items:flex-start}
    .cardBtns{display:flex; gap:6px; align-items:center; opacity:.85}
    .cardBtns button{border:1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.05); color: rgba(231,231,231,.86); border-radius: 10px; padding:4px 6px; cursor:pointer; font-size:12px}
    .cardBtns button:hover{background: rgba(255,255,255,.08)}

    .cards{padding:12px; display:flex; flex-direction:column; gap:10px; min-height: 120px}
    .card{border:1px solid rgba(255,255,255,.12); border-radius:12px; background: rgba(17,24,42,.88); padding:10px; position:relative; overflow:hidden}
    .card::before{content:""; position:absolute; left:0; top:0; bottom:0; width:6px; background: rgba(255,255,255,.08)}
    .pri-ultra::before{background: rgba(34,198,198,.90)}
    .pri-high::before{background: rgba(124,255,178,.85)}
    .pri-normal::before{background: rgba(154,208,255,.85)}
    .pri-planning::before{background: rgba(231,231,231,.30)}

    .card b{display:block}
    .card p{margin:6px 0 0; color: rgba(231,231,231,.78)}
    .badge{display:inline-flex; padding:3px 8px; border-radius:999px; font-size:11px; border:1px solid rgba(255,255,255,.14); color: rgba(231,231,231,.78); margin-top:8px}
    .card{cursor:pointer}
    .card:hover{border-color: rgba(34,198,198,.28)}

    /* Card detail modal */
    .modal{position:fixed; inset:0; z-index:50; display:none; align-items:center; justify-content:center; padding:18px; background:rgba(0,0,0,.65); backdrop-filter: blur(6px);}
    .modal.open{display:flex}
    .box{width:min(920px, 96vw); border:1px solid rgba(255,255,255,.14); border-radius:16px; background:rgba(11,15,26,.96); box-shadow: 0 25px 70px rgba(0,0,0,.55); overflow:hidden}
    .head{display:flex; justify-content:space-between; gap:10px; align-items:flex-start; padding:14px 14px; border-bottom:1px solid rgba(255,255,255,.10)}
    .head b{font-size:16px}
    .close{background:transparent; border:1px solid rgba(255,255,255,.18); color:var(--text); border-radius:12px; padding:8px 10px; cursor:pointer}
    .body{padding:14px}
    .grid{display:grid; grid-template-columns: 1fr 1fr; gap:12px}
    .field label{display:block; font-size:12px; color: var(--muted); margin-bottom:6px}
    .field input,.field textarea,.field select{width:100%; padding:10px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.14); background:#0d1426; color:var(--text); font-size:14px; font-family: inherit}
    .field textarea{min-height:110px; max-height:260px}
    .rowbtn{display:flex; gap:10px; flex-wrap:wrap; align-items:center}
    .pillbtn{border:1px solid rgba(34,198,198,.40); background: rgba(34,198,198,.10); color: rgba(231,231,231,.92); border-radius: 999px; padding:8px 10px; cursor:pointer; font-size:12px}
    .pillbtn:hover{border-color: rgba(34,198,198,.65)}

    .todo{display:grid; grid-template-columns: auto 1fr auto; gap:8px; align-items:center; padding:8px 10px; border:1px solid rgba(255,255,255,.10); border-radius:12px; background: rgba(255,255,255,.03); margin-top:8px}
    .todo input[type=text]{width:100%; padding:8px 10px; border-radius:10px; border:1px solid rgba(255,255,255,0.10); background:#0d1426; color:var(--text)}
    .todoBtns{display:flex; gap:6px}
    .mini{border:1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.05); color: rgba(231,231,231,.86); border-radius: 10px; padding:6px 8px; cursor:pointer; font-size:12px}
    .mini:hover{background: rgba(255,255,255,.08)}

    .btn{border:1px solid rgba(34,198,198,.40); background: rgba(34,198,198,.10); color: rgba(231,231,231,.92); border-radius: 12px; padding:8px 10px; cursor:pointer}
    .btn:hover{border-color: rgba(34,198,198,.65)}
    .small{font-size:12px}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1>ClawdPM</h1>
        <div class="muted small">Cards are task-groups. Click a card to generate + manage to-dos.</div>
      </div>
      <button class="btn" id="pmRefresh" type="button">Refresh</button>
    </div>

    <div class="board" id="pmBoard"></div>
  </div>

  <div class="modal" id="cardModal" role="dialog" aria-modal="true" aria-label="Card details">
    <div class="box">
      <div class="head">
        <div>
          <b id="cm_title">Card</b>
          <div class="muted small" id="cm_sub">Edit details, generate to-dos, and execute.</div>
        </div>
        <button class="close" id="cm_close" type="button">Close</button>
      </div>
      <div class="body">
        <div class="grid">
          <div class="field">
            <label>Title</label>
            <input id="cm_in_title" />
          </div>
          <div class="field">
            <label>Priority</label>
            <select id="cm_in_pri">
              <option value="ultra">ultra (teal)</option>
              <option value="high">high (green)</option>
              <option value="normal">normal (blue)</option>
              <option value="planning">planning (gray)</option>
            </select>
          </div>
          <div class="field" style="grid-column: 1 / span 2;">
            <label>Description</label>
            <textarea id="cm_in_body"></textarea>
          </div>
          <div class="field" style="grid-column: 1 / span 2;">
            <label>Move To</label>
            <select id="cm_move_to"></select>
          </div>
        </div>

        <div class="rowbtn" style="margin-top:12px; justify-content:space-between;">
          <div class="rowbtn">
            <button class="pillbtn" id="cm_generate" type="button">Generate To‑Dos</button>
            <button class="pillbtn" id="cm_addtodo" type="button">+ To‑Do</button>
            <button class="pillbtn" id="cm_moveup" type="button">Move ↑</button>
            <button class="pillbtn" id="cm_movedn" type="button">Move ↓</button>
          </div>
          <button class="pillbtn" id="cm_save" type="button">Save</button>
        </div>

        <div style="margin-top:12px;" class="muted small">To‑Dos</div>
        <div id="cm_todos"></div>
        <div class="muted small" id="cm_msg" style="margin-top:10px;"></div>
      </div>
    </div>
  </div>

  <script>
    const esc = (s) => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const rand = () => (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : ('c_' + Math.random().toString(16).slice(2) + Date.now().toString(16));

    let PM = null;
    let ACTIVE = null; // { colId, cardId }

    function priClass(p){
      const v = String(p||'planning').toLowerCase();
      if (v === 'ultra') return 'pri-ultra';
      if (v === 'high') return 'pri-high';
      if (v === 'normal') return 'pri-normal';
      return 'pri-planning';
    }

    function findCard(){
      if (!ACTIVE || !PM) return null;
      const col = (PM.columns || []).find(c => c && c.id === ACTIVE.colId);
      if (!col) return null;
      const card = (col.cards || []).find(c => c && c.id === ACTIVE.cardId);
      if (!card) return null;
      return { col, card };
    }

    const $ = (id) => document.getElementById(id);
    const modal = $('cardModal');
    const cmClose = $('cm_close');
    const cmSave = $('cm_save');
    const cmGen = $('cm_generate');
    const cmAdd = $('cm_addtodo');
    const cmTodos = $('cm_todos');
    const cmMsg = $('cm_msg');
    const cmMoveTo = $('cm_move_to');
    const cmMoveUp = $('cm_moveup');
    const cmMoveDn = $('cm_movedn');

    function fillMoveTo(){
      if (!cmMoveTo) return;
      cmMoveTo.innerHTML = '';
      const cols = (PM && PM.columns) ? PM.columns : [];
      for (const c of cols){
        if (!c || !c.id) continue;
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.title || c.id;
        cmMoveTo.appendChild(opt);
      }
      if (ACTIVE && ACTIVE.colId) cmMoveTo.value = ACTIVE.colId;
    }

    function openModal(colId, cardId){
      ACTIVE = { colId, cardId };
      const fc = findCard();
      if (!fc) return;
      const card = fc.card;

      $('cm_title').textContent = card.title || 'Card';
      $('cm_in_title').value = card.title || '';
      $('cm_in_body').value = card.body || '';
      $('cm_in_pri').value = String(card.priority || 'normal');

      fillMoveTo();
      renderTodos();
      if (cmMsg) cmMsg.textContent = '';
      if (modal) modal.classList.add('open');
    }

    function closeModal(){
      if (modal) modal.classList.remove('open');
      ACTIVE = null;
    }

    function ensureTodos(card){
      if (!Array.isArray(card.todos)) card.todos = [];
      // migrate old shape if any
      card.todos = card.todos.map(t => ({
        id: t.id || rand(),
        text: String(t.text || '').trim(),
        done: !!t.done
      })).filter(t => t.text);
    }

    function renderTodos(){
      if (!cmTodos) return;
      const fc = findCard();
      if (!fc) { cmTodos.innerHTML = ''; return; }
      const card = fc.card;
      ensureTodos(card);

      cmTodos.innerHTML = '';
      card.todos.forEach((t, i) => {
        const row = document.createElement('div');
        row.className = 'todo';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!t.done;
        cb.addEventListener('change', () => { t.done = cb.checked; });

        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = t.text;
        inp.addEventListener('input', () => { t.text = inp.value; });

        const btns = document.createElement('div');
        btns.className = 'todoBtns';

        const up = document.createElement('button');
        up.className = 'mini';
        up.type = 'button';
        up.textContent = '↑';
        up.title = 'Move up';
        up.addEventListener('click', () => {
          if (i <= 0) return;
          const tmp = card.todos[i-1];
          card.todos[i-1] = card.todos[i];
          card.todos[i] = tmp;
          renderTodos();
        });

        const dn = document.createElement('button');
        dn.className = 'mini';
        dn.type = 'button';
        dn.textContent = '↓';
        dn.title = 'Move down';
        dn.addEventListener('click', () => {
          if (i >= card.todos.length - 1) return;
          const tmp = card.todos[i+1];
          card.todos[i+1] = card.todos[i];
          card.todos[i] = tmp;
          renderTodos();
        });

        const del = document.createElement('button');
        del.className = 'mini';
        del.type = 'button';
        del.textContent = '✕';
        del.title = 'Delete';
        del.addEventListener('click', () => {
          card.todos.splice(i, 1);
          renderTodos();
        });

        btns.appendChild(up);
        btns.appendChild(dn);
        btns.appendChild(del);

        row.appendChild(cb);
        row.appendChild(inp);
        row.appendChild(btns);
        cmTodos.appendChild(row);
      });

      if (!card.todos.length) {
        cmTodos.innerHTML = '<div class="muted small" style="margin-top:8px;">No to-dos yet. Click Generate To‑Dos or + To‑Do.</div>';
      }
    }

    async function persist(){
      await save();
      await load();
    }

    async function saveCardEdits(){
      const fc = findCard();
      if (!fc) return;
      const card = fc.card;

      // handle move-to column before editing fields
      const destColId = cmMoveTo ? cmMoveTo.value : (ACTIVE && ACTIVE.colId);
      if (destColId && ACTIVE && destColId !== ACTIVE.colId) {
        const fromCol = (PM.columns || []).find(c => c && c.id === ACTIVE.colId);
        const toCol = (PM.columns || []).find(c => c && c.id === destColId);
        if (fromCol && toCol) {
          fromCol.cards = Array.isArray(fromCol.cards) ? fromCol.cards : [];
          toCol.cards = Array.isArray(toCol.cards) ? toCol.cards : [];
          const idx = fromCol.cards.findIndex(x => x && x.id === ACTIVE.cardId);
          if (idx >= 0) {
            const moved = fromCol.cards.splice(idx, 1)[0];
            toCol.cards.push(moved);
            ACTIVE.colId = destColId;
          }
        }
      }

      const fc2 = findCard();
      if (!fc2) return;
      const card2 = fc2.card;
      card2.title = $('cm_in_title').value.trim();
      card2.body = $('cm_in_body').value.trim();
      card2.priority = $('cm_in_pri').value;
      ensureTodos(card2);
      // prune blank todos
      card2.todos = card2.todos.filter(t => String(t.text||'').trim());
      if (cmMsg) cmMsg.textContent = 'Saving…';
      await persist();
      if (cmMsg) cmMsg.textContent = 'Saved.';
      setTimeout(() => { if (cmMsg) cmMsg.textContent = ''; }, 900);
    }

    async function addTodo(){
      const fc = findCard();
      if (!fc) return;
      const card = fc.card;
      ensureTodos(card);
      card.todos.push({ id: rand(), text: 'New todo', done: false });
      renderTodos();
    }

    async function generateTodos(){
      const fc = findCard();
      if (!fc) return;
      const card = fc.card;
      if (cmMsg) cmMsg.textContent = 'Generating…';
      try {
        const res = await fetch('/api/pm/generate-todos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ title: $('cm_in_title').value.trim() || card.title, body: $('cm_in_body').value.trim() || card.body })
        });
        const j = await res.json();
        if (!res.ok || !j || !j.ok) throw new Error((j && j.error) ? j.error : ('http ' + res.status));
        const todos = Array.isArray(j.todos) ? j.todos : [];
        ensureTodos(card);
        // append generated items as new todos
        for (const t of todos){
          if (!t || !t.text) continue;
          card.todos.push({ id: rand(), text: String(t.text).trim(), done: false });
        }
        // de-dupe by text
        const seen = new Set();
        card.todos = card.todos.filter(t => {
          const k = String(t.text||'').trim().toLowerCase();
          if (!k) return false;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        renderTodos();
        if (cmMsg) cmMsg.textContent = 'Generated.';
      } catch (e) {
        if (cmMsg) cmMsg.textContent = 'Generate failed: ' + String(e);
      }
    }

    if (cmClose) cmClose.addEventListener('click', closeModal);
    if (modal) modal.addEventListener('click', (e) => { if (e.target && e.target.id === 'cardModal') closeModal(); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
    async function moveCard(dir){
      const fc = findCard();
      if (!fc) return;
      const col = fc.col;
      col.cards = Array.isArray(col.cards) ? col.cards : [];
      const i = col.cards.findIndex(x => x && x.id === ACTIVE.cardId);
      if (i < 0) return;
      const j = i + dir;
      if (j < 0 || j >= col.cards.length) return;
      const tmp = col.cards[j];
      col.cards[j] = col.cards[i];
      col.cards[i] = tmp;
      await persist();
      // keep modal open + todo render
      fillMoveTo();
      renderTodos();
    }

    if (cmSave) cmSave.addEventListener('click', saveCardEdits);
    if (cmAdd) cmAdd.addEventListener('click', addTodo);
    if (cmGen) cmGen.addEventListener('click', generateTodos);
    if (cmMoveUp) cmMoveUp.addEventListener('click', () => moveCard(-1));
    if (cmMoveDn) cmMoveDn.addEventListener('click', () => moveCard(+1));

    function priClass(p){
      const v = String(p||'planning').toLowerCase();
      if (v === 'ultra') return 'pri-ultra';
      if (v === 'high') return 'pri-high';
      if (v === 'normal') return 'pri-normal';
      return 'pri-planning';
    }

    async function save(){
      await fetch('/api/pm', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        body: JSON.stringify({ pm: PM })
      });
    }

    async function addCard(colId){
      const title = (prompt('Card title') || '').trim();
      if (!title) return;
      const body = (prompt('Description (optional)') || '').trim();
      const p = (prompt('Priority: ultra / high / normal / planning', 'normal') || 'normal').trim().toLowerCase();
      const priority = (['ultra','high','normal','planning'].includes(p)) ? p : 'normal';

      const col = (PM && PM.columns || []).find(c => c && c.id === colId);
      if (!col) return;
      col.cards = Array.isArray(col.cards) ? col.cards : [];
      col.cards.push({ id: rand(), title, body, priority, createdAt: new Date().toISOString() });
      await save();
      render();
    }

    function render(){
      const pm = PM || { columns: [] };
      const host = document.getElementById('pmBoard');
      host.innerHTML = '';
      for (const col of (pm.columns || [])){
        const el = document.createElement('div');
        el.className = 'col';

        const cardsHtml = (col.cards || []).map((c, idx) => {
          const pc = priClass(c.priority);
          const badge = '<span class="badge">' + esc(String(c.priority || 'planning')) + '</span>';
          const btns = '<div class="cardBtns">'
            + '<button type="button" data-cup="' + esc(col.id) + '" data-cid="' + esc(c.id) + '" title="Move up">↑</button>'
            + '<button type="button" data-cdn="' + esc(col.id) + '" data-cid="' + esc(c.id) + '" title="Move down">↓</button>'
            + '</div>';
          return '<div class="card ' + pc + '" data-card-id="' + esc(c.id) + '" data-col-id="' + esc(col.id) + '">'
            + '<div class="cardRow">'
            +   '<b>' + esc(c.title) + '</b>'
            +   btns
            + '</div>'
            + (c.body ? ('<p>' + esc(c.body) + '</p>') : '')
            + badge
            + '</div>';
        }).join('');

        el.innerHTML = ''
          + '<div class="colHead">'
          +   '<b>' + esc(col.title) + '</b>'
          +   '<div class="colActions">'
          +     '<button class="mini2" type="button" data-col-left="' + esc(col.id) + '" title="Move column left">◀</button>'
          +     '<button class="mini2" type="button" data-col-right="' + esc(col.id) + '" title="Move column right">▶</button>'
          +     '<button class="mini2" type="button" data-col-rename="' + esc(col.id) + '" title="Rename column">✎</button>'
          +     '<span class="muted small">' + (col.cards || []).length + '</span>'
          +     '<button class="addBtn" type="button" data-add="' + esc(col.id) + '">+ Card</button>'
          +   '</div>'
          + '</div>'
          + '<div class="cards">' + cardsHtml + '</div>';

        host.appendChild(el);
      }

      function moveColumn(colId, dir){
        const cols = (PM && PM.columns) ? PM.columns : [];
        const i = cols.findIndex(c => c && c.id === colId);
        if (i < 0) return;
        const j = i + dir;
        if (j < 0 || j >= cols.length) return;
        const tmp = cols[j];
        cols[j] = cols[i];
        cols[i] = tmp;
        save().then(render);
      }

      function renameColumn(colId){
        const cols = (PM && PM.columns) ? PM.columns : [];
        const col = cols.find(c => c && c.id === colId);
        if (!col) return;
        const t = (prompt('Rename column', col.title || '') || '').trim();
        if (!t) return;
        col.title = t;
        save().then(render);
      }

      async function moveCardInline(colId, cardId, dir){
        const col = (PM && PM.columns || []).find(c => c && c.id === colId);
        if (!col) return;
        col.cards = Array.isArray(col.cards) ? col.cards : [];
        const i = col.cards.findIndex(c => c && c.id === cardId);
        if (i < 0) return;
        const j = i + dir;
        if (j < 0 || j >= col.cards.length) return;
        const tmp = col.cards[j];
        col.cards[j] = col.cards[i];
        col.cards[i] = tmp;
        await save();
        render();
      }

      Array.from(document.querySelectorAll('button[data-add]')).forEach(b => {
        b.addEventListener('click', () => addCard(b.getAttribute('data-add')));
      });

      Array.from(document.querySelectorAll('button[data-col-left]')).forEach(b => {
        b.addEventListener('click', () => moveColumn(b.getAttribute('data-col-left'), -1));
      });
      Array.from(document.querySelectorAll('button[data-col-right]')).forEach(b => {
        b.addEventListener('click', () => moveColumn(b.getAttribute('data-col-right'), +1));
      });
      Array.from(document.querySelectorAll('button[data-col-rename]')).forEach(b => {
        b.addEventListener('click', () => renameColumn(b.getAttribute('data-col-rename')));
      });

      Array.from(document.querySelectorAll('button[data-cup]')).forEach(b => {
        b.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          moveCardInline(b.getAttribute('data-cup'), b.getAttribute('data-cid'), -1);
        });
      });
      Array.from(document.querySelectorAll('button[data-cdn]')).forEach(b => {
        b.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          moveCardInline(b.getAttribute('data-cdn'), b.getAttribute('data-cid'), +1);
        });
      });

      Array.from(document.querySelectorAll('.card[data-card-id]')).forEach(c => {
        c.addEventListener('click', () => {
          openModal(c.getAttribute('data-col-id'), c.getAttribute('data-card-id'));
        });
      });
    }

    async function load(){
      const host = document.getElementById('pmBoard');
      try {
        const res = await fetch('/api/pm', { credentials:'include', cache:'no-store' });
        if (!res.ok) {
          host.innerHTML = '<div class="muted">Could not load board (' + res.status + '). If you just logged in, hard refresh.</div>';
          return;
        }
        const j = await res.json();
        PM = (j && j.ok && j.pm) ? j.pm : { columns: [] };
        render();
      } catch (e) {
        host.innerHTML = '<div class="muted">Failed to load board. Hard refresh.</div>';
      }
    }

    document.getElementById('pmRefresh').addEventListener('click', load);
    load();
  </script>
</body>
</html>`);
});

app.get('/publish', (req, res) => {
  res.type('text/html; charset=utf-8').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Console Publish</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background: #0b1020; color: #e8eefc; margin: 0; }
    a { color: #9ad0ff; }
    .wrap { max-width: 1000px; margin: 0 auto; padding: 18px; }
    .card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.10); border-radius: 14px; padding: 14px; }
    .muted { color: rgba(255,255,255,0.65); font-size: 12px; }
    li { margin: 6px 0; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div style="font-weight:800; font-size:18px;">Console Publish</div>
      <div class="muted">Build: 2026-02-28.1</div>
      <p style="margin-top:12px; line-height:1.5;">This page tracks the plan for publishing <b>Clawd Console</b> open source and where we might distribute it.</p>

      <div style="margin-top:12px;">
        <div style="font-weight:700;">Targets (candidates)</div>
        <ul>
          <li><b>GitHub</b> (primary repo)</li>
          <li>GitLab / Codeberg (mirrors)</li>
          <li>Package: npm (if we extract as a package)</li>
          <li>Container: GHCR / Docker Hub (if we containerize)</li>
          <li>Docs: GitHub Pages (simple) or MkDocs/Docusaurus</li>
        </ul>
      </div>

      <div style="margin-top:12px;">
        <div style="font-weight:700;">Open questions</div>
        <ul>
          <li>Repo layout: what stays in Clawdbot vs what lives in the Clawd Console project?</li>
          <li>License (MIT/Apache-2.0/etc.)</li>
          <li>Install story: single script? docker-compose? systemd unit?</li>
        </ul>
      </div>

      <div class="muted" style="margin-top:12px;">Note: This started as a scaffold; updated with a quick scan of Clawdbot-specific UIs and how Clawd Console might fit.</div>

      <div style="margin-top:16px; font-weight:700;">Current UIs in the Space</div>
      <div class="muted" style="margin-top:4px;">Not exhaustive — these are the Clawdbot-native surfaces I could confirm quickly.</div>
      <div style="display:flex; gap: 12px; flex-wrap: wrap; margin-top: 10px;">
        <div class="card" style="flex:1; min-width: 260px;">
          <div style="font-weight:800;">Control UI</div>
          <div class="muted" style="margin-top:6px;">Browser SPA served by the Gateway (dashboard + chat + sessions + cron + logs).</div>
          <div style="margin-top:10px;">
            <a href="https://docs.clawd.bot/web/control-ui" target="_blank" rel="noopener">Docs</a>
            <span class="muted"> • </span>
            <a href="https://github.com/clawdbot/clawdbot" target="_blank" rel="noopener">Repo</a>
          </div>
        </div>

        <div class="card" style="flex:1; min-width: 260px;">
          <div style="font-weight:800;">WebChat</div>
          <div class="muted" style="margin-top:6px;">Native chat UI(s) that talk directly to the Gateway WebSocket (same sessions/routing).</div>
          <div style="margin-top:10px;">
            <a href="https://docs.clawd.bot/web/webchat" target="_blank" rel="noopener">Docs</a>
          </div>
        </div>

        <div class="card" style="flex:1; min-width: 260px;">
          <div style="font-weight:800;">Canvas Host</div>
          <div class="muted" style="margin-top:6px;">A UI surface for node/agent canvases (rendered UI, A2UI, etc.).</div>
          <div style="margin-top:10px;">
            <a href="https://docs.clawd.bot/gateway/index" target="_blank" rel="noopener">Docs</a>
          </div>
        </div>
      </div>

      <div style="margin-top:16px;">
        <div style="font-weight:800;">Where Clawd Console fits</div>
        <div style="margin-top:8px; line-height:1.6; font-size: 14px; color: rgba(255,255,255,0.82);">
          Clawdbot has solid general-purpose UIs (Control UI/WebChat), but nothing that’s obviously optimized for operator workflows like: persistent transcript indexing + action buttons, DEL checklists, scheduled reporting, and filterable worklogs. Clawd Console looks positioned as a <b>power-user cockpit</b> that complements the Control UI rather than replacing it.
        </div>
      </div>

      <div style="margin-top:16px;">
        <div style="font-weight:800;">What we need to ship v1 ("alladat")</div>
        <div class="muted" style="margin-top:6px;">A practical checklist to make this installable, testable, and friendly for other Clawdbot users.</div>

        <div style="margin-top:10px; display:flex; flex-direction:column; gap: 10px;">
          <div>
            <div style="font-weight:700;">1) Package boundaries</div>
            <div class="muted" style="margin-top:4px;">Decide what is the product: a standalone "Clawd Console" service, a Clawdbot plugin, or a skill + static UI bundle. Right now it’s a standalone Express service that talks to the Gateway WS.</div>
          </div>

          <div>
            <div style="font-weight:700;">2) Install story (one command)</div>
            <div class="muted" style="margin-top:4px;">Provide: repo + README + env vars + systemd unit template (or docker-compose). Goal: someone can go from zero → running UI in ~5 minutes.</div>
          </div>

          <div>
            <div style="font-weight:700;">3) Config + secrets</div>
            <div class="muted" style="margin-top:4px;">Document required env vars (AUTH_USER/AUTH_PASS, PORT, DATA_DIR, gateway URL/token strategy). Avoid reading gateway token from /root/.clawdbot by default (or make it explicitly optional).</div>
          </div>

          <div>
            <div style="font-weight:700;">4) Versioning + compatibility</div>
            <div class="muted" style="margin-top:4px;">Tie releases to Clawdbot Gateway protocol expectations (we pin protocol=3). Include a compatibility note for minimum Clawdbot version.</div>
          </div>

          <div>
            <div style="font-weight:700;">5) Test the package the right way</div>
            <div class="muted" style="margin-top:4px;">When we call it v1: spin up a second fresh Clawdbot instance (VM/Docker/new user) and install Clawd Console using only the README. No manual tweaks. If it works, it’s real.</div>
          </div>

          <div>
            <div style="font-weight:700;">6) UX defaults</div>
            <div class="muted" style="margin-top:4px;">Make sane defaults: transcript retention, DEL behavior, scheduled module behavior. Add a small Settings panel later if needed.</div>
          </div>

          <div>
            <div style="font-weight:700;">7) License + contribution</div>
            <div class="muted" style="margin-top:4px;">Pick a license (MIT/Apache-2.0), add CONTRIBUTING, and decide whether this is Charles-specific or generic enough for public.</div>
          </div>
        </div>
      </div>

      <div style="margin-top:12px;"><a href="/" rel="noopener">← Back to Console</a></div>
    </div>
  </div>
</body>
</html>`);
});

function makeMsg({ text, attachments }) {
  return {
    id: `msg_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`,
    ts: new Date().toISOString(),
    text: typeof text === 'string' ? text : '',
    attachments: Array.isArray(attachments) ? attachments : [],
  };
}

function logWork(event, data) {
  const entry = {
    id: 'wl_' + Math.random().toString(16).slice(2) + Date.now().toString(16),
    ts: new Date().toISOString(),
    event,
    data: data || null,
  };
  appendJsonl(WORK_FILE, entry);
  broadcast({ type: 'worklog', entry });
  return entry;
}

// --- Agent bridge (Gateway chat.send) ---
let gw = {
  ws: null,
  connected: false,
  connectNonce: null,
  inflight: new Map(), // runId -> { consoleMsgId }
};

// Persisted run status so UI "thinking" survives reloads.
const RUN_FILE = path.join(DATA_DIR, 'run-state.json');
let runState = { inFlight: false, updatedAt: null };
try {
  if (fs.existsSync(RUN_FILE)) runState = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8')) || runState;
} catch {}
function setInFlight(v) {
  runState.inFlight = !!v;
  runState.updatedAt = new Date().toISOString();
  try { fs.writeFileSync(RUN_FILE, JSON.stringify(runState), 'utf8'); } catch {}
  broadcast({ type: 'run', state: runState });
}

function extractTextFromGatewayMessage(message) {
  try {
    const parts = message?.content;
    if (!Array.isArray(parts)) return '';
    let text = parts
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');

    // Strip reply tags meant for other chat surfaces.
    text = text.replace(/\[\[\s*reply_to[^\]]*\]\]/gi, '');
    text = text.replace(/\[\[\s*reply_to_current\s*\]\]/gi, '');

    return text.trim();
  } catch {
    return '';
  }
}

function consoleBotSay(text) {
  const msg = {
    id: 'bot_' + Date.now().toString(16) + crypto.randomBytes(3).toString('hex'),
    ts: new Date().toISOString(),
    text: String(text || ''),
    attachments: [],
  };
  appendJsonl(MSG_FILE, msg);
  appendTranscriptLine('assistant', msg);

  // Best-effort auto-checkoff: if there is an active DEL and the assistant mentions an item, mark it done.
  const state = loadDEState();
  const de = currentDE(state);
  if (de && Array.isArray(de.items) && !de.completed) {
    const lower = msg.text.toLowerCase();
    let changed = false;

    // If the assistant includes explicit DEL checkboxes, honor them.
    // Format:
    // DEL UPDATE:
    // [x] item text
    // [ ] item text
    const lines = msg.text.split(/\r?\n/);
    const delLines = lines.map(l => l.trim()).filter(l => /^\[(x| )\]/i.test(l));
    if (delLines.length) {
      for (const dl of delLines) {
        const m = dl.match(/^\[(x| )\]\s+(.*)$/i);
        if (!m) continue;
        const mark = m[1].toLowerCase() === 'x';
        const txt = (m[2] || '').trim().toLowerCase();
        if (!txt) continue;
        const it = de.items.find(it => String(it.text||'').toLowerCase() === txt);
        if (it && it.done !== mark) { it.done = mark; changed = true; }
      }
    } else {
      // fallback fuzzy match
      for (const it of de.items) {
        if (it.done) continue;
        const needle = String(it.text || '').toLowerCase();
        if (needle && lower.includes(needle.slice(0, Math.min(needle.length, 40)))) {
          it.done = true;
          changed = true;
        }
      }
    }

    if (changed) {
      de.updatedAt = msg.ts;
      de.completed = de.items.every(x => x.done);
      saveDEState(state);
      broadcast({ type: 'de_state', state, active: currentDE(state) });
    }
  }

  broadcast({ type: 'message', message: msg });
  return msg;
}

gw.pending = new Map(); // id -> {resolve,reject,method}

function gwSendReq(method, params) {
  if (!gw.ws || gw.ws.readyState !== WebSocket.OPEN) throw new Error('gateway ws not connected');
  const id = crypto.randomUUID();
  gw.ws.send(JSON.stringify({ type: 'req', id, method, params }));
  return new Promise((resolve, reject) => {
    gw.pending.set(id, { resolve, reject, method, ts: Date.now() });
    setTimeout(() => {
      const p = gw.pending.get(id);
      if (!p) return;
      gw.pending.delete(id);
      reject(new Error('gateway timeout: ' + method));
    }, 60_000);
  });
}

function connectGateway() {
  const token = process.env.GATEWAY_TOKEN || loadGatewayToken();
  if (!token) {
    logWork('gateway.token.missing', {});
    return;
  }

  const url = GATEWAY_WS_URL.replace(/^http/, 'ws');
  logWork('gateway.connecting', { url });

  const ws = new WebSocket(url);
  gw.ws = ws;
  gw.connected = false;
  gw.connectNonce = null;

  ws.on('open', () => {
    // wait for connect.challenge event
  });

  ws.on('message', (data) => {
    const msg = safeJsonParse(data.toString('utf8'));
    if (!msg) return;

    if (msg.type === 'res' && typeof msg.id === 'string') {
      const p = gw.pending.get(msg.id);
      if (p) {
        gw.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.payload);
        else p.reject(new Error(msg.error?.message || 'gateway error'));
      }
      // continue processing below for connect
    }

    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      gw.connectNonce = msg.payload?.nonce || null;
      try {
        // Connect handshake (ignore response promise)
        void gwSendReq('connect', {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: 'gateway-client',
            version: 'claw-console-bridge',
            platform: 'linux',
            mode: 'webchat',
            displayName: 'Clawd Console Bridge',
          },
          role: 'operator',
          auth: { token },
          // no device (token auth is allowed)
        });
      } catch (e) {
        logWork('gateway.connect.error', { error: String(e) });
      }
      return;
    }

    if (msg.type === 'res' && msg.ok === true && msg.payload && msg.payload.type === 'hello-ok') {
      gw.connected = true;
      logWork('gateway.connected', { host: msg.payload?.server?.host, protocol: msg.payload?.protocol });
      return;
    }

    // chat events
    if (msg.type === 'event' && msg.event === 'chat') {
      const p = msg.payload;
      if (!p || p.state !== 'final' || !p.message) return;
      if (p.sessionKey !== CONSOLE_SESSION_KEY) return;
      if (p.message.role !== 'assistant') return;

      const text = extractTextFromGatewayMessage(p.message);
      if (text) {
        consoleBotSay(text);
        logWork('gateway.reply.posted', { sessionKey: p.sessionKey, runId: p.runId });
      }
      // Final assistant message arrived via events; clear thinking.
      setInFlight(false);
      return;
    }
  });

  ws.on('close', () => {
    const was = gw.connected;
    gw.connected = false;
    logWork('gateway.disconnected', { wasConnected: was });
    setTimeout(connectGateway, 1500);
  });

  ws.on('error', (e) => {
    logWork('gateway.ws.error', { error: String(e) });
  });
}

function acceptMessage({ text, attachments }) {
  const msg = makeMsg({ text, attachments });
  appendJsonl(MSG_FILE, msg);

  // Dynamic Execution List extraction: if user message contains a 3+ item list.
  const items = extractChecklist(msg.text);
  if (items) {
    const state = loadDEState();
    const de = {
      id: 'de_' + Date.now().toString(16),
      createdAt: msg.ts,
      updatedAt: msg.ts,
      sourceMsgId: msg.id,
      completed: false,
      items: items.map((t) => ({ text: t, done: false }))
    };
    state.lists.push(de);
    state.activeIndex = state.lists.length - 1;
    saveDEState(state);
    broadcast({ type: 'de_state', state, active: de });
    appendTranscriptLine('user', msg, { de: de.id, d: de.items.map(it => ({ t: it.text, d: it.done ? 1 : 0 })) });
  } else {
    appendTranscriptLine('user', msg);
  }

  broadcast({ type: 'message', message: msg });
  logWork('message.saved', { id: msg.id, hasText: !!msg.text, attachments: msg.attachments.length });

  // If this is a user message (not bot), forward to Clawdbot Gateway chat.send
  if (!msg.id.startsWith('bot_') && gw.connected) {
    (async () => {
      try {
        const attachmentLinks = (msg.attachments || []).map(a => a.url).filter(Boolean);
        const suffix = attachmentLinks.length ? ('\n\nAttachments:\n' + attachmentLinks.join('\n')) : '';
        const runId = msg.id; // reuse for idempotency

        setInFlight(true);
        await gwSendReq('chat.send', {
          sessionKey: CONSOLE_SESSION_KEY,
          idempotencyKey: runId,
          message: (msg.text || '') + suffix,
          deliver: false,
        });

        logWork('gateway.chat.send', { runId, sessionKey: CONSOLE_SESSION_KEY });

        // Poll chat.history for the assistant reply
        const startedAt = Date.now();
        let lastTxt = '';
        while (Date.now() - startedAt < 90_000) {
          await new Promise(r => setTimeout(r, 900));
          const payload = await gwSendReq('chat.history', { sessionKey: CONSOLE_SESSION_KEY, limit: 50 });
          const messages = payload?.messages;
          if (!Array.isArray(messages)) continue;
          const assistants = messages
            .map(m => (m && m.message) ? m.message : m)
            .filter(m => m && m.role === 'assistant');
          const latest = assistants[assistants.length - 1];
          const txt = extractTextFromGatewayMessage(latest);
          if (txt && txt !== lastTxt) {
            lastTxt = txt;
            consoleBotSay(txt);
            logWork('gateway.reply.posted', { sessionKey: CONSOLE_SESSION_KEY, runId });
            setInFlight(false);
            return;
          }
        }
        logWork('gateway.reply.timeout', { runId });
        setInFlight(false);
      } catch (e) {
        logWork('gateway.chat.send.error', { error: String(e) });
        setInFlight(false);
      }
    })();
  } else if (!gw.connected) {
    logWork('gateway.not_connected', {});
  }

  return msg;
}

app.post('/api/message', (req, res) => {
  const { text, attachments } = req.body || {};
  if (typeof text !== 'string' && !Array.isArray(attachments)) {
    return res.status(400).json({ ok: false, error: 'Expected {text, attachments}' });
  }
  const msg = acceptMessage({ text, attachments });
  res.json({ ok: true, message: msg });
});

app.post('/api/abort', async (req, res) => {
  try {
    if (!gw.connected) return res.status(409).json({ ok: false, error: 'Gateway not connected' });
    await gwSendReq('chat.abort', { sessionKey: CONSOLE_SESSION_KEY });
    logWork('gateway.chat.abort', { sessionKey: CONSOLE_SESSION_KEY });
    setInFlight(false);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

app.use('/uploads', express.static(UPLOAD_DIR, {
  // Must be false or an array of strings; true triggers a serve-static/send type error.
  // Also: don't serve directory indexes for uploads.
  index: false,
  fallthrough: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store');
  }
}));

app.use('/static', express.static(path.join(__dirname, 'static'), {
  index: false,
  fallthrough: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store');
  }
}));

app.get('/', (req, res) => {
  // Avoid stale caching while we're iterating fast.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <base href="/" />
  <title>Clawd Console</title>
  <meta http-equiv="Cache-Control" content="no-store" />
  <meta http-equiv="Pragma" content="no-cache" />
  <meta name="claw-build" content="${BUILD}" />
  <style>
    :root {
      --bg: #0b0f1a;
      --card: #11182a;
      --card2: #0f1526;
      --text: #e7e7e7;
      --muted: rgba(231,231,231,0.7);
      --border: rgba(231,231,231,0.12);
      --accent: #9ad0ff;
    }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 18px; line-height: 1.35; background: var(--bg); color: var(--text); }

    /* darker scrollbars */
    * { scrollbar-color: rgba(154,208,255,0.35) rgba(255,255,255,0.06); }
    *::-webkit-scrollbar { width: 12px; height: 12px; }
    *::-webkit-scrollbar-track { background: rgba(255,255,255,0.06); border-radius: 999px; }
    *::-webkit-scrollbar-thumb { background: rgba(154,208,255,0.30); border-radius: 999px; border: 2px solid rgba(0,0,0,0.25); }
    *::-webkit-scrollbar-thumb:hover { background: rgba(154,208,255,0.42); }
    a { color: var(--accent); }

    .scriptBtn{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      gap:10px;
      padding:8px 10px;
      border-radius:12px;
      border:1px solid rgba(34,198,198,.40);
      background: linear-gradient(180deg, rgba(34,198,198,.18), rgba(34,198,198,.08));
      color: rgba(231,231,231,.92);
      font-size:12px;
      font-weight:750;
      text-decoration:none;
      white-space:nowrap;
    }
    .scriptBtn:hover{
      border-color: rgba(34,198,198,.70);
      background: linear-gradient(180deg, rgba(34,198,198,.26), rgba(34,198,198,.10));
      text-decoration:none;
    }

    /* layout */
    .wrap { display: grid; grid-template-columns: 300px 1.25fr 0.75fr; gap: 14px; max-width: 1920px; }
    .sidebar { position: sticky; top: 18px; align-self: start; }
    .main { min-width: 0; }
    .right { min-width: 0; }

    /* responsive: drop right column under main on smaller screens */
    @media (max-width: 1180px) {
      .wrap { grid-template-columns: 280px 1fr; }
      .right { grid-column: 2 / span 1; }
    }
    @media (max-width: 900px) {
      .wrap { grid-template-columns: 1fr; }
      .sidebar { position: static; }
      .right { grid-column: auto; }
    }

    .card { border: 1px solid var(--border); border-radius: 12px; padding: 14px; background: var(--card); box-shadow: 0 10px 25px rgba(0,0,0,0.25); }
    .muted { color: var(--muted); font-size: 13px; }
    .row { display:flex; gap: 10px; align-items:center; flex-wrap: wrap; }
    button { padding: 9px 12px; border-radius: 10px; border: 1px solid var(--border); background: #1a2744; color: var(--text); cursor: pointer; }
    button:hover { background: #22335a; }
    .qbtn{padding:7px 10px; border-radius: 999px; border:1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.04); color: rgba(231,231,231,0.86); font-size:12px; cursor:pointer}
    .qbtn:hover{background: rgba(255,255,255,0.08)}

    /* lightweight modal (reuses .cc_modal markup) */
    .cc_modal{position:fixed; inset:0; z-index:80; display:none; align-items:center; justify-content:center; padding:18px; background:rgba(0,0,0,.65); backdrop-filter: blur(6px);}
    .cc_modal.open{display:flex}
    .cc_box{border:1px solid rgba(255,255,255,.14); border-radius:16px; background:rgba(11,15,26,.94); box-shadow: 0 25px 70px rgba(0,0,0,.55); overflow:hidden}
    .cc_right{padding:16px}
    .cc_head{display:flex; align-items:flex-start; justify-content:space-between; gap:10px}
    .cc_close{background:transparent; border:1px solid rgba(255,255,255,.18); color:var(--text); border-radius:12px; padding:8px 10px; cursor:pointer}
    .cc_form{margin-top:12px; display:grid; gap:10px}
    .cc_form input{width:100%; padding:10px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.14); background:#0d1426; color:var(--text)}
    .cc_row{display:flex; gap:10px; flex-wrap:wrap; align-items:center}
    .cc_msg{font-size:12px; color:rgba(231,231,231,0.72)}

    .wlbtn { padding: 4px 8px; border-radius: 999px; background: rgba(255,255,255,0.04); font-size: 12px; }
    .wlbtn:hover { background: rgba(255,255,255,0.08); }
    .wlbtn.in { border-color: rgba(154,208,255,0.55); background: rgba(154,208,255,0.10); }
    .wlbtn.out { border-color: rgba(255,160,80,0.55); background: rgba(255,160,80,0.10); }

    #plan { height: 44px; white-space: nowrap; background: #1a2744; }
    #send { height: 44px; white-space: nowrap; background: #19783d; border-color: rgba(255,255,255,0.18); }
    #send:hover { background: #1e8a46; }

    /* Thinking + DEL status colors */
    .pill.is-thinking { background: #c26a1a; color: #fff; border-color: rgba(255,255,255,0.22); }
    .pill.de-active { background: #118a8a; color: #fff; border-color: rgba(255,255,255,0.22); }
    input[type=file] { display:block; margin: 10px 0; }

    /* chat */
    #chatlog { background: var(--card2); color: var(--text); border: 1px solid var(--border); border-radius: 12px; padding: 12px; height: 520px; overflow:auto; }
    .msg { padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.08); }
    .meta { font-size: 12px; color: rgba(255,255,255,0.65); display:flex; justify-content: space-between; gap: 12px; align-items: baseline; }
    .name-user { color: #22c6c6; font-weight: 700; }
    .name-agent { color: #b46cff; font-weight: 700; }
    .txt { margin-top: 6px; white-space: pre-wrap; }
    .att { margin-top: 8px; display:flex; gap: 10px; flex-wrap: wrap; }
    .chip { display:inline-flex; gap: 8px; align-items:center; border:1px solid rgba(255,255,255,0.18); border-radius: 999px; padding: 4px 10px; font-size: 12px; }
    .chip a { color: var(--accent); text-decoration: none; }

    /* Markdown-lite formatting (assistant messages) */
    .md_ln{margin:0; line-height:1.55}
    .md_sp{height:10px}
    .md_ul{margin:10px 0 0 18px; padding:0; color: rgba(231,231,231,0.86)}
    .md_ul li{margin:6px 0}
    .md_code{margin-top:10px; border:1px solid rgba(34,198,198,.22); border-radius:12px; background: rgba(0,0,0,.14); overflow:hidden}
    .md_codebar{display:flex; justify-content:space-between; align-items:center; gap:10px; padding:8px 10px; border-bottom:1px solid rgba(255,255,255,0.08)}
    .md_code pre{margin:0; padding:10px; overflow:auto}
    .md_code code{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; color: rgba(231,231,231,.92)}
    .md_copy{border:1px solid rgba(34,198,198,.40); background: rgba(34,198,198,.10); color: rgba(231,231,231,.92); border-radius: 999px; padding:6px 10px; cursor:pointer; font-size:12px}
    .md_copy:hover{border-color: rgba(34,198,198,.65)}

    #composer { display:flex; gap: 10px; align-items: flex-end; }
    #msg { width: 100%; min-height: 54px; max-height: 180px; padding: 10px; border-radius: 12px; border: 1px solid var(--border); font-size: 14px; background: #0d1426; color: var(--text); }
    #send { height: 44px; white-space: nowrap; }
    #pasteHint { font-size: 12px; color: var(--muted); }
    .preview { display:flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
    .thumb { border: 1px solid var(--border); border-radius: 10px; padding: 6px; background: #0d1426; }
    .thumb img { max-height: 96px; display:block; border-radius: 8px; }
    code { background: rgba(255,255,255,0.08); padding:2px 6px; border-radius:6px; }

    .statusline { display:flex; gap: 10px; flex-wrap: wrap; align-items: center; justify-content: space-between; }
    .pill { border: 1px solid var(--border); background: #0d1426; border-radius: 999px; padding: 6px 10px; font-size: 12px; color: var(--muted); }

    /* Rules accordion */
    .ruleItem { border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; background: rgba(255,255,255,0.03); overflow:hidden; }
    .ruleHead { width:100%; display:flex; justify-content: space-between; gap: 10px; align-items:center; padding: 10px 12px; cursor:pointer; user-select:none; }
    .ruleHead:hover { background: rgba(255,255,255,0.04); }
    .ruleTitle { font-weight: 750; font-size: 14px; color: rgba(231,231,231,0.92); }
    .ruleChevron { color: rgba(231,231,231,0.6); font-size: 12px; }
    .ruleBody { display:none; padding: 0 12px 12px 12px; color: rgba(231,231,231,0.82); font-size: 13px; line-height: 1.55; }
    .ruleBody.open { display:block; }

    /* Prevent forced scroll-to-bottom: user controls reading position */
    #chatlog { height: 520px; overflow: auto; scroll-behavior: smooth; }
    .ok { color: #7CFFB2; }
    .err { color: #ff8c8c; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="sidebar">
      <div class="card">
        <div class="row" style="justify-content: space-between; align-items: center;">
          <div class="row" style="gap: 10px;">
            <div style="width:36px;height:36px;border-radius:10px;background:rgba(34,198,198,.10);border:1px solid rgba(34,198,198,.35);display:flex;align-items:center;justify-content:center;">
              <svg width="24" height="24" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Clawd Console">
                <path d="M46 18H26c-4.4 0-8 3.6-8 8v12c0 4.4 3.6 8 8 8H46" stroke="rgba(34,198,198,.95)" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
                <rect x="26" y="23" width="16" height="8" rx="4" fill="rgba(34,198,198,.22)" stroke="rgba(34,198,198,.55)" stroke-width="2"/>
                <rect x="26" y="35" width="16" height="8" rx="4" fill="rgba(34,198,198,.12)" stroke="rgba(34,198,198,.40)" stroke-width="2"/>
                <path d="M46 28l8 4-8 4" stroke="rgba(34,198,198,.95)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <div>
              <div style="font-weight:700; font-size: 16px;">Clawd Console</div>
              <div class="muted">Your command deck</div>
            </div>
          </div>
        </div>
        <div class="pill" id="status" style="margin-top: 10px;">Connecting…</div>
        <div class="muted" style="margin-top: 8px;">Build: <code>${BUILD}</code></div>
        <div class="muted" style="margin-top: 6px;">(If UI looks stale, hard refresh. Build is server-tracked.)</div>
        <div class="muted" style="margin-top: 10px; display:flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;">
          <span>Storage: <code>${DATA_DIR}</code></span>
          <a class="scriptBtn" href="/transcript" target="_blank" rel="noopener">ClawdScript — View Entire Chat</a>
        </div>
      </div>

      <div class="card" style="margin-top: 14px;">
        <div style="font-weight:700; margin-bottom: 8px;">ClawdApps</div>

        <div class="row" style="gap: 8px; margin-bottom: 10px;">
          <button id="tabPM" type="button" class="pill" style="cursor:pointer;">ClawdPM</button>
          <button id="tabRepo" type="button" class="pill" style="cursor:pointer;">ClawdRepo</button>
          <button id="tabSec" type="button" class="pill" style="cursor:pointer;">ClawdSec</button>
          <button id="tabOps" type="button" class="pill" style="cursor:pointer;">ClawdOps</button>
          <button id="tabPub" type="button" class="pill" style="cursor:pointer;">ClawdPub</button>
          <button id="tabBuild" type="button" class="pill" style="cursor:pointer;">ClawdBuild</button>
        </div>

        <div id="panelPM" style="display:flex; flex-direction:column; gap: 10px;">
          <div class="row" style="justify-content:space-between; align-items:center;">
            <div>
              <div class="muted">ClawdPM</div>
              <div style="margin-top:4px;">Trello-style projects, lists, and cards (WIP).</div>
            </div>
            <a class="scriptBtn" href="/pm" target="_blank" rel="noopener">Open ClawdPM</a>
          </div>

          <div class="muted" style="margin-top:2px;">Tip: keep ClawdPM on a second monitor.</div>
        </div>

        <div id="panelPub" style="display:none; flex-direction:column; gap: 10px;">
          <div class="muted">ClawdPub SOP • Design and Iteration Guidelines</div>
          <div style="white-space:pre-wrap; background: rgba(0,0,0,0.12); border: 1px solid rgba(255,255,255,0.10); border-radius: 12px; padding: 10px; max-height: 320px; overflow:auto;">${escHtml(readSopSnippet())}</div>
          <div class="row" style="justify-content: space-between; align-items:center;">
            <a href="/clawdpub/sop" target="_blank" rel="noopener">Open full SOP →</a>
            <span class="muted">(editable file-backed)</span>
          </div>
        </div>

        <div id="panelRepo" style="display:none; flex-direction:column; gap: 10px;">
          <div class="row" style="justify-content:space-between; align-items:center;">
            <div class="muted">ClawdRepo — commits (this project)</div>
            <div class="row" style="gap:8px;">
              <a class="pill" id="repoOpen" href="https://github.com/nwesource01/clawdconsole" target="_blank" rel="noopener" style="cursor:pointer; text-decoration:none;">GitHub</a>
              <button class="pill" id="repoRefresh" type="button" style="cursor:pointer;">Refresh</button>
            </div>
          </div>
          <div class="muted">Local repo: <code>${__dirname}</code></div>
          <div id="repoList" style="margin-top:6px; background: rgba(0,0,0,0.12); border: 1px solid rgba(255,255,255,0.10); border-radius: 12px; padding: 10px; max-height: 360px; overflow:auto;"></div>
        </div>

        <div id="panelSec" style="display:none; flex-direction:column; gap: 10px;">
          <div class="muted">ClawdSec (security) — WIP</div>
          <div style="line-height:1.5;">
            <div><b>Rule:</b> don’t paste real secrets into chat or a web UI.</div>
            <div class="muted" style="margin-top:6px;">Instead, store secrets in server env files (e.g. <code>/etc/clawdio-console.env</code>) and rotate them when needed.</div>
            <div class="muted" style="margin-top:10px;">Password reset (Console auth):</div>
            <div class="md_code" style="margin-top:8px;"><pre><code>sudo nano /etc/clawdio-console.env
sudo systemctl restart clawdio-console.service</code></pre></div>
          </div>
        </div>

        <div id="panelOps" style="display:none; flex-direction:column; gap: 10px;">
          <div class="muted">ClawdOps (operations) — WIP</div>
          <div style="line-height:1.5;">
            <div>Uptime, backups, deploy checklist, and health checks.</div>
            <div class="muted" style="margin-top:8px;">Suggested keep-alive ping: set an UptimeRobot check to hit <code>/healthz</code> every minute.</div>
          </div>
        </div>

        <div id="panelBuild" style="display:none; flex-direction:column; gap: 10px;">
          <div class="muted">ClawdBuild (coming)</div>
          <div style="line-height:1.45;">
            <div><b>Idea:</b> layered, iterative app delivery with visibility: spec → tasks → code → tests → commits → release.</div>
            <div class="muted" style="margin-top:6px;">We’ll wire this into the Console as an operator-guided build pipeline.</div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top: 14px;" id="rulesCard">
        <h2 style="margin:0 0 10px 0">ClawdRules!</h2>
        <div class="muted" style="margin-bottom: 10px;">Operator heaven: small rules that prevent repeat questions.</div>

        <div style="display:flex; flex-direction:column; gap: 10px;">
          <div class="ruleItem">
            <div class="ruleHead" role="button" tabindex="0" aria-expanded="false">
              <div class="ruleTitle">Formatting: use code blocks for commands</div>
              <div class="ruleChevron">▸</div>
            </div>
            <div class="ruleBody">When I give shell commands, I will put them in fenced code blocks (triple backticks) so the Console renders a copyable command block. This prevents accidental “paste a URL into bash” mistakes and makes commands one-click copy.</div>
          </div>

          <div class="ruleItem">
            <div class="ruleHead" role="button" tabindex="0" aria-expanded="false">
              <div class="ruleTitle">URLs: don’t bold links</div>
              <div class="ruleChevron">▸</div>
            </div>
            <div class="ruleBody">When sharing URLs, keep <b>**</b> out of the link (don’t wrap links in bold). It can break clickability and looks spammy.</div>
          </div>

          <div class="ruleItem">
            <div class="ruleHead" role="button" tabindex="0" aria-expanded="false">
              <div class="ruleTitle">URLs: add “open in a new tab/window”</div>
              <div class="ruleChevron">▸</div>
            </div>
            <div class="ruleBody">When I share a URL with you, I’ll explicitly say: <code>open in a new tab/window</code> so it’s obvious it’s safe to click and won’t derail your current context.</div>
          </div>

          <div class="ruleItem">
            <div class="ruleHead" role="button" tabindex="0" aria-expanded="false">
              <div class="ruleTitle">URLs: plain links, one per line</div>
              <div class="ruleChevron">▸</div>
            </div>
            <div class="ruleBody">Prefer plain links (no embed tricks) and one link per line for readability.</div>
          </div>

          <div class="ruleItem">
            <div class="ruleHead" role="button" tabindex="0" aria-expanded="false">
              <div class="ruleTitle">Versioning: call out refresh/test-required changes</div>
              <div class="ruleChevron">▸</div>
            </div>
            <div class="ruleBody">If I make a change that requires you to refresh the UI and/or re-test a flow, I will explicitly say so and mention the new build/version to look for.</div>
          </div>

        </div>

        <div class="muted" style="margin-top:10px;">We’ll keep adding to this list.</div>
      </div>

      <div class="card" style="margin-top: 14px;">
        <h2 style="margin:0 0 10px 0">Manual upload</h2>
        <form id="upform" style="margin-top: 10px;">
          <input type="file" name="file" required />
          <div class="row" style="margin-top: 8px;">
            <button type="submit">Upload</button>
            <a href="/uploads/" target="_blank" rel="noopener">Browse uploads</a>
          </div>
        </form>
        <div class="muted" id="out" style="margin-top: 8px;"></div>
      </div>
    </div>

    <div class="main">
      <div class="card" id="scheduled" style="margin-bottom: 14px;">
        <div id="schedHeader" class="row" style="justify-content: space-between; align-items:center; cursor:pointer;">
          <div class="row" style="gap:10px; align-items: baseline;">
            <h2 style="margin:0">ClawdJobs</h2>
            <div class="muted" id="schedTitleSuffix"></div>
          </div>
          <div class="row" style="gap:8px; align-items:center; justify-content:flex-start; margin-left: 50px; flex: 1;">
            <button id="schedTabJobs" type="button" class="wlbtn" style="font-size:14px;">Jobs</button>
            <span class="muted">|</span>
            <button id="schedTabEmail" type="button" class="wlbtn" style="font-size:14px; color:#6fb3ff;">Email</button>
            <button id="schedTabDocs" type="button" class="wlbtn" style="font-size:14px; color:#7CFFB2;">Docs</button>
          </div>
          <button id="schedToggle" type="button" class="wlbtn" title="Toggle">▸</button>
        </div>
        <div id="schedBody" style="display:none; margin-top: 10px; background: var(--card2); border: 1px solid var(--border); border-radius: 12px; padding: 10px;"></div>
      </div>

      <div class="card">
        <h2 style="margin:0 0 10px 0">Chat</h2>
        <div id="chatlog"></div>

        <div id="composer" style="margin-top: 12px;">
          <textarea id="msg" placeholder="Type a message. Paste images/screenshots here (Ctrl+V) ..."></textarea>
          <div style="display:flex; flex-direction:column; gap:8px; align-items: stretch;">
            <button id="plan" type="button">Plan</button>
            <button id="send" type="button">Send</button>
          </div>
        </div>

        <div id="quickbar" style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; justify-content:flex-start; align-items:center;">
          <div class="row" id="quickButtons" style="gap: 10px;">
            <button id="btnReviewRecent" type="button" class="qbtn">Review Recent</button>
            <button id="btnReviewWeek" type="button" class="qbtn">Review Week</button>
            <button id="btnRepeatLast" type="button" class="qbtn">Repeat Last</button>
            <button id="btnAddBtn" type="button" class="qbtn">Add a Button</button>
            <a id="btnAdmin" class="qbtn" href="/adminonly" target="_blank" rel="noopener" title="Admin" style="display:inline-flex; align-items:center; justify-content:center; gap:8px; text-decoration:none;">⚙️</a>
          </div>
        </div>

        <div id="pasteHint">Tip: click the textarea, then paste a screenshot. It will upload automatically and attach to your message.</div>
        <div class="preview" id="preview"></div>
        <div class="muted" id="debug" style="margin-top: 10px;"></div>
      </div>
    </div>

    <div class="right">
      <div class="card" id="decard">
        <div class="statusline" style="justify-content: space-between; align-items:center;">
          <div class="row" style="gap:10px; align-items:center;">
            <h2 style="margin:0">ClawdList</h2>
            <div class="pill" id="deStatus">Idle</div>
          </div>
          <div class="row" style="gap: 8px; align-items:center;">
            <button id="dePrev" type="button" class="wlbtn" title="Previous completed list">Prev</button>
            <button id="deNext" type="button" class="wlbtn" title="Next completed list">Next</button>
          </div>
        </div>
        <div class="muted" style="margin-top: 8px;">Checklists (newest first). Use Prev/Next to browse completed lists; persists until complete.</div>
        <div id="deLists" style="margin-top:10px; display:flex; flex-direction:column; gap: 12px;"></div>
      </div>

      <div class="card" style="margin-top: 14px;">
        <div class="statusline" style="justify-content: space-between; align-items:center;">
          <div class="row" style="gap:12px; align-items:center;">
            <h2 style="margin:0">ClawdWork</h2>
            <div id="wlFilters" class="row" style="gap:6px; margin-left: 50px;">
              <button type="button" class="wlbtn" data-filter="errors">errors</button>
              <button type="button" class="wlbtn" data-filter="gateway">gateway</button>
              <button type="button" class="wlbtn" data-filter="ws">ws</button>
              <button type="button" class="wlbtn" data-filter="messages">messages</button>
              <button type="button" class="wlbtn" data-filter="uploads">uploads</button>
              <button type="button" class="wlbtn" data-filter="de">del</button>
            </div>
          </div>
          <div class="row" style="gap:8px; align-items:center;">
            <button id="btnStop" type="button" style="background:transparent; border:1px solid rgba(255,80,80,0.8);">Stop</button>
            <button id="btnAdd" type="button" style="background:transparent; border:1px solid rgba(80,255,160,0.8);">Add</button>
            <div class="pill" id="thinking">Idle</div>
          </div>
        </div>
        <div class="row" style="justify-content: space-between; margin-top: 8px;">
          <div class="muted">High-level activity + timestamps (no private chain-of-thought).</div>
          <button id="wlRecent" type="button" class="wlbtn">Recent</button>
        </div>
        <div id="worklog" style="margin-top:10px; background: var(--card2); border: 1px solid var(--border); border-radius: 12px; padding: 10px; height: 520px; overflow:auto;"></div>
      </div>
    </div>
  </div>

  <!-- Add Button modal -->
  <div class="cc_modal" id="ab_modal" aria-label="Add a button" role="dialog" aria-modal="true">
    <div class="cc_box" style="width:min(760px, 96vw);">
      <div class="cc_right" style="padding:16px;">
        <div class="cc_head">
          <div>
            <b>Add a Button</b>
            <div class="muted">Create a quick-action that sends chat text.</div>
          </div>
          <button class="cc_close" id="ab_close" type="button">Close</button>
        </div>

        <form class="cc_form" id="ab_form" style="margin-top:12px;">
          <input id="ab_label" name="label" placeholder="Button label" required />
          <textarea id="ab_text" name="text" placeholder="Chat text this button should send" style="width:100%; min-height: 120px; max-height: 260px; padding:10px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.14); background:#0d1426; color:var(--text); font-size:14px; font-family: inherit;" required></textarea>
          <div class="cc_row">
            <button class="qbtn" type="submit">Save</button>
            <button class="qbtn" id="ab_cancel" type="button">Cancel</button>
          </div>
          <div class="cc_msg" id="ab_msg"></div>
        </form>
      </div>
    </div>
  </div>

<script src="/static/app.js"></script>
<script src="/static/publish.js"></script>
</body>
</html>`);
});

// --- WebSocket chat (best UX) ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const wsClients = new Set();
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const ws of wsClients) {
    try { ws.send(s); } catch {}
  }
}

function authedWs(req) {
  const cookies = parseCookies(req);
  const tok = cookies[SESS_COOKIE];
  if (tok) {
    const exp = sessions.get(tok);
    if (exp && exp > Date.now()) return true;
  }
  return false;
}

wss.on('connection', (ws, req) => {
  if (!authedWs(req)) {
    try { ws.close(4401, 'unauthorized'); } catch {}
    return;
  }

  // Hard cap concurrent WS connections. Keeps multiple open consoles from fighting the same session.
  const MAX_WS_CLIENTS = Number(process.env.CONSOLE_MAX_WS_CLIENTS || 2);
  if (wsClients.size >= MAX_WS_CLIENTS) {
    try { ws.close(4429, 'too many connections'); } catch {}
    return;
  }

  wsClients.add(ws);
  logWork('ws.connected', { clients: wsClients.size });
  ws.send(JSON.stringify({ type: 'hello', ok: true }));

  ws.on('message', (data) => {
    const msg = safeJsonParse(data.toString('utf8'));
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
      return;
    }

    if (msg.type === 'message') {
      const text = typeof msg.text === 'string' ? msg.text : '';
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
      const saved = acceptMessage({ text, attachments });
      ws.send(JSON.stringify({ type: 'ack', id: msg.clientId || null, savedId: saved.id }));
    }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
    logWork('ws.disconnected', { clients: wsClients.size });
  });
});

async function telemetryPost(url, body){
  // Node 18+ has global fetch.
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const ok = res && res.ok;
    return { ok, status: res ? res.status : 0 };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    clearTimeout(to);
  }
}

async function runTelemetry(kind){
  if (!TELEMETRY_OPT_IN) return;

  const install = ensureInstallId();
  const payload = {
    installId: install.installId,
    createdAt: install.createdAt,
    appVersion: (function(){ try { return require('./package.json').version; } catch { return null; } })(),
    build: BUILD,
    platform: {
      node: process.version,
      os: process.platform,
      arch: process.arch,
    }
  };

  if (kind === 'install') {
    const r = await telemetryPost(TELEMETRY_INSTALL_URL, payload);
    if (r.ok) writeTelemetryState({ lastInstallAt: new Date().toISOString(), lastErr: null });
    else writeTelemetryState({ lastErr: 'install:' + (r.error || r.status || 'failed') });
    return;
  }

  if (kind === 'daily') {
    const r = await telemetryPost(TELEMETRY_DAILY_URL, payload);
    if (r.ok) writeTelemetryState({ lastDailyAt: new Date().toISOString(), lastErr: null });
    else writeTelemetryState({ lastErr: 'daily:' + (r.error || r.status || 'failed') });
  }
}

function startTelemetry(){
  if (!TELEMETRY_OPT_IN) return;
  // fire install once per process start if never succeeded
  const st = readTelemetryState();
  if (!st.lastInstallAt) {
    runTelemetry('install');
  }

  // Daily heartbeat
  const intervalMs = TELEMETRY_INTERVAL_HOURS * 60 * 60 * 1000;
  setInterval(() => {
    runTelemetry('daily');
  }, intervalMs).unref?.();

  // also send one daily quickly on boot if last daily is old
  try {
    const last = st.lastDailyAt ? Date.parse(st.lastDailyAt) : 0;
    if (!last || (Date.now() - last) > (intervalMs * 0.9)) {
      setTimeout(() => runTelemetry('daily'), 15_000).unref?.();
    }
  } catch {}

  logWork('telemetry.opt_in', { base: TELEMETRY_BASE_URL, installUrl: TELEMETRY_INSTALL_URL, dailyUrl: TELEMETRY_DAILY_URL });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Clawd Console listening on http://127.0.0.1:${PORT}`);
  // Start gateway bridge
  connectGateway();
  // Start opt-in telemetry pinger
  startTelemetry();
});
