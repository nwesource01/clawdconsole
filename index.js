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
const { execFile, spawn } = require('child_process');
const https = require('https');

const PORT = process.env.PORT ? Number(process.env.PORT) : 21337;
const BUILD = '2026-03-03.78';

// Telemetry (opt-in): open-source installs can optionally ping a hosted collector.
const TELEMETRY_OPT_IN = String(process.env.TELEMETRY_OPT_IN || '').trim() === '1';
const TELEMETRY_BASE_URL = (process.env.TELEMETRY_BASE_URL || 'https://app.clawdconsole.com').replace(/\/$/, '');
const TELEMETRY_INSTALL_URL = process.env.TELEMETRY_INSTALL_URL || (TELEMETRY_BASE_URL + '/api/telemetry/v1/install');
const TELEMETRY_DAILY_URL = process.env.TELEMETRY_DAILY_URL || (TELEMETRY_BASE_URL + '/api/telemetry/v1/daily');
const TELEMETRY_INTERVAL_HOURS = Math.max(1, Number(process.env.TELEMETRY_INTERVAL_HOURS || 24));

// Clawdbot Gateway (for agent bridge)
const GATEWAY_WS_URL_DEFAULT = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:18789';
const CONSOLE_SESSION_KEY_DEFAULT = process.env.CONSOLE_SESSION_KEY || 'claw-console';

const DATA_DIR = process.env.DATA_DIR || '/home/master/clawd/console-data';

// Best-effort public IP helper (used for UI status).
let cachedPublicIp = { ip: null, at: 0 };
async function getServerPublicIp(){
  const ttlMs = 10 * 60 * 1000;
  if (cachedPublicIp.at && (Date.now() - cachedPublicIp.at) < ttlMs) return cachedPublicIp.ip;

  // Allow explicit override.
  const envIp = String(process.env.PUBLIC_IP || '').trim();
  if (envIp) {
    cachedPublicIp = { ip: envIp, at: Date.now() };
    return envIp;
  }

  // DigitalOcean metadata (no external internet required)
  const metaUrl = process.env.DO_METADATA_URL || 'http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address';
  const mod = metaUrl.startsWith('https:') ? https : http;

  const ip = await new Promise((resolve) => {
    const req = mod.get(metaUrl, { timeout: 1200 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(String(data || '').trim() || null));
    });
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve(null); });
    req.on('error', () => resolve(null));
  });

  cachedPublicIp = { ip, at: Date.now() };
  return ip;
}

// file-backed gateway override config (so different installs/accounts can swap integrations)
const CODEX_CFG_FILE = path.join(DATA_DIR, 'codex-config.json');
let codexCfg = readJson(CODEX_CFG_FILE, null);
let GATEWAY_WS_URL = (codexCfg && codexCfg.gatewayWsUrl) ? String(codexCfg.gatewayWsUrl) : GATEWAY_WS_URL_DEFAULT;
let CONSOLE_SESSION_KEY = (codexCfg && codexCfg.consoleSessionKey) ? String(codexCfg.consoleSessionKey) : CONSOLE_SESSION_KEY_DEFAULT;
let gwLastError = null;
let gwLastEvent = null;

// Together.ai (OpenAI-compatible) config (Qwen/Llama/etc)
const TOGETHER_CFG_FILE = path.join(DATA_DIR, 'together-config.json');
function readTogetherCfg(){
  const j = readJson(TOGETHER_CFG_FILE, null) || {};
  return {
    baseUrl: String(j.baseUrl || 'https://api.together.xyz').trim() || 'https://api.together.xyz',
    model: String(j.model || 'Qwen/Qwen3-Coder-Next-FP8').trim() || 'Qwen/Qwen3-Coder-Next-FP8',
    apiKey: (typeof j.apiKey === 'string') ? j.apiKey : '',
    updatedAt: j.updatedAt || null,
  };
}
function writeTogetherCfg(patch){
  const cur = readTogetherCfg();
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  const ok = writeJson(TOGETHER_CFG_FILE, next);
  return ok ? next : null;
}

function recordGatewayEvent(kind, payload){
  const ev = { ts: new Date().toISOString(), kind: String(kind||''), payload };
  gwLastEvent = ev;
  gwEvents.push(ev);
  while (gwEvents.length > GW_EVENTS_MAX) gwEvents.shift();
  try { appendJsonl(GATEWAY_EVENTS_FILE, ev); } catch {}
  // best-effort live stream to consoles
  try { broadcast({ type: 'gateway_event', event: ev }); } catch {}
}

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MSG_FILE = path.join(DATA_DIR, 'messages.jsonl');
const WORK_FILE = path.join(DATA_DIR, 'worklog.jsonl');
// Minimal ongoing transcript (tiny JSONL; appended on every user + bot msg)
const TRANSCRIPT_FILE = path.join(DATA_DIR, 'transcript.jsonl');
// Raw gateway events (for debugging Codex / gateway behavior)
const GATEWAY_EVENTS_FILE = path.join(DATA_DIR, 'gateway-events.jsonl');
const gwEvents = []; // ring buffer in memory
const GW_EVENTS_MAX = 250;
// Scheduled reports log
const SCHED_FILE = path.join(DATA_DIR, 'scheduled.jsonl');

// Telemetry local state
const INSTALL_FILE = path.join(DATA_DIR, 'install.json');
const TELEMETRY_STATE_FILE = path.join(DATA_DIR, 'telemetry-state.json');

// Telemetry collector logs (only used on the hosted collector)
const TELEMETRY_FILE = path.join(DATA_DIR, 'telemetry.jsonl');

// Custom quick buttons (server-side persistence)
const BUTTONS_FILE = path.join(DATA_DIR, 'buttons.json');

// Branding: shared Apps menu (CSS stored in data dir so updates propagate without redeploy)
const BRANDING_MENU_FILE = path.join(DATA_DIR, 'branding-menu.json');
const BRANDING_MENU_DEFAULT = {
  cssOverrides: "/* Add CSS overrides here. Example:\n.appsMenuBtn{ border-radius:12px; }\n*/\n",
  updatedAt: null,
};
function readBrandingMenu(){
  try {
    if (!fs.existsSync(BRANDING_MENU_FILE)) return { ...BRANDING_MENU_DEFAULT };
    const j = JSON.parse(fs.readFileSync(BRANDING_MENU_FILE, 'utf8'));
    return {
      cssOverrides: (typeof j.cssOverrides === 'string') ? j.cssOverrides : BRANDING_MENU_DEFAULT.cssOverrides,
      updatedAt: j.updatedAt || null,
    };
  } catch {
    return { ...BRANDING_MENU_DEFAULT };
  }
}
function writeBrandingMenu(patch){
  const cur = readBrandingMenu();
  const next = {
    ...cur,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BRANDING_MENU_FILE, JSON.stringify(next, null, 2));
  return next;
}

const APPS_MENU_BASE_CSS = `
  .appsMenuWrap{ position:relative; display:inline-flex; align-items:center; justify-content:flex-end; }
  .appsMenuBtn{
    cursor:pointer; user-select:none;
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,.22);
    background: rgba(0,0,0,.18);
    padding: 5px 8px;
    font-weight: 950;
    font-size: 13px;
    line-height: 1;
    color: rgba(231,231,231,.92);
  }
  .appsMenuBtnTxt{ border-bottom: 2px solid rgba(34,198,198,.55); padding-bottom: 2px; }
  .appsMenuBtn:hover{ background: rgba(0,0,0,.26); border-color: rgba(34,198,198,.40); }
  .appsMenuBtn:hover .appsMenuBtnTxt{ border-bottom-color: rgba(34,198,198,.85); }

  .appsMenuBtnChev{ opacity:.8; transition: transform 160ms ease; }
  .appsMenuWrap.open .appsMenuBtnChev{ transform: rotate(180deg); }

  .appsMenuDrop{
    position:absolute;
    right:0;
    top: calc(100% + 10px);
    width: min(560px, 92vw);
    border-radius: 18px;
    border: 1px solid rgba(255,255,255,0.14);
    background: #0a0f1e;
    box-shadow: 0 18px 60px rgba(0,0,0,.55);
    overflow:hidden;

    transform: translateY(-6px) scale(.985);
    opacity: 0;
    pointer-events: none;
    transition: opacity 170ms ease, transform 170ms ease;
    z-index: 30;
  }
  .appsMenuWrap.open .appsMenuDrop{ opacity: 1; transform: translateY(0) scale(1); pointer-events:auto; }

  .appsMenuDropHead{ display:flex; justify-content:space-between; align-items:center; padding:12px 14px; border-bottom:1px solid rgba(255,255,255,0.10); }
  .appsAll{ color: rgba(232,238,252,.92); font-weight:900; text-decoration:none; }
  .appsAll:hover{ text-decoration: underline; }

  .appsGrid{ display:grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap:10px; padding: 12px 14px 14px 14px; }
  @media (max-width: 520px){ .appsGrid{ grid-template-columns: 1fr; } }

  .appsLink{
    display:flex; align-items:center; gap:10px;
    padding:9px 10px;
    border-radius: 14px;
    border: 1px solid rgba(255,255,255,0.10);
    background: rgba(255,255,255,0.04);
    text-decoration:none;
    color: rgba(232,238,252,.92);
    transform: translateZ(0);
    transition: transform 140ms ease, background 140ms ease, border-color 140ms ease;
  }
  .appsLink:hover{ transform: translateY(-1px); background: rgba(255,255,255,0.06); border-color: rgba(34,198,198,.35); }
  .appsLink[aria-current="page"]{ border-color: rgba(34,198,198,.55); background: rgba(34,198,198,.10); }

  .appsDot{ width:10px; height:10px; border-radius:999px; background: rgba(34,198,198,.75); box-shadow: 0 0 0 4px rgba(34,198,198,.12); flex:0 0 auto; }
  .appsLbl{ font-weight: 850; letter-spacing: .2px; }
`;

const APPS_MENU_BASE_JS = `
(() => {
  function initOne(wrap){
    const btn = wrap.querySelector('.appsMenuBtn');
    const drop = wrap.querySelector('.appsMenuDrop');
    if (!btn || !drop) return;

    function setOpen(v){
      wrap.classList.toggle('open', !!v);
      btn.setAttribute('aria-expanded', v ? 'true' : 'false');
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      setOpen(!wrap.classList.contains('open'));
    });

    btn.addEventListener('dblclick', (e) => {
      e.preventDefault();
      window.location.href = '/apps';
    });

    document.addEventListener('click', (e) => {
      if (!wrap.classList.contains('open')) return;
      const t = e.target;
      if (t && wrap.contains(t)) return;
      setOpen(false);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setOpen(false);
    });
  }

  document.querySelectorAll('.appsMenuWrap').forEach(initOne);
})();
`;

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

// --- ClawdCode workspaces (file-backed) ---
const CODE_WS_ROOT = '/home/master/clawd/code/workspaces';
const CODE_WS_FILE = path.join(DATA_DIR, 'code-workspaces.json');

function slugifyWsTitle(s){
  return String(s||'')
    .trim()
    .replace(/\s+/g,'-')
    .replace(/[^a-zA-Z0-9._-]/g,'')
    .slice(0, 60) || 'workspace';
}

function loadCodeWs(){
  try {
    if (!fs.existsSync(CODE_WS_FILE)) throw new Error('missing');
    const j = JSON.parse(fs.readFileSync(CODE_WS_FILE, 'utf8'));
    if (!j || !Array.isArray(j.workspaces)) throw new Error('bad');
    return j;
  } catch {
    // seed
    const seeded = {
      workspaces: [
        { id:'console', title:'Console', root: path.resolve(__dirname), git: null },
      ],
    };
    try {
      fs.mkdirSync(path.dirname(CODE_WS_FILE), { recursive:true });
      fs.writeFileSync(CODE_WS_FILE, JSON.stringify(seeded, null, 2), 'utf8');
    } catch {}
    return seeded;
  }
}

function saveCodeWs(state){
  const next = {
    workspaces: Array.isArray(state && state.workspaces) ? state.workspaces : [],
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(CODE_WS_FILE), { recursive:true });
  fs.writeFileSync(CODE_WS_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function inferGitForRoot(root){
  try {
    if (!root) return null;
    if (!fs.existsSync(path.join(root, '.git'))) return null;
    const execFileSync = require('child_process').execFileSync;
    const remote = String(execFileSync('git', ['config','--get','remote.origin.url'], { cwd: root, stdio:['ignore','pipe','ignore'] }) || '').trim();
    const branch = String(execFileSync('git', ['rev-parse','--abbrev-ref','HEAD'], { cwd: root, stdio:['ignore','pipe','ignore'] }) || '').trim();
    if (!remote) return null;
    return { remote, branch: (branch && branch !== 'HEAD') ? branch : '' };
  } catch {
    return null;
  }
}

function listCodeWorkspaces(){
  const st = loadCodeWs();
  const wss = Array.isArray(st.workspaces) ? st.workspaces : [];
  // hide duplicates + invalid
  const seen = new Set();
  const out = [];
  for (const w of wss){
    if (!w || !w.id || !w.root) continue;
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    const git = w.git ? { remote: String(w.git.remote||''), branch: String(w.git.branch||'') } : null;
    const inferred = git && git.remote ? git : inferGitForRoot(String(w.root));
    out.push({
      id: String(w.id),
      title: String(w.title || w.id),
      root: String(w.root),
      git: inferred && inferred.remote ? { remote: String(inferred.remote||''), branch: String(inferred.branch||'') } : null,
    });
  }
  return out;
}

function defaultCodeWsId(){ return 'console'; }

function currentCodeWorkspace(req){
  const sess = getSessionFromReq(req);
  const want = String(sess && sess.codeWorkspace || '').trim() || defaultCodeWsId();
  const wss = listCodeWorkspaces();
  const ws = wss.find(w => w && w.id === want) || wss.find(w => w && w.id === 'console') || wss[0];
  return ws || { id:'console', title:'Console', root: path.resolve(__dirname), git:null };
}

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

  // token-only bridge endpoints (for cross-box notes)
  if (req.path === '/api/ops/bridge/inbox' || req.path === '/api/ops/bridge/outbox') return next();

  // allow telemetry collector endpoints without auth (hosted collector)
  if (req.path.startsWith('/api/telemetry/v1/')) return next();

  // 1) session cookie
  const cookies = parseCookies(req);
  const tok = cookies[SESS_COOKIE];
  if (tok) {
    const sess = sessions.get(tok);
    const exp = (sess && typeof sess === 'object') ? sess.exp : sess;
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
  sessions.set(token, { exp: Date.now() + SESS_TTL_MS, unlocks: {} });
  res.setHeader('Set-Cookie', `${SESS_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(SESS_TTL_MS/1000)}; HttpOnly; Secure; SameSite=Strict`);

  return next();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// --- Preview proxy (server-side): /proxy/<port>/<path> -> http://127.0.0.1:<port>/<path>
const PREVIEW_PORTS = new Set([5000, 5001]);
app.use('/proxy/:port', (req, res) => {
  try {
    const port = Number(req.params.port || 0);
    if (!PREVIEW_PORTS.has(port)) return res.status(400).type('text/plain').send('bad port');

    // preserve full path after /proxy/:port
    const basePrefix = '/proxy/' + String(port);
    const rest = String(req.originalUrl || '').startsWith(basePrefix) ? String(req.originalUrl).slice(basePrefix.length) : (req.url || '');
    const pathPart = rest && rest.startsWith('/') ? rest : ('/' + String(rest || ''));

    const target = 'http://127.0.0.1:' + String(port) + pathPart;
    const u = new URL(target);

    const mod = (u.protocol === 'https:') ? require('https') : require('http');

    const headers = { ...req.headers };
    headers.host = u.host;
    delete headers['content-length'];

    const pr = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      method: req.method,
      path: u.pathname + u.search,
      headers,
    }, (pres) => {
      res.statusCode = pres.statusCode || 502;

      // rewrite Location headers back through the proxy
      const loc = pres.headers && pres.headers.location;
      if (loc) {
        try {
          const locUrl = new URL(loc, u.toString());
          if (locUrl.hostname === '127.0.0.1' && String(locUrl.port) === String(port)) {
            res.setHeader('Location', basePrefix + locUrl.pathname + locUrl.search);
            delete pres.headers.location;
          }
        } catch {}
      }

      for (const [k,v] of Object.entries(pres.headers || {})) {
        if (!k) continue;
        if (k.toLowerCase() === 'content-security-policy') continue;
        try { if (v != null) res.setHeader(k, v); } catch {}
      }

      pres.pipe(res);
    });

    pr.on('error', (e) => {
      res.status(502).type('text/plain').send('proxy error: ' + String(e));
    });

    if (req.method === 'GET' || req.method === 'HEAD') pr.end();
    else req.pipe(pr);
  } catch (e) {
    res.status(500).type('text/plain').send('proxy exception: ' + String(e));
  }
});

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
  <link rel="stylesheet" href="/static/apps-menu.css" />
  <style>
    :root{ --bg:#0b0f1a; --card:#11182a; --text:#e7e7e7; --muted: rgba(231,231,231,.70); --border: rgba(231,231,231,.12); --teal:#22c6c6; }
    body{margin:0; font-family: system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background: var(--bg); color: var(--text)}
    .wrap{max-width: 1200px; margin:0 auto; padding: 16px;}

    /* Header like the Apps suite: left title, right menu aligned to container edge */
    .top{display:grid; grid-template-columns: minmax(0, 620px) 1fr; gap:12px; align-items:baseline}
    @media (max-width: 980px){ .top{grid-template-columns: 1fr;} }
    .topR{display:flex; justify-content:flex-end; justify-self:end; width:100%; }

    h1{margin:0; font-size:18px}
    .muted{color:var(--muted); font-size:12px}
    .pill{ display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:8px 10px; border-radius:999px; border:1px solid rgba(34,198,198,.40); background: linear-gradient(180deg, rgba(34,198,198,.18), rgba(34,198,198,.08)); color: rgba(231,231,231,.92); text-decoration:none; white-space:nowrap; font-weight:750; font-size:12px; }
    .pill:hover{ border-color: rgba(34,198,198,.70); background: linear-gradient(180deg, rgba(34,198,198,.26), rgba(34,198,198,.10)); }

    ${APPS_MENU_CSS}

    .card{border:1px solid var(--border); border-radius:14px; background: rgba(255,255,255,.03); padding:14px; margin-top:12px}
    textarea,input,select{width:100%; padding:10px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.14); background:#0d1426; color:var(--text); font-size:14px; font-family: inherit; line-height:1.35}
    textarea::placeholder,input::placeholder{color: rgba(231,231,231,.35)}
    textarea{min-height:110px; max-height:300px}
    .row{display:flex; gap:10px; flex-wrap:wrap; align-items:center}
    .nameGrid{display:grid; grid-template-columns: 1fr 320px; gap:12px; align-items:start}
    @media (max-width: 980px){ .nameGrid{grid-template-columns: 1fr;} }
    .sideFields{display:flex; flex-direction:column; gap:10px; min-width:0;}
    .field{display:flex; flex-direction:column; gap:6px; min-width:0;}
    .actions{display:flex; gap:10px; flex-wrap:wrap; justify-content:space-between; align-items:center; }
    .actions > *{flex:0 0 auto;}
    .btn{border:1px solid rgba(34,198,198,.40); background: rgba(34,198,198,.10); color: rgba(231,231,231,.92); border-radius: 12px; padding:10px 12px; cursor:pointer}
    .btn:hover{border-color: rgba(34,198,198,.65)}
    table{width:100%; border-collapse: collapse; margin-top:12px; font-size:13px}
    th,td{padding:10px 8px; border-bottom:1px solid rgba(255,255,255,.08); text-align:left; vertical-align:top}
    .tag{display:inline-flex; padding:3px 8px; border-radius:999px; font-size:12px; border:1px solid rgba(255,255,255,.14)}
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
      <div class="topR">${appsMenuHtml('/name')}</div>
    </div>

    <div class="card">
      <div class="nameGrid">
        <div style="min-width:0;">
          <div class="muted" style="margin-bottom:6px;">Business names (one per line)</div>
          <textarea id="names" placeholder=""></textarea>
          <div class="muted" style="margin-top:6px; font-size:12px;">Example: <code>InfraClawd</code> <span class="muted">(one per line)</span></div>
        </div>

        <div class="sideFields">
          <div class="field">
            <div class="muted">TLDs (comma-separated)</div>
            <input id="tlds" value=".com,.io,.ai,.app" />
          </div>
          <div class="field">
            <div class="muted">Max variants per name</div>
            <input id="variants" value="8" />
          </div>
          <div class="actions">
            <button class="btn" id="run" type="button">Check</button>
            <button class="mini" id="clear" type="button">Clear</button>
          </div>
        </div>
      </div>

      <div class="muted" id="status" style="margin-top:10px;"></div>
      <div id="out"></div>
    </div>
  </div>

<script src="/static/name.js"></script>
<script src="/static/apps-menu.js"></script>
</body>
</html>`);
});

// --- Public demo (no auth) ---
const DEMO_MESSAGES = [
  { t: '2026-02-28T00:00:00.000Z', r: 'user', x: 'Build a landing page for Clawd Console and show me the iteration trail.' },
  { t: '2026-02-28T00:00:05.000Z', r: 'assistant', x: 'Draft v1 shipped. Next: tighten hero, add pricing, and a demo environment. DEL created for iteration steps.', d: ['Draft hero + CTA', 'Add modules section', 'Add pricing ($19/seat/year)', 'Create demo route (no outbound)', 'Wire waitlist form'] },
  { t: '2026-02-28T00:00:12.000Z', r: 'assistant', x: 'Uploaded screenshot mockups. You can paste images here too (demo shows the UI affordance).', a: [{ name: 'mock.png', url: '#', mime: 'image/png' }] },
  { t: '2026-02-28T00:00:20.000Z', r: 'user', x: 'Now revise the hero copy to be sharper and more specific.' },
  { t: '2026-02-28T00:00:26.000Z', r: 'assistant', x: 'Revision v2: "Productivity amplification for Clawdbots. Multi-version workflows with visible deltas, jobs, commits, and publishing."' },
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
  <title>Clawd Console - Demo</title>
  <meta name="robots" content="noindex" />
  <link rel="stylesheet" href="/static/demo.css" />
</head>
<body>
  <div class="top">
    <div class="badge">DEMO</div>
    <div class="title">Clawd Console</div>
    <div class="sub">Safe playground • no integrations • no outbound messaging</div>
    <a class="link" href="#" onclick="return false" rel="noopener">Open app</a>
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
        <li><b>ClawdSOP</b> - processitized SOP builds</li>
        <li><b>ClawdBuild</b> - layered app delivery</li>
        <li><b>ClawdJobs</b> - scheduled training + automation</li>
        <li><b>ClawdPub</b> - iterative client/public pages</li>
        <li><b>ClawdPM</b> - project manager layer</li>
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

app.get('/api/status', async (req, res) => {
  const forwardedFor = (req.headers['x-forwarded-for'] || '').toString();
  const clientIp = forwardedFor.split(',')[0].trim() || req.socket.remoteAddress || null;
  const serverPublicIp = await getServerPublicIp();
  res.json({
    ok: true,
    service: 'claw-console',
    build: BUILD,
    inFlight: !!runState.inFlight,
    serverTime: new Date().toISOString(),
    hostname: require('os').hostname(),
    serverBind: '127.0.0.1',
    clientIp,
    serverPublicIp,
    gateway: {
      connected: !!(gw && gw.connected),
      url: GATEWAY_WS_URL,
      sessionKey: CONSOLE_SESSION_KEY,
      lastError: gwLastError,
      lastEvent: gwLastEvent,
    },
  });
});

app.get('/api/run', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, state: runState });
});

app.get('/api/gateway/events', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
  const tail = gwEvents.slice(-limit);
  res.json({ ok:true, events: tail });
});

app.get('/api/ops/codex/profiles', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const authPath = '/root/.clawdbot/agents/main/agent/auth-profiles.json';
    const store = readJson(authPath, null) || {};
    const profilesObj = (store && store.profiles && typeof store.profiles === 'object') ? store.profiles : {};
    const profiles = Object.keys(profilesObj).map((id) => {
      const p = profilesObj[id] || {};
      const provider = String(p.provider || p.providerKey || '').trim();
      let email = '';
      try {
        // decode JWT payload (not verifying signature; UI only)
        const access = String(p.access || '').split('.')[1] || '';
        const json = access ? JSON.parse(Buffer.from(access.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8')) : null;
        email = String(json?.['https://api.openai.com/profile']?.email || json?.email || '').trim();
      } catch {}
      return {
        id,
        type: String(p.type || ''),
        provider,
        expires: (typeof p.expires === 'number') ? p.expires : null,
        email: email || null,
        accountId: p.accountId ? String(p.accountId) : null,
      };
    });

    // best-effort read current session override
    let current = { key: CONSOLE_SESSION_KEY, authProfileOverride: null };
    try {
      const payload = await gwSendReq('sessions.list', { limit: 400, includeGlobal: true, includeUnknown: true });
      const items = Array.isArray(payload?.items) ? payload.items : [];
      const hit = items.find(it => it && (it.key === CONSOLE_SESSION_KEY || it.key === ('main:' + CONSOLE_SESSION_KEY) || it.key?.endsWith(':' + CONSOLE_SESSION_KEY)));
      if (hit && hit.sessionEntry) {
        current.authProfileOverride = hit.sessionEntry.authProfileOverride || null;
      }
    } catch {}

    res.json({ ok:true, profiles, current, lastGood: store.lastGood || null });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

app.post('/api/ops/codex/profile', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const sess = getSessionFromReq(req);
  if (!sess) return res.status(401).json({ ok:false, error:'no_session' });
  try {
    const profileId = String(req.body?.profileId || '').trim();
    await gwSendReq('sessions.patch', { key: CONSOLE_SESSION_KEY, authProfileOverride: profileId || '' });
    logWork('ops.codex.profile.set', { sessionKey: CONSOLE_SESSION_KEY, profileId: profileId || '' });
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

app.get('/api/ops/codex', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const cfg = readJson(CODEX_CFG_FILE, null) || {};
  res.json({
    ok:true,
    config: cfg,
    effective: {
      gatewayWsUrl: GATEWAY_WS_URL,
      consoleSessionKey: CONSOLE_SESSION_KEY,
    },
    gateway: {
      connected: !!(gw && gw.connected),
      lastError: gwLastError,
      lastEvent: gwLastEvent,
    }
  });
});

app.post('/api/ops/codex', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const sess = getSessionFromReq(req);
  if (!sess) return res.status(401).json({ ok:false, error:'no_session' });

  const gatewayWsUrl = String(req.body?.gatewayWsUrl || '').trim();
  const consoleSessionKey = String(req.body?.consoleSessionKey || '').trim();

  const cfg = readJson(CODEX_CFG_FILE, null) || {};
  if (gatewayWsUrl) cfg.gatewayWsUrl = gatewayWsUrl;
  if (consoleSessionKey) cfg.consoleSessionKey = consoleSessionKey;
  cfg.updatedAt = new Date().toISOString();

  const ok = writeJson(CODEX_CFG_FILE, cfg);
  if (!ok) return res.status(500).json({ ok:false, error:'write_failed' });

  // apply immediately
  CODExCfg = cfg;
  GATEWAY_WS_URL = (cfg && cfg.gatewayWsUrl) ? String(cfg.gatewayWsUrl) : GATEWAY_WS_URL_DEFAULT;
  CONSOLE_SESSION_KEY = (cfg && cfg.consoleSessionKey) ? String(cfg.consoleSessionKey) : CONSOLE_SESSION_KEY_DEFAULT;

  // reconnect
  try { gw.ws && gw.ws.close && gw.ws.close(); } catch {}
  setTimeout(connectGateway, 50);

  logWork('ops.codex.saved', { gatewayWsUrl: GATEWAY_WS_URL, consoleSessionKey: CONSOLE_SESSION_KEY });
  res.json({ ok:true, effective: { gatewayWsUrl: GATEWAY_WS_URL, consoleSessionKey: CONSOLE_SESSION_KEY } });
});

app.post('/api/ops/codex/reconnect', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const sess = getSessionFromReq(req);
  if (!sess) return res.status(401).json({ ok:false, error:'no_session' });
  try { gw.ws && gw.ws.close && gw.ws.close(); } catch {}
  setTimeout(connectGateway, 50);
  logWork('ops.codex.reconnect', {});
  res.json({ ok:true });
});

// --- Together.ai Ops integration (config + test) ---
app.get('/api/ops/together', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const sess = getSessionFromReq(req);
  if (!sess) return res.status(401).json({ ok:false, error:'no_session' });
  const cfg = readTogetherCfg();
  const maskedKey = cfg.apiKey ? (String(cfg.apiKey).slice(0,4) + '********' + String(cfg.apiKey).slice(-4)) : '';
  res.json({ ok:true, config: { baseUrl: cfg.baseUrl, model: cfg.model, hasKey: !!cfg.apiKey, maskedKey, updatedAt: cfg.updatedAt || null } });
});

app.post('/api/ops/together', express.json({ limit: '50kb' }), (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const sess = getSessionFromReq(req);
  if (!sess) return res.status(401).json({ ok:false, error:'no_session' });

  const baseUrl = String(req.body?.baseUrl || '').trim();
  const model = String(req.body?.model || '').trim();
  const apiKey = (typeof req.body?.apiKey === 'string') ? String(req.body.apiKey) : null; // null = don't change
  const clearKey = String(req.body?.clearKey || '') === '1';

  const patch = {};
  if (baseUrl) patch.baseUrl = baseUrl.replace(/\/$/, '');
  if (model) patch.model = model;
  if (clearKey) patch.apiKey = '';
  else if (apiKey !== null) patch.apiKey = apiKey.trim();

  const next = writeTogetherCfg(patch);
  if (!next) return res.status(500).json({ ok:false, error:'write_failed' });

  logWork('ops.together.saved', { baseUrl: next.baseUrl, model: next.model, hasKey: !!next.apiKey });
  res.json({ ok:true, config: { baseUrl: next.baseUrl, model: next.model, hasKey: !!next.apiKey, updatedAt: next.updatedAt || null } });
});

app.get('/api/ops/together/serverless-models', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const sess = getSessionFromReq(req);
  if (!sess) return res.status(401).json({ ok:false, error:'no_session' });

  // Best-effort scrape from Together docs (no auth). Cached lightly by client anyway.
  const url = 'https://docs.together.ai/docs/serverless-models';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'clawd-console' } });
    const html = await r.text();
    // Extract likely "API Model String" tokens: org/model with no spaces.
    const out = new Set();
    const re = /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/g;
    let m;
    while ((m = re.exec(html))) {
      const s = m[0];
      // Filter obvious non-model paths.
      if (s.includes('/docs') || s.includes('/api') || s.includes('/assets')) continue;
      // Heuristic: ignore overly short or non-LLM tokens.
      if (s.length < 6) continue;
      out.add(s);
      if (out.size > 250) break;
    }
    const models = Array.from(out).sort();
    return res.json({ ok:true, url, models });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e), url });
  }
});

app.post('/api/ops/together/test', express.json({ limit: '50kb' }), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const sess = getSessionFromReq(req);
  if (!sess) return res.status(401).json({ ok:false, error:'no_session' });

  const cfg = readTogetherCfg();
  const model = String(req.body?.model || cfg.model || '').trim();
  let baseUrl = String(req.body?.baseUrl || cfg.baseUrl || '').trim().replace(/\/$/, '');
  // Guardrail: Together has a "Dedicated Endpoints" URL pattern like /models/<org>/<model>.
  // Serverless chat completions should use the root API base (e.g. https://api.together.xyz).
  if (/api\.together\.(ai|xyz)\/models\//i.test(baseUrl)) {
    baseUrl = 'https://api.together.xyz';
  }
  const apiKey = String(req.body?.apiKey || cfg.apiKey || '').trim();
  const prompt = String(req.body?.prompt || 'Say hello.').slice(0, 4000);

  if (!apiKey) return res.status(400).json({ ok:false, error:'missing_api_key' });
  if (!model) return res.status(400).json({ ok:false, error:'missing_model' });
  if (!baseUrl) return res.status(400).json({ ok:false, error:'missing_base_url' });

  const url = baseUrl + '/v1/chat/completions';
  const started = Date.now();

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 120,
      }),
    });

    const txt = await resp.text();
    let j = null;
    try { j = JSON.parse(txt); } catch { j = null; }

    if (!resp.ok) {
      return res.status(502).json({ ok:false, error:'upstream_http_' + resp.status, ms: Date.now() - started, body: j || txt.slice(0, 1200) });
    }

    const out = j?.choices?.[0]?.message?.content || j?.choices?.[0]?.text || '';
    res.json({ ok:true, ms: Date.now() - started, model, baseUrl, output: String(out || '').slice(0, 1600), raw: j ? undefined : txt.slice(0, 1600) });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e), ms: Date.now() - started, url });
  }
});

app.get('/clawdpub/sop', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const txt = readSopSnippet(200000);
  res.type('text/plain; charset=utf-8').send(txt);
});

const ADMINONLY_ENABLED = String(process.env.ADMINONLY_ENABLED || '').trim() === '1';

app.get('/adminonly', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!ADMINONLY_ENABLED) return res.status(404).type('text/plain').send('Not found');

  // Hostname-gated admin: only expose admin surfaces on claw.nwesource.com
  // (app.clawdconsole.com remains a non-admin preview host.)
  const host = String(req.headers.host || '').split(':')[0].trim().toLowerCase();
  if (host && host !== 'claw.nwesource.com') {
    return res.status(404).type('text/plain').send('Not found');
  }

  res.type('text/html; charset=utf-8').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CC Admin</title>
  <meta name="robots" content="noindex" />
  <link rel="stylesheet" href="/static/apps-menu.css" />
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

    /* Layout safety: prevent overlap by forcing responsive flow */
    *{ box-sizing: border-box; }
    textarea,input,select{ max-width:100%; }

    .admGrid2{ display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:12px; align-items:start; }
    @media (max-width: 980px){ .admGrid2{ grid-template-columns: 1fr; } }

    .admSubCard{ background: rgba(0,0,0,0.12); }
    .admFieldLabel{ margin-bottom:6px; }
    .admTextarea{
      width:100%;
      min-height:240px;
      padding:10px 12px;
      border-radius:12px;
      border:1px solid rgba(255,255,255,0.14);
      background:#0d1426;
      color:var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size:12px;
      line-height:1.35;
    }
    .admRow{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
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
      <button id="admTabApps" class="tabbtn" type="button" style="margin-top:10px;">ClawdApps</button>
      <button id="admTabAdoption" class="tabbtn" type="button" style="margin-top:10px;">Adoption</button>
      <button id="admTabCRM" class="tabbtn" type="button" style="margin-top:10px;">CRM</button>
      <button id="admTabChangelog" class="tabbtn" type="button" style="margin-top:10px;">Changelog</button>
      <button id="admTabFeatures" class="tabbtn" type="button" style="margin-top:10px;">Features</button>
      <button id="admTabBranding" class="tabbtn" type="button" style="margin-top:10px;">Branding</button>
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

      <div id="admPanelApps" class="card" style="display:none;">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:baseline; flex-wrap:wrap;">
          <h1 style="margin:0; font-size:18px;">ClawdApps</h1>
          <div class="muted">Modules + structure overview</div>
        </div>
        <div class="muted" style="margin-top:8px;">Goal: mirror the ecosystem structure (Console parent + Hub + nested modules) like the transcript.</div>

        <div style="margin-top:12px; display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:12px; align-items:start;">
          <div class="card" style="background: rgba(0,0,0,0.12);">
            <div style="font-weight:900;">Console</div>
            <div class="muted" style="margin-top:6px;">Primary operator cockpit.</div>
            <div style="margin-top:10px; display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:10px;">
              ${[
                ['Transcript', '/transcript'],
                ['PM', '/pm'],
                ['Queue', '/apps/queue'],
                ['Admin', '/adminonly'],
              ].map(([t,href]) => (
                `<div class="card" style="background: rgba(255,255,255,0.03); padding:10px;">
                  <div style="font-weight:800;">${t}</div>
                  <div class="muted">${href}</div>
                </div>`
              )).join('')}
            </div>
          </div>

          <div class="card" style="background: rgba(0,0,0,0.12);">
            <div style="font-weight:900;">ClawdApps Hub</div>
            <div class="muted" style="margin-top:6px;">Directory / lobby (map-only): <code>/apps</code></div>

            <div style="margin-top:10px; display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:10px;">
              ${[
                ['ClawdPM', '/pm'],
                ['ClawdScript', '/apps/script'],
                ['ClawdName', '/name'],
                ['ClawdRepo', '/apps/repo'],
                ['ClawdCode', '/apps/code'],
                ['ClawdSec', '/apps/sec'],
                ['ClawdOps', '/apps/ops'],
                ['ClawdPub', '/apps/pub'],
                ['ClawdBuild', '/apps/build'],
                ['ClawdQueue', '/apps/queue'],
              ].map(([t,href]) => (
                `<div class="card" style="background: rgba(255,255,255,0.03); padding:10px;">
                  <div style="font-weight:800;">${t}</div>
                  <div class="muted">${href}</div>
                </div>`
              )).join('')}
            </div>
          </div>
        </div>

        <div style="margin-top:12px; border-top:1px solid rgba(255,255,255,0.10); padding-top:12px;" class="muted">Divider: Console section above, ClawdApps Hub modules below.</div>
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
            <div style="font-weight:900; font-size:26px; margin-top:6px;" id="adoptTotal">-</div>
            <div class="muted" style="margin-top:6px;">(Clawdbot + Moltbot + Console)</div>
          </div>
          <div style="border:1px solid rgba(255,255,255,0.10); border-radius:14px; padding:12px; background: rgba(255,255,255,0.03);">
            <div class="muted">Clawdbot installs</div>
            <div style="font-weight:900; font-size:26px; margin-top:6px;" id="adoptClawdbot">-</div>
          </div>
          <div style="border:1px solid rgba(255,255,255,0.10); border-radius:14px; padding:12px; background: rgba(255,255,255,0.03);">
            <div class="muted">Clawd Console installs</div>
            <div style="font-weight:900; font-size:26px; margin-top:6px;" id="adoptConsole">-</div>
            <div class="muted" style="margin-top:6px;">Console adoption rate: <span id="adoptRate">-</span></div>
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

      <div id="admPanelChangelog" class="card" style="display:none;">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:baseline; flex-wrap:wrap;">
          <h1 style="margin:0; font-size:18px;">Changelog</h1>
          <div class="muted">Patch notes + commit log</div>
        </div>
        <div class="muted" style="margin-top:8px;">Notes source: <code>${DATA_DIR}/changelog.jsonl</code></div>

        <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap; align-items:center;">
          <button id="chgRefresh" class="tabbtn" type="button" style="width:auto;">Refresh</button>
          <span class="muted" id="chgCount"></span>
        </div>

        <div style="margin-top:12px; border:1px solid rgba(255,255,255,0.10); border-radius:12px; padding:10px; background: rgba(0,0,0,0.12);">
          <div class="muted" style="margin-bottom:10px;">This page is generated from transcript history. No manual edits.</div>
          <div class="row" style="gap:10px; flex-wrap:wrap; align-items:center;">
            <button id="chgUpdate" class="tabbtn" type="button" style="width:auto;">Update Changelog</button>
            <button id="chgRebuild" class="tabbtn" type="button" style="width:auto;">Rebuild</button>
            <span class="muted" id="chgSaved"></span>
          </div>
        </div>

        <div id="chgList" style="margin-top:12px;"></div>
        <div class="muted" style="margin-top:12px;">Tip: this is for operator-facing patch notes; the commit list is still available in the Repo tab in the main Console.</div>
      </div>

      <div id="admPanelFeatures" class="card" style="display:none;">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:baseline; flex-wrap:wrap;">
          <h1 style="margin:0; font-size:18px;">Features (placeholder)</h1>
          <div class="muted">ClawdWork • AI Memory</div>
        </div>

        <div class="muted" style="margin-top:10px; line-height:1.55;">
          Goal: a THOROUGH, living catalog of everything shipped in ClawdConsole, organized two ways:
          <ul>
            <li><b>By Widget / Surface</b> (Console Home, ClawdWork, ClawdList, Transcript, ClawdPM, ClawdCode, ClawdOps, Admin, etc.)</li>
            <li><b>By Solution Category</b> (AI Memory & continuity, operator safety, automation/queueing, publishing, debugging/observability, onboarding, etc.)</li>
          </ul>
          Each feature becomes a card with:
          <ul>
            <li><b>Feature name</b> + status (draft/ready)</li>
            <li><b>Problem it solves</b> (pain)</li>
            <li><b>How to use</b> (steps)</li>
            <li><b>Where it lives</b> (route + widget)</li>
            <li><b>Proof</b> (screenshot or transcript link/message id)</li>
          </ul>

          Not building the full system yet — this is the placeholder + agreed direction.
        </div>
      </div>

      <div id="admPanelBranding" class="card" style="display:none;">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:baseline; flex-wrap:wrap;">
          <h1 style="margin:0; font-size:18px;">Branding</h1>
          <div class="muted">Shared UI primitives</div>
        </div>

        <div class="card admSubCard" style="margin-top:12px;">
          <div style="font-weight:900;">Menus</div>
          <div class="muted" style="margin-top:6px;">This controls the shared <b>ClawdApps</b> dropdown style for all apps pages.</div>

          <div class="admGrid2" style="margin-top:12px;">
            <div style="min-width:0;">
              <div class="muted admFieldLabel">CSS overrides</div>
              <textarea id="brandMenuCss" class="admTextarea"></textarea>
              <div class="admRow" style="margin-top:10px;">
                <button id="brandMenuSave" class="tabbtn" type="button" style="width:auto;">Save</button>
                <button id="brandMenuReset" class="tabbtn" type="button" style="width:auto;">Reset</button>
                <span class="muted" id="brandMenuSaved"></span>
              </div>
            </div>

            <div style="min-width:0;">
              <div class="muted admFieldLabel">Preview</div>
              <div class="card" style="background: rgba(255,255,255,0.03); box-shadow:none;">
                <div style="display:flex; justify-content:flex-end; flex-wrap:wrap; gap:10px;">${appsMenuHtml('/adminonly')}</div>
                <div class="muted" style="margin-top:12px;">Note: base menu CSS is fixed; this textarea is for overrides only.</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="muted" style="margin-top:12px;">More admin tabs coming.</div>
    </main>
  </div>

  <script src="/static/adminonly.js"></script>
  <script src="/static/apps-menu.js"></script>
</body>
</html>`);
});

