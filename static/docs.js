// ClawdDocs frontend (MVP)
(() => {
  function esc(s){ return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function apiUrl(p){ return new URL(p, window.location.origin).toString(); }

  const listEl = document.getElementById('docsList');
  const viewEl = document.getElementById('docsView');
  const viewTitle = document.getElementById('docsViewTitle');
  const viewMeta = document.getElementById('docsViewMeta');
  const mineBtn = document.getElementById('docsTabMine');
  const teamBtn = document.getElementById('docsTabTeam');
  const whoEl = document.getElementById('docsWho');

  // Determine mode from marketable routes.
  let mode = (window.location.pathname || '').includes('/TeamClawd/') ? 'team' : ((window.location.pathname || '').includes('/team') ? 'team' : 'mine');

  function setMode(m){
    mode = m;
    try { mineBtn && mineBtn.classList.toggle('on', mode==='mine'); } catch {}
    try { teamBtn && teamBtn.classList.toggle('on', mode==='team'); } catch {}
    const base = (mode === 'team') ? '/TeamClawd/docs' : '/ClawdDocs/mine';
    if (!window.location.pathname.startsWith(base)) history.replaceState({}, '', base);
    loadList();
  }

  async function loadList(){
    if (!listEl) return;
    listEl.innerHTML = '<div class="muted">Loading…</div>';
    const endpoint = (mode === 'team') ? '/api/team/docs/index' : '/api/docs/mine/index';
    try {
      const res = await fetch(apiUrl(endpoint), { credentials: 'include', cache: 'no-store' });
      const j = await res.json();
      const items = (j && j.ok && Array.isArray(j.items)) ? j.items : [];
      if (whoEl) {
        const who = (mode === 'team') ? 'Team' : (j && j.me ? String(j.me) : 'Mine');
        whoEl.textContent = who;
      }
      if (!items.length) {
        listEl.innerHTML = '<div class="muted">No docs yet.</div>';
        return;
      }
      listEl.innerHTML = items.map(d => {
        const title = esc(d.title || d.slug || 'Untitled');
        const cats = Array.isArray(d.categories) ? d.categories : [];
        const chips = cats.slice(0,4).map(c => '<span class="chip">' + esc(c) + '</span>').join('');
        const sub = [d.member ? ('<span class="muted">' + esc(d.member) + '</span>') : '', d.updated ? ('<span class="muted">' + esc(d.updated) + '</span>') : ''].filter(Boolean).join(' • ');
        return '<div class="docRow" data-slug="' + esc(d.slug) + '">' +
          '<div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">' +
            '<div style="font-weight:800;">' + title + '</div>' +
            '<div class="muted">' + (sub || '') + '</div>' +
          '</div>' +
          '<div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">' + chips + '</div>' +
        '</div>';
      }).join('');

      // click to open
      Array.from(listEl.querySelectorAll('.docRow')).forEach(row => {
        row.addEventListener('click', () => {
          const slug = row.getAttribute('data-slug') || '';
          if (slug) loadDoc(slug);
        });
      });
    } catch {
      listEl.innerHTML = '<div class="muted">Failed to load docs.</div>';
    }
  }

  async function loadDoc(slug){
    if (!viewEl) return;
    viewEl.textContent = 'Loading…';
    const endpoint = (mode === 'team') ? ('/api/team/docs/doc?slug=' + encodeURIComponent(slug)) : ('/api/docs/mine/doc?slug=' + encodeURIComponent(slug));
    try {
      const res = await fetch(apiUrl(endpoint), { credentials: 'include', cache: 'no-store' });
      const j = await res.json();
      if (!j || !j.ok) throw new Error('bad');
      if (viewTitle) viewTitle.textContent = j.title || slug;
      if (viewMeta) {
        const meta = [j.member ? ('Member: ' + j.member) : null, j.updated ? ('Updated: ' + j.updated) : null].filter(Boolean).join(' • ');
        viewMeta.textContent = meta;
      }
      viewEl.textContent = String(j.body || '');
    } catch {
      viewEl.textContent = 'Failed to load doc.';
    }
  }

  if (mineBtn) mineBtn.addEventListener('click', () => setMode('mine'));
  if (teamBtn) teamBtn.addEventListener('click', () => setMode('team'));

  // default
  setMode(mode);
})();
