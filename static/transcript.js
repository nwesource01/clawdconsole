// Transcript viewer (client-side search + actions)
(() => {
  let BUILD = 'unknown';
  const buildEl = document.getElementById('t_build');
  async function loadBuild() {
    try {
      const res = await fetch(new URL('/api/build', window.location.origin).toString(), { credentials: 'include', cache: 'no-store' });
      const j = await res.json();
      if (j && j.ok && j.build) BUILD = j.build;
    } catch {}
    if (buildEl) buildEl.textContent = BUILD;
  }
  loadBuild();

  const listEl = document.getElementById('t_list');
  const qEl = document.getElementById('t_q');
  const statusEl = document.getElementById('t_status');
  const loadMoreBtn = document.getElementById('t_more');
  const orderBtn = document.getElementById('t_order');

  const roleBtns = Array.from(document.querySelectorAll('button[data-role]'));
  const dayBtns = Array.from(document.querySelectorAll('button[data-days]'));
  const hasListBtn = document.getElementById('hasListBtn');

  const USER_NAME = 'Charles';
  const AGENT_NAME = 'Clawdio';

  let q = '';
  let role = '';
  let days = 0;
  let hasList = false;
  let order = (localStorage.getItem('claw_transcript_order') || 'asc') === 'desc' ? 'desc' : 'asc';
  let offset = 0;
  const pageSize = 200;
  let done = false;

  function esc(s) {
    return (s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function linkify(escapedText) {
    const urlRe = /(https?:\/\/[^\s<]+[^<.,;:!?)\]\s])/g;
    return String(escapedText || '').replace(urlRe, (u) => {
      return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>';
    });
  }

  function apiUrl(p) {
    return new URL(p, window.location.origin).toString();
  }

  async function sendToChat(text) {
    const res = await fetch(apiUrl('/api/message'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, attachments: [] }),
      cache: 'no-store'
    });
    if (!res.ok) throw new Error('send failed: http ' + res.status);
  }

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

  function renderRow(item) {
    const ts = item.t || '';
    const roleKey = item.r || '';
    const text = item.x || '';
    const atts = Array.isArray(item.a) ? item.a : [];

    const speaker = (roleKey === 'assistant') ? AGENT_NAME : USER_NAME;
    const speakerClass = (roleKey === 'assistant') ? 't_agent' : 't_user';

    const div = document.createElement('div');
    div.className = 't_row';

    const top = document.createElement('div');
    top.className = 't_top';

    const meta = document.createElement('div');
    meta.className = 't_meta';
    meta.innerHTML = '<span class="t_ts">' + esc(fmtTs(ts)) + '</span> — <span class="' + speakerClass + '">' + esc(speaker) + '</span>';

    const actions = document.createElement('div');
    actions.className = 't_actions';

    const body = document.createElement('pre');
    body.className = 't_text';
    // Allow clickable URLs inside transcript text.
    body.innerHTML = linkify(esc(text));

    // If this entry has a hidden DEL, show a List button
    if (item && item.d) {
      const btnList = document.createElement('button');
      btnList.textContent = 'List';
      btnList.style.background = '#1f8f4a';
      btnList.style.borderColor = 'rgba(255,255,255,0.18)';
      btnList.addEventListener('click', () => {
        const existing = div.querySelector('.t_del');
        if (existing) { existing.remove(); return; }
        const box = document.createElement('div');
        box.className = 't_del';
        box.style.marginTop = '8px';
        box.style.padding = '10px';
        box.style.border = '1px solid rgba(255,255,255,0.10)';
        box.style.borderRadius = '12px';
        box.style.background = 'rgba(0,0,0,0.12)';
        const items = Array.isArray(item.d) ? item.d : [];
        box.innerHTML = '<div class="muted" style="margin-bottom:6px;">Dynamic Execution List (hidden)</div>' +
          items.map((it) => {
            const done = it && it.d ? '✅' : '⬜';
            const txt = (it && it.t) ? it.t : '';
            return '<div style="margin:4px 0;">' + done + ' ' + esc(txt) + '</div>';
          }).join('');
        div.appendChild(box);
      });
      actions.appendChild(btnList);
    }

    const btnDiscuss = document.createElement('button');
    btnDiscuss.textContent = 'Discuss';
    btnDiscuss.addEventListener('click', async () => {
      const msg = `Discuss transcript item:\n[${ts}] (${role})\n${text}`;
      await sendToChat(msg);
    });

    const btnReview = document.createElement('button');
    btnReview.textContent = 'Review';
    btnReview.addEventListener('click', async () => {
      const msg = `Review this transcript item and tell me if it contains an uncompleted request/task, and what the next action should be. Do not take action yet.\n\n[${ts}] (${role})\n${text}`;
      await sendToChat(msg);
    });

    const btnCopy = document.createElement('button');
    btnCopy.textContent = 'Copy';
    btnCopy.addEventListener('click', async () => {
      const s = `[${ts}] (${role}) ${text}`;
      try {
        await navigator.clipboard.writeText(s);
      } catch {
        // fallback
        const ta = document.createElement('textarea');
        ta.value = s;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
    });

    actions.appendChild(btnDiscuss);
    actions.appendChild(btnReview);
    actions.appendChild(btnCopy);

    top.appendChild(meta);
    top.appendChild(actions);

    const att = document.createElement('div');
    att.className = 't_atts';
    if (atts.length) {
      att.innerHTML = atts.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`).join(' ');
    }

    div.appendChild(top);
    div.appendChild(body);
    if (atts.length) div.appendChild(att);
    return div;
  }

  async function fetchPage({ reset } = {}) {
    if (done && !reset) return;
    if (reset) {
      offset = 0;
      done = false;
      listEl.innerHTML = '';
    }

    statusEl.textContent = 'Loading…';
    const u = new URL(apiUrl('/api/transcript/search'));
    if (q) u.searchParams.set('q', q);
    if (role) u.searchParams.set('role', role);
    if (days) u.searchParams.set('days', String(days));
    if (hasList) u.searchParams.set('hasList', '1');
    u.searchParams.set('order', order);
    u.searchParams.set('offset', String(offset));
    u.searchParams.set('limit', String(pageSize));

    const res = await fetch(u.toString(), { credentials: 'include', cache: 'no-store' });
    const txt = await res.text();
    let j;
    try { j = JSON.parse(txt); } catch { j = null; }
    if (!res.ok || !j || !j.ok) {
      statusEl.textContent = 'Error loading transcript';
      throw new Error('transcript search failed: ' + res.status + ' ' + txt.slice(0, 120));
    }

    for (const item of j.items || []) listEl.appendChild(renderRow(item));

    offset += (j.items || []).length;
    done = !!j.done;
    statusEl.textContent = done ? `Done. Showing ${offset} items.` : `Showing ${offset} items…`;
    loadMoreBtn.disabled = done;
  }

  function setActive(btns, pred) {
    for (const b of btns) b.classList.toggle('active', !!pred(b));
  }

  function updateFiltersFromUi() {
    q = (qEl.value || '').trim();
    const activeRole = roleBtns.find(b => b.classList.contains('active'));
    role = activeRole ? (activeRole.getAttribute('data-role') || '') : '';
    const activeDays = dayBtns.find(b => b.classList.contains('active'));
    days = activeDays ? Number(activeDays.getAttribute('data-days') || 0) || 0 : 0;
    hasList = hasListBtn ? hasListBtn.classList.contains('on') : false;
  }

  qEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      updateFiltersFromUi();
      fetchPage({ reset: true });
    }
  });

  // Role buttons
  for (const b of roleBtns) {
    b.addEventListener('click', () => {
      setActive(roleBtns, x => x === b);
      updateFiltersFromUi();
      fetchPage({ reset: true });
    });
  }

  // Day buttons
  for (const b of dayBtns) {
    b.addEventListener('click', () => {
      setActive(dayBtns, x => x === b);
      updateFiltersFromUi();
      fetchPage({ reset: true });
    });
  }

  // List toggle
  if (hasListBtn) {
    hasListBtn.addEventListener('click', () => {
      hasListBtn.classList.toggle('on');
      updateFiltersFromUi();
      fetchPage({ reset: true });
    });
  }

  document.getElementById('t_search').addEventListener('click', () => {
    updateFiltersFromUi();
    fetchPage({ reset: true });
  });

  loadMoreBtn.addEventListener('click', () => fetchPage());

  if (orderBtn) {
    orderBtn.addEventListener('click', () => {
      order = (order === 'asc') ? 'desc' : 'asc';
      localStorage.setItem('claw_transcript_order', order);
      orderBtn.classList.toggle('active', order === 'desc');
      fetchPage({ reset: true });
    });
    orderBtn.classList.toggle('active', order === 'desc');
  }

  // initial defaults
  const roleAll = document.getElementById('roleAll');
  const daysAll = document.getElementById('daysAll');
  if (roleAll) roleAll.classList.add('active');
  if (daysAll) daysAll.classList.add('active');
  updateFiltersFromUi();

  fetchPage({ reset: true });
})();
