// ClawdPM client (CSP-safe: external script)
(() => {
  const pmJsStatus = document.getElementById('pm_js_status');
  const setPmStatus = (t) => { try { if (pmJsStatus) pmJsStatus.textContent = 'JS: ' + String(t || ''); } catch {} };

  const buildMeta = document.querySelector('meta[name="clawd-build"]');
  const build = buildMeta ? String(buildMeta.getAttribute('content') || '') : '';

  window.addEventListener('error', (e) => setPmStatus('ERROR ' + (e && e.message ? e.message : 'unknown')));
  window.addEventListener('unhandledrejection', (e) => setPmStatus('REJECT ' + String(e && e.reason ? e.reason : e)));
  setPmStatus('running' + (build ? (' (build ' + build + ')') : ''));

  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rand = () => (window.crypto && window.crypto.randomUUID)
    ? window.crypto.randomUUID()
    : ('c_' + Math.random().toString(16).slice(2) + Date.now().toString(16));

  function bootPM(){
    try {
      const el = document.getElementById('pm_boot');
      if (!el) return { columns: [] };
      const j = JSON.parse(el.textContent || '{}');
      if (!j || typeof j !== 'object') return { columns: [] };
      if (!Array.isArray(j.columns)) j.columns = [];
      return j;
    } catch {
      return { columns: [] };
    }
  }

  let PM = bootPM();
  let ACTIVE = null; // { colId, cardId }

  const $ = (id) => document.getElementById(id);
  const modal = $('cardModal');
  const cmClose = $('cm_close');
  const cmSave = $('cm_save');
  const cmDone = $('cm_done');
  const cmTrash = $('cm_trash');
  const cmGen = $('cm_generate');
  const cmAdd = $('cm_addtodo');
  const cmTodos = $('cm_todos');
  const cmMsg = $('cm_msg');
  const cmMoveTo = $('cm_move_to');
  const cmMoveUp = $('cm_moveup');
  const cmMoveDn = $('cm_movedn');
  const cmQReply = $('cm_qreply');
  const cmSendConsole = $('cm_send_console');

  const cmInDesc = $('cm_in_desc');
  const cmInContent = $('cm_in_content');

  function priClass(p){
    const v = String(p || 'planning').toLowerCase();
    if (v === 'ultra') return 'pri-ultra';
    if (v === 'high') return 'pri-high';
    if (v === 'normal') return 'pri-normal';
    return 'pri-planning';
  }

  function findCard(){
    if (!ACTIVE || !PM) return null;
    const col = (PM.columns || []).find((c) => c && c.id === ACTIVE.colId);
    if (!col) return null;
    const card = (col.cards || []).find((c) => c && c.id === ACTIVE.cardId);
    if (!card) return null;
    return { col, card };
  }

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
    setPmStatus('click ' + String(colId||'') + ' / ' + String(cardId||''));
    ACTIVE = { colId, cardId };
    const fc = findCard();
    if (!fc) { setPmStatus('click: card not found in model'); return; }
    const card = fc.card;

    if (!card.desc && card.body) card.desc = card.body;
    if (!card.content) card.content = '';

    $('cm_title').textContent = card.title || 'Card';
    $('cm_in_title').value = card.title || '';
    $('cm_in_desc').value = card.desc || '';
    $('cm_in_content').value = card.content || '';
    $('cm_in_pri').value = String(card.priority || 'normal');

    const qtxt = String(card.queuedCompletionReply || '').trim();
    if (cmQReply) cmQReply.textContent = qtxt || '(none yet)';

    fillMoveTo();
    renderTodos();
    if (cmMsg) cmMsg.textContent = '';
    if (modal) { modal.classList.add('open'); modal.style.display = 'flex'; }
  }

  function closeModal(){
    if (modal) { modal.classList.remove('open'); modal.style.display = 'none'; }
    ACTIVE = null;
  }

  function ensureTodos(card){
    if (!Array.isArray(card.todos)) card.todos = [];
    card.todos = card.todos.map((t) => ({
      id: t.id || rand(),
      text: String(t.text || '').trim(),
      done: !!t.done,
    })).filter((t) => t.text);
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

      function miniBtn(label, title, fn){
        const b = document.createElement('button');
        b.className = 'mini';
        b.type = 'button';
        b.textContent = label;
        b.title = title;
        b.addEventListener('click', fn);
        return b;
      }

      btns.appendChild(miniBtn('↑', 'Move up', () => {
        if (i <= 0) return;
        const tmp = card.todos[i-1];
        card.todos[i-1] = card.todos[i];
        card.todos[i] = tmp;
        renderTodos();
      }));
      btns.appendChild(miniBtn('↓', 'Move down', () => {
        if (i >= card.todos.length - 1) return;
        const tmp = card.todos[i+1];
        card.todos[i+1] = card.todos[i];
        card.todos[i] = tmp;
        renderTodos();
      }));
      btns.appendChild(miniBtn('✕', 'Delete', () => {
        card.todos.splice(i, 1);
        renderTodos();
      }));

      row.appendChild(cb);
      row.appendChild(inp);
      row.appendChild(btns);
      cmTodos.appendChild(row);
    });
  }

  async function persist(){
    await fetch('/api/pm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ pm: PM }),
    });
  }

  function ensureDoneColumn(){
    PM.columns = Array.isArray(PM.columns) ? PM.columns : [];
    let done = PM.columns.find(c => c && String(c.id||'') === 'done')
      || PM.columns.find(c => c && String(c.title||'').toLowerCase() === 'done');
    if (!done) {
      done = { id:'done', title:'Done', cards: [] };
      PM.columns.push(done);
    }
    done.cards = Array.isArray(done.cards) ? done.cards : [];
    return done;
  }

  async function deleteCard(){
    const fc = findCard();
    if (!fc) return;
    const { col, card } = fc;

    const title = String(card.title || card.id || 'this card');
    const ok = confirm('Delete card "' + title + '"? This cannot be undone.');
    if (!ok) return;

    col.cards = Array.isArray(col.cards) ? col.cards : [];
    col.cards = col.cards.filter(x => x && x.id !== card.id);

    await persist();
    render();
    closeModal();
    setPmStatus('deleted card');
  }

  async function markDoneArchive(){
    const fc = findCard();
    if (!fc) return;
    const { col, card } = fc;

    card.completedAt = new Date().toISOString();
    card.queueStatus = 'done';

    const doneCol = ensureDoneColumn();
    col.cards = Array.isArray(col.cards) ? col.cards : [];
    doneCol.cards = Array.isArray(doneCol.cards) ? doneCol.cards : [];

    col.cards = col.cards.filter(x => x && x.id !== card.id);
    doneCol.cards.push(card);

    ACTIVE.colId = doneCol.id;
    await persist();
    render();
    closeModal();
    setPmStatus('archived to Done');
  }

  async function saveCardEdits(){
    const fc = findCard();
    if (!fc) return;
    const { col, card } = fc;

    card.title = ($('cm_in_title').value || '').trim();
    card.desc = (cmInDesc ? cmInDesc.value : '').trim();
    card.content = (cmInContent ? cmInContent.value : '').trim();
    card.body = card.desc; // legacy
    card.priority = $('cm_in_pri').value;

    const targetColId = cmMoveTo ? String(cmMoveTo.value||'') : '';
    if (targetColId && targetColId !== col.id) {
      const to = (PM.columns || []).find(c => c && c.id === targetColId);
      if (to) {
        col.cards = Array.isArray(col.cards) ? col.cards : [];
        to.cards = Array.isArray(to.cards) ? to.cards : [];
        col.cards = col.cards.filter(x => x && x.id !== card.id);
        to.cards.push(card);
        ACTIVE.colId = to.id;
      }
    }

    await persist();
    render();
    if (cmMsg) cmMsg.textContent = 'Saved.';
    setTimeout(() => { if (cmMsg) cmMsg.textContent = ''; }, 900);
  }

  async function generateTodos(){
    const fc = findCard();
    if (!fc) return;
    const card = fc.card;
    ensureTodos(card);
    if (cmMsg) cmMsg.textContent = 'Generating…';
    try {
      const res = await fetch('/api/pm/generate-todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ title: card.title, body: (card.content || card.body || '') }),
      });
      const j = await res.json();
      const items = (j && j.ok && Array.isArray(j.todos)) ? j.todos : [];
      const seen = new Set(card.todos.map(t => t.text));
      for (const it of items) {
        if (!it || !it.text) continue;
        if (seen.has(it.text)) continue;
        card.todos.push({ id: rand(), text: it.text, done: false });
        seen.add(it.text);
      }
      renderTodos();
      if (cmMsg) cmMsg.textContent = 'Generated.';
    } catch (e) {
      if (cmMsg) cmMsg.textContent = 'Generate failed: ' + String(e);
    }
  }

  function addTodo(){
    const fc = findCard();
    if (!fc) return;
    const card = fc.card;
    ensureTodos(card);
    card.todos.push({ id: rand(), text: 'New item', done: false });
    renderTodos();
  }

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
    fillMoveTo();
    renderTodos();
    render();
  }

  async function addCard(colId){
    const title = (prompt('Card title') || '').trim();
    if (!title) return;
    const desc = (prompt('Description (optional)') || '').trim();
    const p = (prompt('Priority: ultra / high / normal / planning', 'normal') || 'normal').trim().toLowerCase();
    const priority = (['ultra','high','normal','planning'].includes(p)) ? p : 'normal';

    const col = (PM && PM.columns || []).find(c => c && c.id === colId);
    if (!col) return;
    col.cards = Array.isArray(col.cards) ? col.cards : [];
    col.cards.push({ id: rand(), title, desc, content:'', body: desc, priority, createdAt: new Date().toISOString(), todos: [] });
    await persist();
    render();
  }

  function slug(s){
    return String(s||'').trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  }

  async function addColumn(){
    const name = (prompt('Column name', 'New Column') || '').trim();
    if (!name) return;

    PM.columns = Array.isArray(PM.columns) ? PM.columns : [];
    const base = slug(name) || 'col';
    let id = base;
    let n = 2;
    while (PM.columns.some(c => c && String(c.id||'') === id)) {
      id = base + '-' + String(n++);
    }

    PM.columns.push({ id, title: name, cards: [] });
    await persist();
    render();
    alignMenuToLastColumn();
  }

  async function moveColumn(colId, dir){
    const cols = (PM && PM.columns) ? PM.columns : [];
    const i = cols.findIndex(c => c && c.id === colId);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= cols.length) return;
    const tmp = cols[j];
    cols[j] = cols[i];
    cols[i] = tmp;
    await persist();
    render();
  }

  async function renameColumn(colId){
    const cols = (PM && PM.columns) ? PM.columns : [];
    const col = cols.find(c => c && c.id === colId);
    if (!col) return;
    const name = (prompt('Column name', col.title || '') || '').trim();
    if (!name) return;
    col.title = name;
    await persist();
    render();
  }

  async function deleteColumn(colId){
    const cols = (PM && PM.columns) ? PM.columns : [];
    const i = cols.findIndex(c => c && c.id === colId);
    if (i < 0) return;
    const col = cols[i];
    const n = Array.isArray(col.cards) ? col.cards.length : 0;

    const name = String(col.title || col.id || 'this column');
    const ok = confirm('Delete column "' + name + '" and all ' + n + ' card(s)? This cannot be undone.');
    if (!ok) return;

    cols.splice(i, 1);
    await persist();
    render();
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
    await persist();
    render();
  }

  function render(){
    const pm = PM || { columns: [] };
    const host = document.getElementById('pmBoard');
    if (!host) return;
    host.innerHTML = '';

    const colsArr = (pm.columns || []);
    for (let colIdx = 0; colIdx < colsArr.length; colIdx++){
      const col = colsArr[colIdx];
      const el = document.createElement('div');
      el.className = 'col';

      const cards = Array.isArray(col.cards) ? col.cards : [];

      const cardsHtml = cards.map((c) => {
        const q = (c.queueStatus || (c.completedAt ? 'done' : (c.queuedAt ? 'queued' : '')));
        const qBadge = q ? ('<span class="badge" style="margin-left:6px;">' + esc(q === 'done' ? '✓ done' : (q === 'queued' ? '⏳ queued' : q)) + '</span>') : '';
        const badge = '<span class="badge">' + esc(String(c.priority || 'planning')) + '</span>' + qBadge;
        const desc = (c.desc || c.body || '');
        const short = String(desc).length > 110 ? (String(desc).slice(0, 110) + '…') : String(desc);

        const btns = '<div class="cardBtns">'
          + '<button type="button" data-cup="' + esc(col.id) + '" data-cid="' + esc(c.id) + '" title="Move up">↑</button>'
          + '<button type="button" data-cdn="' + esc(col.id) + '" data-cid="' + esc(c.id) + '" title="Move down">↓</button>'
          + '</div>';

        return '<div class="card ' + priClass(c.priority) + '" data-card-id="' + esc(c.id) + '" data-col-id="' + esc(col.id) + '">' 
          + '<div class="cardRow">'
          +   '<b>' + esc(c.title) + '</b>'
          +   btns
          + '</div>'
          + (short ? ('<p>' + esc(short) + '</p>') : '')
          + badge
          + '</div>';
      }).join('');

      const addColFooter = (colIdx === colsArr.length - 1) ? (
        '<div class="colFooter" style="margin-top:10px; padding:10px; border:1px dashed rgba(255,255,255,0.14); border-radius:14px; background: rgba(255,255,255,0.02); display:flex; justify-content:center;">'
        + '<button class="addBtn" type="button" data-addcol="1">+ Column</button>'
        + '</div>'
      ) : '';

      el.innerHTML = ''
        + '<div class="colHead">'
        +   '<b>' + esc(col.title) + '</b>'
        +   '<div class="colActions">'
        +     '<button class="mini2" type="button" data-col-left="' + esc(col.id) + '" title="Move column left">◀</button>'
        +     '<button class="mini2" type="button" data-col-right="' + esc(col.id) + '" title="Move column right">▶</button>'
        +     '<button class="mini2" type="button" data-col-rename="' + esc(col.id) + '" title="Rename column">✎</button>'
        +     '<button class="mini2 miniDanger" type="button" data-col-trash="' + esc(col.id) + '" title="Delete column">🗑</button>'
        +     '<span class="muted small">' + cards.length + '</span>'
        +     '<button class="addBtn" type="button" data-add="' + esc(col.id) + '">+ Card</button>'
        +   '</div>'
        + '</div>'
        + '<div class="cards">' + cardsHtml + '</div>'
        + addColFooter;

      host.appendChild(el);
    }

    // column actions
    Array.from(document.querySelectorAll('button[data-col-left]')).forEach(b => {
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); moveColumn(b.getAttribute('data-col-left'), -1); });
    });
    Array.from(document.querySelectorAll('button[data-col-right]')).forEach(b => {
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); moveColumn(b.getAttribute('data-col-right'), +1); });
    });
    Array.from(document.querySelectorAll('button[data-col-rename]')).forEach(b => {
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); renameColumn(b.getAttribute('data-col-rename')); });
    });
    Array.from(document.querySelectorAll('button[data-col-trash]')).forEach(b => {
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); deleteColumn(b.getAttribute('data-col-trash')); });
    });
    Array.from(document.querySelectorAll('button[data-add]')).forEach(b => {
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); addCard(b.getAttribute('data-add')); });
    });
    Array.from(document.querySelectorAll('button[data-addcol]')).forEach(b => {
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); addColumn(); });
    });

    // card actions
    Array.from(document.querySelectorAll('button[data-cup]')).forEach(b => {
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); moveCardInline(b.getAttribute('data-cup'), b.getAttribute('data-cid'), -1); });
    });
    Array.from(document.querySelectorAll('button[data-cdn]')).forEach(b => {
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); moveCardInline(b.getAttribute('data-cdn'), b.getAttribute('data-cid'), +1); });
    });

    Array.from(document.querySelectorAll('.card[data-card-id]')).forEach((c) => {
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
        if (host) host.insertAdjacentHTML('afterbegin', '<div class="muted" style="margin-bottom:8px;">Could not load board (' + res.status + ').</div>');
        return;
      }
      const j = await res.json();
      PM = (j && j.ok && j.pm) ? j.pm : { columns: [] };
      render();
    } catch {
      // ignore
    }
  }

  // Wire modal controls
  if (cmClose) cmClose.addEventListener('click', closeModal);
  if (modal) modal.addEventListener('click', (e) => { if (e.target && e.target.id === 'cardModal') closeModal(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  if (cmSave) cmSave.addEventListener('click', saveCardEdits);
  if (cmTrash) cmTrash.addEventListener('click', deleteCard);
  if (cmDone) cmDone.addEventListener('click', markDoneArchive);
  if (cmAdd) cmAdd.addEventListener('click', addTodo);
  if (cmGen) cmGen.addEventListener('click', generateTodos);
  if (cmMoveUp) cmMoveUp.addEventListener('click', () => moveCard(-1));
  if (cmMoveDn) cmMoveDn.addEventListener('click', () => moveCard(+1));

  if (cmSendConsole) cmSendConsole.addEventListener('click', async () => {
    const fc = findCard();
    if (!fc) return;
    const card = fc.card;
    const id = String(card.id || '');
    const title = String(card.title || '');
    const reply = String(card.queuedCompletionReply || '').trim();
    const msg = [
      'FOLLOW-UP REQUEST (from PM)',
      'Card: ' + title,
      'Card ID: ' + id,
      '',
      'Queued Completion Reply:',
      reply || '(none)',
    ].join('\n');
    try {
      await fetch('/api/message', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({ text: msg, attachments: [] }) });
    } catch {}
  });

  function alignMenuToLastColumn(){
    try {
      const menuWrap = document.getElementById('pmMenuWrap');
      const wrap = document.querySelector('.wrap');
      const boardWrap = document.getElementById('pmBoardWrap');
      const cols = Array.from(document.querySelectorAll('.col'));
      if (!menuWrap || !wrap || !boardWrap || !cols.length) return;

      const wrapRect = wrap.getBoundingClientRect();
      const menuRect = menuWrap.getBoundingClientRect();
      const lastCol = cols[cols.length - 1];
      const lastRect = lastCol.getBoundingClientRect();

      // If last column is visible in viewport, align to its right edge; otherwise align to wrap/page edge.
      const viewportRight = window.innerWidth;
      const onScreen = lastRect.left < viewportRight && lastRect.right <= viewportRight;
      const targetRight = onScreen ? lastRect.right : wrapRect.right;

      // Pull the menu left so its right edge aligns to the last visible column's right edge.
      const delta = Math.max(0, Math.floor(wrapRect.right - targetRight));
      menuWrap.style.marginRight = delta ? (delta + 'px') : '0px';
      menuWrap.style.maxWidth = '';
    } catch {}
  }

  // Initial render from boot model; then refresh in background
  try { render(); setPmStatus('rendered (boot model)'); } catch { setPmStatus('render failed'); }

  const btn = document.getElementById('pmRefresh');
  if (btn) btn.addEventListener('click', () => { load(); });

  // + Column button is rendered inline under the last column.

  load();
})();
