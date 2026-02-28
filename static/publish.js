// ClawdApps tabs
(() => {
  const tabPM = document.getElementById('tabPM');
  const tabPub = document.getElementById('tabPub');
  const tabBuild = document.getElementById('tabBuild');

  const panelPM = document.getElementById('panelPM');
  const panelPub = document.getElementById('panelPub');
  const panelBuild = document.getElementById('panelBuild');

  const tabs = [
    { key: 'pm', tab: tabPM, panel: panelPM },
    { key: 'pub', tab: tabPub, panel: panelPub },
    { key: 'build', tab: tabBuild, panel: panelBuild },
  ];

  function setTab(which) {
    for (const t of tabs) {
      const on = t.key === which;
      if (t.panel) t.panel.style.display = on ? 'flex' : 'none';
      if (t.tab) t.tab.style.borderColor = on ? 'rgba(154,208,255,0.55)' : 'rgba(255,255,255,0.12)';
    }
  }

  if (tabPM) tabPM.addEventListener('click', () => setTab('pm'));
  if (tabPub) tabPub.addEventListener('click', () => setTab('pub'));
  if (tabBuild) tabBuild.addEventListener('click', () => setTab('build'));

  // default
  setTab('pm');
})();