// Branding menu API (adminonly)
app.get('/admin/api/branding/menu', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!ADMINONLY_ENABLED) return res.status(404).json({ ok:false, error:'disabled' });
  const host = String(req.headers.host || '').split(':')[0].trim().toLowerCase();
  if (host && host !== 'claw.nwesource.com') return res.status(404).json({ ok:false, error:'not_found' });
  const sess = getSessionFromReq(req);
  if (!sess) return res.status(401).json({ ok:false, error:'no_session' });
  const brand = readBrandingMenu();
  res.json({ ok:true, branding: brand });
});

app.post('/admin/api/branding/menu', express.json({ limit: '200kb' }), (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!ADMINONLY_ENABLED) return res.status(404).json({ ok:false, error:'disabled' });
  const host = String(req.headers.host || '').split(':')[0].trim().toLowerCase();
  if (host && host !== 'claw.nwesource.com') return res.status(404).json({ ok:false, error:'not_found' });
  const sess = getSessionFromReq(req);
  if (!sess) return res.status(401).json({ ok:false, error:'no_session' });

  const cssOverrides = (typeof req.body?.cssOverrides === 'string') ? req.body.cssOverrides : '';
  // Guardrail: keep it reasonably small.
  if (cssOverrides.length > 50000) return res.status(400).json({ ok:false, error:'too_large' });

  const next = writeBrandingMenu({ cssOverrides });
  logWork('branding.menu.saved', { bytes: cssOverrides.length });
  res.json({ ok:true, branding: next });
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

const CHANGELOG_FILE = path.join(DATA_DIR, 'changelog.jsonl');
function appendChangelog(entry){
  const e = entry || {};
  const out = {
    id: 'chg_' + Date.now().toString(16) + '_' + Math.random().toString(16).slice(2),
    ts: new Date().toISOString(),
    title: String(e.title || '').trim().slice(0, 200),
    body: String(e.body || '').trim().slice(0, 5000),
    build: BUILD,
  };
  if (!out.title) out.title = '(untitled)';
  fs.appendFileSync(CHANGELOG_FILE, JSON.stringify(out) + '\n', 'utf8');
  return out;
}
function readChangelog(limit){
  const n = Math.max(1, Math.min(500, Number(limit || 100)));
  if (!fs.existsSync(CHANGELOG_FILE)) return [];
  const lines = fs.readFileSync(CHANGELOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
  const slice = lines.slice(-n);
  const out = [];
  for (const ln of slice){
    try { out.push(JSON.parse(ln)); } catch {}
  }
  return out.reverse();
}


function updateChangelogFromTranscript({ mode } = {}){
  const m = (mode === 'rebuild') ? 'rebuild' : 'append';
  const buildRe = /(Build\s*(?:is\s*now|bumped\s*to|now)\s*[:=]?\s*(\d{4}-\d{2}-\d{2}\.\d+))/i;
  const lines = fs.existsSync(TRANSCRIPT_FILE)
    ? fs.readFileSync(TRANSCRIPT_FILE, 'utf8').split(/\r?\n/).filter(Boolean)
    : [];

  const existing = new Set();
  if (fs.existsSync(CHANGELOG_FILE) && m === 'append') {
    for (const ln of fs.readFileSync(CHANGELOG_FILE,'utf8').split(/\r?\n/).filter(Boolean)) {
      try { const e = JSON.parse(ln); if (e && e.build) existing.add(String(e.build)); } catch {}
    }
  }

  if (m === 'rebuild') {
    try { fs.writeFileSync(CHANGELOG_FILE, '', 'utf8'); } catch {}
    existing.clear();
  }

  let added = 0;
  for (const ln of lines){
    let obj; try { obj = JSON.parse(ln); } catch { obj = null; }
    if (!obj || obj.r !== 'assistant') continue;
    const text = String(obj.x || '');
    const m2 = text.match(buildRe);
    if (!m2) continue;
    const build = m2[2];
    if (existing.has(build)) continue;

    const parts = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const body = parts.slice(0, 18).join('\n').slice(0, 5000);

    appendChangelog({ title: 'Console build ' + build, body, build });
    existing.add(build);
    added++;
  }

  return { ok: true, mode: m, added };
}

app.post('/api/changelog/update', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const mode = (req.body && req.body.mode) ? String(req.body.mode) : 'append';
  const out = updateChangelogFromTranscript({ mode });
  logWork('changelog.updated', out);
  res.json(out);
});

app.get('/api/changelog', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, entries: readChangelog(req.query?.limit || 200) });
});

app.post('/api/changelog', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const title = String(req.body?.title || '').trim();
  const body = String(req.body?.body || '').trim();
  const saved = appendChangelog({ title, body });
  logWork('changelog.saved', { id: saved.id, build: saved.build });
  res.json({ ok: true, entry: saved });
});

// --- ClawdPub: published artifacts index ---
const PUB_FILE = path.join(__dirname, '..', 'clawdpub', 'published.json');
app.get('/api/pub/items', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const raw = fs.existsSync(PUB_FILE) ? fs.readFileSync(PUB_FILE, 'utf8') : '[]';
    let items; try { items = JSON.parse(raw); } catch { items = []; }
    if (!Array.isArray(items)) items = [];
    const counts = {};
    for (const it of items) {
      const c = (it && it.category) ? String(it.category) : 'other';
      counts[c] = (counts[c] || 0) + 1;
    }
    res.json({ ok: true, counts, items });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

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

app.get('/api/repo/install', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const guidePath = path.join(__dirname, '..', 'docs', 'SETUP-QUESTIONS.md');
    const guide = fs.existsSync(guidePath) ? fs.readFileSync(guidePath, 'utf8') : '';
    const tarUrl = (process.env.INSTALL_TAR_URL || '').trim();
    res.json({ ok: true, tarUrl: tarUrl || null, guide: guide || '' });
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

// --- ClawdBuild: Templates index (file-backed) ---
const CLAWDBUILD_TEMPLATES_FILE = path.join(DATA_DIR, 'clawdbuild-templates.json');
function readBuildTemplates(){
  const fallback = { updatedAt: null, templates: [
    {
      id: 'tpl_nextjs_tailwind',
      title: 'Next.js + Tailwind (starter)',
      repoUrl: 'https://github.com/vercel/next.js/tree/canary/examples/with-tailwindcss',
      stack: 'Next.js',
      tags: ['tailwind', 'frontend'],
      desc: 'Good default for landing pages + dashboards.',
      notes: 'Start here for fast UI work.'
    }
  ]};
  return readJson(CLAWDBUILD_TEMPLATES_FILE, fallback);
}
function writeBuildTemplates(obj){
  const out = (obj && Array.isArray(obj.templates)) ? obj : readBuildTemplates();
  out.updatedAt = new Date().toISOString();
  out.templates = Array.isArray(out.templates) ? out.templates : [];
  writeJson(CLAWDBUILD_TEMPLATES_FILE, out);
  return out;
}

app.get('/api/build/templates', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const j = readBuildTemplates();
  res.json({ ok:true, updatedAt: j.updatedAt, templates: j.templates || [] });
});

app.post('/api/build/templates', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const tpl = req.body && req.body.template;
  if (!tpl || typeof tpl !== 'object') return res.status(400).json({ ok:false, error:'Expected {template}' });

  const cur = readBuildTemplates();
  cur.templates = Array.isArray(cur.templates) ? cur.templates : [];

  const id = String(tpl.id || '').trim() || ('tpl_' + crypto.randomBytes(6).toString('hex'));
  const next = {
    id,
    title: String(tpl.title || '').trim().slice(0, 200),
    repoUrl: String(tpl.repoUrl || '').trim().slice(0, 500),
    stack: String(tpl.stack || '').trim().slice(0, 80),
    tags: Array.isArray(tpl.tags) ? tpl.tags.map(x => String(x||'').trim()).filter(Boolean).slice(0, 12) : [],
    desc: String(tpl.desc || tpl.description || '').trim().slice(0, 500),
    notes: String(tpl.notes || '').trim().slice(0, 4000),
    updatedAt: new Date().toISOString(),
  };

  const i = cur.templates.findIndex(x => x && String(x.id||'') === id);
  if (i >= 0) cur.templates[i] = { ...cur.templates[i], ...next };
  else cur.templates.unshift(next);

  const saved = writeBuildTemplates(cur);
  logWork('build.templates.saved', { id });
  res.json({ ok:true, updatedAt: saved.updatedAt, templates: saved.templates });
});

app.post('/api/build/templates/delete', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.body?.id || '').trim();
  if (!id) return res.status(400).json({ ok:false, error:'Missing id' });

  const cur = readBuildTemplates();
  cur.templates = Array.isArray(cur.templates) ? cur.templates : [];
  const before = cur.templates.length;
  cur.templates = cur.templates.filter(x => x && String(x.id||'') !== id);
  const saved = writeBuildTemplates(cur);
  logWork('build.templates.deleted', { id, before, after: saved.templates.length });
  res.json({ ok:true, updatedAt: saved.updatedAt, templates: saved.templates });
});

// --- ClawdCode (browse + edit files under selected workspace root) ---
function safeCodePath(rootAbs, rel){
  const base = path.resolve(String(rootAbs || ''));
  const r = String(rel || '').replace(/\\/g, '/');
  const clean = r.replace(/^\/+/, '');
  const abs = path.resolve(base, clean);
  if (!abs.startsWith(base + path.sep) && abs !== base) return null;
  return abs;
}

function codeModeFor(rel, abs){
  const p = String(rel || '').replace(/\\/g,'/');
  const base = path.basename(abs || p);

  // default
  let mode = 'rw';

  // protect common secret-bearing files (visible in tree, but blocked from open unless break-glass)
  const secretNames = [
    '.env', '.env.local', '.env.development', '.env.production',
    '.npmrc', '.netrc',
    'id_rsa', 'id_ed25519',
    'auth-profiles.json',
  ];

  const secretExts = ['.pem','.key','.p12','.pfx','.kdbx'];

  if (secretNames.includes(base)) mode = 'list';
  if (base.startsWith('.env.')) mode = 'list';
  if (secretExts.some(x => base.toLowerCase().endsWith(x))) mode = 'list';

  // never show these even in tree if they exist under repo (rare)
  if (p.replace(/\/+$/,'') === '.git' || p.startsWith('.git/')) mode = 'deny';

  return mode;
}

function getSessionFromReq(req){
  const cookies = parseCookies(req);
  const tok = cookies[SESS_COOKIE];
  if (!tok) return null;
  const sess = sessions.get(tok);
  if (!sess) return null;
  if (typeof sess === 'object') return sess;
  // legacy sessions map value
  return { exp: sess, unlocks: {} };
}

function hasBreakglass(req, wsId, rel, wantWrite){
  const sess = getSessionFromReq(req);
  if (!sess || !sess.unlocks) return false;
  const k = String(wsId || '') + ':' + String(rel||'');
  const u = sess.unlocks[k];
  if (!u) return false;
  if (Number(u.until || 0) < Date.now()) return false;
  if (wantWrite && !u.write) return false;
  return true;
}

