// ClawdBuild client (CSP-safe)
(() => {
  const $ = (id) => document.getElementById(id);
  const msg = $('cbMsg');
  const list = $('cbLocalList');
  const btn = $('cbRefresh');

  function setMsg(t){ if (msg) msg.textContent = t || ''; }
  function esc(s){ return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  async function load(){
    if (!list) return;
    setMsg('Loading…');
    list.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const res = await fetch('/api/build/templates', { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      const tpls = Array.isArray(j.templates) ? j.templates : [];
      if (!tpls.length) {
        list.innerHTML = '<div class="muted">(none)</div>';
        setMsg('');
        return;
      }
      list.innerHTML = tpls.map(t => {
        const title = esc(t.title||t.name||'(untitled)');
        const stack = esc((t.stack||'') + (Array.isArray(t.tags)&&t.tags.length ? (' • ' + t.tags.join(', ')) : ''));
        const url = t.repoUrl ? ('<a href="' + esc(t.repoUrl) + '" target="_blank" rel="noopener">' + esc(t.repoUrl) + '</a>') : '';
        const desc = esc(t.desc||t.description||'');
        return '<div style="padding:10px 8px; border-top:1px solid rgba(255,255,255,0.08);">'
          + '<div style="font-weight:900;">' + title + '</div>'
          + (stack ? ('<div class="muted" style="margin-top:6px;">' + stack + '</div>') : '')
          + (url ? ('<div class="muted" style="margin-top:6px;">' + url + '</div>') : '')
          + (desc ? ('<div class="muted" style="margin-top:6px;">' + desc + '</div>') : '')
          + '</div>';
      }).join('');
      setMsg('');
    } catch (e) {
      list.innerHTML = '<div class="muted">Failed to load.</div>';
      setMsg('Load failed: ' + String(e));
    }
  }

  if (btn) btn.addEventListener('click', load);
  load();
})();
