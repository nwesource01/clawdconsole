// Clawd Console frontend
(() => {
  // BUILD is served by the backend so we have a single source of truth.
  let BUILD = 'unknown';

  const out = document.getElementById('out');
  const chatlog = document.getElementById('chatlog');
  const ta = document.getElementById('msg');
  const preview = document.getElementById('preview');
  const statusEl = document.getElementById('status');
  const debugEl = document.getElementById('debug');
  const worklogEl = document.getElementById('worklog');
  const thinkingEl = document.getElementById('thinking');
  const schedHeader = document.getElementById('schedHeader');
  const schedToggle = document.getElementById('schedToggle');
  const schedBody = document.getElementById('schedBody');
  const schedTitleSuffix = document.getElementById('schedTitleSuffix');
  const schedTabJobs = document.getElementById('schedTabJobs');
  const schedTabEmail = document.getElementById('schedTabEmail');
  const schedTabDocs = document.getElementById('schedTabDocs');

  function dbg(s) {
    if (debugEl) debugEl.textContent = s || '';
  }

  async function loadBuild() {
    try {
      const res = await fetch(apiUrl('/api/build'), { credentials: 'include', cache: 'no-store' });
      const j = await res.json();
      if (j && j.ok && j.build) BUILD = j.build;
    } catch {}
    // Prove JS is running
    if (statusEl) statusEl.textContent = 'JS loaded (' + BUILD + ')…';
    dbg('');
    console.log('Clawd Console JS loaded:', BUILD);
  }

  let pendingAttachments = [];

  function esc(s) {
    return (s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // NOTE: there is also an esc() in the DEL section below; keep behavior consistent.

  function linkify(escapedText) {
    // escapedText must already be HTML-escaped.
    const urlRe = /(https?:\/\/[^\s<]+[^<.,;:!?)\]\s])/g;
    return String(escapedText || '').replace(urlRe, (u) => {
      return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>';
    });
  }

  function apiUrl(p) {
    return new URL(p, window.location.origin).toString();
  }

  function setThinking(s) {
    if (!thinkingEl) return;
    thinkingEl.textContent = s;
    const isThinking = /^thinking/i.test(String(s || ''));
    thinkingEl.classList.toggle('is-thinking', isThinking);
  }

  // --- ClawdApps tabs (sidebar) ---
  const tabPM = document.getElementById('tabPM');
  const tabRepo = document.getElementById('tabRepo');
  const tabPub = document.getElementById('tabPub');
  const tabBuild = document.getElementById('tabBuild');

  const panelPM = document.getElementById('panelPM');
  const panelRepo = document.getElementById('panelRepo');
  const panelPub = document.getElementById('panelPub');
  const panelBuild = document.getElementById('panelBuild');

  const repoList = document.getElementById('repoList');
  const repoRefresh = document.getElementById('repoRefresh');

  function setAppTab(which){
    const map = [
      { k: 'pm', tab: tabPM, panel: panelPM },
      { k: 'repo', tab: tabRepo, panel: panelRepo },
      { k: 'pub', tab: tabPub, panel: panelPub },
      { k: 'build', tab: tabBuild, panel: panelBuild },
    ];

    for (const t of map){
      const on = t.k === which;
      if (t.panel) t.panel.style.display = on ? 'flex' : 'none';
      if (t.tab) {
        t.tab.style.borderColor = on ? 'rgba(34,198,198,.55)' : 'rgba(231,231,231,0.12)';
        t.tab.style.color = on ? 'rgba(231,231,231,0.92)' : 'rgba(231,231,231,0.72)';
      }
    }
  }

  async function loadRepoCommits(){
    if (!repoList) return;
    repoList.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const res = await fetch(apiUrl('/api/repo/commits?limit=60'), { credentials: 'include', cache: 'no-store' });
      const j = await res.json();
      const commits = (j && j.ok && Array.isArray(j.commits)) ? j.commits : [];
      if (!commits.length) {
        repoList.innerHTML = '<div class="muted">No commits found.</div>';
        return;
      }

      repoList.innerHTML = commits.map(c => {
        const short = esc((c.hash || '').slice(0, 7));
        const msg = esc(c.subject || '');
        const when = esc(c.date || '');
        const ref = c.refs ? ('<span class="muted">(' + esc(c.refs) + ')</span>') : '';
        return '<div style="padding:8px 6px; border-bottom:1px solid rgba(255,255,255,0.08)">' +
          '<div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">' +
            '<div><code>' + short + '</code> ' + ref + '</div>' +
            '<div class="muted">' + when + '</div>' +
          '</div>' +
          '<div style="margin-top:6px;">' + msg + '</div>' +
        '</div>';
      }).join('');
    } catch (e) {
      repoList.innerHTML = '<div class="muted">Failed to load commits.</div>';
    }
  }

  if (tabPM) tabPM.addEventListener('click', () => setAppTab('pm'));
  if (tabRepo) tabRepo.addEventListener('click', () => { setAppTab('repo'); loadRepoCommits(); });
  if (tabPub) tabPub.addEventListener('click', () => setAppTab('pub'));
  if (tabBuild) tabBuild.addEventListener('click', () => setAppTab('build'));
  if (repoRefresh) repoRefresh.addEventListener('click', loadRepoCommits);

  // default
  setAppTab('pm');

  // --- Custom quick buttons (Add a Button) ---
  const btnAddBtn = document.getElementById('btnAddBtn');
  const abModal = document.getElementById('ab_modal');
  const abClose = document.getElementById('ab_close');
  const abCancel = document.getElementById('ab_cancel');
  const abForm = document.getElementById('ab_form');
  const abLabel = document.getElementById('ab_label');
  const abText = document.getElementById('ab_text');
  const abMsg = document.getElementById('ab_msg');

  const CUSTOM_BTNS_KEY = 'cc_custom_buttons_v1';

  function readCustomButtons(){
    try {
      const j = JSON.parse(localStorage.getItem(CUSTOM_BTNS_KEY) || '[]');
      return Array.isArray(j) ? j : [];
    } catch { return []; }
  }
  function writeCustomButtons(arr){
    try { localStorage.setItem(CUSTOM_BTNS_KEY, JSON.stringify(arr || [])); } catch {}
  }

  function openAddBtn(){
    if (!abModal) return;
    abModal.style.display = 'flex';
    abModal.classList.add('open');
    if (abMsg) abMsg.textContent = '';
    if (abLabel) abLabel.value = '';
    if (abText) abText.value = '';
    setTimeout(() => abLabel && abLabel.focus(), 50);
  }
  function closeAddBtn(){
    if (!abModal) return;
    abModal.classList.remove('open');
    abModal.style.display = 'none';
  }

  function renderCustomButtons(){
    const host = document.getElementById('quickButtons');
    if (!host) return;

    // remove previously-rendered custom
    Array.from(host.querySelectorAll('button[data-custombtn="1"]')).forEach(el => el.remove());

    const btns = readCustomButtons();
    // Insert after Review Week (before Add a Button)
    const anchor = document.getElementById('btnAddBtn');

    for (const b of btns){
      if (!b || !b.label || !b.text) continue;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'qbtn';
      el.setAttribute('data-custombtn', '1');
      el.textContent = String(b.label).slice(0, 32);
      el.addEventListener('click', () => {
        sendMessageWsOrHttp(String(b.text), []).then(refresh);
      });
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(el, anchor);
      else host.appendChild(el);
    }
  }

  if (btnAddBtn) btnAddBtn.addEventListener('click', openAddBtn);
  if (abClose) abClose.addEventListener('click', closeAddBtn);
  if (abCancel) abCancel.addEventListener('click', closeAddBtn);
  if (abModal) abModal.addEventListener('click', (e) => { if (e.target && e.target.id === 'ab_modal') closeAddBtn(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAddBtn(); });

  if (abForm) {
    abForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const label = (abLabel && abLabel.value || '').trim();
      const text = (abText && abText.value || '').trim();
      if (!label || !text) {
        if (abMsg) abMsg.textContent = 'Please fill out both fields.';
        return;
      }
      const btns = readCustomButtons();
      btns.push({ label, text, createdAt: new Date().toISOString() });
      writeCustomButtons(btns.slice(-20));
      renderCustomButtons();
      closeAddBtn();
    });
  }

  // initial render
  renderCustomButtons();

  // --- Worklog filters ---
  const wlFilterBtns = Array.from(document.querySelectorAll('.wlbtn[data-filter]'));
  const wlRecentBtn = document.getElementById('wlRecent');
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

    // latest at top
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

    // do not auto-scroll; user controls. "Recent" button jumps to top.
  }

  let worklogCache = [];

  async function refreshWorklog() {
    const res = await fetch(apiUrl('/api/worklog?limit=300'), { credentials: 'include', cache: 'no-store' });
    const txt = await res.text();
    let j;
    try { j = JSON.parse(txt); } catch { j = null; }
    if (res.ok && j && j.ok) {
      worklogCache = j.entries || [];
      renderWorklog(worklogCache);
    }
  }

  // --- Dynamic Execution UI ---
  const deListsEl = document.getElementById('deLists');
  const deStatusEl = document.getElementById('deStatus');
  const dePrevBtn = document.getElementById('dePrev');
  const deNextBtn = document.getElementById('deNext');
  // (footer mark-all removed; actions live on each card now)

  let deState = { lists: [], activeIndex: -1 };
  let deActive = null;
  let deCompletedIndex = 0; // browse completed lists (newest-first)
  let deBrowseCompleted = false;

  function esc(s) {
    return (s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function renderOneList(de, isActive, labelRight = '') {
    const box = document.createElement('div');
    box.style.border = '1px solid rgba(255,255,255,0.10)';
    box.style.borderRadius = '12px';
    box.style.padding = '10px';
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

    // Per-card actions row (incomplete lists)
    const allDone = !!de.completed || (de.items && de.items.every(it => it.done));
    if (!allDone) {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.justifyContent = 'space-between';
      row.style.marginTop = '10px';

      const mark = document.createElement('button');
      mark.textContent = 'Mark All Complete';
      mark.className = 'wlbtn';
      mark.addEventListener('click', async () => {
        await fetch(apiUrl('/api/de/mark-all'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ listId: de.id }),
          cache: 'no-store'
        });
        refreshDE();
      });

      const del = document.createElement('button');
      del.textContent = 'Del';
      del.className = 'wlbtn';
      del.style.color = '#ff8c8c';
      del.addEventListener('click', async () => {
        await fetch(apiUrl('/api/de/delete'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ listId: de.id }),
          cache: 'no-store'
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
      cb.disabled = false;
      cb.addEventListener('change', async () => {
        await fetch(apiUrl('/api/de/toggle'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ listId: de.id, idx: i, done: cb.checked }),
          cache: 'no-store'
        });
        refreshDE();
      });

      const label = document.createElement('div');
      label.style.flex = '1';
      label.style.whiteSpace = 'pre-wrap';

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

      // per-item delete (red x)
      const delx = document.createElement('button');
      delx.textContent = '✕';
      delx.className = 'wlbtn';
      delx.style.padding = '2px 8px';
      delx.style.color = '#ff8c8c';
      delx.title = 'Delete item';
      delx.addEventListener('click', async () => {
        await fetch(apiUrl('/api/de/item/delete'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ listId: de.id, idx: i }),
          cache: 'no-store'
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

  function renderDE() {
    if (!deListsEl || !deStatusEl) return;
    deListsEl.innerHTML = '';

    const lists = Array.isArray(deState.lists) ? deState.lists : [];
    const active = deActive;

    if (!lists.length || !active) {
      deStatusEl.textContent = 'Idle';
      deStatusEl.classList.remove('de-active');
      deListsEl.innerHTML = '<div class="muted">No checklists yet.</div>';
      return;
    }

    const allDone = !!active.completed || active.items.every(it => it.done);
    const isActive = !allDone;

    let label = 'Idle';
    if (allDone) {
      label = 'Complete';
    } else {
      // Show "Active" briefly right after the list is created (building moment),
      // then switch to "In Progress" once it’s visible/stable.
      const createdAtMs = Date.parse(active.createdAt || '') || 0;
      const ageMs = createdAtMs ? (Date.now() - createdAtMs) : 999999;
      label = (ageMs >= 0 && ageMs < 2500) ? 'Active' : 'In Progress';
    }

    deStatusEl.textContent = label;
    deStatusEl.classList.toggle('de-active', isActive);

    // Build buckets
    const activeId = active.id;
    const newestFirst = lists.slice().reverse();

    const incomplete = newestFirst.filter(l => !l.completed && l.items && l.items.some(it => !it.done));
    const completed = newestFirst.filter(l => !!l.completed || (l.items && l.items.every(it => it.done)));

    // 1) Show ALL incomplete lists, each as its own card (newest first).
    for (const l of incomplete) {
      deListsEl.appendChild(renderOneList(l, l.id === activeId, (l.id === activeId) ? 'ACTIVE' : 'PENDING'));
    }

    // 2) Optionally show one completed list for review (Prev/Next)
    if (deBrowseCompleted && completed.length) {
      const idx = Math.max(0, Math.min(completed.length - 1, deCompletedIndex));
      const l = completed[idx];
      const card = renderOneList(l, false, `COMPLETED (${idx + 1}/${completed.length})`);
      deListsEl.appendChild(card);
    }
  }

  async function refreshDE() {
    try {
      const res = await fetch(apiUrl('/api/de'), { credentials: 'include', cache: 'no-store' });
      const j = await res.json();
      if (j && j.ok) {
        deState = j.state || { lists: [], activeIndex: -1 };
        deActive = j.active || null;
        // reset browse index to newest completed and hide completed card until user browses
        deCompletedIndex = 0;
        deBrowseCompleted = false;
        renderDE();
      }
    } catch {}
  }

  if (dePrevBtn) dePrevBtn.addEventListener('click', () => {
    // browse completed lists (newest-first)
    deBrowseCompleted = true;
    deCompletedIndex = Math.min(deCompletedIndex + 1, 9999);
    renderDE();
  });

  if (deNextBtn) deNextBtn.addEventListener('click', () => {
    deBrowseCompleted = true;
    deCompletedIndex = Math.max(deCompletedIndex - 1, 0);
    renderDE();
  });

  // footer mark-all removed; actions are per-card

  // --- Scheduled UI ---
  let schedOpen = false;
  let schedTab = 'jobs';

  const RELIABILITY_NOTE = "Reliability note (no API keys): for this to work consistently we likely need an authenticated browser session + a stable procedure for the cron job to follow, or we switch to an OAuth/API integration later.";

  const schedInstructions = {
    jobs: {
      title: 'Scheduled Jobs',
      // Jobs tab is a two-column layout; content generated in render.
      instructions: ''
    },
    email: {
      title: 'Scheduled Email',
      instructions: 'Daily 07:15 UTC: check clawdia@nwesource.com for new emails since last check.'
    },
    docs: {
      title: 'Scheduled Docs',
      instructions: 'Daily 07:00 UTC: check Google Docs for any new @mentions/comments since last check.'
    }
  };

  function fmtIsoShort(iso) {
    try {
      return new Date(iso).toLocaleString(undefined, { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
    } catch { return iso || ''; }
  }

  function renderScheduled(entries) {
    if (!schedBody) return;

    const spec = schedInstructions[schedTab] || { title: 'Scheduled', instructions: '' };
    if (schedTitleSuffix) schedTitleSuffix.textContent = spec.title.replace(/^Scheduled\s*/, '');

    const kind = (schedTab === 'email') ? 'email' : (schedTab === 'docs' ? 'docs' : 'jobs');

    const filtered = (kind === 'jobs') ? [] : (entries || []).filter(e => e && e.kind === kind);
    const latest = filtered.length ? filtered[filtered.length - 1] : null;

    const report = latest ? String(latest.report || '').trim() : '';

    const latestLine = latest ? ('<div class="muted">Latest: ' + esc(latest.title || latest.kind) + ' • ' + esc(fmtIsoShort(latest.ts)) + '</div>') : '';

    const showReport = (kind !== 'jobs');

    if (kind === 'jobs') {
      // Two columns: Working List (left) + Verified Jobs (right)
      const left =
        '<div style="flex:1; min-width: 280px;">' +
          '<div style="font-weight:700;">Working List</div>' +
          '<div style="height:1px; background: rgba(255,255,255,0.10); margin:6px 0 10px 0;"></div>' +
          '<div style="white-space:pre-wrap;">' + esc('- Email (daily 07:15 UTC)\n- Docs @mentions (daily 07:00 UTC)\n\n' + RELIABILITY_NOTE) + '</div>' +
        '</div>';

      const divider = '<div style="width:1px; align-self:stretch; background: rgba(255,255,255,0.10);"></div>';

      const right =
        '<div style="flex:1; min-width: 280px;">' +
          '<div style="font-weight:700;">Verified Jobs</div>' +
          '<div style="height:1px; background: rgba(255,255,255,0.10); margin:6px 0 10px 0;"></div>' +
          '<div class="muted">(none yet)</div>' +
        '</div>';

      schedBody.innerHTML =
        '<div class="row" style="gap:14px; align-items:stretch;">' + left + divider + right + '</div>';
      return;
    }

    // Email/Docs tabs
    const ins = String(spec.instructions || '').trim();
    schedBody.innerHTML =
      latestLine +
      '<div style="margin-top:8px;">' +
        '<div class="muted">Instructions</div>' +
        '<div style="white-space:pre-wrap; margin-top:4px;">' + esc(ins) + '</div>' +
      '</div>' +
      (showReport ?
        ('<div style="margin-top:12px;">' +
          '<div class="muted">Report</div>' +
          '<div style="white-space:pre-wrap; margin-top:4px;">' + esc(report || '(empty)') + '</div>' +
        '</div>')
        :
        ''
      );
  }

  let scheduledCache = [];
  async function refreshScheduled() {
    try {
      const res = await fetch(apiUrl('/api/scheduled?limit=100'), { credentials: 'include', cache: 'no-store' });
      const j = await res.json();
      if (j && j.ok) {
        scheduledCache = j.entries || [];
        renderScheduled(scheduledCache);
      }
    } catch {}
  }

  function setSchedOpen(v) {
    schedOpen = !!v;
    if (schedBody) schedBody.style.display = schedOpen ? 'block' : 'none';
    if (schedToggle) schedToggle.textContent = schedOpen ? '▾' : '▸';
    if (schedOpen && schedTab !== 'jobs') {
      // keep current tab unless we were closed
    }
    if (schedOpen && !schedTab) schedTab = 'jobs';
  }

  function setSchedTab(k) {
    schedTab = k;
    // Clicking any tab opens the card.
    setSchedOpen(true);
    if (schedTabJobs) schedTabJobs.classList.toggle('on', k === 'jobs');
    if (schedTabEmail) schedTabEmail.classList.toggle('on', k === 'email');
    if (schedTabDocs) schedTabDocs.classList.toggle('on', k === 'docs');
    renderScheduled(scheduledCache);
  }

  function openAndDefaultJobs() {
    setSchedOpen(true);
    setSchedTab('jobs');
  }

  if (schedHeader) {
    schedHeader.addEventListener('click', (e) => {
      // allow buttons to handle themselves
      const t = e.target;
      if (t && (t.tagName === 'BUTTON')) return;
      const next = !schedOpen;
      setSchedOpen(next);
      if (next) setSchedTab('jobs');
    });
  }

  if (schedToggle) schedToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = !schedOpen;
    setSchedOpen(next);
    if (next) setSchedTab('jobs');
  });
  if (schedTabJobs) schedTabJobs.addEventListener('click', () => setSchedTab('jobs'));
  if (schedTabEmail) schedTabEmail.addEventListener('click', () => setSchedTab('email'));
  if (schedTabDocs) schedTabDocs.addEventListener('click', () => setSchedTab('docs'));
  setSchedOpen(false);
  schedTab = 'jobs';
  renderScheduled(scheduledCache);

  function renderPreview() {
    if (!preview) return;
    preview.innerHTML = '';
    for (const a of pendingAttachments) {
      const div = document.createElement('div');
      div.className = 'thumb';
      if (a.mime && a.mime.startsWith('image/')) {
        div.innerHTML = '<img src="' + a.url + '" alt="preview" />\n' +
          '<div class="muted">' + esc(a.filename) + '</div>';
      } else {
        div.innerHTML = '<div class="muted">Attached: <a href="' + a.url + '" target="_blank" rel="noopener">' +
          esc(a.filename) + '</a></div>';
      }
      preview.appendChild(div);
    }
  }

  const USER_NAME = 'Charles';
  const AGENT_NAME = 'Clawdio';

  function fmtTs(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    } catch {
      return iso || '';
    }
  }

  function isNearBottom(el) {
    if (!el) return true;
    const thresholdPx = 120;
    return (el.scrollHeight - (el.scrollTop + el.clientHeight)) < thresholdPx;
  }

  function renderMessages(msgs) {
    if (!chatlog) return;

    const stick = isNearBottom(chatlog);
    const prevTop = chatlog.scrollTop;

    chatlog.innerHTML = '';
    for (const m of msgs) {
      const isBot = typeof m.id === 'string' && m.id.startsWith('bot_');
      const name = isBot ? AGENT_NAME : USER_NAME;
      const nameClass = isBot ? 'name-agent' : 'name-user';

      const el = document.createElement('div');
      el.className = 'msg';
      const atts = (m.attachments || []).map(a => {
        const label = a.filename || a.url;
        return '<span class="chip">📎 <a href="' + a.url + '" target="_blank" rel="noopener">' + esc(label) + '</a></span>';
      }).join('');
      el.innerHTML =
        '<div class="meta">' +
          '<div><span class="' + nameClass + '">' + esc(name) + '</span></div>' +
          '<div class="muted">' + esc(fmtTs(m.ts)) + '</div>' +
        '</div>' +
        '<div class="txt">' + linkify(esc(m.text || '')) + '</div>' +
        '<div class="att">' + atts + '</div>';
      chatlog.appendChild(el);
    }

    // Only autoscroll if the user was already near the bottom.
    if (stick) chatlog.scrollTop = chatlog.scrollHeight;
    else chatlog.scrollTop = prevTop;
  }

  async function refresh() {
    const res = await fetch(apiUrl('/api/messages?limit=50'), { credentials: 'include', cache: 'no-store' });
    const txt = await res.text();
    let j;
    try { j = JSON.parse(txt); } catch { j = null; }
    if (!res.ok || !j || !j.ok) {
      dbg('messages http ' + res.status + ' ' + (txt || '').slice(0, 120));
      return;
    }
    renderMessages(j.messages);
  }

  async function uploadBlob(blob, filename) {
    const fd = new FormData();
    fd.append('file', blob, filename);
    const res = await fetch(apiUrl('/api/upload'), { method: 'POST', body: fd, credentials: 'include', cache: 'no-store' });
    const txt = await res.text();
    let j;
    try { j = JSON.parse(txt); } catch { j = null; }
    if (!res.ok || !j || !j.ok) throw new Error('upload http ' + res.status + ' ' + (txt || '').slice(0, 120));
    return j;
  }

  if (ta) {
    ta.addEventListener('paste', async (e) => {
      const items = (e.clipboardData && e.clipboardData.items) ? Array.from(e.clipboardData.items) : [];
      const img = items.find(it => it.type && it.type.startsWith('image/'));
      if (!img) return;

      e.preventDefault();
      const blob = img.getAsFile();
      if (!blob) return;

      const name = 'pasted_' + new Date().toISOString().replace(/[:.]/g,'-') + '.png';
      ta.disabled = true;
      const sendBtn = document.getElementById('send');
      if (sendBtn) sendBtn.disabled = true;
      try {
        const up = await uploadBlob(blob, name);
        pendingAttachments.push({ url: up.url, filename: up.filename, mime: up.mime, size: up.size });
        renderPreview();
        dbg('pasted image attached: ' + up.filename);
      } catch (err) {
        dbg('Paste upload failed: ' + err);
        alert('Paste upload failed: ' + err);
      } finally {
        ta.disabled = false;
        if (sendBtn) sendBtn.disabled = false;
        ta.focus();
      }
    });
  }

  let waitingForBot = false;

  async function sendMessage() {
    const text = ta ? ta.value : '';
    const atts = pendingAttachments;
    pendingAttachments = [];
    renderPreview();

    setThinking('Thinking…');
    waitingForBot = true;

    const res = await fetch(apiUrl('/api/message'), {
      credentials: 'include',
      cache: 'no-store',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, attachments: atts }),
    });

    const txt = await res.text();
    let j;
    try { j = JSON.parse(txt); } catch { j = null; }
    if (!res.ok || !j || !j.ok) {
      const msg = 'send http ' + res.status + ' ' + (txt || '').slice(0, 120);
      dbg(msg);
      setThinking('Idle');
      waitingForBot = false;
      alert('Send failed: ' + msg);
      return;
    }

    if (ta) ta.value = '';
    await refresh();
    await refreshWorklog();
  }

  const sendBtn = document.getElementById('send');

  async function updateStatus() {
    if (!statusEl) return;
    try {
      const res = await fetch(apiUrl('/api/status'), { credentials: 'include', cache: 'no-store' });
      const txt = await res.text();
      let j;
      try { j = JSON.parse(txt); } catch { j = null; }
      if (!res.ok || !j || !j.ok) {
        const msg = 'status http ' + res.status + ' ' + (txt || '').slice(0, 80);
        dbg(msg);
        statusEl.textContent = 'Connecting… (' + msg + ')';
        return;
      }
      dbg('');
      statusEl.textContent = 'Talking to Clawdio • your IP: ' + (j.clientIp || '?') + ' • server: ' + (j.hostname || '?') + ' • build: ' + (j.build || '?');

      // thinking light survives reloads
      if (j.inFlight && !waitingForBot) {
        setThinking('Thinking…');
      }
    } catch (e) {
      const msg = 'status exception: ' + String(e);
      dbg(msg);
      statusEl.textContent = 'Connecting… (' + msg + ')';
    }
  }

  // Manual upload
  const upform = document.getElementById('upform');
  if (upform) {
    upform.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (out) out.textContent = 'Uploading...';
      const fd = new FormData(e.target);
      const res = await fetch(apiUrl('/api/upload'), { method: 'POST', body: fd, credentials: 'include', cache: 'no-store' });
      const txt = await res.text();
      let j;
      try { j = JSON.parse(txt); } catch { j = null; }
      if (out) out.textContent = (res.ok && j && j.ok) ? ('OK: ' + j.url) : ('Error: http ' + res.status + ' ' + (txt || '').slice(0, 120));
    });
  }

  // Worklog UI hooks
  // tri-state: off -> include -> exclude -> off
  for (const b of wlFilterBtns) {
    b.addEventListener('click', () => {
      const k = b.getAttribute('data-filter');
      if (!k) return;

      const isIn = wlIn.has(k);
      const isOut = wlOut.has(k);

      if (!isIn && !isOut) {
        wlIn.add(k);
      } else if (isIn) {
        wlIn.delete(k);
        wlOut.add(k);
      } else {
        wlOut.delete(k);
      }

      b.classList.toggle('in', wlIn.has(k));
      b.classList.toggle('out', wlOut.has(k));
      renderWorklog(worklogCache);
    });
  }
  if (wlRecentBtn && worklogEl) {
    wlRecentBtn.addEventListener('click', () => {
      worklogEl.scrollTop = 0;
    });
  }

  // Stop/Add buttons
  const btnStop = document.getElementById('btnStop');
  const btnAdd = document.getElementById('btnAdd');
  if (btnStop) {
    btnStop.addEventListener('click', async () => {
      try {
        await fetch(apiUrl('/api/abort'), { method: 'POST', credentials: 'include', cache: 'no-store' });
      } catch {}
    });
  }
  if (btnAdd) {
    btnAdd.addEventListener('click', async () => {
      // Best available "in-between" behavior: abort current run, then let you add context.
      try {
        await fetch(apiUrl('/api/abort'), { method: 'POST', credentials: 'include', cache: 'no-store' });
      } catch {}

      if (ta) {
        const prefix = 'ADD CONTEXT (incorporate into the previous request):\n';
        if (!ta.value.startsWith(prefix)) ta.value = prefix + ta.value;
        ta.focus();
      }
    });
  }

  // WebSocket for real-time updates (best)
  let ws;
  function wsUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + window.location.host + '/ws';
  }

  function connectWs() {
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      dbg('ws exception: ' + String(e));
      return;
    }

    ws.addEventListener('open', () => {
      dbg('');
      console.log('ws open');
    });

    ws.addEventListener('message', (ev) => {
      const j = (() => { try { return JSON.parse(ev.data); } catch { return null; } })();
      if (!j || !j.type) return;
      if (j.type === 'message' && j.message) {
        refresh();
        refreshWorklog();
        // If a bot message arrives, clear thinking
        if (typeof j.message.id === 'string' && j.message.id.startsWith('bot_')) {
          setThinking('Idle');
          waitingForBot = false;
        }
      }
      if (j.type === 'worklog') {
        refreshWorklog();
      }
      if (j.type === 'de_state') {
        deState = j.state || deState;
        deActive = j.active || deActive;
        renderDE();
      }
      if (j.type === 'scheduled') {
        refreshScheduled();
      }
      if (j.type === 'run' && j.state) {
        if (j.state.inFlight) setThinking('Thinking…');
      }
    });

    ws.addEventListener('close', (ev) => {
      dbg('ws closed: ' + ev.code);
      setTimeout(connectWs, 1500);
    });

    ws.addEventListener('error', () => {
      // will also get close
    });
  }

  async function sendMessageWsOrHttp(text, atts) {

    // always show thinking when we send
    setThinking('Thinking…');
    waitingForBot = true;

    // prefer ws
    if (ws && ws.readyState === 1) {
      const clientId = 'c_' + Math.random().toString(16).slice(2);
      ws.send(JSON.stringify({ type: 'message', clientId, text, attachments: atts }));
      return;
    }

    // fallback http (must use provided text; do NOT read textarea which may already be cleared)
    const res = await fetch(apiUrl('/api/message'), {
      credentials: 'include',
      cache: 'no-store',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, attachments: atts }),
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error('send http ' + res.status + ' ' + (txt || '').slice(0, 120));
    }
  }

  function quickSend(text) {
    const atts = pendingAttachments;
    pendingAttachments = [];
    renderPreview();
    if (ta) ta.value = '';
    return sendMessageWsOrHttp(text, atts).then(refresh);
  }

  // Plan button = send with auto-append (no toggle state)
  const planBtn = document.getElementById('plan');
  if (planBtn) {
    planBtn.addEventListener('click', async () => {
      const text = ta ? ta.value : '';
      const atts = pendingAttachments;
      pendingAttachments = [];
      renderPreview();
      if (ta) ta.value = '';
      await sendMessageWsOrHttp('PLAN MODE\n' + (text || ''), atts);
      await refresh();
    });
  }

  // override send button to use ws when available
  if (sendBtn) {
    sendBtn.removeEventListener('click', sendMessage);
    sendBtn.addEventListener('click', async () => {
      const text = ta ? ta.value : '';
      const atts = pendingAttachments;
      pendingAttachments = [];
      renderPreview();
      if (ta) ta.value = '';
      await sendMessageWsOrHttp(text, atts);
      await refresh();
    });
  }

  if (ta) {
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = ta.value;
        const atts = pendingAttachments;
        pendingAttachments = [];
        renderPreview();
        ta.value = '';
        sendMessageWsOrHttp(text, atts).then(refresh);
      }
    });
  }

  // Quick action buttons
  const btnRecent = document.getElementById('btnReviewRecent');
  if (btnRecent) {
    btnRecent.addEventListener('click', () => {
      quickSend(
        'Review Recent: Please review the last 100 messages from *me* in this session and list any requests/tasks I asked for that do not appear completed yet. Keep it as a checklist of TODOs; don\'t start doing them until I confirm.'
      );
    });
  }

  const btnWeek = document.getElementById('btnReviewWeek');
  if (btnWeek) {
    btnWeek.addEventListener('click', () => {
      quickSend(
        'Review Week: Please review all messages from the last 7 days in this session and list any requests/tasks I asked for that do not appear completed yet. Keep it as a checklist of TODOs; don\'t start doing them until I confirm.'
      );
    });
  }

  function initRulesAccordion() {
    const heads = Array.from(document.querySelectorAll('.ruleHead'));
    if (!heads.length) return;

    function toggle(head) {
      const body = head && head.parentElement ? head.parentElement.querySelector('.ruleBody') : null;
      if (!body) return;
      const isOpen = body.classList.toggle('open');
      head.setAttribute('aria-expanded', String(isOpen));
      const chevron = head.querySelector('.ruleChevron');
      if (chevron) chevron.textContent = isOpen ? '▾' : '▸';
    }

    for (const h of heads) {
      h.addEventListener('click', () => toggle(h));
      h.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle(h);
        }
      });
    }
  }

  initRulesAccordion();

  setThinking('Idle');
  loadBuild().then(updateStatus);
  refresh();
  refreshWorklog();
  refreshDE();
  refreshScheduled();
  connectWs();
  setInterval(updateStatus, 5000);
  // keep a slow poll as fallback
  setInterval(refresh, 10000);
  setInterval(refreshWorklog, 15000);
  setInterval(refreshDE, 15000);

  window.addEventListener('error', (e) => {
    dbg('window error: ' + (e && e.message ? e.message : String(e)));
  });
  window.addEventListener('unhandledrejection', (e) => {
    dbg('promise rejection: ' + String(e && e.reason ? e.reason : e));
  });
})();
