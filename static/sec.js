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
  wireCopy();
})();
