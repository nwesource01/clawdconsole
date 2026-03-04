(() => {
  // Menu 1: mouse-driven glow + gentle tilt
  const el = document.querySelector('.q.m1');
  if (el) {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      el.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
      el.style.setProperty('--my', (y * 100).toFixed(1) + '%');

      const dx = (x - 0.5);
      const dy = (y - 0.5);
      const rotY = (dx * 6);
      const rotX = (-dy * 6);
      el.style.transform = `perspective(900px) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg)`;
    });
    el.addEventListener('pointerleave', () => {
      el.style.transform = '';
    });
  }

  // Copy helper so you can say "Menu 1 with animation 4" etc.
  document.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const txt = btn.getAttribute('data-copy') || '';
      try {
        await navigator.clipboard.writeText(txt);
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy label'; }, 900);
      } catch {
        alert(txt);
      }
    });
  });
})();
