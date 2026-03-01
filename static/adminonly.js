(() => {
  const tabSitemap = document.getElementById('admTabSitemap');
  const tabAdoption = document.getElementById('admTabAdoption');
  const tabCRM = document.getElementById('admTabCRM');
  const tabChangelog = document.getElementById('admTabChangelog');

  const panelSitemap = document.getElementById('admPanelSitemap');
  const panelAdoption = document.getElementById('admPanelAdoption');
  const panelCRM = document.getElementById('admPanelCRM');
  const panelChangelog = document.getElementById('admPanelChangelog');

  const crmList = document.getElementById('crmList');
  const crmCount = document.getElementById('crmCount');
  const crmRefresh = document.getElementById('crmRefresh');

  const adoptRefresh = document.getElementById('adoptRefresh');
  const adoptSave = document.getElementById('adoptSave');
  const adoptSaved = document.getElementById('adoptSaved');
  const adoptTotal = document.getElementById('adoptTotal');
  const adoptClawdbot = document.getElementById('adoptClawdbot');
  const adoptConsole = document.getElementById('adoptConsole');
  const adoptRate = document.getElementById('adoptRate');
  const inClawdbot = document.getElementById('adoptInClawdbot');
  const inMoltbot = document.getElementById('adoptInMoltbot');
  const inConsole = document.getElementById('adoptInConsole');

  const tabs = [
    { key: 'sitemap', tab: tabSitemap, panel: panelSitemap },
    { key: 'adoption', tab: tabAdoption, panel: panelAdoption },
    { key: 'crm', tab: tabCRM, panel: panelCRM },
    { key: 'changelog', tab: tabChangelog, panel: panelChangelog },
  ];

  function setTab(k){
    for (const t of tabs){
      const on = t.key === k;
      if (t.panel) t.panel.style.display = on ? 'block' : 'none';
      if (t.tab) t.tab.style.borderColor = on ? 'rgba(154,208,255,0.55)' : 'rgba(255,255,255,0.12)';
    }
    if (k === 'crm') loadCRM();
    if (k === 'adoption') loadAdoption();
    if (k === 'changelog') loadChangelog();
  }

  function esc(s){
    return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  async function loadAdoption(){
    if (!panelAdoption) return;
    if (adoptSaved) adoptSaved.textContent = '';
    try {
      const res = await fetch('/api/adoption', { credentials: 'include', cache: 'no-store' });
      const j = await res.json();
      const a = (j && j.ok && j.adoption) ? j.adoption : { clawdbot: 0, moltbot: 0, console: 0 };
      const claw = Number(a.clawdbot || 0);
      const molt = Number(a.moltbot || 0);
      const con = Number(a.console || 0);
      const total = claw + molt + con;
      const rate = total ? ((con / total) * 100) : 0;

      if (adoptClawdbot) adoptClawdbot.textContent = String(claw);
      if (adoptConsole) adoptConsole.textContent = String(con);
      if (adoptTotal) adoptTotal.textContent = String(total);
      if (adoptRate) adoptRate.textContent = total ? (rate.toFixed(1) + '%') : '—';

      if (inClawdbot) inClawdbot.value = String(claw);
      if (inMoltbot) inMoltbot.value = String(molt);
      if (inConsole) inConsole.value = String(con);

      if (adoptSaved) adoptSaved.textContent = a.updatedAt ? ('Last updated: ' + a.updatedAt) : '';
    } catch {
      if (adoptSaved) adoptSaved.textContent = 'Failed to load.';
    }
  }

  async function saveAdoption(){
    try {
      if (adoptSaved) { adoptSaved.textContent = 'Saving…'; }
      const payload = {
        clawdbot: Number(inClawdbot && inClawdbot.value || 0),
        moltbot: Number(inMoltbot && inMoltbot.value || 0),
        console: Number(inConsole && inConsole.value || 0),
      };
      const res = await fetch('/api/adoption', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      const j = await res.json();
      if (j && j.ok) {
        if (adoptSaved) adoptSaved.textContent = 'Saved.';
        loadAdoption();
      } else {
        if (adoptSaved) adoptSaved.textContent = 'Save failed.';
      }
    } catch {
      if (adoptSaved) adoptSaved.textContent = 'Save failed.';
    }
  }

  async function loadChangelog(){
    const list = document.getElementById('chgList');
    const count = document.getElementById('chgCount');
    const saved = document.getElementById('chgSaved');
    if (saved) saved.textContent = '';
    if (!list) return;
    list.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const res = await fetch('/api/changelog?limit=200', { credentials: 'include', cache: 'no-store' });
      const j = await res.json();
      const entries = (j && j.ok && Array.isArray(j.entries)) ? j.entries : [];
      if (count) count.textContent = entries.length ? (entries.length + ' entry(s)') : 'No entries yet';
      if (!entries.length) { list.innerHTML = '<div class="muted">No changelog entries yet.</div>'; return; }
      list.innerHTML = entries.map(e => {
        const t = esc(e.ts || '');
        const title = esc(e.title || '');
        const body = esc(e.body || '');
        const build = e.build ? ('<span class="muted">build ' + esc(e.build) + '</span>') : '';
        return `
          <div style="border:1px solid rgba(255,255,255,0.10); border-radius:12px; padding:10px; margin-top:10px; background: rgba(255,255,255,0.03);">
            <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">
              <div><b>${title}</b> ${build}</div>
              <div class="muted">${t}</div>
            </div>
            ${body ? ('<div class="muted" style="margin-top:8px; white-space:pre-wrap;">' + body + '</div>') : ''}
          </div>
        `;
      }).join('');
    } catch (e) {
      list.innerHTML = '<div class="muted">Failed to load changelog.</div>';
    }
  }

  async function saveChangelog(){
    const titleEl = document.getElementById('chgTitle');
    const bodyEl = document.getElementById('chgBody');
    const saved = document.getElementById('chgSaved');
    try {
      if (saved) saved.textContent = 'Saving…';
      const payload = { title: (titleEl?.value || '').trim(), body: (bodyEl?.value || '').trim() };
      const res = await fetch('/api/changelog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      if (saved) saved.textContent = 'Saved.';
      if (titleEl) titleEl.value = '';
      if (bodyEl) bodyEl.value = '';
      loadChangelog();
    } catch (e) {
      if (saved) saved.textContent = 'Save failed.';
    }
  }

  async function loadCRM(){
    if (!crmList) return;
    crmList.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const res = await fetch('/api/crm/leads?limit=2000', { credentials: 'include', cache: 'no-store' });
      const j = await res.json();
      const leads = (j && j.ok && Array.isArray(j.leads)) ? j.leads : [];
      if (crmCount) crmCount.textContent = leads.length ? (leads.length + ' lead(s)') : 'No leads yet';

      if (!leads.length) {
        crmList.innerHTML = '<div class="muted">No leads yet.</div>';
        return;
      }

      // newest first
      leads.reverse();

      const rows = leads.map(l => {
        const name = l.name ? esc(l.name) : '<span class="muted">(no name)</span>';
        const email = esc(l.email || '');
        const ts = esc(l.ts || '');
        const src = l.source ? esc(l.source) : '<span class="muted">(unknown)</span>';
        return `
          <div style="border:1px solid rgba(255,255,255,0.10); border-radius:12px; padding:10px; margin-bottom:10px; background: rgba(255,255,255,0.03);">
            <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">
              <div><b>${name}</b> • <a href="mailto:${email}">${email}</a></div>
              <div class="muted">${ts}</div>
            </div>
            <div class="muted" style="margin-top:6px;">source: ${src}</div>
          </div>
        `;
      }).join('');

      crmList.innerHTML = rows;
    } catch (e) {
      crmList.innerHTML = '<div class="muted">Failed to load leads.</div>';
    }
  }

  if (tabSitemap) tabSitemap.addEventListener('click', () => setTab('sitemap'));
  if (tabAdoption) tabAdoption.addEventListener('click', () => setTab('adoption'));
  if (tabCRM) tabCRM.addEventListener('click', () => setTab('crm'));
  if (tabChangelog) tabChangelog.addEventListener('click', () => setTab('changelog'));
  if (crmRefresh) crmRefresh.addEventListener('click', loadCRM);

  const chgRefresh = document.getElementById('chgRefresh');
  const chgSave = document.getElementById('chgSave');
  if (chgRefresh) chgRefresh.addEventListener('click', loadChangelog);
  if (chgSave) chgSave.addEventListener('click', saveChangelog);

  if (adoptRefresh) adoptRefresh.addEventListener('click', loadAdoption);
  if (adoptSave) adoptSave.addEventListener('click', saveAdoption);

  setTab('sitemap');
})();