app.get('/api/code/tree', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ws = currentCodeWorkspace(req);
  const rel = String(req.query.path || '').trim();
  const abs = safeCodePath(ws.root, rel);
  if (!abs) return res.status(400).json({ ok:false, error:'bad_path' });

  try {
    const st = fs.statSync(abs);
    if (!st.isDirectory()) return res.status(400).json({ ok:false, error:'not_dir' });
    const names = fs.readdirSync(abs);
    const items = names
      .filter(n => !!n)
      .map(n => {
        const p = path.join(abs, n);
        let s; try { s = fs.statSync(p); } catch { s = null; }
        const isDir = !!(s && s.isDirectory());
        const relp = path.relative(ws.root, p).replace(/\\/g,'/');
        const mode = isDir ? 'rw' : codeModeFor(relp, p);
        return {
          name: n,
          type: isDir ? 'dir' : 'file',
          path: relp,
          mode,
          size: s && !isDir ? s.size : null,
          mtime: s ? new Date(s.mtimeMs).toISOString() : null,
        };
      })
      .sort((a,b) => (a.type === b.type) ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1));

    res.json({ ok:true, workspace: { id: ws.id, title: ws.title, root: ws.root }, path: path.relative(ws.root, abs).replace(/\\/g,'/'), items });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

app.get('/api/code/file', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ws = currentCodeWorkspace(req);
  const rel = String(req.query.path || '').trim();
  const abs = safeCodePath(ws.root, rel);
  if (!abs) return res.status(400).json({ ok:false, error:'bad_path' });

  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return res.status(400).json({ ok:false, error:'not_file' });

    const relp = path.relative(ws.root, abs).replace(/\\/g,'/');
    const mode = codeModeFor(relp, abs);

    if (mode === 'deny') return res.status(404).json({ ok:false, error:'not_found' });

    // list-mode: visible, but not renderable unless break-glass
    if (mode === 'list' && !hasBreakglass(req, ws.id, relp, false)) {
      return res.status(403).json({
        ok:false,
        error:'blocked',
        mode,
        path: relp,
        size: st.size,
        mtime: new Date(st.mtimeMs).toISOString(),
        why: 'This file is protected and cannot be displayed in the browser UI without break-glass.'
      });
    }

    if (st.size > 1024*1024) return res.status(413).json({ ok:false, error:'file_too_large' });
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return res.status(415).json({ ok:false, error:'binary_file' });
    const text = buf.toString('utf8');
    res.json({ ok:true, mode, path: relp, size: st.size, mtime: new Date(st.mtimeMs).toISOString(), text });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

app.post('/api/code/file', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ws = currentCodeWorkspace(req);
  const rel = String(req.body?.path || '').trim();
  const text = String(req.body?.text ?? '');
  const abs = safeCodePath(ws.root, rel);
  if (!abs) return res.status(400).json({ ok:false, error:'bad_path' });
  if (Buffer.byteLength(text, 'utf8') > 1024*1024) return res.status(413).json({ ok:false, error:'payload_too_large' });

  try {
    const st = fs.existsSync(abs) ? fs.statSync(abs) : null;
    if (st && !st.isFile()) return res.status(400).json({ ok:false, error:'not_file' });

    const relp = path.relative(ws.root, abs).replace(/\\/g,'/');
    const mode = codeModeFor(relp, abs);
    if (mode === 'deny') return res.status(404).json({ ok:false, error:'not_found' });

    if (mode === 'list' && !hasBreakglass(req, ws.id, relp, true)) {
      return res.status(403).json({ ok:false, error:'blocked_write', mode, path: relp, why:'Protected file; use break-glass or edit locally.' });
    }

    fs.writeFileSync(abs, text, 'utf8');
    const st2 = fs.statSync(abs);
    logWork('code.file.saved', { path: relp, bytes: Buffer.byteLength(text,'utf8') });
    res.json({ ok:true, mode, size: st2.size, mtime: new Date(st2.mtimeMs).toISOString() });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

app.get('/api/code/workspaces', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ws = currentCodeWorkspace(req);
  const workspaces = listCodeWorkspaces();
  res.json({ ok:true, workspaces, current: ws.id });
});

app.post('/api/code/workspace', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.body?.id || '').trim();
  const workspaces = listCodeWorkspaces();
  const ws = workspaces.find(w => w && w.id === id);
  if (!ws) return res.status(400).json({ ok:false, error:'bad_workspace' });
  const sess = getSessionFromReq(req);
  if (!sess) return res.status(401).json({ ok:false, error:'no_session' });
  sess.codeWorkspace = ws.id;
  logWork('code.workspace.set', { workspace: ws.id });
  res.json({ ok:true, current: ws.id });
});

app.post('/api/code/workspace/create', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const sess = getSessionFromReq(req);
  if (!sess) return res.status(401).json({ ok:false, error:'no_session' });

  const title = String(req.body?.title || '').trim().slice(0, 80);
  if (!title) return res.status(400).json({ ok:false, error:'missing_title' });

  const id = 'ws_' + crypto.randomBytes(6).toString('hex');
  const slug = slugifyWsTitle(title);
  const root = path.join(CODE_WS_ROOT, slug);

  try {
    fs.mkdirSync(root, { recursive:true });
    const cur = loadCodeWs();
    cur.workspaces = Array.isArray(cur.workspaces) ? cur.workspaces : [];
    cur.workspaces.push({ id, title, root, git: null, createdAt: new Date().toISOString() });
    saveCodeWs(cur);
    sess.codeWorkspace = id;
    logWork('code.workspace.created', { id, title, root });
    res.json({ ok:true, workspace: { id, title, root, git:null }, current: id });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

app.post('/api/code/git/connect', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const sess = getSessionFromReq(req);
  if (!sess) return res.status(401).json({ ok:false, error:'no_session' });

  const wsId = String(req.body?.workspaceId || sess.codeWorkspace || '').trim();
  const remoteUrl = String(req.body?.remoteUrl || '').trim();
  const branch = String(req.body?.branch || '').trim();

  if (!wsId) return res.status(400).json({ ok:false, error:'missing_workspace' });
  if (!remoteUrl) return res.status(400).json({ ok:false, error:'missing_remote' });

  // only github for now
  if (!/^https:\/\/(www\.)?github\.com\//i.test(remoteUrl) && !/^git@github\.com:/i.test(remoteUrl)) {
    return res.status(400).json({ ok:false, error:'only_github_supported' });
  }

  // Prefer GitHub CLI auth (already set up on this host). Token env is optional fallback.
  const execFileSync = require('child_process').execFileSync;
  let ghOk = false;
  try {
    execFileSync('gh', ['auth','status','-h','github.com'], { stdio:['ignore','pipe','pipe'] });
    ghOk = true;
  } catch { ghOk = false; }

  const token = String(process.env.CODE_GIT_TOKEN || process.env.GITHUB_TOKEN || '').trim();
  if (!ghOk && !token) {
    return res.status(400).json({ ok:false, error:'missing_auth', hint:'Login gh (preferred) or set CODE_GIT_TOKEN in /etc/clawdio-console.env' });
  }

  const wss = listCodeWorkspaces();
  const ws = wss.find(w => w && w.id === wsId);
  if (!ws) return res.status(400).json({ ok:false, error:'bad_workspace' });

  try {
    fs.mkdirSync(ws.root, { recursive:true });

    // determine if directory is empty enough to clone
    const names = fs.readdirSync(ws.root).filter(n => n && n !== '.DS_Store');
    const hasGit = fs.existsSync(path.join(ws.root, '.git'));

    function parseRepo(u){
      const s = String(u||'').trim();
      let m;
      if ((m = s.match(/^https:\/\/(www\.)?github\.com\/([^\s\/]+)\/([^\s\/]+?)(?:\.git)?\/?$/i))) {
        return m[2] + '/' + m[3];
      }
      if ((m = s.match(/^git@github\.com:([^\s\/]+)\/([^\s\/]+?)(?:\.git)?$/i))) {
        return m[1] + '/' + m[2];
      }
      return '';
    }

    const repo = parseRepo(remoteUrl);
    if (!repo) return res.status(400).json({ ok:false, error:'bad_repo_url' });

    if (!hasGit) {
      if (names.length) return res.status(409).json({ ok:false, error:'workspace_not_empty' });
      if (ghOk) {
        const args = ['repo','clone', repo, ws.root];
        if (branch) args.push('--', '--branch', branch);
        execFileSync('gh', args, { stdio:'pipe' });
      } else {
        // fallback: token-injected https clone
        const cloneUrl = ('https://x-access-token:' + encodeURIComponent(token) + '@github.com/' + repo + '.git');
        execFileSync('git', ['clone', cloneUrl, ws.root], { stdio:'pipe' });
      }
    } else {
      // repo exists: ensure origin remote set and fetch
      try { execFileSync('git', ['remote','remove','origin'], { cwd: ws.root, stdio:'pipe' }); } catch {}
      execFileSync('git', ['remote','add','origin', remoteUrl], { cwd: ws.root, stdio:'pipe' });
      execFileSync('git', ['fetch','--all','--prune'], { cwd: ws.root, stdio:'pipe' });
      if (branch) {
        try { execFileSync('git', ['checkout', branch], { cwd: ws.root, stdio:'pipe' }); } catch {
          execFileSync('git', ['checkout','-b', branch, 'origin/' + branch], { cwd: ws.root, stdio:'pipe' });
        }
      }
    }

    // persist mapping (no token)
    const cur = loadCodeWs();
    cur.workspaces = Array.isArray(cur.workspaces) ? cur.workspaces : [];
    const i = cur.workspaces.findIndex(w => w && w.id === wsId);
    if (i >= 0) {
      cur.workspaces[i].git = { remote: remoteUrl, branch: branch || '' };
      cur.workspaces[i].updatedAt = new Date().toISOString();
    }
    saveCodeWs(cur);

    logWork('code.git.connected', { workspace: wsId, remote: remoteUrl, branch: branch || '' });
    res.json({ ok:true });
  } catch (e) {
    logWork('code.git.connect.error', { workspace: wsId, error: String(e) });
    res.status(500).json({ ok:false, error: String(e) });
  }
});

app.post('/api/code/git/disconnect', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const sess = getSessionFromReq(req);
  if (!sess) return res.status(401).json({ ok:false, error:'no_session' });
  const wsId = String(req.body?.workspaceId || sess.codeWorkspace || '').trim();
  if (!wsId) return res.status(400).json({ ok:false, error:'missing_workspace' });

  try {
    const cur = loadCodeWs();
    cur.workspaces = Array.isArray(cur.workspaces) ? cur.workspaces : [];
    const i = cur.workspaces.findIndex(w => w && w.id === wsId);
    if (i >= 0) {
      cur.workspaces[i].git = null;
      cur.workspaces[i].updatedAt = new Date().toISOString();
    }
    saveCodeWs(cur);
    logWork('code.git.disconnected', { workspace: wsId });
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

app.post('/api/code/breakglass', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const pass = String(req.body?.pass || '');
  const rel = String(req.body?.path || '').trim();
  const write = !!req.body?.write;
  const mins = Math.max(1, Math.min(60, Number(req.body?.minutes || 10)));

  const BG_PASS = String(process.env.CODE_BREAKGLASS_PASS || '').trim();
  if (!BG_PASS) return res.status(400).json({ ok:false, error:'breakglass_disabled' });
  if (!pass || pass !== BG_PASS) return res.status(403).json({ ok:false, error:'bad_pass' });

  const ws = currentCodeWorkspace(req);
  const abs = safeCodePath(ws.root, rel);
  if (!abs) return res.status(400).json({ ok:false, error:'bad_path' });

  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return res.status(400).json({ ok:false, error:'not_file' });

    const relp = path.relative(ws.root, abs).replace(/\\/g,'/');
    const mode = codeModeFor(relp, abs);
    if (mode !== 'list') return res.json({ ok:true, path: relp, mode, note:'not_protected' });

    const sess = getSessionFromReq(req);
    if (!sess) return res.status(401).json({ ok:false, error:'no_session' });
    sess.unlocks = sess.unlocks || {};

    const until = Date.now() + (mins * 60 * 1000);
    const k = ws.id + ':' + relp;
    sess.unlocks[k] = { until, write: write ? true : false };

    logWork('code.breakglass', { workspace: ws.id, path: relp, minutes: mins, write: !!write });
    res.json({ ok:true, workspace: ws.id, path: relp, mode, until: new Date(until).toISOString(), write: !!write });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

// --- ClawdOps (operator profile + repeated questions + brand) ---
const OPS_PROFILE_FILE = path.join(DATA_DIR, 'ops-profile.md');

// Brand / assistant name (UI only)
const BRAND_FILE = path.join(DATA_DIR, 'brand.json');
function readBrand(){
  try {
    const j = readJson(BRAND_FILE, null);
    const assistantName = (j && typeof j.assistantName === 'string' && j.assistantName.trim()) ? j.assistantName.trim().slice(0, 48) : 'Clawdio';
    return { assistantName };
  } catch {
    return { assistantName: 'Clawdio' };
  }
}
function writeBrand(patch){
  const cur = readBrand();
  const next = { ...cur };
  if (patch && typeof patch.assistantName === 'string') {
    const v = patch.assistantName.trim().slice(0, 48);
    if (v) next.assistantName = v;
  }
  try {
    writeJson(BRAND_FILE, next);
    return next;
  } catch {
    return null;
  }
}

app.get('/api/ops/brand', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    return res.json({ ok:true, brand: readBrand() });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e) });
  }
});
app.post('/api/ops/brand', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const assistantName = String(req.body?.assistantName || '');
    const out = writeBrand({ assistantName });
    if (!out) return res.status(500).json({ ok:false, error:'write_failed' });
    logWork('ops.brand.saved', { assistantName: out.assistantName });
    return res.json({ ok:true, brand: out });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

app.get('/api/ops/profile', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const text = fs.existsSync(OPS_PROFILE_FILE) ? fs.readFileSync(OPS_PROFILE_FILE, 'utf8') : '';
    res.json({ ok:true, text });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});
