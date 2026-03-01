(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function slugifyName(name){
    return String(name||'').trim().toLowerCase()
      .replace(/&/g,' and ')
      .replace(/[^a-z0-9\s-]/g,'')
      .replace(/\s+/g,'-')
      .replace(/-+/g,'-')
      .replace(/^-/,'').replace(/-$/,'');
  }

  function variantsFor(name, maxN){
    const base = slugifyName(name);
    const raw = String(name||'').trim().toLowerCase().replace(/[^a-z0-9]/g,'');
    const out = [];
    const push = (s) => { if (s && !out.includes(s)) out.push(s); };
    push(raw);
    push(base.replace(/-/g,''));
    push(base);
    if (raw) {
      push('get' + raw);
      push(raw + 'hq');
      push(raw + 'app');
      push('try' + raw);
    }
    return out.slice(0, Math.max(1, maxN||8));
  }

  function buildDomains(){
    const names = String($('names').value||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    const tlds = String($('tlds').value||'').split(',').map(s=>s.trim()).filter(Boolean).map(t => t.startsWith('.')?t:('.'+t));
    const maxV = Math.max(1, Math.min(30, Number($('variants').value||8)));

    const domains = [];
    for (const n of names){
      for (const v of variantsFor(n, maxV)){
        for (const t of tlds){
          domains.push(v + t);
        }
      }
    }
    return Array.from(new Set(domains)).slice(0, 800);
  }

  function pill(status){
    if (status === 'taken') return '<span class="pill p-bad">taken</span>';
    if (status === 'likely_available') return '<span class="pill p-ok">likely available</span>';
    if (status === 'invalid') return '<span class="pill p-inv">invalid</span>';
    return '<span class="pill p-unk">unknown</span>';
  }

  function setStatus(htmlOrText, isHtml=false){
    const el = $('status');
    if (!el) return;
    if (isHtml) el.innerHTML = htmlOrText;
    else el.textContent = htmlOrText;
  }

  window.addEventListener('error', (e) => {
    try {
      const msg = (e && (e.message || (e.error && e.error.message))) ? (e.message || e.error.message) : String(e);
      setStatus('JS error: ' + msg);
    } catch {}
  });

  async function run(){
    const domains = buildDomains();
    setStatus('Checking ' + domains.length + ' domains…');
    $('out').innerHTML = '';

    let res, txt, j;
    try {
      res = await fetch('/api/name/check', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        credentials:'include',
        body: JSON.stringify({ domains })
      });
      txt = await res.text();
      try { j = JSON.parse(txt); } catch { j = null; }
    } catch (e) {
      setStatus('Request failed: ' + String(e));
      return;
    }

    if (!res.ok || !j || !j.ok) {
      if (res.status === 401) {
        setStatus('Auth required. Open <a href="/" style="color:var(--teal)">/</a> and log in, then come back and retry.', true);
      } else {
        setStatus('Failed (' + res.status + '): ' + String((txt||'').slice(0,160)));
      }
      return;
    }

    const rows = (j.results || []);
    const avail = rows.filter(r => r && r.status === 'likely_available');
    const taken = rows.filter(r => r && r.status === 'taken');
    const unk = rows.filter(r => r && (r.status === 'unknown' || r.status === 'invalid'));

    setStatus('Done. ' +
      '<b>' + avail.length + '</b> likely available • ' +
      '<b>' + taken.length + '</b> taken • ' +
      '<b>' + unk.length + '</b> unknown/invalid.', true);

    const html = '<table>'
      + '<thead><tr><th>Domain</th><th>Status</th><th>Evidence</th><th></th></tr></thead>'
      + '<tbody>'
      + rows.map(r => {
        const copy = '<button class="mini" data-copy="' + esc(r.domain) + '">Copy</button>';
        return '<tr>'
          + '<td><code>' + esc(r.domain) + '</code></td>'
          + '<td>' + pill(r.status) + (r.cached ? ' <span class="muted">(cached)</span>' : '') + '</td>'
          + '<td class="muted">' + esc(r.reason || '') + (r.code ? (' (' + esc(r.code) + ')') : '') + '</td>'
          + '<td>' + copy + '</td>'
          + '</tr>';
      }).join('')
      + '</tbody></table>';

    $('out').innerHTML = html;
    Array.from(document.querySelectorAll('button[data-copy]')).forEach(b => {
      b.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(b.getAttribute('data-copy')||''); b.textContent = 'Copied'; setTimeout(()=>b.textContent='Copy', 900); } catch {}
      });
    });
  }

  const runBtn = $('run');
  const clearBtn = $('clear');
  if (runBtn) runBtn.addEventListener('click', run);
  if (clearBtn) clearBtn.addEventListener('click', () => { $('names').value=''; $('out').innerHTML=''; setStatus('Ready.'); $('names').focus(); });

  setStatus('Ready.');
})();
