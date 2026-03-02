// ClawdCode client (CSP-safe)
(() => {
  const $ = (id) => document.getElementById(id);
  const treeEl = $('codeTree');
  const editor = $('codeEditor');
  const pathEl = $('codePath');
  const msgEl = $('codeMsg');
  const btnSave = $('codeSave');
  const btnReload = $('codeReload');
  const btnUp = $('codeUp');

  let curDir = '';
  let curFile = '';
  let dirty = false;

  function setMsg(t){ if (msgEl) msgEl.textContent = t || ''; }

  function esc(s){
    return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  async function loadDir(dir){
    curDir = String(dir||'');
    setMsg('Loading tree…');
    if (treeEl) treeEl.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const res = await fetch('/api/code/tree?path=' + encodeURIComponent(curDir), { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      curDir = String(j.path||'');
      renderTree(j.items || []);
      setMsg('');
    } catch (e) {
      if (treeEl) treeEl.innerHTML = '<div class="muted">Failed to load tree.</div>';
      setMsg('Tree load failed: ' + String(e));
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
      const icon = it.type === 'dir' ? '📁' : '📄';
      rows.push(
        '<div class="coderow" data-type="' + esc(it.type) + '" data-path="' + esc(it.path) + '">' +
          '<span class="muted" style="margin-right:8px;">' + icon + '</span>' +
          '<span>' + esc(it.name) + '</span>' +
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
        if (type === 'up') {
          const parts = curDir.split('/').filter(Boolean);
          parts.pop();
          return loadDir(parts.join('/'));
        }
      });
    });
  }

  async function openFile(p){
    if (dirty && !confirm('Discard unsaved changes?')) return;
    setMsg('Loading file…');
    try {
      const res = await fetch('/api/code/file?path=' + encodeURIComponent(p), { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error(j && j.error ? j.error : ('http ' + res.status));
      curFile = String(j.path||p||'');
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
    setMsg('Saving…');
    try {
      const res = await fetch('/api/code/file', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        body: JSON.stringify({ path: curFile, text: editor ? editor.value : '' })
      });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error(j && j.error ? j.error : ('http ' + res.status));
      dirty = false;
      setMsg('Saved.');
      setTimeout(() => setMsg(''), 900);
      // refresh tree to update mtimes
      loadDir(curDir);
    } catch (e) {
      setMsg('Save failed: ' + String(e));
    }
  }

  function goUp(){
    const parts = curDir.split('/').filter(Boolean);
    parts.pop();
    loadDir(parts.join('/'));
  }

  if (editor) editor.addEventListener('input', () => { dirty = true; });
  if (btnSave) btnSave.addEventListener('click', saveFile);
  if (btnReload) btnReload.addEventListener('click', () => curFile && openFile(curFile));
  if (btnUp) btnUp.addEventListener('click', goUp);

  // boot
  loadDir('');
})();
