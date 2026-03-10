// ClawdSec client (CSP-safe)
(() => {
  function wireCopy(){
    Array.from(document.querySelectorAll('[data-copy]')).forEach(btn => {
      if (btn.dataset.wired === '1') return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', async () => {
        let txt = '';
        const cj = btn.getAttribute('data-copyj');
        if (cj) {
          try { txt = JSON.parse(cj); } catch { txt = ''; }
        } else {
          txt = btn.getAttribute('data-copy') || '';
          try {
            const ta = document.createElement('textarea');
            ta.innerHTML = txt;
            txt = ta.value;
          } catch {}
        }
        try {
          await navigator.clipboard.writeText(String(txt || ''));
          const old = btn.textContent;
          btn.textContent = 'Copied';
          setTimeout(() => (btn.textContent = old), 900);
        } catch {
          const old = btn.textContent;
          btn.textContent = 'Copy failed';
          setTimeout(() => (btn.textContent = old), 900);
        }
      });
    });
  }
  async function loadFail2ban(){
    const box = document.getElementById('secF2B');
    if (!box) return;
    try {
      const res = await fetch('/api/sec/fail2ban', { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!j || !j.ok) {
        box.textContent = 'Fail2ban not available.';
        return;
      }
      const jails = Array.isArray(j.jails) ? j.jails : [];
      if (!jails.length) {
        box.textContent = 'No jails detected.';
        return;
      }
      const rows = jails.map(x => {
        const name = x.name || 'unknown';
        const cb = Number(x.currentlyBanned||0);
        const tb = Number(x.totalBanned||0);
        const cf = Number(x.currentlyFailed||0);
        const tf = Number(x.totalFailed||0);
        return `<div class="card" style="background: rgba(0,0,0,0.10); margin-top:10px;">
          <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:center;">
            <div style="font-weight:900;">${name}</div>
            <div class="muted">Banned: <b>${cb}</b> (total ${tb}) • Failed: <b>${cf}</b> (total ${tf})</div>
          </div>
        </div>`;
      }).join('');
      box.innerHTML = rows;
    } catch {
      box.textContent = 'Fail2ban status failed to load.';
    }
  }
  wireCopy();
  loadFail2ban();
})();
