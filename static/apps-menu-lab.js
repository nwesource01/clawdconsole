(() => {
  const APPS = [
    { label: 'ClawdPM', href: '/pm' },
    { label: 'ClawdScript', href: '/apps/script' },
    { label: 'ClawdName', href: '/name' },
    { label: 'ClawdRepo', href: '/apps/repo' },
    { label: 'ClawdCode', href: '/apps/code' },
    { label: 'ClawdSec', href: '/apps/sec' },
    { label: 'ClawdOps', href: '/apps/ops' },
    { label: 'ClawdPub', href: '/apps/pub' },
    { label: 'ClawdBuild', href: '/apps/build' },
    { label: 'ClawdQueue', href: '/apps/queue' },
  ];

  const esc = (s) => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function renderAppsGrid() {
    return APPS.map(a => {
      return '<a class="mItem" href="' + esc(a.href) + '"><span class="dot" aria-hidden="true"></span><span class="lbl">' + esc(a.label) + '</span></a>';
    }).join('');
  }

  document.querySelectorAll('[data-menu]').forEach(host => {
    const grid = host.querySelector('.mGrid');
    if (grid) grid.innerHTML = renderAppsGrid();

    // menu button behavior
    const btn = host.querySelector('.mBtn');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        host.classList.toggle('open');
      });
      btn.addEventListener('dblclick', (e) => {
        e.preventDefault();
        window.location.href = '/apps';
      });
    }

    // Menu 1: mouse-driven glow + gentle tilt on the open panel
    if (host.classList.contains('menu1')) {
      const panel = host.querySelector('.mPanel');
      if (panel) {
        panel.addEventListener('pointermove', (e) => {
          const r = panel.getBoundingClientRect();
          const x = (e.clientX - r.left) / r.width;
          const y = (e.clientY - r.top) / r.height;
          panel.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
          panel.style.setProperty('--my', (y * 100).toFixed(1) + '%');

          const dx = (x - 0.5);
          const dy = (y - 0.5);
          const rotY = (dx * 5);
          const rotX = (-dy * 5);
          panel.style.transform = `perspective(900px) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg)`;
        });
        panel.addEventListener('pointerleave', () => {
          panel.style.transform = '';
        });
      }
    }
  });

  // Close menus when clicking outside
  document.addEventListener('click', (e) => {
    const t = e.target;
    document.querySelectorAll('.menuBox.open').forEach(box => {
      if (t && box.contains(t)) return;
      box.classList.remove('open');
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.menuBox.open').forEach(box => box.classList.remove('open'));
    }
  });
})();
