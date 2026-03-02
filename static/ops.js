// ClawdOps client (CSP-safe)
(() => {
  const $ = (id) => document.getElementById(id);
  const msg = $('opsMsg');
  const ta = $('opsProfile');
  const btnSave = $('opsSave');
  const btnCommit = $('opsCommit');
  const btnTemplate = $('opsTemplate');
  const btnRepeat = $('opsRepeat');
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

  load();
})();
