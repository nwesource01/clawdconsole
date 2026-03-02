// ClawdSec client (CSP-safe)
(() => {
  function wireCopy(){
    Array.from(document.querySelectorAll('[data-copy]')).forEach(btn => {
      if (btn.dataset.wired === '1') return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', async () => {
        const txt = btn.getAttribute('data-copy') || '';
        try {
          await navigator.clipboard.writeText(txt);
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