app.post('/api/ops/profile', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const text = String(req.body?.text || '');
    fs.writeFileSync(OPS_PROFILE_FILE, text, 'utf8');
    logWork('ops.profile.saved', { bytes: Buffer.byteLength(text, 'utf8') });
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

const OPS_MEMORY_PATH = '/home/master/clawd/memory/clawdops-profile.md';
app.post('/api/ops/commit', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const text = String(req.body?.text || '');
    fs.mkdirSync(path.dirname(OPS_MEMORY_PATH), { recursive:true });
    fs.writeFileSync(OPS_MEMORY_PATH, text, 'utf8');
    logWork('ops.profile.committed', { path: OPS_MEMORY_PATH, bytes: Buffer.byteLength(text, 'utf8') });
    res.json({ ok:true, path: OPS_MEMORY_PATH });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

const AUTO_STATE_FILE = path.join(DATA_DIR, 'auto-state.md');
function readAutoStateMeta(){
  try {
    if (!fs.existsSync(AUTO_STATE_FILE)) return { fileUpdatedAt: '' };
    const raw = fs.readFileSync(AUTO_STATE_FILE, 'utf8');
    const head = raw.split(/\r?\n/).slice(0, 12).join('\n');
    const m = head.match(/\bUpdated:\s*([^\n]+)\s*/i);
    return { fileUpdatedAt: m ? String(m[1] || '').trim() : '' };
  } catch {
    return { fileUpdatedAt: '' };
  }
}

const AUTO_STATE_MAX_LINES = Math.max(50, Math.min(2000, Number(process.env.AUTO_STATE_MAX_LINES || 500)));
const AUTO_STATE_INCLUDE = String(process.env.AUTO_STATE_INCLUDE || 'ops,repo,code,pm,queue,build,publish,upload,bridge,telemetry,security').trim();
const AUTO_STATE_ALLOW_PREFIXES = new Set(AUTO_STATE_INCLUDE.split(',').map(s => s.trim()).filter(Boolean));

function shouldIncludeAutoStateEvent(ev){
  const e = String(ev || '').trim();
  if (!e) return false;
  // Only include "apps work" style events. Use prefix before first dot.
  const head = e.split('.')[0];
  return AUTO_STATE_ALLOW_PREFIXES.has(head);
}

function summarizeAutoStateEvent(entry){
  try {
    const ts = entry && entry.ts ? String(entry.ts) : '';
    const ev = entry && entry.event ? String(entry.event) : '';
    const data = entry && typeof entry.data !== 'undefined' ? entry.data : null;

    // Compact one-line JSON for data (avoid huge blobs)
    let d = '';
    if (data && typeof data === 'object') {
      const slim = Array.isArray(data)
        ? data.slice(0, 6)
        : Object.fromEntries(Object.entries(data).slice(0, 10));
      d = JSON.stringify(slim);
      if (d.length > 240) d = d.slice(0, 240) + '…';
    } else if (typeof data === 'string') {
      d = data.length > 240 ? (data.slice(0, 240) + '…') : data;
      d = JSON.stringify(d);
    } else if (data != null) {
      d = JSON.stringify(data);
    }

    return `- ${ts ? ts.replace('T',' ').slice(0,19) : '(no-ts)'} • ${ev}${d ? (' ' + d) : ''}`;
  } catch {
    return '';
  }
}

function generateAutoStateFromWorklog({ reason } = {}){
  try {
    const now = new Date().toISOString();
    const all = readLastJsonl(WORK_FILE, 2500);
    const lines = [];

    lines.push('# AUTO-STATE');
    lines.push('Updated: ' + now);
    lines.push('Reason: ' + (reason || 'hourly'));
    lines.push('Mode: events-only (apps work)');
    lines.push('');

    // Filter + render newest-last but keep only what fits.
    const filtered = all.filter(x => x && shouldIncludeAutoStateEvent(x.event));
    const rendered = filtered.map(summarizeAutoStateEvent).filter(Boolean);

    // Keep most recent lines up to AUTO_STATE_MAX_LINES (minus header).
    const headLines = lines.length;
    const budget = Math.max(0, AUTO_STATE_MAX_LINES - headLines - 2);
    const tail = budget ? rendered.slice(-budget) : [];

    lines.push('## Recent app worklog events');
    if (!tail.length) lines.push('(none)');
    else lines.push(...tail);

    lines.push('');

    fs.writeFileSync(AUTO_STATE_FILE, lines.join('\n'), 'utf8');
    logWork('ops.auto_state.generated', { reason: reason || 'hourly', lines: lines.length, include: Array.from(AUTO_STATE_ALLOW_PREFIXES) });
    return { ok:true, updatedAt: now, wroteLines: lines.length };
  } catch (e) {
    return { ok:false, error: String(e) };
  }
}

const AUTO_STATE_ACK_FILE = path.join(DATA_DIR, 'auto-state-ack.json');
function readAutoStateAck(){
  try {
    if (!fs.existsSync(AUTO_STATE_ACK_FILE)) return { ackAt:'', updatedAt:'' };
    const j = JSON.parse(fs.readFileSync(AUTO_STATE_ACK_FILE, 'utf8'));
    return { ackAt: String(j.ackAt||''), updatedAt: String(j.updatedAt||'') };
  } catch {
    return { ackAt:'', updatedAt:'' };
  }
}
function writeAutoStateAck({ ackAt, updatedAt }){
  try {
    const next = { ackAt: String(ackAt||''), updatedAt: String(updatedAt||''), wroteAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(AUTO_STATE_ACK_FILE), { recursive:true });
    fs.writeFileSync(AUTO_STATE_ACK_FILE, JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch {
    return null;
  }
}

app.get('/api/ops/auto-state/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const meta = readAutoStateMeta();
    const fileUpdatedAt = meta.fileUpdatedAt || '';
    const ack = readAutoStateAck();
    const aiAckAt = ack.ackAt || '';
    const aiAckUpdatedAt = ack.updatedAt || '';
    const aiCaughtUp = !!fileUpdatedAt && fileUpdatedAt === aiAckUpdatedAt;
    res.json({ ok:true, fileUpdatedAt, aiAckAt, aiAckUpdatedAt, aiCaughtUp });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

let autoStateRehydrate = { inProgress:false, lastSentAt:0, nonce:'', updatedAt:'' };

async function pollForAutoStateAck({ wantLine, fileUpdatedAt, runId }){
  const startedAt = Date.now();
  let last = '';
  while (Date.now() - startedAt < 60_000) {
    await new Promise(r => setTimeout(r, 1100));
    let payload;
    try { payload = await gwSendReq('chat.history', { sessionKey: CONSOLE_SESSION_KEY, limit: 160 }); } catch { payload = null; }
    const messages = payload?.messages;
    if (!Array.isArray(messages)) continue;

    const assistants = messages
      .map(m => (m && m.message) ? m.message : m)
      .filter(m => m && m.role === 'assistant');

    // Scan newest-first for the ACK line.
    for (let k = assistants.length - 1; k >= 0; k--) {
      const txt = extractTextFromGatewayMessage(assistants[k]);
      if (!txt || txt === last) continue;
      last = txt;
      const line = String(txt).trim().split(/\r?\n/)[0];
      if (line === wantLine) {
        const out = writeAutoStateAck({ ackAt: new Date().toISOString(), updatedAt: fileUpdatedAt || '' });
        logWork('ops.auto_state.rehydrate.acked', { updatedAt: fileUpdatedAt || '', runId });
        return { ok:true, out };
      }
    }
  }
  return { ok:false, error:'ack_timeout' };
}

app.post('/api/ops/auto-state/rehydrate', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Disabled: too noisy. Re-enable only when we have a safer handshake.
  return res.status(410).json({ ok:false, error:'rehydrate_disabled' });
  try {
    if (!gw.connected) return res.status(409).json({ ok:false, error:'gateway_not_connected' });

    const meta = readAutoStateMeta();
    const fileUpdatedAt = meta.fileUpdatedAt || '';
    const text = fs.existsSync(AUTO_STATE_FILE) ? fs.readFileSync(AUTO_STATE_FILE, 'utf8') : '';
    if (!text.trim()) return res.status(404).json({ ok:false, error:'auto_state_missing' });

    const ack = readAutoStateAck();
    if (fileUpdatedAt && ack && ack.updatedAt === fileUpdatedAt) {
      return res.json({ ok:true, noop:true, fileUpdatedAt, aiAckAt: ack.ackAt, aiAckUpdatedAt: ack.updatedAt });
    }

    // Dedup: if a rehydrate is already in progress, don't spam the model.
    if (autoStateRehydrate.inProgress && autoStateRehydrate.updatedAt === fileUpdatedAt) {
      return res.status(202).json({ ok:true, inProgress:true, fileUpdatedAt });
    }

    const nonce = crypto.randomBytes(6).toString('hex');
    const wantLine = 'AUTO_STATE_ACK Updated=' + (fileUpdatedAt || '(unknown)') + ' Nonce=' + nonce;

    // Strip any trailing "validation" style prompts accidentally embedded in auto-state.
    const safeText = String(text || '').replace(/\n---\s*alladat\s*validation[\s\S]*$/i, '').trimEnd();

    const prompt = [
      'AUTO_STATE_REHYDRATE v1',
      'Updated: ' + (fileUpdatedAt || '(unknown)'),
      'Nonce: ' + nonce,
      '',
      'You are being given the current Console AUTO-STATE. Ingest it as operating context.',
      'Then reply with EXACTLY one line:',
      wantLine,
      '',
      '--- AUTO-STATE BEGIN ---',
      safeText,
      '--- AUTO-STATE END ---',
    ].join('\n');

    const runId = 'rehydrate_' + Date.now().toString(16) + '_' + nonce;

    autoStateRehydrate = { inProgress:true, lastSentAt: Date.now(), nonce, updatedAt: fileUpdatedAt || '' };

    await gwSendReq('chat.send', {
      sessionKey: CONSOLE_SESSION_KEY,
      idempotencyKey: runId,
      message: prompt,
      deliver: true,
    });
    logWork('ops.auto_state.rehydrate.sent', { runId, updatedAt: fileUpdatedAt || '' });

    // respond immediately; poll in background and write ACK file when it arrives
    res.json({ ok:true, sent:true, fileUpdatedAt });

    pollForAutoStateAck({ wantLine, fileUpdatedAt, runId })
      .then((r) => {
        if (!r || !r.ok) logWork('ops.auto_state.rehydrate.timeout', { updatedAt: fileUpdatedAt || '', runId });
      })
      .catch((e) => {
        logWork('ops.auto_state.rehydrate.error', { error: String(e), runId });
      })
      .finally(() => {
        autoStateRehydrate.inProgress = false;
      });
  } catch (e) {
    autoStateRehydrate.inProgress = false;
    logWork('ops.auto_state.rehydrate.error', { error: String(e) });
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

app.get('/api/ops/auto-state', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const text = fs.existsSync(AUTO_STATE_FILE) ? fs.readFileSync(AUTO_STATE_FILE, 'utf8') : '';
    res.json({ ok:true, text });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

app.post('/api/ops/auto-state/generate', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const r = generateAutoStateFromWorklog({ reason: String(req.body?.reason || 'manual') });
    if (!r || !r.ok) return res.status(500).json({ ok:false, error: r ? r.error : 'failed' });
    return res.json({ ok:true, result: r });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// Optional: hourly auto-state generator (events-only). Disabled by default.
if (String(process.env.AUTO_STATE_HOURLY || '').trim() === '1') {
  try {
    generateAutoStateFromWorklog({ reason: 'startup' });
  } catch {}
  setInterval(() => {
    try { generateAutoStateFromWorklog({ reason: 'hourly' }); } catch {}
  }, 60 * 60 * 1000);
}

const CLAWD_RULES_FILE = '/home/master/clawd/memory/clawd-rules.md';
app.get('/api/ops/rules', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const text = fs.existsSync(CLAWD_RULES_FILE) ? fs.readFileSync(CLAWD_RULES_FILE, 'utf8') : '';
    res.json({ ok:true, text });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

app.post('/api/ops/restart', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const confirm = String(req.body?.confirm || '').trim().toUpperCase();
    if (confirm !== 'RESTART') return res.status(400).json({ ok:false, error:'confirm_required' });
    logWork('ops.restart.requested', { by: 'ui' });
    res.json({ ok:true });
    // restart after response so the browser receives OK
    setTimeout(() => {
      try { process.exit(0); } catch {}
    }, 250);
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

app.get('/api/ops/repeated-questions', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
  try {
    const txt = fs.existsSync(TRANSCRIPT_FILE) ? fs.readFileSync(TRANSCRIPT_FILE, 'utf8') : '';
    const lines = txt.split(/\r?\n/).filter(Boolean);

    const map = new Map(); // q -> {count,lastTs}

    for (const ln of lines){
      let o; try { o = JSON.parse(ln); } catch { o = null; }
      if (!o || o.r !== 'assistant') continue;
      const msg = String(o.x || '');
      const ts = String(o.t || '');

      // candidate question lines: either single-line ending with ? or any line containing ?
      const parts = msg.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      for (const p of parts){
        if (!p.includes('?')) continue;
        const q = p.replace(/\s+/g,' ').trim();
        if (q.length < 8 || q.length > 240) continue;
        const key = q.toLowerCase();
        const cur = map.get(key) || { q, count: 0, lastTs: null };
        cur.q = q;
        cur.count++;
        cur.lastTs = ts || cur.lastTs;
        map.set(key, cur);
      }
    }

    const items = Array.from(map.values())
      .filter(it => it.count >= 2)
      .sort((a,b) => b.count - a.count)
      .slice(0, limit);

    res.json({ ok:true, items });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
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

// --- Speech-to-text (local, on-box) ---
const STT_TMP_DIR = path.join(DATA_DIR, 'tmp');
try { fs.mkdirSync(STT_TMP_DIR, { recursive: true }); } catch {}

const sttStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, STT_TMP_DIR),
  filename: (req, file, cb) => {
    const safeBase = path.basename(file.originalname || 'audio').replace(/[^a-zA-Z0-9._-]/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `${stamp}__${safeBase}`);
  }
});

const sttUpload = multer({
  storage: sttStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// Warm STT worker (loads model once)
let sttWorker = null;
let sttWorkerBuf = '';
const sttPending = new Map(); // id -> { resolve, reject, t }
let sttBusy = false;

function ensureSttWorker(){
  if (sttWorker && !sttWorker.killed) return;

  const py = process.env.STT_PYTHON || '/opt/clawdconsole/stt-venv/bin/python3';
  const pyPath = (py && fs.existsSync(py)) ? py : 'python3';
  const script = path.join(__dirname, 'scripts', 'stt_worker.py');

  sttWorker = spawn(pyPath, [script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      STT_MODEL: String(process.env.STT_MODEL || 'tiny.en'),
      STT_DEVICE: String(process.env.STT_DEVICE || 'cpu'),
      STT_COMPUTE_TYPE: String(process.env.STT_COMPUTE_TYPE || 'int8'),
    }
  });

  sttWorkerBuf = '';

  sttWorker.stdout.on('data', (chunk) => {
    sttWorkerBuf += chunk.toString('utf8');
    while (true){
      const idx = sttWorkerBuf.indexOf('\n');
      if (idx < 0) break;
      const line = sttWorkerBuf.slice(0, idx).trim();
      sttWorkerBuf = sttWorkerBuf.slice(idx + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { continue; }
      const id = String(msg.id || '');
      const p = sttPending.get(id);
      if (!p) continue;
      sttPending.delete(id);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(String(msg.error || 'stt_failed')));
    }
  });

  sttWorker.on('exit', (code, sig) => {
    const err = new Error('stt_worker_exit ' + String(code) + ' ' + String(sig || ''));
    for (const [id, p] of sttPending.entries()){
      try { p.reject(err); } catch {}
      sttPending.delete(id);
    }
    sttWorker = null;
    sttBusy = false;
  });
}

function sttTranscribeViaWorker(inPath, timeoutMs){
  ensureSttWorker();
  const id = 'stt_' + crypto.randomBytes(10).toString('hex');
  const payload = JSON.stringify({ id, path: inPath }) + '\n';

  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      sttPending.delete(id);
      reject(new Error('stt_timeout'));
    }, timeoutMs || 120000);

    sttPending.set(id, {
      resolve: (msg) => { clearTimeout(t); resolve(msg); },
      reject: (e) => { clearTimeout(t); reject(e); },
      t
    });

    try {
      sttWorker.stdin.write(payload);
    } catch (e) {
      clearTimeout(t);
      sttPending.delete(id);
      reject(e);
    }
  });
}

app.post('/api/stt', sttUpload.single('audio'), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const sess = getSessionFromReq(req);
  if (!sess) return res.status(401).json({ ok:false, error:'no_session' });
  if (!req.file) return res.status(400).json({ ok:false, error:'no_audio' });

  if (sttBusy) return res.status(429).json({ ok:false, error:'stt_busy' });
  sttBusy = true;

  const inPath = req.file.path;
  const startedAt = Date.now();
  function safeUnlink(p){ try { fs.unlinkSync(p); } catch {} }

  try {
    const msg = await sttTranscribeViaWorker(inPath, 120000);
    res.json({ ok:true, text: String(msg.text || ''), ms: Date.now() - startedAt, model: String(process.env.STT_MODEL || 'tiny.en') });
  } catch (e) {
    res.status(500).json({ ok:false, error:'stt_exception', detail: String(e) });
  } finally {
    sttBusy = false;
    safeUnlink(inPath);
  }
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

// --- ClawdApps (ecosystem map + module pages) ---
function appsPageShell({ title, subtitle, bodyHtml, activePath }) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <link rel="stylesheet" href="/static/apps-menu.css" />
  <style>
    :root{ --bg:#0b1020; --text:#e8eefc; --muted: rgba(232,238,252,.68); --border: rgba(255,255,255,0.10); --card: rgba(255,255,255,0.04); --card2: rgba(0,0,0,0.14); --accent:#22c6c6; }
    body{ font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background: var(--bg); color: var(--text); margin:0; }
    a{ color:#9ad0ff; }
    .wrap{ width:100%; max-width: 1400px; margin:0 auto; padding: 18px; }
    body[data-wide="1"] .wrap{ max-width:none; padding: 10px 12px 26px 12px; height: 100vh; box-sizing:border-box; display:flex; flex-direction:column; overflow:hidden; }
    body[data-wide="1"]{ height:100vh; overflow:hidden; }
    body[data-wide="1"] .subcard{ padding: 10px 12px; }
    body[data-wide="1"] .footer{ display:none; }

    /* Title row: left title, right app menu (aligned to container edge) */
    .top{ display:grid; grid-template-columns: auto 1fr; gap: 12px; align-items:flex-start; }
    @media (max-width: 980px){ .top{ grid-template-columns: 1fr; } }
    .topL{ min-width: 240px; display:flex; flex-direction:column; gap:6px; min-width:0; }
    .topC{ display:flex; justify-content:flex-end; justify-self:end; width:100%; min-width:0; max-width:100%; flex-wrap:wrap; gap:10px; overflow:visible; }

    /* Header workspace selector: use the "empty space" between title and menu.
       Keep it closer to the title (not centered), and wrap under the title when narrow. */
    .hdrRow{ display:flex; gap:12px; align-items:flex-start; min-width:0; }
    .hdrRow .hdrTitle{ flex:1; min-width: 360px; }
    /* selectors stack under each other in their own block, offset from title */
    .hdrSelStack{ display:flex; flex-direction:column; gap:6px; align-items:flex-start; margin-left: clamp(50px, 6vw, 240px); flex:0 0 auto; }
    .hdrWs{ display:flex; gap:8px; align-items:center; justify-content:flex-start; flex-wrap:wrap; }
    .hdrWs .muted{ font-size:12px; }
    .hdrWsSel{ padding:6px 8px; height: 34px; width: 220px; max-width: 260px; }
    body[data-wide="1"] .top{ grid-template-columns: auto 1fr; }
    body[data-wide="1"] .topC{ justify-content:flex-end; margin-top: 0; min-width:0; }

    h1{ margin:0; font-size: 22px; }
    .muted{ color: var(--muted); font-size: 12px; }
    .pill{ display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:8px 10px; border-radius:999px; border:1px solid rgba(34,198,198,.40); background: linear-gradient(180deg, rgba(34,198,198,.18), rgba(34,198,198,.08)); color: rgba(231,231,231,.92); text-decoration:none; white-space:nowrap; font-weight:750; font-size:12px; }
    .pill:hover{ border-color: rgba(34,198,198,.70); background: linear-gradient(180deg, rgba(34,198,198,.26), rgba(34,198,198,.10)); }

    /* Apps menu (click to expand; double-click opens /apps) */
    .appsMenuWrap{ position:relative; display:inline-flex; align-items:center; justify-content:flex-end; }
    .appsMenuBtn{ cursor:pointer; user-select:none; }
    .appsMenuBtnChev{ opacity:.8; transition: transform 160ms ease; }
    .appsMenuWrap.open .appsMenuBtnChev{ transform: rotate(180deg); }

    .appsMenuDrop{
      position:absolute;
      right:0;
      top: calc(100% + 10px);
      width: min(560px, 92vw);
      border-radius: 18px;
      border: 1px solid rgba(255,255,255,0.14);
      background: radial-gradient(560px 240px at 25% 0%, rgba(34,198,198,.20), rgba(0,0,0,0) 60%), rgba(10,14,28,.92);
      box-shadow: 0 18px 60px rgba(0,0,0,.55);
      overflow:hidden;

      transform: translateY(-6px) scale(.985);
      opacity: 0;
      pointer-events: none;
      transition: opacity 170ms ease, transform 170ms ease;
    }
    .appsMenuWrap.open .appsMenuDrop{ opacity: 1; transform: translateY(0) scale(1); pointer-events:auto; }

    .appsMenuDropHead{ display:flex; justify-content:space-between; align-items:center; padding:12px 14px; border-bottom:1px solid rgba(255,255,255,0.10); }
    .appsAll{ color: rgba(232,238,252,.92); font-weight:900; text-decoration:none; }
    .appsAll:hover{ text-decoration: underline; }

    .appsGrid{ display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:10px; padding: 12px 14px 14px 14px; }
    @media (max-width: 520px){ .appsGrid{ grid-template-columns: 1fr; } }

    .appsLink{
      display:flex; align-items:center; gap:10px;
      padding:10px 12px;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.10);
      background: rgba(255,255,255,0.04);
      text-decoration:none;
      color: rgba(232,238,252,.92);
      transform: translateZ(0);
      transition: transform 140ms ease, background 140ms ease, border-color 140ms ease;
    }
    .appsLink:hover{ transform: translateY(-1px); background: rgba(255,255,255,0.06); border-color: rgba(34,198,198,.35); }
    .appsLink[aria-current="page"]{ border-color: rgba(34,198,198,.55); background: rgba(34,198,198,.10); }

    .appsDot{ width:10px; height:10px; border-radius:999px; background: rgba(34,198,198,.75); box-shadow: 0 0 0 4px rgba(34,198,198,.12); flex:0 0 auto; }
    .appsLbl{ font-weight: 850; letter-spacing: .2px; }

    .card{ background: var(--card); border:1px solid var(--border); border-radius: 14px; padding: 14px; }
    .grid{ display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-top: 14px; }
    @media (max-width: 1180px){ .grid{ grid-template-columns: repeat(2, minmax(0,1fr)); } }
    @media (max-width: 700px){ .grid{ grid-template-columns: 1fr; } }
    .app{ display:flex; gap:12px; align-items:flex-start; text-decoration:none; color: inherit; min-height: 150px; }
    .ico{ width: 38px; height:38px; border-radius: 12px; background: rgba(34,198,198,.10); border:1px solid rgba(34,198,198,.35); display:flex; align-items:center; justify-content:center; flex: 0 0 auto; }
    .ico svg{ width:22px; height:22px; stroke: rgba(34,198,198,.95); fill:none; stroke-width: 2.4; }
    .appTitle{ font-weight: 900; font-size: 14px; }
    .appDesc{ margin-top:4px; color: rgba(232,238,252,.72); font-size: 12px; line-height:1.35; min-height: 3.9em; }
    .appRoute{ margin-top:8px; color: rgba(232,238,252,.58); font-size: 12px; }
    .footer{ margin-top: 14px; color: rgba(232,238,252,.55); font-size: 12px; }
    .subcard{ margin-top: 14px; background: var(--card2); border:1px solid rgba(255,255,255,0.10); border-radius: 14px; padding: 14px; }
    input, textarea, select{ background:#0d1426; border:1px solid rgba(255,255,255,0.14); color: var(--text); border-radius: 12px; padding: 10px 12px; font-size: 14px; font-family: inherit; }
  </style>
</head>
<body data-wide="${(activePath === '/apps/code' || activePath === '/apps/code2') ? '1' : '0'}">
  <div class="wrap">
    <div class="top">
      <div class="topL">
        ${(activePath === '/apps/code') ? (`<div class=\"hdrRow\">
          <div class=\"hdrTitle\">
            <h1 style=\"margin:0;\">${title} <span class=\"muted\" style=\"font-weight:700; font-size:12px; color: rgba(232,238,252,.48);\">build ${BUILD}</span></h1>
            <div class=\"muted\" style=\"margin-top:4px;\">${subtitle || ''}</div>
          </div>
          <div class=\"hdrSelStack\">
            <div class=\"hdrWs\">
              <span class=\"muted\" style=\"font-size:12px;\">Workspace</span>
              <select id=\"hdrWsSel\" class=\"hdrWsSel\"></select>
              <button class=\"pill\" id=\"hdrWsAdd\" type=\"button\">Add</button>
            </div>
            <div class=\"hdrWs\">
              <span class=\"muted\" style=\"font-size:12px;\">Git</span>
              <select id=\"hdrGitSel\" class=\"hdrWsSel\"><option value=\"\">None</option></select>
              <button class=\"pill\" id=\"hdrGitConnect\" type=\"button\">Connect</button>
              <button class=\"pill\" id=\"hdrGitDisc\" type=\"button\">Disconnect</button>
            </div>
          </div>
        </div>`) : (`<h1>${title}</h1>`)}
        <div style="display:none"></div>
      </div>
      <div class="topC">${appsMenuHtml(activePath || '')}</div>
    </div>

    ${bodyHtml || ''}

    <div class="footer">Build: <code>${BUILD}</code></div>
  </div>
  <script src="/static/apps-menu.js"></script>
</body>
</html>`;
}

function appsIcon(kind){
  // lightweight icon set (inline SVG) - keeps the suite feeling like one product.
  const common = {
    script: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10M7 12h10M7 17h7"/></svg>',
    pm: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z"/><path d="M9 10h6M9 13h6"/></svg>',
    name: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-4.4 7-10a7 7 0 0 0-14 0c0 5.6 7 10 7 10z"/><path d="M10 11h4"/></svg>',
    repo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10M7 12h10M7 17h10"/></svg>',
    sec: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l8 4v6c0 5-3.5 9.4-8 10-4.5-.6-8-5-8-10V6l8-4z"/><path d="M9.5 12l1.8 1.8L14.8 10"/></svg>',
    ops: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/></svg>',
    pub: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v12H4z"/><path d="M7 10h10M7 13h10M7 16h6"/></svg>',
    build: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17l7-7 3 3 6-6"/><path d="M20 7v6h-6"/></svg>',
    queue: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10M7 12h10M7 17h10"/><path d="M4 7h0M4 12h0M4 17h0"/></svg>',
    code: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l-4-6 4-6"/><path d="M15 6l4 6-4 6"/><path d="M13 5l-2 14"/></svg>',
  };
  return common[kind] || common.repo;
}


const APPS_MENU_CSS = `
  /* Apps menu (click to expand; double-click opens /apps) */
  .appsMenuWrap{ position:relative; display:inline-flex; align-items:center; justify-content:flex-end; }
  /* Replace everywhere: use Menu #1 launcher style + underline accent */
  .appsMenuBtn{
    cursor:pointer; user-select:none;
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,.22);
    background: rgba(0,0,0,.18);
    padding: 5px 8px;
    font-weight: 950;
    font-size: 13px;
    line-height: 1;
  }
  .appsMenuBtnTxt{ border-bottom: 2px solid rgba(34,198,198,.55); padding-bottom: 2px; }
  .appsMenuBtn:hover{ background: rgba(0,0,0,.26); border-color: rgba(34,198,198,.40); }
  .appsMenuBtn:hover .appsMenuBtnTxt{ border-bottom-color: rgba(34,198,198,.85); }

  .appsMenuBtnChev{ opacity:.8; transition: transform 160ms ease; }
  .appsMenuWrap.open .appsMenuBtnChev{ transform: rotate(180deg); }

  .appsMenuDrop{
    position:absolute;
    right:0;
    top: calc(100% + 10px);
    width: min(560px, 92vw);
    border-radius: 18px;
    border: 1px solid rgba(255,255,255,0.14);
    background: #0a0f1e;
    box-shadow: 0 18px 60px rgba(0,0,0,.55);
    overflow:hidden;

    transform: translateY(-6px) scale(.985);
    opacity: 0;
    pointer-events: none;
    transition: opacity 170ms ease, transform 170ms ease;
    z-index: 30;
  }
  .appsMenuWrap.open .appsMenuDrop{ opacity: 1; transform: translateY(0) scale(1); pointer-events:auto; }

  .appsMenuDropHead{ display:flex; justify-content:space-between; align-items:center; padding:12px 14px; border-bottom:1px solid rgba(255,255,255,0.10); }
  .appsAll{ color: rgba(232,238,252,.92); font-weight:900; text-decoration:none; }
  .appsAll:hover{ text-decoration: underline; }

  .appsGrid{ display:grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap:10px; padding: 12px 14px 14px 14px; }
  @media (max-width: 520px){ .appsGrid{ grid-template-columns: 1fr; } }

  .appsLink{
    display:flex; align-items:center; gap:10px;
    padding:9px 10px;
    border-radius: 14px;
    border: 1px solid rgba(255,255,255,0.10);
    background: rgba(255,255,255,0.04);
    text-decoration:none;
    color: rgba(232,238,252,.92);
    transform: translateZ(0);
    transition: transform 140ms ease, background 140ms ease, border-color 140ms ease;
  }
  .appsLink:hover{ transform: translateY(-1px); background: rgba(255,255,255,0.06); border-color: rgba(34,198,198,.35); }
  .appsLink[aria-current="page"]{ border-color: rgba(34,198,198,.55); background: rgba(34,198,198,.10); }

  .appsDot{ width:10px; height:10px; border-radius:999px; background: rgba(34,198,198,.75); box-shadow: 0 0 0 4px rgba(34,198,198,.12); flex:0 0 auto; }
  .appsLbl{ font-weight: 850; letter-spacing: .2px; }
`;

const APPS_MENU_JS = `
(() => {
  const wrap = document.getElementById('appsMenuWrap');
  const btn = document.getElementById('appsMenuBtn');
  const drop = document.getElementById('appsMenuDrop');
  if (!wrap || !btn || !drop) return;

  function setOpen(v){
    wrap.classList.toggle('open', !!v);
    btn.setAttribute('aria-expanded', v ? 'true' : 'false');
  }

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    setOpen(!wrap.classList.contains('open'));
  });
  btn.addEventListener('dblclick', (e) => {
    e.preventDefault();
    window.location.href = '/apps';
  });

  document.addEventListener('click', (e) => {
    if (!wrap.classList.contains('open')) return;
    const t = e.target;
    if (t && wrap.contains(t)) return;
    setOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });
})();
`;

function appsMenuHtml(activePath){
  const pathNow = String(activePath || '');
  const items = [
    { label: 'ClawdPM', href: '/pm' },
    { label: 'ClawdScript', href: '/apps/script' },
    { label: 'ClawdName', href: '/name' },
    { label: 'ClawdRepo', href: '/apps/repo' },
    { label: 'ClawdCode', href: '/apps/code' },
    { label: 'ClawdSec', href: '/apps/sec' },
    { label: 'ClawdOps', href: '/apps/ops' },
    { label: 'ClawdPub', href: '/apps/pub' },
    { label: 'ClawdBuild', href: '/apps/build' },
    { label: 'ClawdQueue', href: '/apps/queue' },
    { label: 'Apps Menu Lab', href: '/apps/menu-lab' },
  ];

  const links = items.map(it => {
    const isActive = (pathNow === it.href);
    return '<a class="appsLink" href="' + it.href + '" ' + (isActive ? 'aria-current="page"' : '') + '>'
      + '<span class="appsDot" aria-hidden="true"></span>'
      + '<span class="appsLbl">' + escHtml(it.label) + '</span>'
      + '</a>';
  }).join('');

  // NOTE: no IDs (so it can be embedded multiple times); no .pill class (so per-page pill styles don't leak onto it).
  return ''
    + '<div class="appsMenuWrap">'
    +   '<button class="appsMenuBtn" type="button" aria-haspopup="menu" aria-expanded="false" title="Click to open menu • Double-click to open /apps">'
    +     '<span class="appsMenuBtnTxt">ClawdApps</span>'
    +     '<span class="appsMenuBtnChev" aria-hidden="true">▾</span>'
    +   '</button>'
    +   '<div class="appsMenuDrop" role="menu" aria-label="ClawdApps menu">'
    +     '<div class="appsMenuDropHead">'
    +       '<a class="appsAll" href="/apps">Open /apps directory</a>'
    +     '</div>'
    +     '<div class="appsGrid">' + links + '</div>'
    +   '</div>'
    + '</div>';
}

app.get('/apps', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const apps = [
    { k:'script', title:'ClawdScript', href:'/apps/script', desc:'Transcript browser (embedded) + full Script route.' },
    { k:'pm', title:'ClawdPM', href:'/pm', desc:'Board + cards + to-dos (queue-aware).' },
    { k:'name', title:'ClawdName', href:'/name', desc:'Domain availability helper (v0 heuristic).' },
    { k:'repo', title:'ClawdRepo', href:'/apps/repo', desc:'Commits + useful repo links.' },
    { k:'code', title:'ClawdCode', href:'/apps/code', desc:'Browse/edit Console project files (scoped).' },
    { k:'sec', title:'ClawdSec', href:'/apps/sec', desc:'Security posture + copy/paste-safe hardening.' },
    { k:'ops', title:'ClawdOps', href:'/apps/ops', desc:'Ops profile + repeated questions detector.' },
    { k:'pub', title:'ClawdPub', href:'/apps/pub', desc:'Published artifacts + SOP.' },
    { k:'build', title:'ClawdBuild', href:'/apps/build', desc:'Build/health/queue/commits/changelog surface.' },
    { k:'queue', title:'ClawdQueue', href:'/apps/queue', desc:'Serial execution rail (PM-backed) + autorun.' },
  ];

  const bodyHtml = `
    <div class="subcard">
      <div style="font-weight:900;">Ecosystem map</div>
      <div class="muted" style="margin-top:6px;">Per transcript: <b>/apps is map-only</b>. Every module opens on its own route so you never land mid-page.</div>
    </div>
    <div class="grid">${apps.map(a => {
      return `<a class="card app" href="${a.href}" target="_blank" rel="noopener">
        <div class="ico">${appsIcon(a.k)}</div>
        <div style="min-width:0;">
          <div class="appTitle">${a.title}</div>
          <div class="appDesc">${a.desc}</div>
          <div class="appRoute"><code>${a.href}</code></div>
        </div>
      </a>`;
    }).join('')}</div>
  `;

  res.type('text/html; charset=utf-8').send(appsPageShell({
    title: 'ClawdApps',
    subtitle: 'Directory / lobby (map-only). Open modules in new tabs.',
    bodyHtml,
    activePath: '/apps',
  }));
});

// --- Apps Menu Lab (4 concepts, one per corner) ---
app.get('/apps/menu-lab', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Apps Menu Lab</title>
  <link rel="stylesheet" href="/static/apps-menu-lab.css" />
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1>Apps Menu Lab</h1>
        <div class="sub">Four <b>click-to-expand</b> menu options, one per corner. Each button is single-click to open, double-click to go to /apps. Pick like: <b>Menu 1</b> (animation style) or “Menu 1 with Menu 3 reveal”.</div>
      </div>
      <div class="pills">
        <a class="pill" href="/apps">Back to /apps</a>
        <a class="pill" href="/">Console</a>
      </div>
    </div>

    <div class="grid">
      <section class="menuBox menu1" data-menu="1" aria-label="Menu 1">
        <div class="inner">
          <div>
            <div class="tag">Corner 1 • Menu 1</div>
            <div class="title">Magnetic Grid</div>
            <div class="desc">Fast scale+fade reveal with cursor-glow and a subtle tilt on the panel. “Premium” without being slow.</div>
            <div class="headRow">
              <button class="mBtn" type="button"><span>ClawdApps</span><small>▾</small></button>
              <div class="tag" style="opacity:.65;">Double-click → /apps</div>
            </div>
          </div>

          <div class="mPanel">
            <div class="mHead"><div class="hint">Menu 1 reveal</div><div class="hint">Esc closes</div></div>
            <div class="mGrid"></div>
          </div>
        </div>
      </section>

      <section class="menuBox menu2" data-menu="2" aria-label="Menu 2">
        <div class="inner">
          <div>
            <div class="tag">Corner 2 • Menu 2</div>
            <div class="title">Slide-Down Rail</div>
            <div class="desc">Height-reveal drawer. Feels like a tidy dropdown that expands in place (good for dense nav).</div>
            <div class="headRow">
              <button class="mBtn" type="button"><span>ClawdApps</span><small>▾</small></button>
              <div class="tag" style="opacity:.65;">Double-click → /apps</div>
            </div>
          </div>

          <div class="mPanel">
            <div class="mHead"><div class="hint">Menu 2 reveal</div><div class="hint">Esc closes</div></div>
            <div class="mGrid"></div>
          </div>
        </div>
      </section>

      <section class="menuBox menu3" data-menu="3" aria-label="Menu 3">
        <div class="inner">
          <div>
            <div class="tag">Corner 3 • Menu 3</div>
            <div class="title">Ripple Reveal</div>
            <div class="desc">A clip-path circle expands from the top-right like a ripple. Minimal, classy motion.</div>
            <div class="headRow">
              <button class="mBtn" type="button"><span>ClawdApps</span><small>▾</small></button>
              <div class="tag" style="opacity:.65;">Double-click → /apps</div>
            </div>
          </div>

          <div class="mPanel">
            <div class="mHead"><div class="hint">Menu 3 reveal</div><div class="hint">Esc closes</div></div>
            <div class="mGrid"></div>
          </div>
        </div>
      </section>

      <section class="menuBox menu4" data-menu="4" aria-label="Menu 4">
        <div class="inner">
          <div>
            <div class="tag">Corner 4 • Menu 4</div>
            <div class="title">Spring Pop</div>
            <div class="desc">A quick springy pop-in. Feels playful but still crisp. Good if you want “alive UI”.</div>
            <div class="headRow">
              <button class="mBtn" type="button"><span>ClawdApps</span><small>▾</small></button>
              <div class="tag" style="opacity:.65;">Double-click → /apps</div>
            </div>
          </div>

          <div class="mPanel">
            <div class="mHead"><div class="hint">Menu 4 reveal</div><div class="hint">Esc closes</div></div>
            <div class="mGrid"></div>
          </div>
        </div>
      </section>
    </div>
  </div>

  <script src="/static/apps-menu-lab.js"></script>
</body>
</html>`;

  res.type('text/html; charset=utf-8').send(html);
});

function renderModulePage(key){
  const map = {
    script: { title:'ClawdScript', subtitle:'Transcript browser (embedded).', body:`
      <div class="subcard" style="line-height:1.55;">
        <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:baseline;">
          <div class="muted">Embedded <code>/transcript</code> so you can browse without leaving the Apps suite. (Standalone route still exists.)</div>
          <a class="pill" href="/transcript" target="_blank" rel="noopener">Open /transcript</a>
        </div>
        <div style="margin-top:12px; border:1px solid rgba(255,255,255,0.10); border-radius:14px; overflow:hidden;">
          <iframe src="/transcript" style="width:100%; height: 78vh; border:0; background: transparent;"></iframe>
        </div>
      </div>
    ` },
    code: { title:'ClawdCode', subtitle:'Ultrawide IDE cockpit: workspace + file/app previews + chat + operator stack.', body:`
      <div style="line-height:1.55; display:flex; flex-direction:column; flex:1; min-height:0; padding-bottom: 12px; box-sizing:border-box;">
        <style>
          /* local-only layout helpers */
          .ccIde {
            /* Independent columns; only App Preview is flexible.
               Use minmax(min, max) so we NEVER lose the last column on smaller viewports/zoom. */
            --wsMax: clamp(140px, 16vw, 280px);
            --fileMax: clamp(200px, 26vw, 520px);
            --chatMax: clamp(200px, 20vw, 360px);
            --opMax: clamp(200px, 20vw, 360px);

            --wsCol: minmax(88px, var(--wsMax));
            --fileCol: minmax(140px, var(--fileMax));
            --chatCol: minmax(88px, var(--chatMax));
            --opCol: minmax(88px, var(--opMax));

            display:grid;
            grid-template-columns:
              var(--wsCol)
              var(--fileCol)
              minmax(0, 1fr)
              var(--chatCol)
              var(--opCol);
            gap:12px;
            align-items:stretch;
            width:100%;
            flex: 1;
            min-height: 0;
            height: auto;
            box-sizing:border-box;
            overflow: visible; /* let card borders render; wrapper controls overflow */
          }

          @media (max-width: 1600px){
            .ccIde{ --fileMax: clamp(180px, 24vw, 440px); --chatMax: clamp(180px, 18vw, 320px); --opMax: clamp(180px, 18vw, 320px); }
          }
          .ccIde.exp-file { --fileW: minmax(900px, 1.6fr); }
          .ccIde.exp-app { --fileW: 360px; }
          /* app column is always the flexible one (1fr) */
          .ccIde.c-ws { --wsMax: 92px; --wsCol: fit-content(92px); }
          .ccIde.c-file { --fileMax: 160px; --fileCol: fit-content(180px); }

          .ccIde.work-expanded #worklog{ max-height: 56vh; }
          .ccIde.work-expanded #opListCard{ max-height: 32vh; }

          .ccIde.c-chat { --chatMax: 92px; --chatCol: fit-content(140px); }
          .ccIde.c-op { --opMax: 92px; --opCol: fit-content(160px); }

          .ccIde.c-ws #codeTree{ display:none; }
          .ccIde.c-ws #codeCwd{ display:none; }
          .ccIde.c-ws #wsSel, .ccIde.c-ws #codeUp{ display:none; }

          .ccIde.c-file #codeEditor, .ccIde.c-file #codeBlocked, .ccIde.c-file #codePath{ display:none; }
          .ccIde.c-file #codeSave, .ccIde.c-file #codeReload, .ccIde.c-file #codeExpFile{ display:none; }

          .ccIde.c-chat #chatLog, .ccIde.c-chat #chatInput, .ccIde.c-chat #chatSend, .ccIde.c-chat #chatJump{ display:none; }
          /* Operator column collapse: hide body (both List + Work), keep header visible for restore */
          .ccIde.c-op #opPanel .ccPanelBody{ display:none !important; }

          /* ClawdWork collapse: hide log + shrink card to toolbar height */
          .ccIde.work-hide #worklogWrap{ display:none; }
          .ccIde.work-hide #opWorkCard{ flex: 0 0 auto !important; min-height: 0 !important; max-height: 90px; overflow:hidden; }
          .ccIde.work-hide #opListCard{ flex: 1 1 auto; min-height: 240px; }

          /* scrollbar styling */
          .ccIde * { scrollbar-width: thin; scrollbar-color: rgba(232,238,252,.25) rgba(0,0,0,0.25); }
          .ccIde *::-webkit-scrollbar{ width: 10px; height: 10px; }
          .ccIde *::-webkit-scrollbar-thumb{ background: rgba(232,238,252,.18); border-radius: 10px; border: 2px solid rgba(0,0,0,0.35); }
          .ccIde *::-webkit-scrollbar-track{ background: rgba(0,0,0,0.18); border-radius: 10px; }
          .ccPanel { background: rgba(0,0,0,0.10); display:flex; flex-direction:column; min-height:0; height:100%; overflow:hidden; }
          .ccPanelHead .pill{ padding:6px 8px; }
          .ccChevron{ border:1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.03); color: rgba(232,238,252,.68); padding:4px 8px; border-radius:999px; font-weight:800; }
          .ccPanelHead { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:nowrap; padding:10px 10px 0 10px; min-width:0; }
          .ccGridHead{ display:grid; grid-template-columns: auto minmax(90px, 1fr) auto; align-items:center; gap:10px; min-width:0; overflow:hidden; }
          .ccPanelHead.ccGridHead{ display:grid !important; justify-content:initial; }
          .ccTitle{ font-weight:900; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
          /* keep workspace selector from eating the whole header */
          #wsPanel #wsSel{ width: 120px; max-width: 120px; }
          @media (max-width: 1200px){ #wsPanel #wsSel{ width: 104px; max-width: 104px; } }
          #wsPanel .ccTitle{ min-width: 90px; }
          /* Workspace header sizing */
          .ccHeadRow{ display:flex; gap:8px; align-items:center; min-width:0; }
          .ccHeadRow.left{ flex:1; }
          .ccHeadRow.right{ justify-content:flex-end; flex:0 0 auto; }

          /* when a column is collapsed, hide the title text to avoid vertical letter-stacking */
          .ccIde.c-ws #wsPanel .ccTitle,
          .ccIde.c-file #filePanel .ccTitle,
          .ccIde.c-chat #chatPanel .ccTitle,
          .ccIde.c-op #opPanel .ccTitle{ display:none !important; }
          /* ensure titles are visible when not collapsed (guards against stale inline styles/extensions) */
          #wsPanel .ccTitle, #filePanel .ccTitle, #chatPanel .ccTitle, #opPanel .ccTitle{ display:block; }

          /* collapse should hide the entire panel body (inline styles require !important) */
          .ccIde.c-ws #wsPanel .ccPanelBody{ display:none !important; }
          .ccIde.c-file #filePanel .ccPanelBody{ display:none !important; }
          .ccIde.c-chat #chatPanel .ccPanelBody{ display:none !important; }
          .ccIde.c-op #opPanel .ccPanelBody{ display:none !important; }
          .ccPanelBody { padding:10px; overflow:auto; min-height:0; }
          .ccPanelBody.tight { padding:10px; overflow:hidden; min-height:0; }
          .ccEditor { width:100%; max-width:100%; box-sizing:border-box; height:100%; min-height:0; flex:1; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; }
          .ccSmall { font-size: 12px; }
          .ccIframe { width:100%; height: 100%; min-height: 56vh; border:0; border-radius:12px; background:#0b1020; }
          .ccMono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; }
          .ccGrow { flex:1; min-height:0; }
        </style>

        <div class="row" style="margin-top:12px; gap:10px; flex-wrap:wrap; align-items:center;">
          <span class="muted" id="codeMsg"></span>
        </div>

        <div class="ccIde" id="ccIde" style="margin-top:12px;">
          <!-- 1) Workspace -->
          <div class="card ccPanel" id="wsPanel">
            <div class="ccPanelHead ccGridHead">
              <button class="pill" id="wsToggle" type="button" title="Collapse Workspace">◀</button>
              <div class="ccTitle">Workspace</div>
              <div class="ccHeadRow right" style="justify-self:end;"></div>
            </div>
            <div class="ccPanelBody" style="padding-top:8px; display:flex; flex-direction:column; gap:8px;">
              <div class="muted ccSmall" id="codeCwd"></div>
              <div id="codeTree" style="flex:1; min-height:0;"></div>
            </div>
          </div>

          <!-- 2) File Preview -->
          <div class="card ccPanel" id="filePanel">
            <div class="ccPanelHead">
              <div class="ccHeadRow left">
                <button class="pill" id="fileToggle" type="button" title="Collapse File Preview">◀</button>
                <div class="ccTitle">File Preview</div>
              </div>
              <div class="ccHeadRow right">
                <button class="pill" id="codeSave" type="button">Save</button>
                <button class="pill" id="codeReload" type="button">Reload</button>
                <button class="pill" id="codeExpFile" type="button">Expand</button>
              </div>
            </div>
            <div class="ccPanelBody tight" style="display:flex; flex-direction:column; gap:10px; flex:1; min-height:0;">
              <div class="muted ccSmall" id="codePath" style="max-width: 70ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></div>
              <div id="codeBlocked" style="display:none; border:1px solid rgba(255,255,255,0.12); border-radius:12px; padding:10px; background: rgba(255,255,255,0.03);"></div>
              <textarea id="codeEditor" class="ccEditor" spellcheck="false" style="flex:1; min-height:0;"></textarea>
            </div>
          </div>

          <!-- 3) App Preview -->
          <div class="card ccPanel">
            <div class="ccPanelHead">
              <div style="font-weight:900;">App Preview</div>
              <div class="row" style="gap:8px; align-items:center;">
                <select id="appPreset" style="padding:8px 10px; border-radius:12px; border:1px solid rgba(255,255,255,0.14); background:#0d1426; color:var(--text);">
                  <option value="/proxy/5000/">localhost:5000 (server)</option>
                  <option value="/proxy/5001/">localhost:5001 (server)</option>
                </select>
                <button class="pill" id="appOpen" type="button">Open</button>
                <button class="pill" id="codeExpApp" type="button">Expand</button>
              </div>
            </div>
            <div class="ccPanelBody" style="padding-top:8px;">
              <div class="muted ccSmall">Server-side preview (proxied). This loads the app running on the Console host, not your laptop.</div>
              <div class="row" style="margin-top:8px; gap:10px; align-items:center; flex-wrap:wrap;">
                <input id="appUrl" class="ccMono" value="/proxy/5000/" style="flex:1; min-width: 260px; padding:10px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.14); background:#0d1426; color:var(--text);" />
                <button class="pill" id="appGo" type="button">Go</button>
                <span class="muted ccSmall" id="appMsg"></span>
              </div>
              <div style="margin-top:10px;">
                <iframe id="appFrame" class="ccIframe" src="/proxy/5000/"></iframe>
              </div>
            </div>
          </div>

          <!-- 4) Chat -->
          <div class="card ccPanel" id="chatPanel">
            <div class="ccPanelHead">
              <div class="ccHeadRow left">
                <button class="pill" id="chatToggle" type="button" title="Collapse Chat">▶</button>
                <div class="ccTitle">Chat</div>
              </div>
              <div class="ccHeadRow right">
                <div class="muted ccSmall" id="chatMsg"></div>
              </div>
            </div>
            <div class="ccPanelBody" style="display:flex; flex-direction:column; gap:10px;">
              <div id="chatLog" style="flex:1; min-height:0; overflow:auto; border:1px solid rgba(255,255,255,0.10); border-radius:12px; padding:8px; background: rgba(0,0,0,0.10);"></div>
              <textarea id="chatInput" placeholder="Message…" style="width:100%; min-height: 90px; max-height: 180px;"></textarea>
              <div class="row" style="gap:10px; align-items:center;">
                <button class="pill" id="chatSend" type="button" style="border-color: rgba(154,208,255,0.55);">Send</button>
                <button class="pill" id="chatJump" type="button">Jump to latest</button>
              </div>
            </div>
          </div>

          <!-- 5) Operator stack -->
          <div class="card ccPanel" id="opPanel">
            <div class="ccPanelHead">
              <div class="ccHeadRow left">
                <button class="pill" id="opToggle" type="button" title="Collapse ClawdList/Work">▶</button>
                <div class="ccTitle">ClawdList</div>
              </div>
              <div class="ccHeadRow right"></div>
            </div>
            <div class="ccPanelBody" style="display:flex; flex-direction:column; gap:12px; min-height:0; padding-top:10px;">
              <div class="card ccGrow" id="opListCard" style="background: rgba(255,255,255,0.03); overflow:auto; min-height:180px; flex: 1 1 auto;">
                <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:center;">
                  <div class="muted ccSmall" id="deStatus">Idle</div>
                </div>
                <div class="row" style="margin-top:10px; gap:10px; align-items:center;">
                  <button class="pill" id="dePrev" type="button">Prev</button>
                  <button class="pill" id="deNext" type="button">Next</button>
                </div>
                <div id="deLists" style="margin-top:10px;"></div>
              </div>

              <div class="card" id="opWorkCard" style="background: rgba(255,255,255,0.03); flex: 0 0 44%; min-height: 220px; display:flex; flex-direction:column;">
                <div class="row" style="gap:8px; flex-wrap:wrap; align-items:center;">
                  <div style="font-weight:900;">ClawdWork</div>
                  <button id="wlToggle" type="button" class="wlbtn" title="Collapse" style="border:1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.03); color: rgba(232,238,252,.68); padding:4px 8px; border-radius:999px; font-weight:800;">▾</button>
                  <button class="pill" id="wlAdd" type="button">Add</button>
                  <button class="pill" id="wlStop" type="button">Stop</button>
                  <span class="muted ccSmall" id="wlThinking">Idle</span>
                  <span style="flex:1;"></span>
                  <div class="muted ccSmall" id="wlMsg"></div>
                </div>
                <div id="worklogWrap" style="margin-top:10px; flex:1; min-height:0; overflow:hidden; display:flex; flex-direction:column;">
                  <div id="worklog" style="flex:1; min-height:0; overflow:auto;"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <script src="/static/code.js?v=${BUILD}"></script>
    ` },

    code2: { title:'ClawdCode2', subtitle:'FlexCol cockpit (left nav + reorderable panes).', body:`
      <div style="line-height:1.55; display:flex; flex-direction:column; flex:1; min-height:0; padding-bottom: 12px; box-sizing:border-box;">
        <style>
          #cc2Root{ display:flex; flex:1; min-height:0; gap:12px; }
          #cc2Nav{ width: 320px; max-width: 520px; min-width: 220px; overflow:hidden; transition: width .12s ease; }
          #cc2Root.navClosed #cc2Nav{ width: 42px; min-width: 42px; }
          #cc2Root.navClosed #cc2Nav .navOpenOnly{ display:none !important; }
          #cc2Root.navClosed #cc2Nav .navClosedOnly{ display:flex !important; }
          #cc2Nav .navClosedOnly{ display:none; flex-direction:column; align-items:center; gap:10px; padding:10px 0; }

          .cc2Dot{ width:8px; height:8px; border-radius:99px; background: rgba(34,198,198,.9); box-shadow: 0 0 0 2px rgba(34,198,198,.18); }
          .cc2Tri{ appearance:none; border:0; background:transparent; color: rgba(232,238,252,.55); font-weight:900; cursor:pointer; padding:6px; line-height:1; }
          .cc2Tri:hover{ color: rgba(232,238,252,.78); }

          .cc2ProjIco{ width:28px; height:28px; border-radius:10px; background: rgba(34,198,198,.10); border:1px solid rgba(34,198,198,.35); display:flex; align-items:center; justify-content:center; }
          .cc2ProjIco svg{ width:18px; height:18px; stroke: rgba(34,198,198,.95); fill:none; stroke-width:2.6; }

          #cc2Main{ flex:1; min-width:0; min-height:0; display:flex; }
          #cc2Flex{ flex:1; min-width:0; min-height:0; display:flex; overflow:hidden; }

          .pane{ min-height:0; height:100%; display:flex; flex-direction:column; border:1px solid rgba(255,255,255,0.10); background: rgba(255,255,255,0.04); border-radius:14px; overflow:hidden; }
          .paneHead{ display:flex; align-items:center; gap:10px; padding:10px 10px 8px 10px; border-bottom:1px solid rgba(255,255,255,0.08); min-width:0; }
          .paneHead .title{ font-weight:900; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
          .paneHead .spacer{ flex:1; }
          .paneHead .btn{ border:0; background:transparent; color: rgba(232,238,252,.70); cursor:pointer; padding:6px; line-height:1; }
          .paneHead .btn:hover{ color: rgba(232,238,252,.92); }
          .paneHead .btnGroup{ display:flex; gap:2px; align-items:center; }
          .paneBody{ padding:10px; min-height:0; overflow:auto; }
          .paneBody.tight{ overflow:hidden; }
          .paneIcon{ width:18px; height:18px; opacity:.92; display:flex; align-items:center; justify-content:center; }
          .paneIcon svg{ width:18px; height:18px; stroke: rgba(232,238,252,.82); fill:none; stroke-width:2.4; }

          .resizer{ width:10px; cursor: col-resize; flex: 0 0 10px; position:relative; }
          .resizer:after{ content:''; position:absolute; left:4px; top:10px; bottom:10px; width:2px; background: rgba(232,238,252,.12); border-radius:99px; }
          .resizer:hover:after{ background: rgba(232,238,252,.22); }

          .paneCollapsed{ flex: 0 0 54px !important; width:54px !important; }
          .paneCollapsed .paneBody{ display:none !important; }
          .paneCollapsed .title{ display:none !important; }
          .paneCollapsed .btnGroup.move, .paneCollapsed .btnGroup.size{ display:none !important; }

          #pane-appPreview{ --urlCompactMin: 360px; }
          #pane-appPreview.headCollapsed .appHeadRow{ display:none !important; }
          #pane-appPreview.urlHidden .appHeadRow{ display:none !important; }
          #pane-appPreview.urlCompact #appUrl{ width: min(360px, 38vw) !important; }
        </style>

        <div id="cc2Root">
          <div class="card" id="cc2Nav" style="padding:12px; display:flex; flex-direction:column; gap:12px; min-height:0;">
            <div class="navClosedOnly">
              <button class="cc2Tri" id="cc2NavOpen" title="Open menu">▸</button>
              <button class="cc2ProjIco" id="cc2NavIcon" title="Open menu" style="cursor:pointer;">${appsIcon('code')}</button>
              <div class="cc2Dot" title="Status"></div>
            </div>

            <div class="navOpenOnly" style="display:flex; flex-direction:column; gap:12px; min-height:0;">
              <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
                <div style="display:flex; gap:10px; align-items:flex-start; min-width:0;">
                  <div class="cc2ProjIco">${appsIcon('code')}</div>
                  <div style="min-width:0;">
                    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                      <div style="font-weight:900;">ClawdCode2</div>
                      <div class="cc2Dot" title="Status"></div>
                      <div class="muted" style="font-size:12px;">build ${BUILD}</div>
                    </div>
                    <div class="muted" id="cc2Ctx" style="margin-top:4px;">Workspace • Branch • Env</div>
                  </div>
                </div>
                <button class="cc2Tri" id="cc2NavClose" title="Close menu">◂</button>
              </div>

              <div class="subcard" style="margin:0;">
                <div class="muted" style="font-weight:900; margin-bottom:6px;">Workspace</div>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                  <select id="hdrWsSel" style="flex:1; min-width: 160px;"></select>
                  <button class="pill" id="hdrWsAdd" type="button">Add</button>
                </div>
                <div class="muted" id="codeMsg" style="margin-top:8px;"></div>
              </div>

              <div class="subcard" style="margin:0;">
                <div class="muted" style="font-weight:900; margin-bottom:6px;">Git</div>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                  <select id="hdrGitSel" style="flex:1; min-width: 160px;"><option value="">None</option></select>
                  <button class="pill" id="hdrGitConnect" type="button">Connect</button>
                  <button class="pill" id="hdrGitDisc" type="button">Disconnect</button>
                </div>
              </div>

              <div class="subcard" style="margin:0; min-height:0; overflow:auto;">
                <div class="muted" style="font-weight:900; margin-bottom:8px;">Apps</div>
                <div style="display:flex; flex-direction:column; gap:8px;">
                  <a class="pill" href="/apps" target="_blank" rel="noopener" style="justify-content:flex-start;">ClawdApps</a>
                  <a class="pill" href="/pm" target="_blank" rel="noopener" style="justify-content:flex-start;">ClawdPM</a>
                  <a class="pill" href="/apps/script" target="_blank" rel="noopener" style="justify-content:flex-start;">ClawdScript</a>
                  <a class="pill" href="/name" target="_blank" rel="noopener" style="justify-content:flex-start;">ClawdName</a>
                  <a class="pill" href="/apps/repo" target="_blank" rel="noopener" style="justify-content:flex-start;">ClawdRepo</a>
                  <a class="pill" href="/apps/sec" target="_blank" rel="noopener" style="justify-content:flex-start;">ClawdSec</a>
                  <a class="pill" href="/apps/ops" target="_blank" rel="noopener" style="justify-content:flex-start;">ClawdOps</a>
                  <a class="pill" href="/apps/pub" target="_blank" rel="noopener" style="justify-content:flex-start;">ClawdPub</a>
                  <a class="pill" href="/apps/build" target="_blank" rel="noopener" style="justify-content:flex-start;">ClawdBuild</a>
                  <a class="pill" href="/apps/queue" target="_blank" rel="noopener" style="justify-content:flex-start;">ClawdQueue</a>
                </div>
              </div>
            </div>
          </div>

          <div id="cc2Main">
            <div id="cc2Flex">
              <div class="pane" id="pane-workspace" style="flex: 0 0 360px;">
                <div class="paneHead">
                  <div class="paneIcon">${appsIcon('repo')}</div>
                  <div class="title">Workspace</div>
                  <div class="spacer"></div>
                  <div class="btnGroup move"><button class="btn" data-act="left">◁</button><button class="btn" data-act="right">▷</button></div>
                  <div class="btnGroup size"><button class="btn" data-act="minus">−</button><button class="btn" data-act="plus">+</button></div>
                  <button class="btn" data-act="collapse">▸</button>
                </div>
                <div class="paneBody">
                  <div class="muted" id="codeCwd" style="font-size:12px; margin-bottom:8px;"></div>
                  <div id="codeTree" style="min-height:0;"></div>
                </div>
              </div>

              <div class="pane" id="pane-filePreview" style="flex: 0 0 520px;">
                <div class="paneHead">
                  <div class="paneIcon">${appsIcon('code')}</div>
                  <div class="title">File Preview</div>
                  <div class="spacer"></div>
                  <div class="btnGroup move"><button class="btn" data-act="left">◁</button><button class="btn" data-act="right">▷</button></div>
                  <div class="btnGroup size"><button class="btn" data-act="minus">−</button><button class="btn" data-act="plus">+</button></div>
                  <button class="pill" id="codeSave" type="button">Save</button>
                  <button class="pill" id="codeReload" type="button">Reload</button>
                  <button class="btn" data-act="collapse">▸</button>
                </div>
                <div class="paneBody tight" style="display:flex; flex-direction:column; gap:10px;">
                  <div class="muted" id="codePath" style="font-size:12px; max-width: 80ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></div>
                  <div id="codeBlocked" style="display:none; border:1px solid rgba(255,255,255,0.12); border-radius:12px; padding:10px; background: rgba(255,255,255,0.03);"></div>
                  <textarea id="codeEditor" spellcheck="false" style="flex:1; min-height:0; width:100%; box-sizing:border-box;"></textarea>
                </div>
              </div>

              <div class="pane" id="pane-appPreview" style="flex: 1 1 auto; min-width: 360px;">
                <div class="paneHead">
                  <div class="paneIcon">${appsIcon('ops')}</div>
                  <div class="title">App Preview</div>
                  <div class="spacer"></div>
                  <div class="btnGroup move"><button class="btn" data-act="left">◁</button><button class="btn" data-act="right">▷</button></div>
                  <div class="btnGroup size"><button class="btn" data-act="minus">−</button><button class="btn" data-act="plus">+</button></div>
                  <button class="btn" id="appHeadToggle" title="Collapse header">▾</button>
                  <button class="btn" data-act="collapse">▸</button>
                </div>
                <div class="paneBody" style="padding-top:8px; display:flex; flex-direction:column; gap:10px;">
                  <div class="appHeadRow" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                    <input id="appUrl" class="ccMono" value="/proxy/5000/" style="flex: 1 1 320px; min-width: 220px;" />
                    <button class="pill" id="appGo" type="button">Go</button>
                    <span class="muted" id="appMsg" style="font-size:12px;"></span>
                  </div>
                  <div class="muted" style="font-size:12px;">Server-side preview (proxied). Loads the app running on the Console host.</div>
                  <div style="flex:1; min-height:0;"><iframe id="appFrame" class="ccIframe" src="/proxy/5000/" style="width:100%; height:100%; min-height:0; border:0; border-radius:12px; background:#0b1020;"></iframe></div>
                </div>
              </div>

              <div class="pane" id="pane-chat" style="flex: 0 0 360px;">
                <div class="paneHead">
                  <div class="paneIcon">${appsIcon('script')}</div>
                  <div class="title">Chat</div>
                  <div class="spacer"></div>
                  <div class="btnGroup move"><button class="btn" data-act="left">◁</button><button class="btn" data-act="right">▷</button></div>
                  <div class="btnGroup size"><button class="btn" data-act="minus">−</button><button class="btn" data-act="plus">+</button></div>
                  <button class="btn" data-act="collapse">▸</button>
                </div>
                <div class="paneBody" style="display:flex; flex-direction:column; gap:10px;">
                  <div class="muted" id="chatMsg" style="font-size:12px;"></div>
                  <div id="chatLog" style="flex:1; min-height:0; overflow:auto; border:1px solid rgba(255,255,255,0.10); border-radius:12px; padding:8px; background: rgba(0,0,0,0.10);"></div>
                  <textarea id="chatInput" placeholder="Message…" style="width:100%; min-height: 90px; max-height: 180px;"></textarea>
                  <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
                    <button class="pill" id="chatSend" type="button" style="border-color: rgba(154,208,255,0.55);">Send</button>
                    <button class="pill" id="chatJump" type="button">Jump to latest</button>
                  </div>
                </div>
              </div>

              <div class="pane" id="pane-ops" style="flex: 0 0 420px;">
                <div class="paneHead">
                  <div class="paneIcon">${appsIcon('queue')}</div>
                  <div class="title">ClawdList / Work</div>
                  <div class="spacer"></div>
                  <div class="btnGroup move"><button class="btn" data-act="left">◁</button><button class="btn" data-act="right">▷</button></div>
                  <div class="btnGroup size"><button class="btn" data-act="minus">−</button><button class="btn" data-act="plus">+</button></div>
                  <button class="btn" data-act="collapse">▸</button>
                </div>
                <div class="paneBody" style="display:flex; flex-direction:column; gap:12px; min-height:0;">
                  <div class="card" id="opListCard" style="background: rgba(255,255,255,0.03); overflow:auto; min-height:180px; flex: 1 1 auto;">
                    <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:center;">
                      <div class="muted" id="deStatus" style="font-size:12px;">Idle</div>
                    </div>
                    <div style="display:flex; gap:10px; align-items:center; margin-top:10px;">
                      <button class="pill" id="dePrev" type="button">Prev</button>
                      <button class="pill" id="deNext" type="button">Next</button>
                    </div>
                    <div id="deLists" style="margin-top:10px;"></div>
                  </div>

                  <div class="card" id="opWorkCard" style="background: rgba(255,255,255,0.03); flex: 0 0 44%; min-height: 220px; display:flex; flex-direction:column;">
                    <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
                      <div style="font-weight:900;">ClawdWork</div>
                      <button id="wlToggle" type="button" class="wlbtn" title="Collapse" style="border:0; background:transparent; color: rgba(232,238,252,.72); padding:6px;">▾</button>
                      <button class="pill" id="wlAdd" type="button">Add</button>
                      <button class="pill" id="wlStop" type="button">Stop</button>
                      <span class="muted" id="wlThinking" style="font-size:12px;">Idle</span>
                      <span style="flex:1;"></span>
                      <div class="muted" id="wlMsg" style="font-size:12px;"></div>
                    </div>
                    <div id="worklogWrap" style="margin-top:10px; flex:1; min-height:0; overflow:hidden; display:flex; flex-direction:column;">
                      <div id="worklog" style="flex:1; min-height:0; overflow:auto;"></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <script src="/static/code2.js?v=${BUILD}"></script>
    ` },

    repo: { title:'ClawdRepo', subtitle:'Commits for this project + useful repo links.', body:`
      <div class="subcard" style="line-height:1.55;">
        <div class="muted">Local repo: <code>${__dirname}</code></div>
        <div class="muted" style="margin-top:6px;">GitHub: <a href="https://github.com/nwesource01/clawdconsole" target="_blank" rel="noopener">nwesource01/clawdconsole</a></div>
        <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
          <button class="pill" id="repoRefreshBtn" type="button" style="cursor:pointer;">Refresh</button>
        </div>
        <div id="repoCommits" class="card" style="margin-top:12px; background: rgba(0,0,0,0.10);"></div>
      </div>

      <script>
      (async () => {
        const box = document.getElementById('repoCommits');
        const btn = document.getElementById('repoRefreshBtn');

        async function load(){
          if (!box) return;
          box.innerHTML = '<div class="muted">Loading…</div>';
          try {
            const res = await fetch('/api/repo/commits?limit=80', { credentials:'include', cache:'no-store' });
            const j = await res.json();
            const commits = (j && j.ok && Array.isArray(j.commits)) ? j.commits : [];
            if (!commits.length) { box.innerHTML = '<div class="muted">No commits found.</div>'; return; }
            box.innerHTML = commits.map(c => {
              const short = String(c.hash||'').slice(0,7);
              const msg = String(c.subject||'');
              const when = String(c.date||'');
              const refs = c.refs ? ('<span class="muted">(' + String(c.refs) + ')</span>') : '';
              return '<div style="padding:10px 8px; border-bottom:1px solid rgba(255,255,255,0.08)">' +
                '<div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">' +
                  '<div><code>' + short + '</code> ' + refs + '</div>' +
                  '<div class="muted">' + when + '</div>' +
                '</div>' +
                '<div style="margin-top:6px;">' + msg + '</div>' +
              '</div>';
            }).join('');
          } catch {
            box.innerHTML = '<div class="muted">Failed to load commits.</div>';
          }
        }

        if (btn) btn.addEventListener('click', load);
        load();
      })();
      </script>
    ` },
    sec: { title:'ClawdSec', subtitle:'Security posture + copy/paste-safe hardening.', body:`
      <div class="subcard" style="line-height:1.55;">
        <div class="muted">A practical security panel: what’s already enabled in this Console, common failure modes, and safe hardening commands.</div>

        <div class="grid" style="margin-top:12px; grid-template-columns: 1fr 1fr; align-items:start;">
          <div class="card" style="background: rgba(0,0,0,0.10);">
            <div style="font-weight:900; margin-bottom:8px;">Enabled here</div>
            <ul style="margin:0; padding-left: 18px;">
              <li><b>Auth gate</b>: Basic auth + session cookie (fetch works without headers)</li>
              <li><b>Uploads</b>: served without directory index; no-store headers</li>
              <li><b>No secrets in UI</b>: design rule — keep keys in env files</li>
              <li><b>Audit trail</b>: transcript + worklog capture key actions</li>
            </ul>
            <div class="muted" style="margin-top:10px;">Note: some browsers block inline scripts; we keep critical app JS in <code>/static</code>.</div>
          </div>

          <div class="card" style="background: rgba(0,0,0,0.10);">
            <div style="font-weight:900; margin-bottom:8px;">Common trouble spots</div>
            <ul style="margin:0; padding-left: 18px;">
              <li><b>Inline JS blocked</b> → UI appears but buttons don’t work (fix: move JS to <code>/static</code>)</li>
              <li><b>Auth cookie Secure</b> on HTTP → session may not stick (prefer HTTPS reverse proxy)</li>
              <li><b>Open internet</b> → brute force risk (add fail2ban / allowlist / VPN)</li>
            </ul>
          </div>
        </div>

        <div class="card" style="margin-top:12px; background: rgba(0,0,0,0.10);">
          <div style="font-weight:900; margin-bottom:8px;">Security Recommendations (copy-safe)</div>
          <div class="muted" style="margin-bottom:10px;">Run only what you understand. These are suggestions, not auto-executed.</div>

          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; align-items:start;">
            ${(() => {
              const blocks = [
                {
                  title: '1) Put Console behind HTTPS (recommended)',
                  cmd: '# Example (Caddy):\n# reverse_proxy 127.0.0.1:21337\n# (terminate TLS, then access over https://)',
                },
                {
                  title: '2) Lock SSH down + basic firewall',
                  cmd: 'ufw allow OpenSSH\nufw allow 80\nufw allow 443\nufw --force enable\nufw status verbose',
                },
                {
                  title: '3) fail2ban for sshd (quick hardening)',
                  cmd: 'apt-get update\napt-get install -y fail2ban\nsystemctl enable --now fail2ban\nfail2ban-client status',
                },
                {
                  title: '4) Rotate AUTH_PASS',
                  cmd: 'nano /etc/clawdio-console.env\n# update AUTH_PASS=...\nsystemctl restart clawdio-console.service',
                },
              ];
              const esc = (s) => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
              return blocks.map(b => {
                const code = esc(b.cmd);
                const raw = String(b.cmd||'');
                const copy = raw.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                return '<div style="border:1px solid rgba(255,255,255,0.10); border-radius:12px; padding:10px; background: rgba(255,255,255,0.03);">'
                  + '<div style="display:flex; justify-content:space-between; gap:10px; align-items:baseline; flex-wrap:wrap;">'
                  + '<div style="font-weight:900;">' + esc(b.title) + '</div>'
                  + '<button class="pill" type="button" data-copy="' + copy + '">Copy</button>'
                  + '</div>'
                  + '<pre style="margin-top:8px; white-space:pre-wrap;"><code>' + code + '</code></pre>'
                  + '</div>';
              }).join('');
            })()}
          </div>
        </div>
      </div>
      <script src="/static/sec.js"></script>
    ` },
    ops: { title:'ClawdOps', subtitle:'Questionnaire + Gateway + Codex.', body:`
      <div class="subcard" style="line-height:1.55;">
        <div class="row" style="gap:8px; flex-wrap:wrap; margin-bottom:10px; align-items:center;">
          <button class="pill" id="opsTabQ" type="button">Questionnaire</button>
          <button class="pill" id="opsTabG" type="button">Gateway</button>
          <button class="pill" id="opsTabC" type="button">Codex</button>
          <button class="pill" id="opsTabTogether" type="button">Together</button>
          <button class="pill" id="opsTabClawd" type="button">Clawd</button>
          <span style="flex:1;"></span>
          <span id="opsHydration" class="muted" title="Auto-state hydration: unknown" style="display:inline-flex; align-items:center; gap:6px; user-select:none;">
            <span id="opsHydrationIcon" aria-hidden="true" style="font-weight:900;">…</span>
            <span class="muted" style="font-size:12px;">Auto-state</span>
          </span>
          <button class="pill" id="opsRestart" type="button" style="border-color: rgba(255,160,160,0.55);">Restart Console</button>
          <span class="muted" id="opsTabMsg"></span>
        </div>

        <div id="opsTabQuestionnaire">
        <div class="muted">Markdown notes about you + your environment. File-backed in DATA_DIR, and can be committed to workspace memory for long-term use.</div>

        <div class="row" style="margin-top:12px; gap:10px; flex-wrap:wrap; align-items:center;">
          <button class="pill" id="opsSave" type="button">Save</button>
          <button class="pill" id="opsCommit" type="button">Commit to MD memory (workspace)</button>
          <button class="pill" id="opsTemplate" type="button">Insert questionnaire template</button>
          <button class="pill" id="opsRepeat" type="button">Repeated questions</button>
          <span class="muted" id="opsMsg"></span>
        </div>

        <div style="margin-top:12px;">
          <textarea id="opsProfile" placeholder="# Ops profile\n\nWrite anything you want remembered here…" style="width:100%; min-height:320px;"></textarea>
          <div class="muted" style="margin-top:8px;">Saved to: <code>${DATA_DIR}/ops-profile.md</code> • Commit writes to: <code>/home/master/clawd/memory/clawdops-profile.md</code></div>
        </div>

        <div class="card" style="margin-top:12px; background: rgba(0,0,0,0.10);">
          <div style="font-weight:900; margin-bottom:8px;">Repeated questions (best-effort)</div>
          <div class="muted" style="margin-bottom:8px;">Scans transcript assistant messages for repeated question lines so we can turn them into rules or defaults.</div>
          <div id="opsRepeated" style="max-height: 50vh; overflow:auto; padding-right:6px;"></div>
        </div>

        </div><!-- /opsTabQuestionnaire -->
        <div id="opsTabGateway" style="display:none;">

        <div class="card" style="margin-top:12px; background: rgba(0,0,0,0.10);">
          <div style="font-weight:900; margin-bottom:8px;">Gateway Integration</div>
          <div class="muted" style="margin-bottom:10px;">This is where we verify we are receiving <i>all</i> gateway/Codex events and can swap integration details for the next install/account.</div>

          <div class="twoCol">
            <div>
              <div class="muted" style="margin-bottom:6px;">Gateway WS URL</div>
              <input id="codexGatewayUrl" class="inp" placeholder="ws://127.0.0.1:18789" style="width:100%; max-width: 640px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;" />
              <div class="muted" style="margin-top:10px; margin-bottom:6px;">Console sessionKey</div>
              <input id="codexSessionKey" class="inp" placeholder="claw-console" style="width:100%; max-width: 420px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;" />
              <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap;">
                <button class="pill" id="codexSave" type="button">Save integration</button>
                <button class="pill" id="codexReconnect" type="button">Reconnect gateway</button>
                <span class="muted" id="codexMsg"></span>
              </div>
              <div class="muted" style="margin-top:10px;">Saved to: <code>${DATA_DIR}/codex-config.json</code></div>
            </div>

            <div>
              <div style="font-weight:900; margin-bottom:8px;">Status</div>
              <div id="codexStatus" class="muted">Loading…</div>
              <div style="margin-top:10px; font-weight:900;">Last error</div>
              <pre id="codexLastError" style="white-space:pre-wrap; word-break:break-word; margin:8px 0 0; padding:10px; border-radius:12px; border:1px solid rgba(255,255,255,0.10); background: rgba(0,0,0,0.12); max-height: 160px; overflow:auto;"></pre>
            </div>
          </div>

          <div style="margin-top:12px; font-weight:900;">Recent raw gateway events</div>
          <div class="muted" style="margin:6px 0 10px;">If Codex returns an out-of-band message (like usage limit), it should appear here even if it doesn't become a chat message.</div>
          <div class="row" style="gap:10px; flex-wrap:wrap; align-items:center;">
            <button class="pill" id="codexEventsRefresh" type="button">Refresh events</button>
            <label class="muted" style="display:flex; align-items:center; gap:8px;">Limit <input id="codexEventsLimit" class="inp" value="120" style="width:80px;" /></label>
          </div>
          <pre id="codexEvents" style="white-space:pre-wrap; word-break:break-word; margin:10px 0 0; padding:10px; border-radius:12px; border:1px solid rgba(255,255,255,0.10); background: rgba(0,0,0,0.12); max-height: 40vh; overflow:auto;"></pre>
        </div>

        </div><!-- /opsTabGateway -->

        <div id="opsTabCodex" style="display:none;">
          <div class="card" style="margin-top:12px; background: rgba(0,0,0,0.10);">
            <div style="font-weight:900; margin-bottom:8px;">Codex Auth Profile</div>
            <div class="muted" style="margin-bottom:10px;">Switches which Codex OAuth identity is used for the <code>${CONSOLE_SESSION_KEY}</code> session (via <code>sessions.patch</code> authProfileOverride).</div>

            <div class="twoCol">
              <div>
                <div class="muted" style="margin-bottom:6px;">Profile</div>
                <select id="codexProfileSel" class="inp" style="width:100%; max-width: 640px;"></select>
                <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap;">
                  <button class="pill" id="codexProfileApply" type="button">Apply</button>
                  <button class="pill" id="codexProfileClear" type="button">Clear override</button>
                  <span class="muted" id="codexProfileMsg"></span>
                </div>
                <div class="muted" style="margin-top:10px;">Profiles read from: <code>/root/.clawdbot/agents/main/agent/auth-profiles.json</code></div>
              </div>
              <div>
                <div style="font-weight:900; margin-bottom:8px;">Current</div>
                <div id="codexProfileCurrent" class="muted">Loading…</div>
              </div>
            </div>
          </div>
        </div><!-- /opsTabCodex -->

        <div id="opsTabTogetherView" style="display:none;">
          <div class="card" style="margin-top:12px; background: rgba(0,0,0,0.10);">
            <div style="font-weight:900; margin-bottom:8px;">Together.ai (OpenAI-compatible)</div>
            <div class="muted" style="margin-bottom:10px;">Ops-only config to validate calls. This stores a Together API key + default model so we can later route requests through it (e.g. Qwen2.5-Coder).</div>

            <div class="twoCol">
              <div>
                <div class="muted" style="margin-bottom:6px;">Base URL</div>
                <input id="togetherBaseUrl" class="inp" placeholder="https://api.together.xyz" style="width:100%; max-width: 640px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;" />
                <div class="muted" style="margin-top:6px;">Serverless uses <code>https://api.together.xyz</code>. Don’t paste a <code>/models/…</code> dedicated-endpoint URL.</div>

                <div class="muted" style="margin-top:10px; margin-bottom:6px;">Model</div>
                <div class="row" style="gap:10px; flex-wrap:wrap; align-items:center;">
                  <select id="togetherModelPick" class="inp" style="flex:1; min-width: 260px; max-width: 640px;"></select>
                  <button class="pill" id="togetherModelRefresh" type="button">Refresh list</button>
                </div>
                <div class="muted" style="margin-top:6px;">Or type a model override:</div>
                <input id="togetherModel" class="inp" placeholder="Qwen/Qwen3-Coder-Next-FP8" style="width:100%; max-width: 640px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;" />

                <div class="muted" style="margin-top:10px; margin-bottom:6px;">API key</div>
                <input id="togetherApiKey" class="inp" type="password" placeholder="together_..." style="width:100%; max-width: 640px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;" />

                <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap; align-items:center;">
                  <button class="pill" id="togetherSave" type="button">Save</button>
                  <button class="pill" id="togetherClear" type="button">Clear key</button>
                  <span class="muted" id="togetherMsg"></span>
                </div>

                <div class="muted" style="margin-top:10px;">Saved to: <code>${DATA_DIR}/together-config.json</code></div>
              </div>

              <div>
                <div style="font-weight:900; margin-bottom:8px;">Test</div>
                <div class="muted" style="margin-bottom:6px;">Prompt</div>
                <textarea id="togetherPrompt" class="inp" style="width:100%; min-height:120px;">Say hello and confirm you are running on Together.</textarea>
                <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap; align-items:center;">
                  <button class="pill" id="togetherTest" type="button" style="border-color: rgba(154,208,255,0.55);">Run test</button>
                  <span class="muted" id="togetherTestMsg"></span>
                </div>
                <pre id="togetherOut" style="white-space:pre-wrap; word-break:break-word; margin:10px 0 0; padding:10px; border-radius:12px; border:1px solid rgba(255,255,255,0.10); background: rgba(0,0,0,0.12); max-height: 40vh; overflow:auto;"></pre>
              </div>
            </div>
          </div>
        </div><!-- /opsTabTogetherView -->

        <div id="opsTabClawdView" style="display:none;">
          <div class="card" style="margin-top:12px; background: rgba(0,0,0,0.10);">
            <div style="font-weight:900; margin-bottom:8px;">Clawd</div>
            <div class="muted" style="margin-bottom:10px;">UI branding only. This does not rename services/hosts; it just changes how the Console refers to the assistant.</div>

            <div class="twoCol">
              <div>
                <div class="muted" style="margin-bottom:6px;">Assistant name</div>
                <input id="brandAssistantName" class="inp" placeholder="Clawdwell" style="width:100%; max-width: 420px;" />
                <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap; align-items:center;">
                  <button class="pill" id="brandSave" type="button">Save</button>
                  <button class="pill" id="brandReload" type="button">Reload</button>
                  <span class="muted" id="brandMsg"></span>
                </div>
                <div class="muted" style="margin-top:10px;">Saved to: <code>${DATA_DIR}/brand.json</code></div>
              </div>
              <div>
                <div style="font-weight:900; margin-bottom:8px;">Current</div>
                <div id="brandCurrent" class="muted">Loading…</div>
                <div class="muted" style="margin-top:10px;">Tip: after changing the name, refresh open tabs to see it everywhere.</div>
              </div>
            </div>
          </div>
        </div><!-- /opsTabClawdView -->

      </div>
      <script src="/static/ops.js"></script>
    ` },
    pub: { title:'ClawdPub', subtitle:'Published artifacts + SOP.', body:`
      <div class="subcard" style="line-height:1.55;">
        <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:baseline;">
          <div>Open SOP: <a href="/clawdpub/sop" target="_blank" rel="noopener">/clawdpub/sop</a></div>
          <button class="pill" id="pubRefreshBtn" type="button" style="cursor:pointer;">Refresh</button>
        </div>
        <div id="pubCounts" class="muted" style="margin-top:10px;"></div>
        <div id="pubGrid" class="grid" style="grid-template-columns: repeat(3, minmax(0,1fr));"></div>
      </div>

      <script>
      (async () => {
        const grid = document.getElementById('pubGrid');
        const counts = document.getElementById('pubCounts');
        const btn = document.getElementById('pubRefreshBtn');

        function esc(s){
          return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        }

        async function load(){
          if (!grid) return;
          grid.innerHTML = '<div class="muted">Loading…</div>';
          try {
            const res = await fetch('/api/pub/items', { credentials:'include', cache:'no-store' });
            const j = await res.json();
            const items = (j && j.ok && Array.isArray(j.items)) ? j.items : [];
            const cts = (j && j.ok && j.counts) ? j.counts : {};

            if (counts) {
              const parts = Object.keys(cts).sort().map(k => k + ': ' + cts[k]);
              counts.textContent = parts.length ? ('Counts: ' + parts.join(' • ')) : 'No published items yet.';
            }

            if (!items.length) {
              grid.innerHTML = '<div class="muted">No published artifacts yet.</div>';
              return;
            }

            grid.innerHTML = items.map(it => {
              const title = esc(it.title||'');
              const cat = esc(it.category||'');
              const status = esc(it.status||'');
              const sum = esc(it.summary||'');
              const links = Array.isArray(it.links) ? it.links : [];
              const linksHtml = links.map(l => '<a href="' + esc(l.url||'') + '" target="_blank" rel="noopener">' + esc(l.label||l.url||'link') + '</a>').join(' • ');

              return '<div class="card" style="background: rgba(0,0,0,0.10);">' +
                '<div style="font-weight:900;">' + title + '</div>' +
                '<div class="muted" style="margin-top:6px;">' + [cat,status].filter(Boolean).join(' • ') + '</div>' +
                (sum ? ('<div style="margin-top:10px; color: rgba(232,238,252,.80);">' + sum + '</div>') : '') +
                (linksHtml ? ('<div class="muted" style="margin-top:10px;">' + linksHtml + '</div>') : '') +
              '</div>';
            }).join('');
          } catch {
            grid.innerHTML = '<div class="muted">Failed to load published items.</div>';
          }
        }

        if (btn) btn.addEventListener('click', load);
        load();
      })();
      </script>
    ` },
    build: { title:'ClawdBuild', subtitle:'Templates + spec prompt generator (coming).', body:`
      <div class="subcard" style="line-height:1.55;">
        <div class="muted">ClawdBuild is about going from an idea → a build plan → a real shipped app. First step: a template system.</div>

        <div class="grid" style="margin-top:12px; grid-template-columns: 1.2fr .8fr; align-items:start;">
          <div class="card" style="background: rgba(0,0,0,0.10);">
            <div style="font-weight:900; margin-bottom:8px;">Template libraries (curated)</div>
            <div class="muted">Browse templates where they live. Pick one, then we’ll generate a spec + tasks.</div>

            <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
              <a class="pill" href="https://replit.com/templates" target="_blank" rel="noopener">Replit Templates</a>
              <a class="pill" href="https://lovable.dev/templates" target="_blank" rel="noopener">Lovable Templates</a>
              <a class="pill" href="https://github.com/topics" target="_blank" rel="noopener">GitHub Topics</a>
            </div>

            <div style="margin-top:12px;">
              <details>
                <summary style="cursor:pointer; font-weight:900;">Categories</summary>
                <div style="margin-top:10px; display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
                  <div class="card" style="background: rgba(255,255,255,0.03); padding:10px;">
                    <div style="font-weight:800;">CRM</div>
                    <div class="muted" style="margin-top:6px;"><a href="https://github.com/topics/crm" target="_blank" rel="noopener">github.com/topics/crm</a></div>
                  </div>
                  <div class="card" style="background: rgba(255,255,255,0.03); padding:10px;">
                    <div style="font-weight:800;">Project manager / Kanban</div>
                    <div class="muted" style="margin-top:6px;"><a href="https://github.com/topics/kanban" target="_blank" rel="noopener">github.com/topics/kanban</a></div>
                  </div>
                  <div class="card" style="background: rgba(255,255,255,0.03); padding:10px;">
                    <div style="font-weight:800;">Dashboard / Admin</div>
                    <div class="muted" style="margin-top:6px;"><a href="https://github.com/topics/admin-dashboard" target="_blank" rel="noopener">github.com/topics/admin-dashboard</a></div>
                  </div>
                  <div class="card" style="background: rgba(255,255,255,0.03); padding:10px;">
                    <div style="font-weight:800;">Landing page</div>
                    <div class="muted" style="margin-top:6px;"><a href="https://github.com/topics/landing-page" target="_blank" rel="noopener">github.com/topics/landing-page</a></div>
                  </div>
                </div>
              </details>
            </div>

            <div class="muted" style="margin-top:12px;">Note: this is intentionally link-first (curated) to avoid building a heavy template marketplace UI too early.</div>
          </div>

          <div class="card" style="background: rgba(0,0,0,0.10);">
            <div style="font-weight:900; margin-bottom:8px;">Prompt Generator (placeholder)</div>
            <div class="muted">Next phase: “I want a CRM like Salesforce…” → generate a build spec prompt + task breakdown + recommended templates.</div>

            <div class="muted" style="margin-top:10px;">Planned inputs:</div>
            <ul style="margin:8px 0 0 18px;">
              <li>Use-case</li>
              <li>Tech stack (filter)</li>
              <li>Complexity</li>
              <li>Ships-with checklist (auth/db/deploy)</li>
            </ul>
          </div>
        </div>

        <div class="card" style="margin-top:12px; background: rgba(0,0,0,0.10);">
          <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:baseline;">
            <div style="font-weight:900;">Local Template Index (advanced)</div>
            <button class="pill" id="cbRefresh" type="button">Refresh</button>
          </div>
          <div class="muted" style="margin-top:6px;">File-backed index for internal use. UI editing is disabled on purpose (curated link-first UX above).</div>
          <div class="muted" style="margin-top:6px;">Source: <code>${DATA_DIR}/clawdbuild-templates.json</code></div>
          <div class="muted" id="cbMsg" style="margin-top:10px;"></div>
          <div id="cbLocalList" style="margin-top:10px;"></div>
        </div>
      </div>
      <script src="/static/build.js"></script>
    ` },
    queue: { title:'ClawdQueue', subtitle:'Serial execution rail (PM-backed).', body:`
      <div class="subcard" style="line-height:1.55;">
        <div class="muted">Source: a selected PM column in <code>${PM_FILE}</code>. Queue + PM share the same cards (status is synced).</div>

        <div class="row" style="margin-top:12px; gap:10px; flex-wrap:wrap; align-items:center;">
          <span class="muted">Column</span>
          <select id="qCol" style="min-width:220px; padding:10px 12px;"></select>
          <button class="pill" id="qColSave" type="button">Use column</button>

          <label class="muted" style="display:flex; gap:8px; align-items:center;">
            <input type="checkbox" id="qAuto" /> Auto-run next after Done (15s)
          </label>
          <button class="pill" id="qStop" type="button">Stop</button>

          <span style="flex:1;"></span>

          <button class="pill" id="qRun" type="button" style="border-color: rgba(124,255,178,.55); background: linear-gradient(180deg, rgba(124,255,178,.22), rgba(124,255,178,.10));">Run next</button>
          <button class="pill" id="qRefresh" type="button">Refresh</button>
          <button class="pill" id="qEnqueueAll" type="button">Enqueue all</button>
          <button class="pill" id="qClearQueue" type="button">Clear queued</button>
          <span class="muted" id="qMsg"></span>
        </div>

        <div class="grid" style="margin-top:12px; grid-template-columns: 1.2fr .6fr .8fr; align-items:start;">
          <div class="card" style="background: rgba(0,0,0,0.10);">
            <div style="font-weight:900; margin-bottom:8px;">Up next (queued)</div>
            <div id="qQueued" class="muted">Loading…</div>
          </div>

          <div class="card" style="background: rgba(0,0,0,0.10);">
            <div style="font-weight:900; margin-bottom:8px;">Done</div>
            <div id="qDone" class="muted">Loading…</div>
          </div>

          <div class="card" style="background: rgba(0,0,0,0.10);">
            <div style="font-weight:900; margin-bottom:8px;">Countdown</div>
            <div class="muted">When you mark an item done, we can auto-continue after a pause.</div>
            <div id="qCountdown" style="margin-top:10px; font-size:16px; font-weight:900;"></div>
            <div class="muted" id="qCountdownSub" style="margin-top:6px;"></div>
          </div>
        </div>

        <div class="card" style="margin-top:12px; background: rgba(0,0,0,0.10);">
          <div style="font-weight:900; margin-bottom:8px;">Rebuild column cards</div>
          <div id="qAll" class="muted">Loading…</div>
        </div>
      </div>

      <script>
      (() => {
        const $ = (id) => document.getElementById(id);
        const msg = $('qMsg');
        let countdownTimer = null;

        function esc(s){
          return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        }

        function setMsg(t){ if (msg) msg.textContent = t || ''; }

        async function load(){
          setMsg('');
          const allEl = $('qAll');
          const qEl = $('qQueued');
          const dEl = $('qDone');
          if (allEl) allEl.textContent = 'Loading…';
          if (qEl) qEl.textContent = 'Loading…';
          if (dEl) dEl.textContent = 'Loading…';

          const res = await fetch('/api/pm', { credentials:'include', cache:'no-store' });
          const j = await res.json();
          const cols = (j && j.ok && j.pm && Array.isArray(j.pm.columns)) ? j.pm.columns : [];

          const stRes = await fetch('/api/queue/state', { credentials:'include', cache:'no-store' });
          const stJ = await stRes.json();
          const selectedId = (stJ && stJ.ok && stJ.state && stJ.state.selectedColumnId) ? String(stJ.state.selectedColumnId) : 'rebuild';
          const autoOn = !!(stJ && stJ.ok && stJ.state && stJ.state.autorunEnabled);

          // Populate column picker
          const sel = $('qCol');
          if (sel) {
            sel.innerHTML = '';
            for (const c of cols) {
              if (!c || !c.id) continue;
              const opt = document.createElement('option');
              opt.value = String(c.id);
              opt.textContent = (c.title || c.id);
              sel.appendChild(opt);
            }
            sel.value = selectedId;
          }

          const autoCb = $('qAuto');
          if (autoCb) autoCb.checked = autoOn;

          const col = cols.find(c => String(c.id||'') === selectedId) || cols.find(c => String(c.id||'') === 'rebuild' || String(c.title||'').toLowerCase() === 'rebuild');
          const cards = (col && Array.isArray(col.cards)) ? col.cards : [];

          const queued = cards.filter(c => (c.queueStatus === 'queued' || c.queuedAt) && !c.completedAt);
          const done = cards.filter(c => c.queueStatus === 'done' || c.completedAt);

          function cardRow(c){
            const status = c.completedAt ? 'done' : (c.queuedAt ? 'queued' : '');
            const badge = status ? ('<span class="badge" style="margin-left:8px;">' + esc(status) + '</span>') : '';
            const meta = [c.desc||'', c.completedAt?('✓ '+String(c.completedAt).slice(0,19).replace('T',' ')):'', c.queuedAt?('queued '+String(c.queuedAt).slice(0,19).replace('T',' ')):''].filter(Boolean).join(' • ');

            const btnQueue = '<button class="pill" data-act="queue" data-id="'+esc(c.id)+'" type="button">Queue</button>';
            const btnDone  = '<button class="pill" data-act="done" data-id="'+esc(c.id)+'" type="button">Done</button>';
            const btnClear = '<button class="pill" data-act="clear" data-id="'+esc(c.id)+'" type="button">Clear</button>';

            return '<div style="padding:10px 8px; border-top:1px solid rgba(255,255,255,0.08);">'
              + '<div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:baseline;">'
              +   '<div style="min-width:240px;">'
              +     '<div style="font-weight:900;">' + esc(c.title||'') + badge + '</div>'
              +     (meta ? ('<div class="muted" style="margin-top:6px;">' + esc(meta) + '</div>') : '')
              +   '</div>'
              +   '<div class="row" style="gap:8px; justify-content:flex-end;">' + btnQueue + btnDone + btnClear + '</div>'
              + '</div>'
              + '</div>';
          }

          if (qEl) qEl.innerHTML = queued.length ? queued.map(cardRow).join('') : '<div class="muted">Nothing queued.</div>';
          if (dEl) dEl.innerHTML = done.length ? done.slice().reverse().slice(0,12).map(cardRow).join('') : '<div class="muted">Nothing completed yet.</div>';
          if (allEl) allEl.innerHTML = cards.length ? cards.map(cardRow).join('') : '<div class="muted">No cards found in Rebuild column.</div>';

          // wire actions
          for (const el of document.querySelectorAll('[data-act][data-id]')){
            el.addEventListener('click', async (ev) => {
              const act = el.getAttribute('data-act');
              const id = el.getAttribute('data-id');
              if (!id) return;

              if (act === 'queue') {
                await fetch('/api/pm/cardPatch', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({ cardId:id, patch:{ queuedAt: new Date().toISOString(), completedAt: null, queueStatus:'queued' } }) });
                setMsg('Queued.');
                return load();
              }
              if (act === 'done') {
                const now = new Date().toISOString();
                await fetch('/api/pm/cardPatch', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({ cardId:id, patch:{ completedAt: now, queueStatus:'done' } }) });
                setMsg('Marked done.');

                // If autorun is enabled, schedule the next queued card kickoff.
                try {
                  const stRes = await fetch('/api/queue/state', { credentials:'include', cache:'no-store' });
                  const stJ = await stRes.json();
                  const en = !!(stJ && stJ.ok && stJ.state && stJ.state.autorunEnabled);
                  if (en) {
                    startCountdown(15, 'Auto-run enabled: moving to the next queued card unless you stop it.');
                    await fetch('/api/queue/autorun/scheduleNext', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({ delayMs: 15000 }) });
                  } else {
                    startCountdown(15, 'Auto-run is OFF. (Countdown is just visual.)');
                  }
                } catch {
                  startCountdown(15, 'Auto-run schedule failed.');
                }

                return load();
              }
              if (act === 'clear') {
                await fetch('/api/pm/cardPatch', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({ cardId:id, patch:{ queuedAt: null, completedAt: null, queueStatus:'' } }) });
                setMsg('Cleared.');
                return load();
              }
            });
          }
        }

        function startCountdown(secs, sub){
          const box = $('qCountdown');
          const subEl = $('qCountdownSub');
          if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
          let left = Number(secs||0);
          if (subEl) subEl.textContent = sub || '';
          if (!box) return;
          box.textContent = left ? ('Continuing in ' + left + 's…') : '';
          countdownTimer = setInterval(() => {
            left--;
            if (left <= 0) {
              clearInterval(countdownTimer);
              countdownTimer = null;
              box.textContent = 'Ready.';
              return;
            }
            box.textContent = 'Continuing in ' + left + 's…';
          }, 1000);
        }

        async function enqueueAll(){
          setMsg('Enqueueing…');
          const res = await fetch('/api/pm', { credentials:'include', cache:'no-store' });
          const j = await res.json();
          const cols = (j && j.ok && j.pm && Array.isArray(j.pm.columns)) ? j.pm.columns : [];

          const stRes = await fetch('/api/queue/state', { credentials:'include', cache:'no-store' });
          const stJ = await stRes.json();
          const selectedId = (stJ && stJ.ok && stJ.state && stJ.state.selectedColumnId) ? String(stJ.state.selectedColumnId) : 'rebuild';

          const col = cols.find(c => String(c.id||'') === selectedId) || cols.find(c => String(c.id||'') === 'rebuild' || String(c.title||'').toLowerCase() === 'rebuild');
          const cards = (col && Array.isArray(col.cards)) ? col.cards : [];

          for (const c of cards){
            if (c.completedAt) continue;
            if (c.queueStatus === 'queued' || c.queuedAt) continue;
            await fetch('/api/pm/cardPatch', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({ cardId:String(c.id), patch:{ queuedAt: new Date().toISOString(), completedAt: null, queueStatus:'queued' } }) });
          }
          setMsg('Enqueued all.');
          load();
        }

        async function clearQueued(){
          setMsg('Clearing…');
          const res = await fetch('/api/pm', { credentials:'include', cache:'no-store' });
          const j = await res.json();
          const cols = (j && j.ok && j.pm && Array.isArray(j.pm.columns)) ? j.pm.columns : [];

          const stRes = await fetch('/api/queue/state', { credentials:'include', cache:'no-store' });
          const stJ = await stRes.json();
          const selectedId = (stJ && stJ.ok && stJ.state && stJ.state.selectedColumnId) ? String(stJ.state.selectedColumnId) : 'rebuild';

          const col = cols.find(c => String(c.id||'') === selectedId) || cols.find(c => String(c.id||'') === 'rebuild' || String(c.title||'').toLowerCase() === 'rebuild');
          const cards = (col && Array.isArray(col.cards)) ? col.cards : [];

          for (const c of cards){
            if (c.completedAt) continue;
            if (!(c.queueStatus === 'queued' || c.queuedAt)) continue;
            await fetch('/api/pm/cardPatch', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({ cardId:String(c.id), patch:{ queuedAt: null, queueStatus:'' } }) });
          }
          setMsg('Cleared queued.');
          load();
        }

        async function saveSelectedColumn(){
          const sel = $('qCol');
          const id = sel ? String(sel.value||'').trim() : '';
          if (!id) return;
          setMsg('Saving…');
          await fetch('/api/queue/state', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({ state: { selectedColumnId: id } }) });
          setMsg('Column set.');
          load();
        }

        async function saveAutorun(){
          const cb = $('qAuto');
          const on = !!(cb && cb.checked);
          setMsg('Saving…');
          await fetch('/api/queue/state', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({ state: { autorunEnabled: on } }) });
          setMsg('Auto-run ' + (on ? 'ON' : 'OFF') + '.');
          load();
        }

        async function stopAutorun(){
          setMsg('Stopping…');
          await fetch('/api/queue/autorun/stop', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: '{}' });
          setMsg('Stopped.');
          load();
        }

        async function runNext(){
          try {
            const stRes = await fetch('/api/queue/state', { credentials:'include', cache:'no-store' });
            const stJ = await stRes.json();
            const en = !!(stJ && stJ.ok && stJ.state && stJ.state.autorunEnabled);
            if (!en) {
              setMsg('Auto-run is OFF. Turn it on first.');
              return;
            }
            setMsg('Scheduling…');
            startCountdown(2, 'Starting next queued card…');
            await fetch('/api/queue/autorun/scheduleNext', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({ delayMs: 1500 }) });
            setMsg('Scheduled.');
          } catch {
            setMsg('Run failed.');
          }
        }

        const btnRun = $('qRun');
        const btnR = $('qRefresh');
        const btnA = $('qEnqueueAll');
        const btnC = $('qClearQueue');
        const btnS = $('qColSave');
        const cbA = $('qAuto');
        const btnStop = $('qStop');
        if (btnRun) btnRun.addEventListener('click', runNext);
        if (btnR) btnR.addEventListener('click', load);
        if (btnA) btnA.addEventListener('click', enqueueAll);
        if (btnC) btnC.addEventListener('click', clearQueued);
        if (btnS) btnS.addEventListener('click', saveSelectedColumn);
        if (cbA) cbA.addEventListener('change', saveAutorun);
        if (btnStop) btnStop.addEventListener('click', stopAutorun);

        load();
      })();
      </script>
    ` },

  };

  const spec = map[key];
  if (!spec) return null;

  const bodyHtml = `${spec.body || ''}`;

  const hrefMap = {
    script: '/apps/script',
    repo: '/apps/repo',
    code: '/apps/code',
    code2: '/apps/code2',
    sec: '/apps/sec',
    ops: '/apps/ops',
    pub: '/apps/pub',
    build: '/apps/build',
    queue: '/apps/queue',
  };

  return appsPageShell({ title: spec.title, subtitle: spec.subtitle, bodyHtml, activePath: hrefMap[key] || '' });
}

app.get('/apps/script', (req,res) => {
  res.setHeader('Cache-Control', 'no-store');
  const html = renderModulePage('script');
  res.type('text/html; charset=utf-8').send(html);
});
app.get('/apps/code', (req,res) => {
  res.setHeader('Cache-Control', 'no-store');
  const html = renderModulePage('code');
  res.type('text/html; charset=utf-8').send(html);
});
app.get('/apps/code2', (req,res) => {
  res.setHeader('Cache-Control', 'no-store');
  const html = renderModulePage('code2');
  res.type('text/html; charset=utf-8').send(html);
});
app.get('/apps/repo', (req,res) => {
  res.setHeader('Cache-Control', 'no-store');
  const html = renderModulePage('repo');
  res.type('text/html; charset=utf-8').send(html);
});
app.get('/apps/sec', (req,res) => {
  res.setHeader('Cache-Control', 'no-store');
  const html = renderModulePage('sec');
  res.type('text/html; charset=utf-8').send(html);
});
app.get('/apps/ops', (req,res) => {
  res.setHeader('Cache-Control', 'no-store');
  const html = renderModulePage('ops');
  res.type('text/html; charset=utf-8').send(html);
});
app.get('/apps/pub', (req,res) => {
  res.setHeader('Cache-Control', 'no-store');
  const html = renderModulePage('pub');
  res.type('text/html; charset=utf-8').send(html);
});
app.get('/apps/build', (req,res) => {
  res.setHeader('Cache-Control', 'no-store');
  const html = renderModulePage('build');
  res.type('text/html; charset=utf-8').send(html);
});
app.get('/apps/queue', (req,res) => {
  res.setHeader('Cache-Control', 'no-store');
  const html = renderModulePage('queue');
  res.type('text/html; charset=utf-8').send(html);
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
const QUEUE_STATE_FILE = path.join(DATA_DIR, 'queue.json');

function readQueueState(){
  const fallback = {
    selectedColumnId: 'rebuild',
    autorunEnabled: false,
    currentCardId: null,
    pendingRunAt: null,
    updatedAt: null,
  };
  return readJson(QUEUE_STATE_FILE, fallback);
}
function writeQueueState(s){
  const out = (s && typeof s === 'object') ? s : readQueueState();
  out.updatedAt = new Date().toISOString();
  writeJson(QUEUE_STATE_FILE, out);
  return out;
}

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

// Patch a single PM card (shared status between PM + Queue)
app.post('/api/pm/cardPatch', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const cardId = String(req.body?.cardId || '').trim();
  const patch = (req.body && typeof req.body.patch === 'object' && req.body.patch) ? req.body.patch : null;
  if (!cardId) return res.status(400).json({ ok:false, error:'Missing cardId' });
  if (!patch) return res.status(400).json({ ok:false, error:'Missing patch' });

  const pm = readPM();
  pm.columns = Array.isArray(pm.columns) ? pm.columns : [];
  let found = null;
  for (const col of pm.columns){
    col.cards = Array.isArray(col.cards) ? col.cards : [];
    const c = col.cards.find(x => x && String(x.id||'') === cardId);
    if (c) { found = c; break; }
  }
  if (!found) return res.status(404).json({ ok:false, error:'Card not found' });

  // Apply a small allowlist of patch keys
  const allowed = ['queuedAt','completedAt','queueStatus'];
  for (const k of allowed){
    if (Object.prototype.hasOwnProperty.call(patch, k)) found[k] = patch[k];
  }
  if (!found.queueStatus) {
    if (found.completedAt) found.queueStatus = 'done';
    else if (found.queuedAt) found.queueStatus = 'queued';
  }

  const saved = writePM(pm);
  logWork('pm.cardPatch', { cardId, queueStatus: found.queueStatus || null });
  res.json({ ok:true, card: found, pm: saved });
});

// Queue state: stores which PM column Queue is syncing
app.get('/api/queue/state', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok:true, state: readQueueState() });
});
app.post('/api/queue/state', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const state = req.body && req.body.state;
  const cur = readQueueState();
  const next = { ...cur };
  if (state && typeof state.selectedColumnId === 'string') next.selectedColumnId = state.selectedColumnId;
  if (state && typeof state.autorunEnabled === 'boolean') next.autorunEnabled = state.autorunEnabled;
  const saved = writeQueueState(next);
  logWork('queue.stateSaved', saved);
  res.json({ ok:true, state: saved });
});

let queueAutorunTimer = null;
function clearQueueAutorunTimer(){
  if (queueAutorunTimer) {
    try { clearTimeout(queueAutorunTimer); } catch {}
    queueAutorunTimer = null;
  }
}

function findQueueColumn(pm, state){
  const cols = (pm && Array.isArray(pm.columns)) ? pm.columns : [];
  const selId = state && state.selectedColumnId ? String(state.selectedColumnId) : 'rebuild';
  return cols.find(c => c && String(c.id||'') === selId) || cols.find(c => c && (String(c.id||'') === 'rebuild' || String(c.title||'').toLowerCase() === 'rebuild')) || null;
}

function findNextQueuedCard(col){
  const cards = (col && Array.isArray(col.cards)) ? col.cards : [];
  return cards.find(c => c && (c.queueStatus === 'queued' || c.queuedAt) && !c.completedAt) || null;
}

function patchCardById(pm, cardId, patch){
  pm.columns = Array.isArray(pm.columns) ? pm.columns : [];
  for (const col of pm.columns){
    col.cards = Array.isArray(col.cards) ? col.cards : [];
    const c = col.cards.find(x => x && String(x.id||'') === String(cardId));
    if (!c) continue;
    for (const k of Object.keys(patch||{})) c[k] = patch[k];
    return c;
  }
  return null;
}

function queueKickoffMessage(card){
  const title = String(card?.title || '').trim();
  const desc = String(card?.desc || card?.body || '').trim();
  const content = String(card?.content || '').trim();
  const id = String(card?.id || '').trim();

  return [
    'ITERATIVE MODE (AUTHORIZED)',
    'QUEUE AUTORUN: start next queued rebuild card.',
    'Card ID: ' + id,
    'Card title: ' + title,
    desc ? ('Card desc: ' + desc) : null,
    content ? ('Card content:\n' + content) : null,
    '',
    'Success criteria:',
    '- Implement the card goal (small commits; restart services if needed).',
    '- Report what changed + build number.',
    '- End your final message with: QUEUE COMPLETE: ' + id,
  ].filter(Boolean).join('\n');
}

function scheduleQueueAutorun(ms){
  const state = readQueueState();
  if (!state.autorunEnabled) return { ok:false, error:'autorun_disabled' };

  clearQueueAutorunTimer();
  const when = new Date(Date.now() + Math.max(0, Number(ms||0))).toISOString();
  state.pendingRunAt = when;
  writeQueueState(state);

  queueAutorunTimer = setTimeout(() => {
    try {
      const state2 = readQueueState();
      if (!state2.autorunEnabled) return;
      const pm = readPM();
      const col = findQueueColumn(pm, state2);
      const next = findNextQueuedCard(col);
      if (!next) {
        state2.pendingRunAt = null;
        state2.currentCardId = null;
        writeQueueState(state2);
        return;
      }

      // mark as current
      state2.pendingRunAt = null;
      state2.currentCardId = String(next.id||null);
      writeQueueState(state2);

      // send message into Console as if user requested next task
      acceptMessage({ text: queueKickoffMessage(next), attachments: [] });
      logWork('queue.autorun.kickoff', { cardId: String(next.id||''), title: String(next.title||''), colId: String(col?.id||'') });
    } catch (e) {
      logWork('queue.autorun.error', { error: String(e) });
    }
  }, Math.max(0, Number(ms||0)));

  return { ok:true, pendingRunAt: when };
}

app.post('/api/queue/autorun/scheduleNext', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const delayMs = Math.max(0, Number(req.body?.delayMs || 15000));
  const out = scheduleQueueAutorun(delayMs);
  if (!out.ok) return res.status(409).json(out);
  res.json(out);
});

app.post('/api/queue/autorun/stop', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  clearQueueAutorunTimer();
  const st = readQueueState();
  st.pendingRunAt = null;
  writeQueueState(st);
  logWork('queue.autorun.stopped', {});
  res.json({ ok:true });
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
  <meta name="clawd-build" content="${BUILD}" />
  <title>ClawdPM</title>
  <link rel="stylesheet" href="/static/apps-menu.css" />
  <style>
    :root { --bg:#0b0f1a; --card:#11182a; --text:#e7e7e7; --muted: rgba(231,231,231,.70); --border: rgba(231,231,231,.12); --teal:#22c6c6; }
    html,body{height:100%}
    body{margin:0; font-family: system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background: var(--bg); color: var(--text)}

    /* Full-width board with horizontal scroll pinned to bottom of viewport */
    .wrap{width:100%; max-width:none; margin:0 auto; padding:16px; box-sizing:border-box; min-height:100vh; display:flex; flex-direction:column;}
    .top{display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; align-items:baseline}
    .top h1{margin:0; font-size:18px}
    .muted{color:var(--muted)}
    .pill{ display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:8px 10px; border-radius:999px; border:1px solid rgba(34,198,198,.40); background: linear-gradient(180deg, rgba(34,198,198,.18), rgba(34,198,198,.08)); color: rgba(231,231,231,.92); text-decoration:none; white-space:nowrap; font-weight:750; font-size:12px; }
    .pill:hover{ border-color: rgba(34,198,198,.70); background: linear-gradient(180deg, rgba(34,198,198,.26), rgba(34,198,198,.10)); }

    ${APPS_MENU_CSS}

    .boardWrap{flex:1; min-height:0; overflow-x:auto; overflow-y:auto; margin-top:12px; padding-bottom:10px;}
    .board{display:flex; gap:12px; align-items:flex-start; width:max-content; min-width:100%;}
    .col{flex:0 0 320px; border:1px solid var(--border); border-radius:14px; background: rgba(255,255,255,.03); overflow:hidden}
    @media (max-width: 780px){ .col{flex-basis: 280px;} }
    .colHead{padding:12px 12px; border-bottom:1px solid rgba(255,255,255,.08); display:flex; justify-content:space-between; align-items:center}
    .colHead b{font-size:14px}
    .colActions{display:flex; gap:2px; align-items:center}
    /* Column header buttons (borderless + tight) */
    .mini2{border:none; background: rgba(255,255,255,.05); color: rgba(231,231,231,.86); border-radius: 10px; padding:3px 5px; cursor:pointer; font-size:11px; line-height:1}
    .mini2:hover{background: rgba(255,255,255,.09)}
    .miniDanger{ background: rgba(255,97,97,.10); }
    .miniDanger:hover{ background: rgba(255,97,97,.14); }
    .addBtn{border:none; background: rgba(255,255,255,.05); color: rgba(231,231,231,.85); border-radius: 999px; padding:3px 7px; cursor:pointer; font-size:11px; line-height:1}
    .addBtn:hover{background: rgba(255,255,255,.09)}

    .cardRow{display:flex; justify-content:space-between; gap:8px; align-items:flex-start}
    .cardBtns{display:flex; gap:2px; align-items:center; opacity:.85}
    .cardBtns button{border:none; background: rgba(255,255,255,.05); color: rgba(231,231,231,.86); border-radius: 10px; padding:3px 5px; cursor:pointer; font-size:11px; line-height:1}
    .cardBtns button:hover{background: rgba(255,255,255,.09)}

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
    .box{width:min(920px, 96vw); max-height: calc(100vh - 36px); border:1px solid rgba(255,255,255,.14); border-radius:16px; background:rgba(11,15,26,.96); box-shadow: 0 25px 70px rgba(0,0,0,.55); overflow:hidden; display:flex; flex-direction:column;}
    .head{flex:0 0 auto; display:flex; justify-content:space-between; gap:10px; align-items:flex-start; padding:14px 14px; border-bottom:1px solid rgba(255,255,255,.10)}
    .head b{font-size:16px}
    .close{background:transparent; border:1px solid rgba(255,255,255,.18); color:var(--text); border-radius:12px; padding:8px 10px; cursor:pointer}
    .body{flex:1; min-height:0; padding:14px; overflow:auto;}
    .grid{display:grid; grid-template-columns: 1fr 1fr; gap:12px}
    .field label{display:block; font-size:12px; color: var(--muted); margin-bottom:6px}
    .field input,.field textarea,.field select{width:100%; padding:10px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.14); background:#0d1426; color:var(--text); font-size:14px; font-family: inherit}
    .field textarea{min-height:110px; max-height:260px}
    .rowbtn{display:flex; gap:10px; flex-wrap:wrap; align-items:center}

    /* dark scrollbars inside the modal */
    .box *, #cm_todos { scrollbar-width: thin; scrollbar-color: rgba(231,231,231,.22) rgba(0,0,0,0.25); }
    .box *::-webkit-scrollbar, #cm_todos::-webkit-scrollbar{ width:10px; height:10px; }
    .box *::-webkit-scrollbar-thumb, #cm_todos::-webkit-scrollbar-thumb{ background: rgba(231,231,231,.16); border-radius: 10px; border: 2px solid rgba(0,0,0,0.35); }
    .box *::-webkit-scrollbar-track, #cm_todos::-webkit-scrollbar-track{ background: rgba(0,0,0,0.18); border-radius: 10px; }
    .pillbtn{border:1px solid rgba(34,198,198,.40); background: rgba(34,198,198,.10); color: rgba(231,231,231,.92); border-radius: 999px; padding:8px 10px; cursor:pointer; font-size:12px}
    .pillbtn:hover{border-color: rgba(34,198,198,.65)}
    .pillDanger{ border-color: rgba(255,97,97,.45); background: rgba(255,97,97,.10); }
    .pillDanger:hover{ border-color: rgba(255,97,97,.70); background: rgba(255,97,97,.14); }

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
    <div class="top" style="display:grid; grid-template-columns: auto auto 1fr; gap:12px; align-items:baseline;">
      <div>
        <h1>ClawdPM</h1>
        <div class="muted small">Cards are task-groups. Click a card to generate + manage to-dos.</div>
        <div class="muted small" id="pm_js_status" style="margin-top:6px;">JS: (loading…)</div>
      </div>
      <div style="align-self:start;">
        <button class="btn" id="pmRefresh" type="button">Refresh</button>
      </div>
      <div id="pmMenuWrap" style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; justify-content:flex-end; justify-self:end; width:100%;">
        ${appsMenuHtml('/pm')}
      </div>
    </div>

    <div class="boardWrap" id="pmBoardWrap">
      <div class="board" id="pmBoard">${(() => {
        try {
          const pm = readPM();
          const cols = Array.isArray(pm.columns) ? pm.columns : [];
          const esc = (s) => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
          const priClass = (p) => {
            const v = String(p||'planning').toLowerCase();
            if (v === 'ultra') return 'pri-ultra';
            if (v === 'high') return 'pri-high';
            if (v === 'normal') return 'pri-normal';
            return 'pri-planning';
          };
          const colHtml = cols.map(col => {
            const cards = Array.isArray(col.cards) ? col.cards : [];
            const cardsHtml = cards.map(c => {
              const desc = (c && (c.desc || c.body) ? (c.desc || c.body) : '');
              const short = String(desc).length > 110 ? (String(desc).slice(0,110) + '…') : String(desc);
              const q = (c.queueStatus || (c.completedAt ? 'done' : (c.queuedAt ? 'queued' : '')));
              const qBadge = q ? ('<span class="badge" style="margin-left:6px;">' + esc(q === 'done' ? '✓ done' : (q === 'queued' ? '⏳ queued' : q)) + '</span>') : '';
              const badge = '<span class="badge">' + esc(String(c.priority || 'planning')) + '</span>' + qBadge;
              return '<div class="card ' + priClass(c.priority) + '" data-card-id="' + esc(c.id) + '" data-col-id="' + esc(col.id) + '">' +
                '<div class="cardRow">' +
                  '<b>' + esc(c.title) + '</b>' +
                '</div>' +
                (short ? ('<p>' + esc(short) + '</p>') : '') +
                badge +
              '</div>';
            }).join('');
            return '<div class="col">' +
              '<div class="colHead">' +
                '<b>' + esc(col.title) + '</b>' +
                '<div class="colActions"><span class="muted small">' + cards.length + '</span></div>' +
              '</div>' +
              '<div class="cards">' + cardsHtml + '</div>' +
            '</div>';
          }).join('');
          return colHtml || '<div class="muted">No columns.</div>';
        } catch {
          return '<div class="muted">Failed to render board.</div>';
        }
      })()}</div>
    </div>
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
            <label>Description (short)</label>
            <textarea id="cm_in_desc"></textarea>
          </div>
          <div class="field" style="grid-column: 1 / span 2;">
            <label>Content (details)</label>
            <textarea id="cm_in_content"></textarea>
          </div>
          <div class="field" style="grid-column: 1 / span 2;">
            <label>Move To</label>
            <select id="cm_move_to"></select>
          </div>
        </div>

        <div class="rowbtn" style="margin-top:12px; justify-content:space-between;">
          <div class="rowbtn">
            <button class="pillbtn" id="cm_generate" type="button">Generate To-Dos</button>
            <button class="pillbtn" id="cm_addtodo" type="button">+ To-Do</button>
            <button class="pillbtn" id="cm_moveup" type="button">Move ↑</button>
            <button class="pillbtn" id="cm_movedn" type="button">Move ↓</button>
          </div>
          <div class="rowbtn" style="gap:10px;">
            <button class="pillbtn pillDanger" id="cm_trash" type="button" title="Delete card">🗑 Delete</button>
            <button class="pillbtn" id="cm_done" type="button">Mark Done (Archive)</button>
            <button class="pillbtn" id="cm_save" type="button">Save</button>
          </div>
        </div>

        <div style="margin-top:12px;" class="muted small">To-Dos</div>
        <div id="cm_todos" style="max-height: min(260px, calc(100vh - 420px)); overflow:auto; padding-right:6px;"></div>
        <div class="muted small" id="cm_msg" style="margin-top:10px;"></div>

        <div style="margin-top:14px;">
          <div class="muted small">Queued Completion Reply</div>
          <div id="cm_qreply" style="margin-top:8px; white-space:pre-wrap; background: rgba(0,0,0,0.12); border:1px solid rgba(255,255,255,0.10); border-radius:12px; padding:10px; max-height:240px; overflow:auto;"></div>
          <div class="rowbtn" style="margin-top:10px; justify-content:flex-end;">
            <button class="pillbtn" id="cm_send_console" type="button">Send to Console</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script id="pm_boot" type="application/json">${(() => {
    try {
      const pm = readPM();
      return JSON.stringify(pm).replace(/</g, '\\u003c');
    } catch {
      return '{"columns":[]}';
    }
  })()}</script>
  <script src="/static/pm.js"></script>
  <script src="/static/apps-menu.js"></script>

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
      <div class="muted" style="margin-top:4px;">Not exhaustive - these are the Clawdbot-native surfaces I could confirm quickly.</div>
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
          Clawdbot has solid general-purpose UIs (Control UI/WebChat), but nothing that's obviously optimized for operator workflows like: persistent transcript indexing + action buttons, DEL checklists, scheduled reporting, and filterable worklogs. Clawd Console looks positioned as a <b>power-user cockpit</b> that complements the Control UI rather than replacing it.
        </div>
      </div>

      <div style="margin-top:16px;">
        <div style="font-weight:800;">What we need to ship v1 ("alladat")</div>
        <div class="muted" style="margin-top:6px;">A practical checklist to make this installable, testable, and friendly for other Clawdbot users.</div>

        <div style="margin-top:10px; display:flex; flex-direction:column; gap: 10px;">
          <div>
            <div style="font-weight:700;">1) Package boundaries</div>
            <div class="muted" style="margin-top:4px;">Decide what is the product: a standalone "Clawd Console" service, a Clawdbot plugin, or a skill + static UI bundle. Right now it's a standalone Express service that talks to the Gateway WS.</div>
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
            <div class="muted" style="margin-top:4px;">When we call it v1: spin up a second fresh Clawdbot instance (VM/Docker/new user) and install Clawd Console using only the README. No manual tweaks. If it works, it's real.</div>
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

// --- Token-only Bridge (cross-box notes) ---
const BRIDGE_TOKEN = String(process.env.BRIDGE_TOKEN || '').trim();
const BRIDGE_INBOX_FILE = path.join(DATA_DIR, 'bridge-inbox.md');
const BRIDGE_OUTBOX_FILE = path.join(DATA_DIR, 'bridge-outbox.md');
const BRIDGE_LOG_FILE = path.join(DATA_DIR, 'bridge-messages.jsonl');

function bridgeAuthOk(req){
  if (!BRIDGE_TOKEN) return false;
  const tok = String(req.headers['x-clawd-bridge-token'] || '').trim();
  return tok && tok === BRIDGE_TOKEN;
}

function readTextFileSafe(p){
  try { return fs.existsSync(p) ? String(fs.readFileSync(p, 'utf8')) : ''; } catch { return ''; }
}

function writeTextFileSafe(p, s){
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  try { fs.writeFileSync(p, String(s || ''), 'utf8'); return true; } catch { return false; }
}

function appendBridgeLog(dir, summary, text){
  const entry = {
    id: 'br_' + crypto.randomBytes(6).toString('hex') + Date.now().toString(16),
    ts: new Date().toISOString(),
    dir: String(dir || ''),
    summary: summary ? String(summary) : null,
    text: String(text || ''),
  };
  try { appendJsonl(BRIDGE_LOG_FILE, entry); } catch {}
  try { broadcast({ type: 'bridge', entry }); } catch {}
  try { logWork('bridge.' + String(dir || 'post'), { summary: entry.summary, bytes: entry.text.length }); } catch {}
  return entry;
}

app.get('/api/ops/bridge/inbox', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!bridgeAuthOk(req)) return res.status(401).type('text/plain').send('Auth required');
  res.json({ ok:true, text: readTextFileSafe(BRIDGE_INBOX_FILE) });
});

