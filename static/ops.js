// ClawdOps client (CSP-safe)
(() => {
  const $ = (id) => document.getElementById(id);
  const msg = $('opsMsg');
  const ta = $('opsProfile');
  const btnSave = $('opsSave');
  const btnCommit = $('opsCommit');
  const btnTemplate = $('opsTemplate');
  const btnRepeat = $('opsRepeat');
  const btnRestart = $('opsRestart');
  const hydWrap = $('opsHydration');
  const hydIcon = $('opsHydrationIcon');
  const list = $('opsRepeated');

  function setMsg(t){ if (msg) msg.textContent = t || ''; }

  async function load(){
    setMsg('Loading…');
    try {
      const res = await fetch('/api/ops/profile', { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      if (ta) ta.value = String(j.text || '');
      setMsg('Loaded.');
      setTimeout(() => setMsg(''), 900);
    } catch (e) {
      setMsg('Load failed: ' + String(e));
    }
  }

  async function save(){
    setMsg('Saving…');
    try {
      const res = await fetch('/api/ops/profile', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        body: JSON.stringify({ text: ta ? ta.value : '' })
      });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      setMsg('Saved.');
      setTimeout(() => setMsg(''), 900);
    } catch (e) {
      setMsg('Save failed: ' + String(e));
    }
  }

  async function commit(){
    setMsg('Committing to memory…');
    try {
      const res = await fetch('/api/ops/commit', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        body: JSON.stringify({ text: ta ? ta.value : '' })
      });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      setMsg('Committed: ' + String(j.path||''));
    } catch (e) {
      setMsg('Commit failed: ' + String(e));
    }
  }

  function insertTemplate(){
    const tpl = [
      '# Ops Profile',
      '',
      '## Who am I / what am I building?',
      '- ',
      '',
      '## Environments',
      '- Primary machine OS: Windows / Mac / Both',
      '- Hosting: ',
      '',
      '## Credentials + integrations (non-secret notes)',
      '- ',
      '',
      '## Safety / constraints',
      '- ',
      '',
      '## Standard operating procedures',
      '- ',
      '',
      '## Current priorities',
      '- ',
      ''
    ].join('\n');

    if (!ta) return;
    if (!ta.value.trim()) {
      ta.value = tpl;
      return;
    }
    ta.value = ta.value.replace(/\s*$/,'') + '\n\n' + tpl + '\n';
  }

  async function loadRepeated(){
    if (!list) return;
    setMsg('Scanning transcript…');
    list.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const res = await fetch('/api/ops/repeated-questions?limit=40', { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      const items = Array.isArray(j.items) ? j.items : [];
      if (!items.length) {
        list.innerHTML = '<div class="muted">No repeated questions found yet.</div>';
        setMsg('');
        return;
      }
      list.innerHTML = items.map(it => {
        const q = String(it.q||'');
        const c = Number(it.count||0);
        const last = String(it.lastTs||'');
        return '<div style="padding:10px 8px; border-top:1px solid rgba(255,255,255,0.08);">'
          + '<div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">'
          + '<div style="font-weight:900;">' + q.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])) + '</div>'
          + '<div class="muted">×' + c + (last ? (' • last ' + last.slice(0,19).replace('T',' ')) : '') + '</div>'
          + '</div>'
          + '</div>';
      }).join('');
      setMsg('');
    } catch (e) {
      list.innerHTML = '<div class="muted">Scan failed.</div>';
      setMsg('Scan failed: ' + String(e));
    }
  }

  if (btnSave) btnSave.addEventListener('click', save);
  if (btnCommit) btnCommit.addEventListener('click', commit);
  if (btnTemplate) btnTemplate.addEventListener('click', insertTemplate);
  if (btnRepeat) btnRepeat.addEventListener('click', loadRepeated);

  if (btnRestart) btnRestart.addEventListener('click', async () => {
    const ok = confirm('Restart the Console service now?');
    if (!ok) return;
    setMsg('Restarting…');
    try {
      const res = await fetch('/api/ops/restart', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        cache:'no-store',
        body: JSON.stringify({ confirm: 'RESTART' })
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j || !j.ok) throw new Error((j && j.error) ? j.error : ('http ' + res.status));
      setMsg('Restart requested. Reconnect in ~3–10s…');
    } catch (e) {
      setMsg('Restart failed: ' + String(e));
    }
  });

  // --- tabs ---
  const tabQ = $('opsTabQ');
  const tabG = $('opsTabG');
  const tabC = $('opsTabC');
  const tabTogether = $('opsTabTogether');
  const tabClawd = $('opsTabClawd');
  const tabClawdwell = $('opsTabClawdwell');
  const tabBridge = $('opsTabBridge');
  const tabRes = $('opsTabRes');
  const tabUpd = $('opsTabUpd');
  const tabMsg = $('opsTabMsg');
  const viewQ = $('opsTabQuestionnaire');
  const viewG = $('opsTabGateway');
  const viewC = $('opsTabCodex');
  const viewTogether = $('opsTabTogetherView');
  const viewClawd = $('opsTabClawdView');
  const viewClawdwell = $('opsTabClawdwellView');
  const viewBridge = $('opsTabBridgeView');
  const viewRes = $('opsTabResView');
  const viewUpd = $('opsTabUpdView');

  // Together.ai panel
  const tgBase = $('togetherBaseUrl');
  const tgPick = $('togetherModelPick');
  const tgPickRef = $('togetherModelRefresh');
  const tgModel = $('togetherModel');
  const tgKey = $('togetherApiKey');
  const tgSave = $('togetherSave');
  const tgClear = $('togetherClear');
  const tgMsg = $('togetherMsg');
  const tgPrompt = $('togetherPrompt');
  const tgTest = $('togetherTest');
  const tgTestMsg = $('togetherTestMsg');
  const tgOut = $('togetherOut');

  function setTabMsg(t){ if (tabMsg) tabMsg.textContent = t || ''; }
  function showTab(which){
    if (viewQ) viewQ.style.display = (which === 'q') ? '' : 'none';
    if (viewG) viewG.style.display = (which === 'g') ? '' : 'none';
    if (viewC) viewC.style.display = (which === 'c') ? '' : 'none';
    if (viewTogether) viewTogether.style.display = (which === 'together') ? '' : 'none';
    if (viewClawd) viewClawd.style.display = (which === 'clawd') ? '' : 'none';
    if (viewClawdwell) viewClawdwell.style.display = (which === 'clawdwell') ? '' : 'none';
    if (viewBridge) viewBridge.style.display = (which === 'bridge') ? '' : 'none';
    if (viewRes) viewRes.style.display = (which === 'res') ? '' : 'none';
    if (viewUpd) viewUpd.style.display = (which === 'upd') ? '' : 'none';
  }

  if (tabQ) tabQ.addEventListener('click', () => showTab('q'));
  if (tabG) tabG.addEventListener('click', () => showTab('g'));
  if (tabC) tabC.addEventListener('click', () => showTab('c'));
  if (tabTogether) tabTogether.addEventListener('click', () => {
    showTab('together');
    loadTogether();
  });
  if (tabClawd) tabClawd.addEventListener('click', () => showTab('clawd'));
  if (tabClawdwell) tabClawdwell.addEventListener('click', () => showTab('clawdwell'));
  if (tabBridge) tabBridge.addEventListener('click', () => {
    showTab('bridge');
    // Opening the tab marks everything as seen.
    loadBridge();
  });
  if (tabRes) tabRes.addEventListener('click', () => {
    showTab('res');
    loadResources();
  });
  if (tabUpd) tabUpd.addEventListener('click', () => {
    showTab('upd');
    loadUpdates();
  });

  // default
  showTab('q');

  function setTgMsg(t){ if (tgMsg) tgMsg.textContent = t || ''; }
  function setTgTestMsg(t){ if (tgTestMsg) tgTestMsg.textContent = t || ''; }
  function safeJson(x){ try { return JSON.stringify(x, null, 2); } catch { return String(x); } }

  async function refreshTogetherModels(){
    if (!tgPick) return;
    try {
      if (tgPickRef) tgPickRef.disabled = true;
      tgPick.innerHTML = '<option value="">Loading…</option>';
      const res = await fetch('/api/ops/together/serverless-models', { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      const models = Array.isArray(j.models) ? j.models : [];

      // Prefer coder-ish models near the top if present.
      const pref = [
        'Qwen/Qwen3-Coder-Next-FP8',
        'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        'deepseek-ai/DeepSeek-V3.1',
      ];
      const uniq = Array.from(new Set(models));
      uniq.sort((a,b) => {
        const ia = pref.indexOf(a);
        const ib = pref.indexOf(b);
        const aPref = ia !== -1;
        const bPref = ib !== -1;
        if (aPref && bPref) return ia - ib;
        if (aPref) return -1;
        if (bPref) return 1;
        return a.localeCompare(b);
      });

      tgPick.innerHTML = '<option value="">(pick a serverless model)</option>' + uniq
        .map(m => '<option value="' + String(m).replace(/"/g,'&quot;') + '">' + String(m).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])) + '</option>')
        .join('');

      // Default select if empty
      if (tgModel && !String(tgModel.value||'').trim()) tgModel.value = 'Qwen/Qwen3-Coder-Next-FP8';
      if (tgPick && tgModel) tgPick.value = String(tgModel.value||'').trim();
    } catch (e) {
      tgPick.innerHTML = '<option value="">(failed to load list)</option>';
      setTgMsg('Model list load failed: ' + String(e));
    } finally {
      if (tgPickRef) tgPickRef.disabled = false;
    }
  }

  async function loadTogether(){
    if (!tgBase && !tgModel) return;
    setTgMsg('Loading…');
    try {
      const res = await fetch('/api/ops/together', { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      const cfg = j.config || {};
      if (tgBase) tgBase.value = String(cfg.baseUrl || 'https://api.together.xyz');
      // Normalize common mistake: pasting a dedicated endpoint URL (/models/...).
      if (tgBase && /api\.together\.(ai|xyz)\/models\//i.test(tgBase.value)) tgBase.value = 'https://api.together.xyz';
      if (tgModel) tgModel.value = String(cfg.model || 'Qwen/Qwen3-Coder-Next-FP8');
      if (tgPick && tgModel) tgPick.value = String(tgModel.value||'').trim();
      // never populate key field from server; show placeholders if key exists
      if (tgKey) tgKey.value = (cfg.hasKey ? '********' : '');
      setTgMsg('Loaded' + (cfg.hasKey ? ' (key set)' : ' (no key)') + '.');
      setTimeout(() => setTgMsg(''), 1200);
      refreshTogetherModels();
    } catch (e) {
      setTgMsg('Load failed: ' + String(e));
    }
  }

  async function saveTogether(){
    setTgMsg('Saving…');
    try {
      const body = {
        baseUrl: tgBase ? tgBase.value : '',
        model: tgModel ? tgModel.value : '',
      };
      const key = tgKey ? String(tgKey.value || '') : '';
      if (key) body.apiKey = key;

      const res = await fetch('/api/ops/together', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error((j && j.error) ? j.error : ('http ' + res.status));
      setTgMsg('Saved.' + (j.config && j.config.hasKey ? ' (key set)' : ' (no key)'));
      if (tgKey) tgKey.value = '';
      setTimeout(() => setTgMsg(''), 1200);
    } catch (e) {
      setTgMsg('Save failed: ' + String(e));
    }
  }

  async function clearTogetherKey(){
    setTgMsg('Clearing…');
    try {
      const res = await fetch('/api/ops/together', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        body: JSON.stringify({ clearKey: '1' }),
      });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      setTgMsg('Cleared.');
      if (tgKey) tgKey.value = '';
      setTimeout(() => setTgMsg(''), 1200);
    } catch (e) {
      setTgMsg('Clear failed: ' + String(e));
    }
  }

  async function testTogether(){
    setTgTestMsg('Running…');
    if (tgOut) tgOut.textContent = '';
    try {
      const body = {
        baseUrl: tgBase ? tgBase.value : '',
        model: tgModel ? tgModel.value : '',
        prompt: tgPrompt ? tgPrompt.value : '',
      };
      const key = tgKey ? String(tgKey.value || '') : '';
      if (key) body.apiKey = key;

      const res = await fetch('/api/ops/together/test', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j || !j.ok) {
        const err = j ? safeJson(j) : ('http ' + res.status);
        if (tgOut) tgOut.textContent = err;
        setTgTestMsg('Failed.');
        return;
      }
      if (tgOut) tgOut.textContent = (j.output ? String(j.output) : safeJson(j));
      setTgTestMsg('OK • ' + String(j.ms || '-') + 'ms');
    } catch (e) {
      if (tgOut) tgOut.textContent = 'Error: ' + String(e);
      setTgTestMsg('Failed.');
    }
  }

  if (tgPick) tgPick.addEventListener('change', () => {
    const v = String(tgPick.value || '').trim();
    if (v && tgModel) tgModel.value = v;
  });
  if (tgPickRef) tgPickRef.addEventListener('click', refreshTogetherModels);

  if (tgSave) tgSave.addEventListener('click', saveTogether);
  if (tgClear) tgClear.addEventListener('click', clearTogetherKey);
  if (tgTest) tgTest.addEventListener('click', testTogether);

  async function refreshHydration(){
    if (!hydWrap || !hydIcon) return;
    let ok = false;
    let at = '';
    try {
      ok = localStorage.getItem('cc_caught_up_ok') === '1';
      at = localStorage.getItem('cc_caught_up_at') || '';
    } catch {}

    hydIcon.textContent = ok ? '✔' : '✖';
    hydIcon.style.color = ok ? 'rgba(80,220,140,0.95)' : 'rgba(255,120,120,0.95)';
    hydWrap.title = ok
      ? ('AI is caught up. (Saw CAUGHT_UP_OK)\nAt: ' + (at || '—'))
      : 'AI is not caught up yet. Use Catch Up and wait for CAUGHT_UP_OK.';
  }

  // initial loads
  loadBrand();
  loadClawdwellNotes();
  refreshHydration();
  setInterval(() => { try { refreshHydration(); } catch {} }, 5000);
  // Bridge is loaded on demand when tab is opened, but we also poll for a "new" indicator.
  setInterval(() => { try { loadBridge({ silent:true }); } catch {} }, 8000);

  // --- Clawdwell notes ---
  const cwTa = $('cwNotes');
  const cwSave = $('cwSave');
  const cwReload = $('cwReload');
  const cwMsg = $('cwMsg');
  const setCwMsg = (t) => { try { if (cwMsg) cwMsg.textContent = t || ''; } catch {} };

  async function loadClawdwellNotes(){
    setCwMsg('Loading…');
    try {
      const res = await fetch('/api/ops/clawdwell-notes', { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      if (cwTa) cwTa.value = String(j.text || '');
      setCwMsg('Loaded.');
      setTimeout(() => setCwMsg(''), 900);
    } catch (e) {
      setCwMsg('Load failed: ' + String(e));
    }
  }

  async function saveClawdwellNotes(){
    setCwMsg('Saving…');
    try {
      const res = await fetch('/api/ops/clawdwell-notes', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        body: JSON.stringify({ text: cwTa ? cwTa.value : '' })
      });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      setCwMsg('Saved.');
      setTimeout(() => setCwMsg(''), 900);
    } catch (e) {
      setCwMsg('Save failed: ' + String(e));
    }
  }

  if (cwSave) cwSave.addEventListener('click', saveClawdwellNotes);
  if (cwReload) cwReload.addEventListener('click', loadClawdwellNotes);

  // --- ClawdBridge ---
  const brRefresh = $('bridgeRefresh');
  const brDir = $('bridgeDir');
  const brSummary = $('bridgeSummary');
  const brText = $('bridgeText');
  const brPost = $('bridgePost');
  const brMsg = $('bridgeMsg');
  const brList = $('bridgeList');

  const setBrMsg = (t) => { try { if (brMsg) brMsg.textContent = t || ''; } catch {} };
  const esc = (s) => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function renderBridge(items){
    if (!brList) return;
    const arr = Array.isArray(items) ? items.slice().reverse() : [];
    if (!arr.length) {
      brList.innerHTML = '<div class="muted">No messages yet.</div>';
      return;
    }

    brList.innerHTML = arr.map(it => {
      const id = esc(it.id||'');
      const dir = esc(it.dir||'');
      const ts = esc((it.ts||'').replace('T',' ').slice(0,19));
      const summary = esc(it.summary || (String(it.text||'').split(/\r?\n/)[0] || '').slice(0, 140));
      const full = esc(String(it.text||''));
      return '<div class="card" style="background: rgba(255,255,255,0.03); padding:10px; margin-top:10px;">'
        + '<div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:baseline;">'
        +   '<div><b>' + (dir === 'outbox' ? 'OUT' : 'IN') + '</b> <span class="muted">' + ts + '</span></div>'
        +   '<button class="pill" type="button" data-bridge-toggle="' + id + '">Details</button>'
        + '</div>'
        + '<div style="margin-top:6px;">' + summary + '</div>'
        + '<pre id="br_' + id + '" style="display:none; margin-top:10px; white-space:pre-wrap; border:1px solid rgba(255,255,255,0.10); background: rgba(0,0,0,0.12); border-radius:12px; padding:10px;">' + full + '</pre>'
        + '</div>';
    }).join('');

    Array.from(brList.querySelectorAll('button[data-bridge-toggle]')).forEach(b => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-bridge-toggle') || '';
        const pre = document.getElementById('br_' + id);
        if (!pre) return;
        const on = pre.style.display !== 'none';
        pre.style.display = on ? 'none' : '';
        b.textContent = on ? 'Details' : 'Hide';
      });
    });
  }

  let bridgeLastSeenTs = 0;

  async function loadBridge(opts = {}){
    const silent = !!opts.silent;
    if (!silent) setBrMsg('Loading…');
    try {
      const res = await fetch('/api/ops/bridge/list?limit=120', { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      const items = Array.isArray(j.items) ? j.items : [];
      renderBridge(items);
      if (!silent) setBrMsg('');

      // indicator: if there are messages newer than last seen, mark the tab.
      let newest = 0;
      for (const it of items){
        const t = Date.parse(it && it.ts ? String(it.ts) : '');
        if (Number.isFinite(t) && t > newest) newest = t;
      }
      if (!bridgeLastSeenTs) bridgeLastSeenTs = newest;

      // If bridge tab is visible, we consider everything seen.
      const bridgeOpen = viewBridge && viewBridge.style.display !== 'none';
      if (bridgeOpen) {
        bridgeLastSeenTs = newest;
        if (tabBridge) tabBridge.textContent = 'ClawdBridge';
      } else {
        if (newest > bridgeLastSeenTs) {
          if (tabBridge) tabBridge.textContent = 'ClawdBridge • new';
        }
      }

    } catch (e) {
      if (!silent) setBrMsg('Load failed: ' + String(e));
    }
  }

  async function postBridge(){
    setBrMsg('Posting…');
    try {
      const res = await fetch('/api/ops/bridge/post', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        body: JSON.stringify({
          dir: brDir ? brDir.value : 'outbox',
          summary: brSummary ? brSummary.value : '',
          text: brText ? brText.value : '',
        })
      });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error((j && j.error) ? j.error : ('http ' + res.status));
      setBrMsg('Posted.');
      setTimeout(() => setBrMsg(''), 900);
      await loadBridge();
    } catch (e) {
      setBrMsg('Post failed: ' + String(e));
    }
  }

  if (brRefresh) brRefresh.addEventListener('click', loadBridge);
  if (brPost) brPost.addEventListener('click', postBridge);

  // --- Resources ---
  const resRefresh = $('resRefresh');
  const resMsg = $('resMsg');
  const resPre = $('resPre');
  const resAlerts = $('resAlerts');

  // --- Updates ---
  const updReload = $('updReload');
  const updSave = $('updSave');
  const updMsg = $('updMsg');
  const updMode = $('updMode');
  const updLevel = $('updLevel');
  const updStatus = $('updStatus');
  const updLatest = $('updLatest');

  const setResMsg = (t) => { try { if (resMsg) resMsg.textContent = t || ''; } catch {} };

  function fmtBytes(n){
    const v = Number(n||0);
    if (!Number.isFinite(v) || v <= 0) return '0 B';
    const u = ['B','KB','MB','GB','TB'];
    let x = v; let i = 0;
    while (x >= 1024 && i < u.length-1){ x /= 1024; i++; }
    return x.toFixed(i ? 1 : 0) + ' ' + u[i];
  }

  function renderResources(j){
    if (!j || !j.ok || !j.host) return;
    const h = j.host;
    const lines = [];
    lines.push('host: ' + (h.hostname || '?') + ' (' + (h.platform || '?') + ')');
    lines.push('uptime: ' + (h.uptimeSec ? Math.floor(h.uptimeSec/60) + ' min' : '?'));
    lines.push('cores: ' + (h.cores || '?'));
    lines.push('load: ' + [h.load1,h.load5,h.load15].map(x => (x==null?'?':Number(x).toFixed(2))).join(' / '));
    lines.push('ram: ' + fmtBytes(h.memUsed) + ' used / ' + fmtBytes(h.memTotal) + ' total (' + Math.round((h.memPct||0)*100) + '%)');
    if (h.disk) {
      lines.push('disk(/): ' + fmtBytes(h.disk.usedBytes) + ' used / ' + fmtBytes(h.disk.totalBytes) + ' total (' + Math.round((h.disk.usedPct||0)*100) + '%)');
    } else {
      lines.push('disk(/): (unavailable)');
    }
    lines.push('ts: ' + (j.ts || ''));

    if (resPre) resPre.textContent = lines.join('\n');

    const alerts = Array.isArray(j.alerts) ? j.alerts : [];
    if (!resAlerts) return;
    if (!alerts.length) {
      resAlerts.textContent = '(none)';
      return;
    }
    resAlerts.innerHTML = alerts.map(a => {
      const lvl = esc(a.level||'warn');
      const msg = esc(a.msg||'');
      return '<div style="margin-top:6px;"><b>' + lvl + '</b>: ' + msg + '</div>';
    }).join('');
  }

  async function loadResources(){
    setResMsg('Loading…');
    try {
      const res = await fetch('/api/ops/resources', { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      renderResources(j);
      setResMsg('');
    } catch (e) {
      setResMsg('Load failed: ' + String(e));
    }
  }

  if (resRefresh) resRefresh.addEventListener('click', loadResources);

  async function loadUpdates(){
    try { if (updMsg) updMsg.textContent = 'Loading…'; } catch {}
    try {
      const [cfgRes, relRes] = await Promise.all([
        fetch('/api/ops/updates/config', { credentials:'include', cache:'no-store' }),
        fetch('/api/repo/releases/latest', { credentials:'include', cache:'no-store' }),
      ]);
      const cfgJ = await cfgRes.json();
      const relJ = await relRes.json();

      if (cfgJ && cfgJ.ok && cfgJ.cfg) {
        if (updMode) updMode.value = String(cfgJ.cfg.mode || 'notify');
        if (updLevel) updLevel.value = String(cfgJ.cfg.maxLevel || 'patch');
      }

      if (updStatus) {
        const local = relJ && relJ.ok && relJ.local ? String(relJ.local.build||'') : '';
        const up = relJ && relJ.ok && relJ.latest ? String(relJ.latest.build||'') : '';
        const lvl = relJ && relJ.ok && relJ.latest ? String(relJ.latest.level||'') : '';
        updStatus.textContent = (up && local && up !== local) ? ('Update available: ' + up + (lvl ? (' ('+lvl+')') : '')) : ('Up to date (' + (local||'?') + ')');
      }
      if (updLatest) updLatest.textContent = (relJ && relJ.ok) ? JSON.stringify(relJ.latest || {}, null, 2) : ('(feed unavailable)');

      if (updMsg) updMsg.textContent = '';
    } catch (e) {
      if (updMsg) updMsg.textContent = 'Load failed: ' + String(e);
    }
  }

  async function saveUpdates(){
    try { if (updMsg) updMsg.textContent = 'Saving…'; } catch {}
    try {
      const body = { cfg: { mode: updMode ? updMode.value : 'notify', maxLevel: updLevel ? updLevel.value : 'patch' } };
      const res = await fetch('/api/ops/updates/config', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      if (updMsg) updMsg.textContent = 'Saved.';
      setTimeout(() => { try { if (updMsg) updMsg.textContent = ''; } catch {} }, 900);
    } catch (e) {
      if (updMsg) updMsg.textContent = 'Save failed: ' + String(e);
    }
  }

  if (updReload) updReload.addEventListener('click', loadUpdates);
  if (updSave) updSave.addEventListener('click', saveUpdates);

  // --- Brand / assistant name ---
  const bName = $('brandAssistantName');
  const bSave = $('brandSave');
  const bReload = $('brandReload');
  const bMsg = $('brandMsg');
  const bCur = $('brandCurrent');
  function setBMsg(t){ if (bMsg) bMsg.textContent = t || ''; }

  async function loadBrand(){
    try {
      const res = await fetch('/api/ops/brand', { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      const name = String(j.brand && j.brand.assistantName ? j.brand.assistantName : '');
      if (bName) bName.value = name;
      if (bCur) bCur.textContent = name ? ('assistantName=' + name) : '(unset)';
    } catch (e) {
      if (bCur) bCur.textContent = 'Failed to load: ' + String(e);
    }
  }

  async function saveBrand(){
    setBMsg('Saving…');
    try {
      const res = await fetch('/api/ops/brand', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        body: JSON.stringify({ assistantName: bName ? bName.value : '' })
      });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      setBMsg('Saved.');
      setTimeout(() => setBMsg(''), 900);
      await loadBrand();
    } catch (e) {
      setBMsg('Save failed: ' + String(e));
    }
  }

  if (bSave) bSave.addEventListener('click', saveBrand);
  if (bReload) bReload.addEventListener('click', loadBrand);

  // --- Gateway integration panel ---
  const cUrl = $('codexGatewayUrl');
  const cKey = $('codexSessionKey');
  const cMsg = $('codexMsg');
  const cSave = $('codexSave');
  const cRec = $('codexReconnect');
  const cStatus = $('codexStatus');
  const cErr = $('codexLastError');
  const cEv = $('codexEvents');
  const cEvBtn = $('codexEventsRefresh');
  const cEvLimit = $('codexEventsLimit');

  // Codex tab controls
  const pSel = $('codexProfileSel');
  const pApply = $('codexProfileApply');
  const pClear = $('codexProfileClear');
  const pMsg = $('codexProfileMsg');
  const pCur = $('codexProfileCurrent');

  function setCMsg(t){ if (cMsg) cMsg.textContent = t || ''; }
  function setPMsg(t){ if (pMsg) pMsg.textContent = t || ''; }
  function fmt(x){ try { return JSON.stringify(x, null, 2); } catch { return String(x); } }

  async function loadGateway(){
    try {
      const res = await fetch('/api/ops/codex', { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      const eff = j.effective || {};
      if (cUrl) cUrl.value = String(eff.gatewayWsUrl || '');
      if (cKey) cKey.value = String(eff.consoleSessionKey || '');
      if (cStatus) {
        const conn = j.gateway && j.gateway.connected ? 'connected' : 'disconnected';
        cStatus.textContent = conn + ' • ' + String(eff.gatewayWsUrl || '') + ' • sessionKey=' + String(eff.consoleSessionKey || '');
      }
      if (cErr) cErr.textContent = (j.gateway && j.gateway.lastError) ? fmt(j.gateway.lastError) : '';
    } catch (e) {
      if (cStatus) cStatus.textContent = 'Failed to load: ' + String(e);
    }
  }

  async function saveGateway(){
    setCMsg('Saving…');
    try {
      const res = await fetch('/api/ops/codex', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        body: JSON.stringify({
          gatewayWsUrl: cUrl ? cUrl.value : '',
          consoleSessionKey: cKey ? cKey.value : '',
        })
      });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      setCMsg('Saved. Reconnecting…');
      setTimeout(() => setCMsg(''), 1200);
      await loadGateway();
    } catch (e) {
      setCMsg('Save failed: ' + String(e));
    }
  }

  async function reconnectGateway(){
    setCMsg('Reconnecting…');
    try {
      const res = await fetch('/api/ops/codex/reconnect', { method:'POST', credentials:'include' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      setCMsg('Reconnect triggered.');
      setTimeout(() => setCMsg(''), 900);
      setTimeout(loadGateway, 400);
    } catch (e) {
      setCMsg('Reconnect failed: ' + String(e));
    }
  }

  async function loadEvents(){
    try {
      const lim = Math.max(1, Math.min(500, Number(cEvLimit ? cEvLimit.value : 120) || 120));
      const res = await fetch('/api/gateway/events?limit=' + encodeURIComponent(String(lim)), { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      if (cEv) cEv.textContent = fmt(j.events || []);
    } catch (e) {
      if (cEv) cEv.textContent = 'Failed to load events: ' + String(e);
    }
  }

  async function loadProfiles(){
    setPMsg('Loading…');
    try {
      const res = await fetch('/api/ops/codex/profiles', { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      const profiles = Array.isArray(j.profiles) ? j.profiles : [];
      const curId = j.current && j.current.authProfileOverride ? String(j.current.authProfileOverride) : '';

      if (pSel) {
        pSel.innerHTML = '<option value="">(default)</option>' + profiles
          .filter(p => p && p.id)
          .map(p => {
            const label = (p.email ? (p.email + ' • ') : '') + (p.provider || '') + ' • ' + p.id;
            const sel = (p.id === curId) ? ' selected' : '';
            return '<option value="' + String(p.id).replace(/"/g,'&quot;') + '"' + sel + '>' + label.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])) + '</option>';
          }).join('');
      }

      if (pCur) {
        const curLine = curId ? ('override=' + curId) : 'override=(none)';
        const lastGood = j.lastGood && j.lastGood['openai-codex'] ? ('lastGood(openai-codex)=' + j.lastGood['openai-codex']) : '';
        pCur.textContent = [curLine, lastGood].filter(Boolean).join(' • ') || curLine;
      }

      setPMsg('');
    } catch (e) {
      setPMsg('Load failed: ' + String(e));
    }
  }

  async function applyProfile(){
    setPMsg('Applying…');
    try {
      const id = pSel ? String(pSel.value || '').trim() : '';
      const res = await fetch('/api/ops/codex/profile', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        body: JSON.stringify({ profileId: id })
      });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      setPMsg('Applied.');
      setTimeout(() => setPMsg(''), 900);
      await loadProfiles();
    } catch (e) {
      setPMsg('Apply failed: ' + String(e));
    }
  }

  async function clearProfile(){
    if (pSel) pSel.value = '';
    return applyProfile();
  }

  if (cSave) cSave.addEventListener('click', saveGateway);
  if (cRec) cRec.addEventListener('click', reconnectGateway);
  if (cEvBtn) cEvBtn.addEventListener('click', loadEvents);
  if (pApply) pApply.addEventListener('click', applyProfile);
  if (pClear) pClear.addEventListener('click', clearProfile);

  load();
  loadGateway();
  loadEvents();
  loadProfiles();
})();
