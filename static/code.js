// ClawdCode IDE cockpit client (CSP-safe)
(() => {
  const $ = (id) => document.getElementById(id);

  // --- File browser/editor ---
  const treeEl = $('codeTree');
  const editor = $('codeEditor');
  const pathEl = $('codePath');
  const msgEl = $('codeMsg');
  const cwdEl = $('codeCwd');
  const blockedEl = $('codeBlocked');

  const btnSave = $('codeSave');
  const btnReload = $('codeReload');
  const btnUp = $('codeUp'); // deprecated (removed from UI)
  const wsSel = $('wsSel');
  const hdrWsSel = $('hdrWsSel');
  const hdrWsAdd = $('hdrWsAdd');
  const hdrGitSel = $('hdrGitSel');
  const hdrGitConnect = $('hdrGitConnect');
  const hdrGitDisc = $('hdrGitDisc');
  const wsToggle = $('wsToggle');
  const fileToggle = $('fileToggle');
  const chatToggle = $('chatToggle');
  const opToggle = $('opToggle');

  // layout expand
  const ideEl = $('ccIde');
  const btnExpFile = $('codeExpFile');
  const btnExpApp = $('codeExpApp');

  // --- App preview ---
  const appPreset = $('appPreset');
  const appUrl = $('appUrl');
  const appGo = $('appGo');
  const appOpen = $('appOpen');
  const appFrame = $('appFrame');
  const appMsg = $('appMsg');

  // --- Chat ---
  const chatLog = $('chatLog');
  const chatInput = $('chatInput');
  const chatSend = $('chatSend');
  const chatJump = $('chatJump');
  const chatMsg = $('chatMsg');

  // --- Operator stack ---
  const opRefresh = $('opRefresh');
  const opWorkExpand = $('wlExpand');
  const wlToggle = $('wlToggle');
  const wlAdd = $('wlAdd');
  const wlStop = $('wlStop');
  const wlThinking = $('wlThinking');
  const worklogEl = $('worklog');
  const wlMsg = $('wlMsg');
  const wlFilterBtns = Array.from(document.querySelectorAll('.wlbtn[data-filter]'));
  const wlRecentBtn = $('wlRecent');

  const deListsEl = $('deLists');
  const deStatusEl = $('deStatus');
  const dePrevBtn = $('dePrev');
  const deNextBtn = $('deNext');

  let curDir = '';
  let curFile = '';
  let dirty = false;
  let lastOpenMeta = null;

  function setMsg(t){ if (msgEl) msgEl.textContent = t || ''; }
  function setChatMsg(t){ if (chatMsg) chatMsg.textContent = t || ''; }
  function setAppMsg(t){ if (appMsg) appMsg.textContent = t || ''; }
  function setWlMsg(t){ if (wlMsg) wlMsg.textContent = t || ''; }

  function esc(s){
    return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function fmtBytes(n){
    const x = Number(n || 0);
    if (!x) return '0 B';
    const u = ['B','KB','MB','GB'];
    let i = 0; let v = x;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? String(v) : v.toFixed(1)) + ' ' + u[i];
  }

  function parentDir(p){
    const parts = String(p||'').split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
  }

  function showBlocked(meta){
    if (!blockedEl) return;
    if (editor) editor.style.display = 'none';
    blockedEl.style.display = 'block';

    const p = esc(meta && meta.path || curFile || '');
    const size = meta && meta.size != null ? fmtBytes(meta.size) : '';
    const mtime = meta && meta.mtime ? esc(meta.mtime) : '';
    const why = esc(meta && meta.why || 'Protected file.');

    blockedEl.innerHTML = `
      <div style="font-weight:900;">Protected file</div>
      <div class="muted" style="margin-top:6px;">${why}</div>
      <div class="muted" style="margin-top:10px;">Path: <code>${p}</code></div>
      <div class="muted" style="margin-top:6px;">Size: <code>${esc(size)}</code> • mtime: <code>${mtime || '—'}</code></div>

      <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
        <button class="pill" id="bgCopyPath" type="button">Copy path</button>
        <button class="pill" id="bgLocal" type="button">Edit locally (VS Code / terminal)</button>
        <button class="pill" id="bgUnlockRo" type="button">Break-glass (view)</button>
        <button class="pill" id="bgUnlockRw" type="button" style="border-color: rgba(255,160,160,0.55);">Break-glass (edit)</button>
        <span class="muted" id="bgMsg"></span>
      </div>

      <details style="margin-top:10px;">
        <summary style="cursor:pointer; font-weight:900;">How to edit without break-glass</summary>
        <div class="muted" style="margin-top:8px; white-space:pre-wrap;">Recommended workflow:
- Copy the path
- Open in VS Code or edit in a terminal editor
- Save
- Back here, hit Reload to confirm changes</div>
      </details>
    `;

    const bgCopyPath = $('bgCopyPath');
    const bgLocal = $('bgLocal');
    const bgUnlockRo = $('bgUnlockRo');
    const bgUnlockRw = $('bgUnlockRw');
    const bgMsg = $('bgMsg');

    const rel = (meta && meta.path) ? String(meta.path) : String(curFile || '');

    if (bgCopyPath) bgCopyPath.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(rel);
        if (bgMsg) bgMsg.textContent = 'Copied.';
        setTimeout(() => { if (bgMsg) bgMsg.textContent = ''; }, 900);
      } catch {
        if (bgMsg) bgMsg.textContent = 'Copy failed.';
      }
    });

    if (bgLocal) bgLocal.addEventListener('click', () => {
      alert('Open this file in your local editor using the path shown. For example:\n\ncode "' + rel + '"\n# or\nnano "' + rel + '"');
    });

    async function doBreakglass(write){
      const pass = prompt('Break-glass password (CODE_BREAKGLASS_PASS):');
      if (!pass) return;
      if (bgMsg) bgMsg.textContent = 'Unlocking…';
      try {
        const res = await fetch('/api/code/breakglass', {
          method:'POST',
          headers:{ 'Content-Type':'application/json' },
          credentials:'include',
          cache:'no-store',
          body: JSON.stringify({ path: rel, pass, write: !!write, minutes: 10 })
        });
        const j = await res.json();
        if (!res.ok || !j || !j.ok) throw new Error(j && j.error ? j.error : ('http ' + res.status));
        if (bgMsg) bgMsg.textContent = 'Unlocked until ' + (j.until || '(soon)') + '.';
        // reopen immediately
        openFile(rel, { force: true });
      } catch (e) {
        if (bgMsg) bgMsg.textContent = 'Unlock failed: ' + String(e);
      }
    }

    if (bgUnlockRo) bgUnlockRo.addEventListener('click', () => doBreakglass(false));
    if (bgUnlockRw) bgUnlockRw.addEventListener('click', () => doBreakglass(true));
  }

  function hideBlocked(){
    if (blockedEl) { blockedEl.style.display = 'none'; blockedEl.innerHTML = ''; }
    if (editor) editor.style.display = 'block';
  }

  async function loadDir(dir){
    curDir = String(dir||'');
    setMsg('Loading tree…');
    if (treeEl) treeEl.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const res = await fetch('/api/code/tree?path=' + encodeURIComponent(curDir), { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error(j && j.error ? j.error : ('http ' + res.status));
      curDir = String(j.path||'');
      if (cwdEl) cwdEl.textContent = curDir ? ('/' + curDir) : '/';
      // show selected workspace title if provided
      if (j.workspace && j.workspace.title) {
        if (cwdEl) cwdEl.textContent = (j.workspace.title + ' • ' + (curDir ? ('/' + curDir) : '/'));
      }
      renderTree(j.items || []);
      setMsg('');
    } catch (e) {
      if (treeEl) treeEl.innerHTML = '<div class="muted">Failed to load tree.</div>';
      setMsg('Tree load failed: ' + String(e));
    }
  }

  function getWsSelect(){
    return hdrWsSel || wsSel;
  }

  async function loadWorkspaces(){
    const sel = getWsSelect();
    if (!sel) return;
    try {
      const res = await fetch('/api/code/workspaces', { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      const wss = Array.isArray(j.workspaces) ? j.workspaces : [];
      sel.innerHTML = wss.map(w => `<option value="${esc(w.id)}">${esc(w.title || w.id)}</option>`).join('');
      sel.value = String(j.current || '');
    } catch {
      sel.innerHTML = '<option value="console">Console</option>';
    }
  }

  async function setWorkspace(id){
    const sel = getWsSelect();
    if (!id) return;
    setMsg('Switching workspace…');
    try {
      const res = await fetch('/api/code/workspace', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        cache:'no-store',
        body: JSON.stringify({ id })
      });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      curDir = '';
      curFile = '';
      dirty = false;
      if (pathEl) pathEl.textContent = '';
      if (editor) editor.value = '';
      hideBlocked();
      await loadWorkspaces();
      await loadDir('');
      await refreshGitUI();
      setMsg('');
    } catch (e) {
      setMsg('Workspace switch failed: ' + String(e));
    }
  }

  function renderTree(items){
    if (!treeEl) return;

    const rows = [];
    if (curDir) {
      rows.push('<div class="coderow" data-type="up" data-path="">..</div>');
    }

    for (const it of items){
      if (!it || !it.name) continue;
      if (it.mode === 'deny') continue;
      const icon = it.type === 'dir' ? '📁' : (it.mode === 'list' ? '🔒' : '📄');
      const modeTag = (it.type === 'file' && it.mode && it.mode !== 'rw') ? (' <span class="muted ccSmall">(' + esc(it.mode) + ')</span>') : '';
      rows.push(
        '<div class="coderow" data-type="' + esc(it.type) + '" data-path="' + esc(it.path) + '" data-mode="' + esc(it.mode||'') + '">' +
          '<span class="muted" style="margin-right:8px;">' + icon + '</span>' +
          '<span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(it.name) + modeTag + '</span>' +
        '</div>'
      );
    }

    treeEl.innerHTML = rows.join('') || '<div class="muted">(empty)</div>';

    Array.from(treeEl.querySelectorAll('.coderow[data-path]')).forEach(row => {
      row.addEventListener('click', async () => {
        const type = row.getAttribute('data-type');
        const p = row.getAttribute('data-path') || '';
        if (type === 'dir') return loadDir(p);
        if (type === 'file') return openFile(p);
        if (type === 'up') return loadDir(parentDir(curDir));
      });
    });
  }

  async function openFile(p, opts = {}){
    if (!p) return;
    if (!opts.force && dirty && !confirm('Discard unsaved changes?')) return;

    setMsg('Loading file…');
    hideBlocked();

    try {
      const res = await fetch('/api/code/file?path=' + encodeURIComponent(p), { credentials:'include', cache:'no-store' });
      const txt = await res.text();
      let j; try { j = JSON.parse(txt); } catch { j = null; }

      if (!res.ok || !j || !j.ok) {
        // blocked is still JSON w/ metadata
        if (j && j.error === 'blocked') {
          curFile = String(j.path || p || '');
          if (pathEl) pathEl.textContent = curFile;
          lastOpenMeta = j;
          dirty = false;
          setMsg('');
          showBlocked(j);
          return;
        }
        throw new Error(j && j.error ? j.error : ('http ' + res.status + ' ' + (txt||'').slice(0,120)));
      }

      curFile = String(j.path||p||'');
      lastOpenMeta = j;
      if (pathEl) pathEl.textContent = curFile;
      if (editor) editor.value = String(j.text||'');
      dirty = false;
      setMsg('');
    } catch (e) {
      setMsg('File load failed: ' + String(e));
    }
  }

  async function saveFile(){
    if (!curFile) { setMsg('No file selected.'); return; }
    if (blockedEl && blockedEl.style.display !== 'none') {
      setMsg('This file is protected. Use break-glass or edit locally.');
      return;
    }
    setMsg('Saving…');
    try {
      const res = await fetch('/api/code/file', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        cache:'no-store',
        body: JSON.stringify({ path: curFile, text: editor ? editor.value : '' })
      });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) {
        if (j && (j.error === 'blocked_write')) {
          showBlocked({ path: j.path || curFile, why: j.why || 'Protected file.' });
          throw new Error(j.why || 'blocked_write');
        }
        throw new Error(j && j.error ? j.error : ('http ' + res.status));
      }
      dirty = false;
      setMsg('Saved.');
      setTimeout(() => setMsg(''), 900);
      loadDir(curDir);
    } catch (e) {
      setMsg('Save failed: ' + String(e));
    }
  }

  function goUp(){
    loadDir(parentDir(curDir));
  }

  if (editor) editor.addEventListener('input', () => { dirty = true; });
  if (btnSave) btnSave.addEventListener('click', saveFile);
  if (btnReload) btnReload.addEventListener('click', () => curFile && openFile(curFile, { force:true }));
  if (btnUp) btnUp.addEventListener('click', goUp);

  function setExpand(mode){
    if (!ideEl) return;
    ideEl.classList.remove('exp-file');
    ideEl.classList.remove('exp-app');
    if (mode === 'file') ideEl.classList.add('exp-file');
    if (mode === 'app') ideEl.classList.add('exp-app');
  }

  function toggleCollapse(which){
    if (!ideEl) return;
    if (which === 'ws') ideEl.classList.toggle('c-ws');
    if (which === 'file') ideEl.classList.toggle('c-file');
    if (which === 'chat') ideEl.classList.toggle('c-chat');
    if (which === 'op') ideEl.classList.toggle('c-op');

    try {
      localStorage.setItem('cc_code_c_ws', ideEl.classList.contains('c-ws') ? '1' : '0');
      localStorage.setItem('cc_code_c_file', ideEl.classList.contains('c-file') ? '1' : '0');
      localStorage.setItem('cc_code_c_chat', ideEl.classList.contains('c-chat') ? '1' : '0');
      localStorage.setItem('cc_code_c_op', ideEl.classList.contains('c-op') ? '1' : '0');
    } catch {}

    // update chevrons
    if (wsToggle) wsToggle.textContent = ideEl.classList.contains('c-ws') ? '▶' : '◀';
    if (fileToggle) fileToggle.textContent = ideEl.classList.contains('c-file') ? '▶' : '◀';
    if (chatToggle) chatToggle.textContent = ideEl.classList.contains('c-chat') ? '◀' : '▶';
    if (opToggle) opToggle.textContent = ideEl.classList.contains('c-op') ? '◀' : '▶';
  }

  function restoreCollapseState(){
    if (!ideEl) return;
    try {
      const cws = localStorage.getItem('cc_code_c_ws');
      const cf = localStorage.getItem('cc_code_c_file');
      const cc = localStorage.getItem('cc_code_c_chat');
      const cop = localStorage.getItem('cc_code_c_op');
      if (cws === '1') ideEl.classList.add('c-ws');
      if (cf === '1') ideEl.classList.add('c-file');
      if (cc === '1') ideEl.classList.add('c-chat');
      if (cop === '1') ideEl.classList.add('c-op');
    } catch {}
    if (wsToggle) wsToggle.textContent = ideEl.classList.contains('c-ws') ? '▶' : '◀';
    if (fileToggle) fileToggle.textContent = ideEl.classList.contains('c-file') ? '▶' : '◀';
    if (chatToggle) chatToggle.textContent = ideEl.classList.contains('c-chat') ? '◀' : '▶';
    if (opToggle) opToggle.textContent = ideEl.classList.contains('c-op') ? '◀' : '▶';
  }

  if (btnExpFile) btnExpFile.addEventListener('click', () => {
    if (!ideEl) return;
    const on = ideEl.classList.contains('exp-file');
    setExpand(on ? '' : 'file');
  });
  if (btnExpApp) btnExpApp.addEventListener('click', () => {
    if (!ideEl) return;
    const on = ideEl.classList.contains('exp-app');
    setExpand(on ? '' : 'app');
  });

  if (wsToggle) wsToggle.addEventListener('click', () => toggleCollapse('ws'));
  if (fileToggle) fileToggle.addEventListener('click', () => toggleCollapse('file'));
  if (chatToggle) chatToggle.addEventListener('click', () => toggleCollapse('chat'));
  if (opToggle) opToggle.addEventListener('click', () => toggleCollapse('op'));
  restoreCollapseState();

  // --- App preview ---
  function normalizePreviewUrl(u){
    const url = String(u||'').trim();
    if (!url) return '';
    // allow same-origin proxy paths only
    if (url.startsWith('/proxy/')) return url;
    // allow shorthand like 5000 or :5000
    const m = url.match(/^:?([0-9]{2,5})\/?(.*)$/);
    if (m) {
      const port = Number(m[1]);
      const rest = m[2] ? ('/' + m[2].replace(/^\/+/, '')) : '/';
      return '/proxy/' + port + rest;
    }
    return url;
  }

  function applyAppUrl(u){
    const url = normalizePreviewUrl(u);
    if (!url) return;
    if (appUrl) appUrl.value = url;
    if (appFrame) appFrame.src = url;
    setAppMsg('Loading…');
  }

  if (appPreset) appPreset.addEventListener('change', () => applyAppUrl(appPreset.value));
  if (appGo) appGo.addEventListener('click', () => applyAppUrl(appUrl && appUrl.value));
  if (appOpen) appOpen.addEventListener('click', () => {
    const url = normalizePreviewUrl(appUrl && appUrl.value);
    if (!url) return;
    window.open(url, '_blank', 'noopener');
  });
  if (appFrame) {
    appFrame.addEventListener('load', () => setAppMsg(''));
    appFrame.addEventListener('error', () => setAppMsg('Failed to load.'));
  }

  // --- Chat (shared session) ---
  let chatCache = [];

  function scrollChatBottom(){
    if (!chatLog) return;
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function renderChat(msgs){
    if (!chatLog) return;
    const arr = Array.isArray(msgs) ? msgs : [];
    chatCache = arr;

    // render oldest->newest
    chatLog.innerHTML = arr.map(m => {
      const role = String(m.r || m.role || '');
      const isA = role === 'assistant';
      const who = isA ? (window.AGENT_NAME || 'Assistant') : 'You';
      const ts = esc(m.ts || '');
      const text = esc(m.text || '');
      const id = esc(m.id || '');
      const wrapStyle = 'padding:8px; border-bottom:1px solid rgba(255,255,255,0.08);';
      const head = `<div class="muted ccSmall" style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">` +
        `<span><b>${esc(who)}</b></span>` +
        `<span>${ts}</span>` +
      `</div>`;
      const body = `<div style="white-space:pre-wrap; word-break:break-word; margin-top:6px;">${text}</div>`;
      const foot = id ? (`<div class="muted ccSmall" style="margin-top:6px;">id: <code>${id}</code></div>`) : '';
      return `<div style="${wrapStyle}">${head}${body}${foot}</div>`;
    }).join('') || '<div class="muted">No messages yet.</div>';
  }

  async function refreshChat(){
    try {
      const res = await fetch('/api/messages?limit=80', { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      renderChat(j.messages || []);
      scrollChatBottom();
      setChatMsg('');
    } catch (e) {
      setChatMsg('Chat load failed: ' + String(e));
    }
  }

  async function sendChat(){
    const text = String(chatInput && chatInput.value || '');
    if (!text.trim()) return;
    if (chatSend) chatSend.disabled = true;
    setChatMsg('Sending…');
    try {
      const res = await fetch('/api/message', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        cache:'no-store',
        body: JSON.stringify({ text })
      });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      if (chatInput) chatInput.value = '';
      await refreshChat();
      await refreshWorklog();
    } catch (e) {
      setChatMsg('Send failed: ' + String(e));
    } finally {
      if (chatSend) chatSend.disabled = false;
      setTimeout(() => setChatMsg(''), 900);
    }
  }

  if (chatSend) chatSend.addEventListener('click', sendChat);
  if (chatJump) chatJump.addEventListener('click', scrollChatBottom);
  // Enter-to-send in ClawdCode chat column. Shift+Enter inserts newline.
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChat();
      }
    });
  }

  // --- Worklog ---
  const wlIn = new Set();
  const wlOut = new Set();

  function classifyWorklog(e) {
    const ev = String(e && e.event ? e.event : '');
    if (/error|fail|exception/i.test(ev)) return 'errors';
    if (ev.startsWith('gateway.')) return 'gateway';
    if (ev.startsWith('ws.')) return 'ws';
    if (ev.startsWith('message.')) return 'messages';
    if (ev.startsWith('upload.')) return 'uploads';
    if (ev.startsWith('de') || ev.includes('del') || ev.includes('dynamic')) return 'de';
    return 'other';
  }

  function renderWorklog(entries) {
    if (!worklogEl) return;
    worklogEl.innerHTML = '';
    const sorted = (entries || []).slice().reverse();
    for (const e of sorted) {
      const bucket = classifyWorklog(e);
      if (wlIn.size && !wlIn.has(bucket)) continue;
      if (wlOut.has(bucket)) continue;
      const line = document.createElement('div');
      line.style.padding = '6px 4px';
      line.style.borderBottom = '1px solid rgba(255,255,255,0.08)';
      line.innerHTML = '<span class="muted">' + esc(e.ts) + '</span> ' + esc(e.event) + (e.data ? (' <span class="muted">' + esc(JSON.stringify(e.data)) + '</span>') : '');
      worklogEl.appendChild(line);
    }
  }

  let worklogCache = [];
  async function refreshWorklog(){
    try {
      const res = await fetch('/api/worklog?limit=300', { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (res.ok && j && j.ok) {
        worklogCache = j.entries || [];
        renderWorklog(worklogCache);
        setWlMsg('');
      }
    } catch (e) {
      setWlMsg('Worklog failed: ' + String(e));
    }
  }

  // filters are currently hidden/removed in ClawdCode to save space; keep logic here for later.
  for (const b of wlFilterBtns) {
    b.style.display = 'none';
  }
  if (wlRecentBtn && worklogEl) wlRecentBtn.addEventListener('click', () => { worklogEl.scrollTop = 0; });

  // --- Dynamic Execution (ClawdList) ---
  let deState = { lists: [], activeIndex: -1 };
  let deActive = null;
  let deCompletedIndex = 0;
  let deBrowseCompleted = false;

  function renderOneList(de, isActive, labelRight = ''){
    const box = document.createElement('div');
    box.style.border = '1px solid rgba(255,255,255,0.10)';
    box.style.borderRadius = '12px';
    box.style.padding = '10px';
    box.style.marginTop = '10px';
    box.style.background = 'rgba(0,0,0,0.10)';

    const titleRow = document.createElement('div');
    titleRow.className = 'muted';
    titleRow.style.display = 'flex';
    titleRow.style.justifyContent = 'space-between';
    titleRow.style.gap = '10px';

    const left = document.createElement('span');
    left.textContent = de.createdAt || '';
    const right = document.createElement('span');
    right.textContent = labelRight || (isActive ? 'ACTIVE' : '');
    titleRow.appendChild(left);
    titleRow.appendChild(right);
    box.appendChild(titleRow);

    const allDone = !!de.completed || (de.items && de.items.every(it => it.done));
    if (!allDone) {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.justifyContent = 'space-between';
      row.style.marginTop = '10px';

      const mark = document.createElement('button');
      mark.textContent = 'Mark All Complete';
      mark.className = 'pill';
      mark.addEventListener('click', async () => {
        await fetch('/api/de/mark-all', {
          method:'POST',
          credentials:'include',
          headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ listId: de.id }),
          cache:'no-store'
        });
        refreshDE();
      });

      const del = document.createElement('button');
      del.textContent = 'Del';
      del.className = 'pill';
      del.style.color = '#ff8c8c';
      del.addEventListener('click', async () => {
        await fetch('/api/de/delete', {
          method:'POST',
          credentials:'include',
          headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ listId: de.id }),
          cache:'no-store'
        });
        refreshDE();
      });

      row.appendChild(mark);
      row.appendChild(del);
      box.appendChild(row);
    }

    for (let i = 0; i < de.items.length; i++) {
      const it = de.items[i];
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '10px';
      row.style.alignItems = 'center';
      row.style.padding = '6px 2px';
      row.style.borderBottom = '1px solid rgba(255,255,255,0.06)';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!it.done;
      cb.addEventListener('change', async () => {
        await fetch('/api/de/toggle', {
          method:'POST',
          credentials:'include',
          headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ listId: de.id, idx: i, done: cb.checked }),
          cache:'no-store'
        });
        refreshDE();
      });

      const label = document.createElement('div');
      label.style.flex = '1';
      label.style.whiteSpace = 'pre-wrap';
      label.style.wordBreak = 'break-word';
      const listComplete = !!de.completed || de.items.every(x => x.done);
      if (listComplete && cb.checked) {
        const pre = document.createElement('span');
        pre.textContent = 'Complete. ';
        pre.style.color = '#c26a1a';
        pre.style.fontWeight = '700';
        label.appendChild(pre);
        label.appendChild(document.createTextNode(it.text || ''));
      } else {
        label.textContent = it.text || '';
        if (cb.checked) label.style.textDecoration = 'line-through';
      }

      const delx = document.createElement('button');
      delx.textContent = '✕';
      delx.className = 'pill';
      delx.style.padding = '2px 8px';
      delx.style.color = '#ff8c8c';
      delx.title = 'Delete item';
      delx.addEventListener('click', async () => {
        await fetch('/api/de/item/delete', {
          method:'POST',
          credentials:'include',
          headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ listId: de.id, idx: i }),
          cache:'no-store'
        });
        refreshDE();
      });

      row.appendChild(cb);
      row.appendChild(label);
      row.appendChild(delx);
      box.appendChild(row);
    }

    return box;
  }

  function renderDE(){
    if (!deListsEl || !deStatusEl) return;
    deListsEl.innerHTML = '';

    const lists = Array.isArray(deState.lists) ? deState.lists : [];
    const active = deActive;

    if (!lists.length || !active) {
      deStatusEl.textContent = 'Idle';
      deListsEl.innerHTML = '<div class="muted">No checklists yet.</div>';
      return;
    }

    const allDone = !!active.completed || active.items.every(it => it.done);

    let label = 'Idle';
    if (allDone) label = 'Complete';
    else {
      const createdAtMs = Date.parse(active.createdAt || '') || 0;
      const ageMs = createdAtMs ? (Date.now() - createdAtMs) : 999999;
      label = (ageMs >= 0 && ageMs < 2500) ? 'Active' : 'In Progress';
    }

    deStatusEl.textContent = label;

    const activeId = active.id;
    const newestFirst = lists.slice().reverse();

    const incomplete = newestFirst.filter(l => !l.completed && l.items && l.items.some(it => !it.done));
    const completed = newestFirst.filter(l => !!l.completed || (l.items && l.items.every(it => it.done)));

    for (const l of incomplete) {
      deListsEl.appendChild(renderOneList(l, l.id === activeId, (l.id === activeId) ? 'ACTIVE' : 'PENDING'));
    }

    if (deBrowseCompleted && completed.length) {
      const idx = Math.max(0, Math.min(completed.length - 1, deCompletedIndex));
      const l = completed[idx];
      deListsEl.appendChild(renderOneList(l, false, `COMPLETED (${idx + 1}/${completed.length})`));
    }
  }

  async function refreshDE(){
    try {
      const res = await fetch('/api/de', { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (j && j.ok) {
        deState = j.state || { lists: [], activeIndex: -1 };
        deActive = j.active || null;
        deCompletedIndex = 0;
        deBrowseCompleted = false;
        renderDE();
      }
    } catch {}
  }

  if (dePrevBtn) dePrevBtn.addEventListener('click', () => {
    deBrowseCompleted = true;
    deCompletedIndex = Math.min(deCompletedIndex + 1, 9999);
    renderDE();
  });
  if (deNextBtn) deNextBtn.addEventListener('click', () => {
    deBrowseCompleted = true;
    deCompletedIndex = Math.max(deCompletedIndex - 1, 0);
    renderDE();
  });

  async function refreshOperator(){
    setWlMsg('Refreshing…');
    await Promise.allSettled([refreshDE(), refreshWorklog()]);
    setTimeout(() => setWlMsg(''), 600);
  }

  if (opRefresh) opRefresh.addEventListener('click', refreshOperator);

  // operator expand (worklog vs list)
  if (opWorkExpand && ideEl) {
    opWorkExpand.style.display = 'none';
    opWorkExpand.addEventListener('click', () => {
      ideEl.classList.toggle('work-expanded');
    });
  }

  // ClawdWork collapse/expand (hide worklog messages but keep buttons + thinking)
  if (wlToggle && ideEl) {
    wlToggle.addEventListener('click', () => {
      const hidden = ideEl.classList.toggle('work-hide');
      wlToggle.textContent = hidden ? '▸' : '▾';
      try { localStorage.setItem('cc_code_work_hide', hidden ? '1' : '0'); } catch {}
    });

    try {
      const st = localStorage.getItem('cc_code_work_hide');
      if (st === '1') {
        ideEl.classList.add('work-hide');
        wlToggle.textContent = '▸';
      }
    } catch {}
  }

  // Stop/Add + thinking light for the operator rail
  async function refreshThinking(){
    if (!wlThinking) return;
    try {
      const res = await fetch('/api/status', { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) return;
      wlThinking.textContent = j.inFlight ? 'Thinking…' : 'Idle';
    } catch {}
  }

  if (wlStop) {
    wlStop.addEventListener('click', async () => {
      if (wlThinking) wlThinking.textContent = 'Stopping…';
      try { await fetch('/api/abort', { method:'POST', credentials:'include', cache:'no-store' }); } catch {}
      await refreshThinking();
      if (wlThinking) wlThinking.textContent = 'Idle';
    });
  }

  if (wlAdd) {
    wlAdd.addEventListener('click', async () => {
      try { await fetch('/api/abort', { method:'POST', credentials:'include', cache:'no-store' }); } catch {}
      if (chatInput) {
        const prefix = 'ADD CONTEXT (incorporate into the previous request):\n';
        if (!chatInput.value.startsWith(prefix)) chatInput.value = prefix + chatInput.value;
        chatInput.focus();
      }
      await refreshThinking();
    });
  }

  // workspaces selector (header or panel)
  const wsSelAny = getWsSelect();
  if (wsSelAny) {
    wsSelAny.addEventListener('change', () => setWorkspace(wsSelAny.value));
  }

  async function refreshGitUI(){
    if (!hdrGitSel) return;
    try {
      const res = await fetch('/api/code/workspaces', { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) return;
      const cur = String(j.current || '');
      const w = (j.workspaces || []).find(x => x && String(x.id) === cur);
      const remote = w && w.git && w.git.remote ? String(w.git.remote) : '';
      hdrGitSel.innerHTML = '<option value="">None</option>' + (remote ? ('<option value="' + esc(remote) + '">' + esc(remote) + '</option>') : '');
      hdrGitSel.value = remote ? remote : '';
    } catch {}
  }

  async function createWorkspace(){
    const title = prompt('New workspace name:');
    if (!title) return;
    setMsg('Creating workspace…');
    try {
      const res = await fetch('/api/code/workspace/create', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        cache:'no-store',
        body: JSON.stringify({ title })
      });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error(j && j.error ? j.error : ('http ' + res.status));
      await loadWorkspaces();
      await loadDir('');
      await refreshGitUI();
      setMsg('');
    } catch (e) {
      setMsg('Create failed: ' + String(e));
    }
  }

  async function connectGit(){
    const remoteUrl = prompt('GitHub repo URL (https://github.com/org/repo or git@github.com:org/repo.git):');
    if (!remoteUrl) return;
    const branch = prompt('Branch (optional):') || '';
    setMsg('Connecting git…');
    try {
      const resWs = await fetch('/api/code/workspaces', { credentials:'include', cache:'no-store' });
      const jWs = await resWs.json();
      const wsId = (jWs && jWs.ok) ? String(jWs.current || '') : '';
      const res = await fetch('/api/code/git/connect', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        cache:'no-store',
        body: JSON.stringify({ workspaceId: wsId, remoteUrl, branch })
      });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error(j && j.error ? j.error : ('http ' + res.status));
      await refreshGitUI();
      await loadDir('');
      setMsg('Git connected.');
      setTimeout(() => setMsg(''), 900);
    } catch (e) {
      setMsg('Git connect failed: ' + String(e));
    }
  }

  async function disconnectGit(){
    setMsg('Disconnecting git…');
    try {
      const resWs = await fetch('/api/code/workspaces', { credentials:'include', cache:'no-store' });
      const jWs = await resWs.json();
      const wsId = (jWs && jWs.ok) ? String(jWs.current || '') : '';
      const res = await fetch('/api/code/git/disconnect', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        cache:'no-store',
        body: JSON.stringify({ workspaceId: wsId })
      });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error(j && j.error ? j.error : ('http ' + res.status));
      await refreshGitUI();
      setMsg('Git disconnected.');
      setTimeout(() => setMsg(''), 900);
    } catch (e) {
      setMsg('Disconnect failed: ' + String(e));
    }
  }

  // --- boot ---
  loadWorkspaces().then(async () => { await loadDir(''); await refreshGitUI(); });
  if (hdrWsAdd) hdrWsAdd.addEventListener('click', createWorkspace);
  if (hdrGitConnect) hdrGitConnect.addEventListener('click', connectGit);
  if (hdrGitDisc) hdrGitDisc.addEventListener('click', disconnectGit);

  refreshChat();
  refreshOperator();

  // light polling (keeps side panels fresh without WS wiring)
  setInterval(() => {
    refreshChat();
    refreshOperator();
    refreshThinking();
  }, 8000);
})();