app.post('/api/ops/bridge/inbox', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!bridgeAuthOk(req)) return res.status(401).type('text/plain').send('Auth required');
  const summary = (req.body && typeof req.body.summary === 'string') ? req.body.summary : '';
  const text = (req.body && typeof req.body.text === 'string') ? req.body.text : '';
  const ok = writeTextFileSafe(BRIDGE_INBOX_FILE, text);
  appendBridgeLog('in', summary, text);
  res.json({ ok: !!ok });
});

app.get('/api/ops/bridge/outbox', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!bridgeAuthOk(req)) return res.status(401).type('text/plain').send('Auth required');
  res.json({ ok:true, text: readTextFileSafe(BRIDGE_OUTBOX_FILE) });
});

app.post('/api/ops/bridge/outbox', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!bridgeAuthOk(req)) return res.status(401).type('text/plain').send('Auth required');
  const summary = (req.body && typeof req.body.summary === 'string') ? req.body.summary : '';
  const text = (req.body && typeof req.body.text === 'string') ? req.body.text : '';
  const ok = writeTextFileSafe(BRIDGE_OUTBOX_FILE, text);
  appendBridgeLog('out', summary, text);
  res.json({ ok: !!ok });
});

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

function handleQueueCompletionText(text, ts){
  try {
    const m = String(text||'').match(/\bQUEUE\s+COMPLETE\s*:\s*([a-zA-Z0-9_\-\.]+)\b/);
    if (!m) return false;
    const cardId = String(m[1] || '').trim();
    if (!cardId) return false;

    const pm = readPM();
    const patched = patchCardById(pm, cardId, {
      completedAt: ts,
      queueStatus: 'done',
      queuedCompletionReply: String(text||'').trim().slice(0, 20000),
      queuedCompletionAt: ts,
    });
    if (patched) writePM(pm);

    const st = readQueueState();
    if (String(st.currentCardId||'') === cardId) {
      st.currentCardId = null;
      st.pendingRunAt = null;
      writeQueueState(st);
    }

    logWork('queue.cardCompleted', { cardId, saved: !!patched });

    // If autorun is enabled, schedule the next queued card kickoff.
    if (st.autorunEnabled) {
      scheduleQueueAutorun(15000);
      logWork('queue.autorun.scheduled', { afterMs: 15000 });
    }

    return true;
  } catch (e) {
    logWork('queue.complete.parse.error', { error: String(e) });
    return false;
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

  // Queue completion harvesting (writes completion reply into the PM card)
  handleQueueCompletionText(msg.text, msg.ts);

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
  if (!gw.ws || gw.ws.readyState !== WebSocket.OPEN) {
    const eobj = { message: 'gateway ws not connected' };
    gwLastError = { ts: new Date().toISOString(), message: eobj.message, raw: eobj };
    const err = new Error(eobj.message);
    err.raw = eobj;
    throw err;
  }
  const id = crypto.randomUUID();
  gw.ws.send(JSON.stringify({ type: 'req', id, method, params }));
  return new Promise((resolve, reject) => {
    gw.pending.set(id, { resolve, reject, method, ts: Date.now() });
    setTimeout(() => {
      const p = gw.pending.get(id);
      if (!p) return;
      gw.pending.delete(id);
      const eobj = { message: 'gateway timeout: ' + method };
      gwLastError = { ts: new Date().toISOString(), message: eobj.message, raw: eobj };
      const err = new Error(eobj.message);
      err.raw = eobj;
      reject(err);
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
  logWork('gateway.connecting', { url, sessionKey: CONSOLE_SESSION_KEY });

  const ws = new WebSocket(url);
  gw.ws = ws;
  gw.connected = false;
  gw.connectNonce = null;

  ws.on('open', () => {
    // wait for connect.challenge event
  });

  ws.on('message', (data) => {
    const raw = data.toString('utf8');
    const msg = safeJsonParse(raw);
    if (!msg) {
      recordGatewayEvent('parse_error', { raw: raw.slice(0, 8000) });
      return;
    }
    recordGatewayEvent('recv', msg);

    if (msg.type === 'res' && typeof msg.id === 'string') {
      const p = gw.pending.get(msg.id);
      if (p) {
        gw.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.payload);
        else {
          const eobj = msg.error || { message: 'gateway error' };
          gwLastError = { ts: new Date().toISOString(), message: String(eobj.message || 'gateway error'), raw: eobj };
          recordGatewayEvent('res_error', { method: p.method, error: eobj });
          const err = new Error(String(eobj.message || 'gateway error'));
          err.raw = eobj;
          p.reject(err);
        }
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
    gwLastError = { ts: new Date().toISOString(), message: String(e) };
    logWork('gateway.ws.error', { error: String(e) });
  });
}

function acceptMessage({ text, attachments, noList }) {
  // Allow UI to mark messages as "no list extraction" (e.g. Quick Chat button payloads).
  // Also allow an inline marker to survive copy/paste:
  //   [[NO_CLAWDLIST]]
  let t = typeof text === 'string' ? text : '';
  let skipList = !!noList;
  if (/^\s*\[\[NO_CLAWDLIST\]\]\s*$/mi.test(t)) {
    skipList = true;
    t = t.replace(/^\s*\[\[NO_CLAWDLIST\]\]\s*\r?\n?/gmi, '');
  }

  const msg = makeMsg({ text: t, attachments });
  appendJsonl(MSG_FILE, msg);

  // Dynamic Execution List extraction: if user message contains a 3+ item list.
  const items = skipList ? null : extractChecklist(msg.text);
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
        const detail = (e && e.raw) ? e.raw : (e && e.message) ? e.message : String(e);
        consoleBotSay('Codex/Gateway error:\n' + (typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)));
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
  const { text, attachments, noList } = req.body || {};
  if (typeof text !== 'string' && !Array.isArray(attachments)) {
    return res.status(400).json({ ok: false, error: 'Expected {text, attachments}' });
  }
  const msg = acceptMessage({ text, attachments, noList: !!noList });
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

// Friendly upload browser (directory listing) for operator convenience.
// NOTE: still behind auth (because it is not in the bypass allowlist).
app.get('/uploads', (req, res) => res.redirect(302, '/uploads/'));
app.get('/uploads/', (req, res) => {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const files = fs.readdirSync(UPLOAD_DIR)
      .filter(n => !n.startsWith('.'))
      .sort((a,b) => b.localeCompare(a));
    const rows = files.slice(0, 500).map(f => {
      const href = '/uploads/' + encodeURIComponent(f);
      return '<li style="margin:6px 0;"><a href="' + href + '" target="_blank" rel="noopener">' + escHtml(f) + '</a></li>';
    }).join('');
    res.type('text/html; charset=utf-8').send(
      '<!doctype html><html><head><meta charset="utf-8" />' +
      '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
      '<title>Uploads</title>' +
      '<style>' +
      'body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;background:#0b1020;color:#e8eefc;margin:0}' +
      'a{color:#9ad0ff}' +
      '.wrap{max-width:980px;margin:0 auto;padding:18px}' +
      '.card{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.10);border-radius:14px;padding:14px}' +
      '.muted{color:rgba(255,255,255,0.65);font-size:12px}' +
      'code{background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:6px}' +
      '</style></head><body><div class="wrap"><div class="card">' +
      '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline;">' +
      '<div style="font-weight:900;font-size:18px;">Uploads</div>' +
      '<div class="muted">Dir: <code>' + escHtml(UPLOAD_DIR) + '</code></div>' +
      '</div>' +
      '<div class="muted" style="margin-top:8px;">Showing up to 500 newest filenames. Click to open in a new tab.</div>' +
      '<ul style="margin-top:12px;">' + (rows || '<li class="muted">No uploads yet.</li>') + '</ul>' +
      '</div></div></body></html>'
    );
  } catch {
    res.status(500).type('text/plain').send('Failed to list uploads');
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

// Shared Apps menu assets (served dynamically so changes propagate immediately).
app.get('/static/apps-menu.css', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const brand = readBrandingMenu();
  const css = String(APPS_MENU_BASE_CSS || '') + "\n\n" + String(brand.cssOverrides || '');
  res.type('text/css; charset=utf-8').send(css);
});

app.get('/static/apps-menu.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/javascript; charset=utf-8').send(String(APPS_MENU_BASE_JS || ''));
});

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
    html, body { height: 100%; overflow: hidden; }
    html{ color-scheme: dark; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 18px; line-height: 1.35; background: var(--bg); color: var(--text); }

    /* brand: dark scrollbars everywhere (including textarea/pre) */
    * { scrollbar-color: rgba(154,208,255,0.28) rgba(0,0,0,0.55); }
    *::-webkit-scrollbar { width: 12px; height: 12px; }
    *::-webkit-scrollbar-track { background: rgba(0,0,0,0.55); border-radius: 999px; }
    *::-webkit-scrollbar-thumb { background: rgba(154,208,255,0.26); border-radius: 999px; border: 2px solid rgba(0,0,0,0.55); }
    *::-webkit-scrollbar-thumb:hover { background: rgba(154,208,255,0.40); }
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
    .wrap { display: grid; grid-template-columns: 300px 1.25fr 0.75fr; gap: 14px; max-width: 1920px; height: calc(100vh - 36px); overflow: hidden; }
    .sidebar { position: sticky; top: 0; align-self: start; max-height: 100%; overflow: hidden; }
    .main { min-width: 0; max-height: 100%; overflow: hidden; display:flex; flex-direction:column; gap:14px; }
    .right { min-width: 0; display:flex; flex-direction:column; gap:14px; height: 100%; overflow: hidden; }

    /* Right column sizing: ClawdList flexes to fill remaining height under ClawdWork */
    #decard{ flex: 1 1 auto; min-height: 0; display:flex; flex-direction:column; overflow:hidden; }
    #deBody{ display:flex; flex-direction:column; min-height: 0; overflow:hidden; }
    #deLists{ flex: 1 1 auto; min-height: 0; overflow:auto; padding-right: 4px; max-height: none; }

    #workcard{ flex: 0 0 420px; min-height: 0; }
    #wlBody{ display:flex; flex-direction:column; min-height:0; }
    #worklog{ flex: 1 1 auto; min-height: 0; overflow:auto; max-height: none; }

    body.workCollapsed #workcard{ flex-basis: auto; }
    body.workCollapsed #decard{ flex: 1 1 auto; }

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

    /* Sidebar widgets */
    /* Keep Readme + Rules compact (scroll inside) so sidebar bottom aligns with main column */
    #readmeBody{ max-height: 220px; overflow:auto; padding-right: 6px; }
    #rulesBody{ max-height: 260px; overflow:auto; padding-right: 6px; }
    #snapBody{ max-height: 280px; overflow:auto; padding-right: 6px; }
    .muted { color: var(--muted); font-size: 13px; }
    .row { display:flex; gap: 10px; align-items:center; flex-wrap: wrap; }

    /* inputs: never overlap / always shrink inside flex+grid */
    .inp{ box-sizing:border-box; min-width:0; max-width:100%; padding:10px 12px; border-radius: 12px; border:1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.18); color: rgba(231,231,231,0.92); font-size: 13px; line-height: 1.2; }

    /* two-column grids must collapse to one column on narrow screens to prevent overlap */
    .twoCol{ display:grid; grid-template-columns: 1fr 1fr; gap:12px; }
    @media (max-width: 900px){ .twoCol{ grid-template-columns: 1fr; } }
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
    .cc_form select{width:100%; padding:10px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.14); background:#0d1426; color:var(--text)}
    .cc_form textarea{width:100%; padding:10px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.14); background:#0d1426; color:var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; line-height: 1.35}
    .cc_row{display:flex; gap:10px; flex-wrap:wrap; align-items:center}
    .pm_grid{display:grid; grid-template-columns: 1fr 220px 160px; gap:10px; align-items:end}
    @media (max-width: 840px){ .pm_grid{grid-template-columns: 1fr; } }
    .cc_msg{font-size:12px; color:rgba(231,231,231,0.72)}

    .wlbtn { padding: 4px 8px; border-radius: 999px; background: rgba(255,255,255,0.04); font-size: 12px; }
    .wlbtn:hover { background: rgba(255,255,255,0.08); }
    .wlbtn.in { border-color: rgba(154,208,255,0.55); background: rgba(154,208,255,0.10); }
    .wlbtn.out { border-color: rgba(255,160,80,0.55); background: rgba(255,160,80,0.10); }

    #plan { height: 36px; white-space: nowrap; background: #1f4b8f; border-color: rgba(154,208,255,0.30); }
    #plan:hover { background: #2456a3; }

    /* Send = primary action (green) */
    #send { height: 36px; white-space: nowrap; background: #19783d; border-color: rgba(255,255,255,0.18); }
    #send:hover { background: #1e8a46; }

    /* Iterate = teal */
    #iterate { height: 36px; white-space: nowrap; background: #118a8a; border-color: rgba(255,255,255,0.18); }
    #iterate:hover { background: #13a0a0; }

    /* Thinking + DEL status colors */
    .pill.is-thinking { background: #c26a1a; color: #fff; border-color: rgba(255,255,255,0.22); }
    .pill.de-active { background: #118a8a; color: #fff; border-color: rgba(255,255,255,0.22); }
    input[type=file] { display:block; margin: 10px 0; }

    /* main column sizing */
    #scheduled{ flex: 0 0 auto; }
    .main > .card:not(#scheduled){ flex: 1 1 auto; min-height: 0; display:flex; flex-direction:column; }

    /* chat */
    #chatlog { background: var(--card2); color: var(--text); border: 1px solid var(--border); border-radius: 12px; padding: 12px; overflow:auto; flex: 1 1 auto; min-height: 0; }
    .msg { padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.08); }
    .meta { font-size: 12px; color: rgba(255,255,255,0.65); display:flex; justify-content: space-between; gap: 12px; align-items: baseline; }
    .msgref{font-size:11px; color: rgba(231,231,231,0.38); cursor:pointer; user-select:none}
    .msgref:hover{color: rgba(231,231,231,0.60); text-decoration: underline}
    .msgpm{font-size:11px; color: rgba(231,231,231,0.38); cursor:pointer; user-select:none}
    .msgpm:hover{color: rgba(231,231,231,0.60); text-decoration: underline}
    .msgpm{font-size:11px; color: rgba(231,231,231,0.38); cursor:pointer; user-select:none}
    .msgpm:hover{color: rgba(231,231,231,0.60); text-decoration: underline}
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

    /* Composer: grid so left (textarea+quick buttons) and right (actions) never overlap */
    /* Fix action column width so the left side can never overlap it */
    #composer { display:grid; grid-template-columns: minmax(0,1fr) 96px; gap: 10px; align-items:start; }
    .composerLeft{ min-width:0; display:flex; flex-direction:column; gap:10px; overflow:hidden; }
    .composerActions{ width:96px; display:flex; flex-direction:column; gap:8px; align-items:stretch; justify-content:flex-start; }

    #quickbar{ display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-start; align-items:center; margin:0; overflow:hidden; }
    #quickButtons{ margin:0; padding:0; gap:10px; max-width:100%; }
    #debug{ margin-top: 4px !important; }

    /* Composer textarea: shorter by default (closer to pre-mic) */
    /* Narrow the textarea so it doesn't visually collide with the action stack */
    #msg { width: calc(100% - 40px); height: 120px; min-height: 120px; max-height: 240px; overflow:auto; padding: 10px; border-radius: 12px; border: 1px solid var(--border); font-size: 14px; background: #0d1426; color: var(--text); }

    /* Action buttons: tighter + uniform */
    #mic,#plan,#send,#iterate{ height: 36px; padding: 6px 10px; font-size: 13px; white-space: nowrap; min-width: 74px; }
    #mic{ font-size: 15px; display:flex; align-items:center; justify-content:center; }
    #micStatus{ font-size:12px; min-height: 16px; }
    /* #pasteHint removed (replaced by ClawdSnap) */
    .preview { display:flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
    .thumb { border: 1px solid var(--border); border-radius: 10px; padding: 6px; background: #0d1426; }
    .thumb img { max-height: 96px; display:block; border-radius: 8px; }
    code { background: rgba(255,255,255,0.08); padding:2px 6px; border-radius:6px; }

    .statusline { display:flex; gap: 10px; flex-wrap: wrap; align-items: center; justify-content: space-between; }
    .pill { border: 1px solid var(--border); background: #0d1426; border-radius: 999px; padding: 6px 10px; font-size: 12px; color: var(--muted); }

    /* Rules accordion (tight + no bold titles) */
    .ruleItem { border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; background: rgba(255,255,255,0.03); overflow:hidden; }
    .ruleHead { width:100%; display:flex; justify-content: space-between; gap: 10px; align-items:center; padding: 8px 10px; cursor:pointer; user-select:none; }
    .ruleHead:hover { background: rgba(255,255,255,0.04); }
    .ruleTitle { font-weight: 500; font-size: 13px; color: rgba(231,231,231,0.92); }
    .ruleChevron { color: rgba(231,231,231,0.6); font-size: 12px; }
    .ruleBody { display:none; padding: 0 10px 10px 10px; color: rgba(231,231,231,0.82); font-size: 13px; line-height: 1.5; }
    .ruleBody.open { display:block; }

    /* Prevent forced scroll-to-bottom: user controls reading position */
    #chatlog { overflow: auto; scroll-behavior: auto; overflow-anchor: none; }
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
          <div class="row" style="gap:8px; justify-content:flex-end;"><a class="scriptBtn" href="/transcript" target="_blank" rel="noopener">ClawdScript - View Entire Chat</a></div>
        </div>
      </div>

      <div class="card" style="margin-top: 14px;" id="appsCard">
        <div class="statusline" style="justify-content: space-between; align-items:center;">
          <div class="row" style="gap:10px; align-items:center;">
            <h2 style="margin:0">ClawdApps</h2>
          </div>
          <div class="row" style="gap:8px; align-items:center;">
            <a class="scriptBtn" href="/apps" target="_blank" rel="noopener" style="text-decoration:none;">Open →</a>
            <button id="appsToggle" type="button" class="wlbtn" title="Collapse">▾</button>
          </div>
        </div>

        <div id="appsBody">

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
          <div class="row" style="justify-content:space-between; align-items:center; flex-wrap:wrap;">
            <div class="muted">ClawdRepo</div>
            <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap;">
              <button class="pill" id="repoTabCommits" type="button" style="cursor:pointer;">Commits</button>
              <button class="pill" id="repoTabInstall" type="button" style="cursor:pointer;">Install</button>
              <span style="width:12px;"></span>
              <a class="pill" id="repoOpen" href="https://github.com/nwesource01/clawdconsole" target="_blank" rel="noopener" style="cursor:pointer; text-decoration:none;">GitHub</a>
              <button class="pill" id="repoRefresh" type="button" style="cursor:pointer;">Refresh</button>
            </div>
          </div>
          <div class="muted">Local repo: <code>${__dirname}</code></div>

          <div id="repoViewCommits">
            <div class="muted" style="margin-top:2px;">Recent commits (this project).</div>
            <div id="repoList" style="margin-top:6px; background: rgba(0,0,0,0.12); border: 1px solid rgba(255,255,255,0.10); border-radius: 12px; padding: 10px; max-height: 360px; overflow:auto;"></div>
          </div>

          <div id="repoViewInstall" style="display:none;">
            <div class="muted" style="margin-top:2px;">Install bundle + quickstart docs.</div>
            <div class="row" style="justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-top:8px;">
              <div>
                <div><b>Bundle (tar)</b></div>
                <div class="muted small">Link to the distributable install bundle.</div>
              </div>
              <a id="repoTarLink" class="pill" href="#" target="_blank" rel="noopener" style="text-decoration:none; display:none;">Download tar →</a>
            </div>
            <div id="repoTarHint" class="muted small" style="margin-top:6px;">(No tar link configured yet.)</div>

            <div style="margin-top:12px; font-weight:900;">User guide</div>
            <div id="repoInstallGuide" style="margin-top:6px; white-space:pre-wrap; background: rgba(0,0,0,0.12); border: 1px solid rgba(255,255,255,0.10); border-radius: 12px; padding: 10px; max-height: 420px; overflow:auto;"></div>
          </div>
        </div>

        <div id="panelSec" style="display:none; flex-direction:column; gap: 10px;">
          <div class="muted">ClawdSec (security) - WIP</div>
          <div style="line-height:1.5;">
            <div><b>Rule:</b> don't paste real secrets into chat or a web UI.</div>
            <div class="muted" style="margin-top:6px;">Instead, store secrets in server env files (e.g. <code>/etc/clawdio-console.env</code>) and rotate them when needed.</div>
            <div class="muted" style="margin-top:10px;">Password reset (Console auth):</div>
            <div class="md_code" style="margin-top:8px;"><pre><code>sudo nano /etc/clawdio-console.env
sudo systemctl restart clawdio-console.service</code></pre></div>
          </div>
        </div>

        <div id="panelOps" style="display:none; flex-direction:column; gap: 10px;">
          <div class="muted">ClawdOps (operations) - WIP</div>
          <div style="line-height:1.5;">
            <div>Uptime, backups, deploy checklist, and health checks.</div>
            <div class="muted" style="margin-top:8px;">Suggested keep-alive ping: set an UptimeRobot check to hit <code>/healthz</code> every minute.</div>
          </div>
        </div>

        <div id="panelBuild" style="display:none; flex-direction:column; gap: 10px;">
          <div class="muted">ClawdBuild (coming)</div>
          <div style="line-height:1.45;">
            <div><b>Idea:</b> layered, iterative app delivery with visibility: spec → tasks → code → tests → commits → release.</div>
            <div class="muted" style="margin-top:6px;">We'll wire this into the Console as an operator-guided build pipeline.</div>
          </div>
        </div>
        </div> <!-- /appsBody -->
      </div>

      <div class="card" style="margin-top: 14px;" id="rulesCard">
        <div class="statusline" style="justify-content: space-between; align-items:center;">
          <div class="row" style="gap:10px; align-items:center;">
            <h2 style="margin:0">ClawdRules!</h2>
          </div>
          <div class="row" style="gap:8px; align-items:center;">
            <button id="rulesToggle" type="button" class="wlbtn" title="Collapse">▾</button>
          </div>
        </div>

        <div id="rulesBody" style="margin-top:10px;">
          <div class="muted" style="margin-bottom: 10px;">Operator heaven: small rules that prevent repeat questions. (Pulled from <code>ClawdRules.md</code>)</div>
          <div id="rulesList" style="display:flex; flex-direction:column; gap:8px;">
            <div class="muted">Loading rules…</div>
          </div>
          <div class="muted" style="margin-top:8px;">Add rules by saying: <code>rule - ...</code></div>
        </div> <!-- /rulesBody -->
      </div>

      <div class="card" style="margin-top: 14px;" id="toolsCard">
        <div class="statusline" style="justify-content: space-between; align-items:center;">
          <div class="row" style="gap:10px; align-items:center;">
            <h2 style="margin:0">ClawdTools</h2>
          </div>
          <div class="row" style="gap:8px; align-items:center;">
            <button id="toolsToggle" type="button" class="wlbtn" title="Collapse">▾</button>
          </div>
        </div>

        <div id="toolsBody" style="margin-top:10px;">
          <div class="muted" style="margin-bottom: 10px; font-weight:700;">Manual Upload</div>
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

      <div class="card" style="margin-top:14px;" id="readmeCard">
        <div class="statusline" style="justify-content: space-between; align-items:center;">
          <div class="row" style="gap:10px; align-items:center;">
            <h2 style="margin:0">ClawdReadMe</h2>
          </div>
          <div class="row" style="gap:8px; align-items:center;">
            <button id="readmeToggle" type="button" class="wlbtn" title="Collapse">▾</button>
          </div>
        </div>
        <div id="readmeBody" style="margin-top: 10px; line-height:1.55;">
          <div class="muted">Short operational notes + hard-won lessons (so we don't repeat mistakes).</div>
          <div style="margin-top:12px; font-weight:800;">Browser Relay (Chrome extension)</div>
          <div class="muted" style="margin-top:6px;">If using it: confirm extension installed, tab attached (badge ON), and use profile="chrome" in automations.</div>
          <div style="margin-top:14px; font-weight:800;">API Keys & Secrets</div>
          <div class="muted" style="margin-top:6px;">Never paste real secrets into chat or web UI. Store in server env files and rotate when needed.</div>
        </div>
      </div>

      <div class="card" style="margin-top:14px; display:none;" id="snapCard">
        <div class="statusline" style="justify-content: space-between; align-items:center;">
          <div class="row" style="gap:10px; align-items:center;">
            <h2 style="margin:0">ClawdSnap</h2>
            <div class="pill" id="snapCount">0</div>
          </div>
          <div class="row" style="gap:8px; align-items:center;">
            <button id="snapClear" type="button" class="wlbtn" title="Hide">✕</button>
          </div>
        </div>
        <div id="snapBody" style="margin-top:10px;"></div>
      </div>
    </div>

    <div class="main">
      <div class="card" id="scheduled">
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
          <div class="composerLeft">
            <textarea id="msg" placeholder="Type a message. Paste images/screenshots here (Ctrl+V) ..."></textarea>

            <div id="quickbar">
              <div class="row" id="quickButtons">
                <button id="btnCatchUp" type="button" class="qbtn">Catch Up</button>
                <button id="btnGitCommit" type="button" class="qbtn">GitCommit</button>
                <button id="btnReviewRecent" type="button" class="qbtn">Review Recent</button>
                <button id="btnReviewWeek" type="button" class="qbtn">Review Week</button>
                <button id="btnRepeatLast" type="button" class="qbtn">Repeat Last</button>
                <button id="btnAddBtn" type="button" class="qbtn">Add a Button</button>
  <!-- adminonly disabled by default -->
              </div>
            </div>
          </div>

          <div class="composerActions">
            <button id="mic" type="button" title="Hold to talk">🎙</button>
            <button id="plan" type="button">Plan</button>
            <button id="send" type="button">Send</button>
            <button id="iterate" type="button">Iterate</button>
            <div class="muted" id="micStatus"></div>
          </div>
        </div>

        <!-- preview moved to ClawdSnap -->
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
            <button id="deToggle" type="button" class="wlbtn" title="Collapse">▾</button>
          </div>
        </div>
        <div id="deBody">
          <div class="muted" style="margin-top: 8px;">Checklists (newest first). Use Prev/Next to browse completed lists; persists until complete.</div>
          <div id="deLists" style="margin-top:10px; display:flex; flex-direction:column; gap: 12px;"></div>
        </div>
      </div>

      <div class="card" id="workcard">
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
            <span id="homeHydration" class="muted" title="Auto-state hydration: unknown" style="display:inline-flex; align-items:center; gap:6px; user-select:none;">
              <span id="homeHydrationIcon" aria-hidden="true" style="font-weight:900;">…</span>
            </span>
            <button id="homeRestart" type="button" class="wlbtn" title="Restart Console">Restart</button>
            <button id="btnStop" type="button" style="background:transparent; border:1px solid rgba(255,80,80,0.8);">Stop</button>
            <button id="btnAdd" type="button" style="background:transparent; border:1px solid rgba(80,255,160,0.8);">Add</button>
            <div class="pill" id="thinking">Idle</div>
            <button id="wlToggle" type="button" class="wlbtn" title="Collapse">▾</button>
          </div>
        </div>
        <div id="wlBody">
        <div class="row" style="justify-content: space-between; margin-top: 8px;">
          <div class="muted">High-level activity + timestamps (no private chain-of-thought).</div>
          <button id="wlRecent" type="button" class="wlbtn">Recent</button>
        </div>
        <div id="worklog" style="margin-top:10px; background: var(--card2); border: 1px solid var(--border); border-radius: 12px; padding: 10px; height: 520px; overflow:auto;"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Send to ClawdPM modal -->
  <div class="cc_modal" id="pm_modal" aria-label="Send to ClawdPM" role="dialog" aria-modal="true">
    <div class="cc_box" style="width:min(860px, 96vw);">
      <div class="cc_right" style="padding:16px;">
        <div class="cc_head">
          <div>
            <b>Send to ClawdPM</b>
            <div class="muted">Create a new card from a chat message.</div>
          </div>
          <button class="cc_close" id="pm_close" type="button">Close</button>
        </div>

        <div class="cc_form" id="pm_form">
          <div class="pm_grid">
            <div>
              <div class="muted" style="margin-bottom:6px;">Title</div>
              <input id="pm_title" placeholder="Card title" />
            </div>
            <div>
              <div class="muted" style="margin-bottom:6px;">Column</div>
              <select id="pm_col"></select>
            </div>
            <div>
              <div class="muted" style="margin-bottom:6px;">Priority</div>
              <select id="pm_pri">
                <option value="ultra">ultra</option>
                <option value="high">high</option>
                <option value="normal" selected>normal</option>
                <option value="planning">planning</option>
              </select>
            </div>
          </div>

          <div>
            <div class="muted" style="margin-bottom:6px;">Description (short)</div>
            <textarea id="pm_body" style="min-height: 120px;"></textarea>
          </div>

          <div>
            <div class="muted" style="margin-bottom:6px;">Notes (details)</div>
            <textarea id="pm_notes" style="min-height: 240px;"></textarea>
          </div>

          <div class="cc_row" style="justify-content: space-between;">
            <div class="cc_msg" id="pm_msg"></div>
            <div class="cc_row">
              <button class="cc_close" id="pm_cancel" type="button">Cancel</button>
              <button class="btn" id="pm_save" type="button">Save Card</button>
            </div>
          </div>
        </div>
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
    const sess = sessions.get(tok);
    const exp = (sess && typeof sess === 'object') ? sess.exp : sess;
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

const BIND = process.env.BIND || process.env.HOST || '127.0.0.1';
server.listen(PORT, BIND, () => {
  console.log(`Clawd Console listening on http://${BIND}:${PORT}`);
  // Start gateway bridge
  connectGateway();
  // Start opt-in telemetry pinger
  startTelemetry();
});
