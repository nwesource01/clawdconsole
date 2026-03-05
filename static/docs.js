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

  const qEl = document.getElementById('docsQ');
  const clearEl = document.getElementById('docsClear');
  const catsEl = document.getElementById('docsFilterCats');
  const memEl = document.getElementById('docsFilterMembers');

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

  let allItems = [];
  let filt = { q:'', cat:'', member:'' };

  function norm(s){ return String(s||'').trim().toLowerCase(); }

  function renderFilterButtons(items){
    if (catsEl) catsEl.innerHTML = '';
    if (memEl) memEl.innerHTML = '';

    const cats = new Map();
    const mems = new Map();
    for (const it of (items||[])){
      const arr = Array.isArray(it.categories) ? it.categories : [];
      for (const c of arr){
        const k = String(c||'').trim();
        if (!k) continue;
        cats.set(k, (cats.get(k)||0)+1);
      }
      const m = String(it.member||'').trim();
      if (m) mems.set(m, (mems.get(m)||0)+1);
    }

    const catList = Array.from(cats.entries()).sort((a,b) => (b[1]-a[1]) || a[0].localeCompare(b[0])).slice(0, 20);
    const memList = Array.from(mems.entries()).sort((a,b) => (b[1]-a[1]) || a[0].localeCompare(b[0])).slice(0, 12);

    if (catsEl) {
      catsEl.innerHTML = catList.map(([c,n]) => {
        const on = (filt.cat === c);
        return `<button type="button" class="pill ${on?'on':''}" data-cat="${esc(c)}">${esc(c)} <span class="muted">(${n})</span></button>`;
      }).join('');
      Array.from(catsEl.querySelectorAll('button[data-cat]')).forEach(btn => {
        btn.addEventListener('click', () => {
          const c = btn.getAttribute('data-cat') || '';
          filt.cat = (filt.cat === c) ? '' : c;
          applyFilters();
        });
      });
    }

    // Only show member filters on Team mode.
    if (memEl) {
      if (mode !== 'team') { memEl.innerHTML = ''; return; }
      memEl.innerHTML = memList.map(([m,n]) => {
        const on = (filt.member === m);
        return `<button type="button" class="pill ${on?'on':''}" data-mem="${esc(m)}">${esc(m)} <span class="muted">(${n})</span></button>`;
      }).join('');
      Array.from(memEl.querySelectorAll('button[data-mem]')).forEach(btn => {
        btn.addEventListener('click', () => {
          const m = btn.getAttribute('data-mem') || '';
          filt.member = (filt.member === m) ? '' : m;
          applyFilters();
        });
      });
    }
  }

  function renderList(items){
    if (!listEl) return;
    if (!items.length) {
      listEl.innerHTML = '<div class="muted">No docs match these filters.</div>';
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

    Array.from(listEl.querySelectorAll('.docRow')).forEach(row => {
      row.addEventListener('click', () => {
        const slug = row.getAttribute('data-slug') || '';
        if (slug) loadDoc(slug);
      });
    });
  }

  function applyFilters(){
    const q = norm(filt.q);
    const cat = String(filt.cat||'').trim();
    const mem = String(filt.member||'').trim();

    const out = allItems.filter(it => {
      if (cat) {
        const arr = Array.isArray(it.categories) ? it.categories : [];
        if (!arr.map(a => String(a||'').trim()).includes(cat)) return false;
      }
      if (mode === 'team' && mem) {
        if (String(it.member||'').trim() !== mem) return false;
      }
      if (q) {
        const hay = [it.slug, it.title, it.member, Array.isArray(it.categories)?it.categories.join(' '):''].map(norm).join(' ');
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    // Update the on/off classes after state changes
    renderFilterButtons(allItems);
    renderList(out);
  }

  async function loadList(){
    if (!listEl) return;
    listEl.innerHTML = '<div class="muted">Loading…</div>';
    const endpoint = (mode === 'team') ? '/api/team/docs/index' : '/api/docs/mine/index';
    try {
      const res = await fetch(apiUrl(endpoint), { credentials: 'include', cache: 'no-store' });
      const j = await res.json();
      const items = (j && j.ok && Array.isArray(j.items)) ? j.items : [];
      allItems = items;

      if (whoEl) {
        const who = (mode === 'team') ? 'Team' : (j && j.me ? String(j.me) : 'Mine');
        whoEl.textContent = who;
      }

      if (!items.length) {
        if (catsEl) catsEl.innerHTML = '';
        if (memEl) memEl.innerHTML = '';
        listEl.innerHTML = '<div class="muted">No docs yet.</div>';
        return;
      }

      renderFilterButtons(items);
      applyFilters();
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

  if (qEl) qEl.addEventListener('input', () => {
    filt.q = String(qEl.value || '');
    applyFilters();
  });
  if (clearEl) clearEl.addEventListener('click', () => {
    filt = { q:'', cat:'', member:'' };
    if (qEl) qEl.value = '';
    applyFilters();
  });

  // default
  setMode(mode);
})();
