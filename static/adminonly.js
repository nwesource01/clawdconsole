(() => {
  const tabSitemap = document.getElementById('admTabSitemap');
  const tabApps = document.getElementById('admTabApps');
  const tabAdoption = document.getElementById('admTabAdoption');
  const tabCRM = document.getElementById('admTabCRM');
  const tabChangelog = document.getElementById('admTabChangelog');
  const tabFeatures = document.getElementById('admTabFeatures');
  const tabBranding = document.getElementById('admTabBranding');
  const tabBossJobs = document.getElementById('admTabBossJobs');
  const tabResolutions = document.getElementById('admTabResolutions');

  const panelSitemap = document.getElementById('admPanelSitemap');
  const panelApps = document.getElementById('admPanelApps');
  const panelAdoption = document.getElementById('admPanelAdoption');
  const panelCRM = document.getElementById('admPanelCRM');
  const panelChangelog = document.getElementById('admPanelChangelog');
  const panelFeatures = document.getElementById('admPanelFeatures');
  const panelBranding = document.getElementById('admPanelBranding');
  const panelBossJobs = document.getElementById('admPanelBossJobs');
  const panelResolutions = document.getElementById('admPanelResolutions');

  const brandMenuCss = document.getElementById('brandMenuCss');
  const brandMenuSave = document.getElementById('brandMenuSave');
  const brandMenuReset = document.getElementById('brandMenuReset');
  const brandMenuSaved = document.getElementById('brandMenuSaved');

  const crmList = document.getElementById('crmList');
  const crmCount = document.getElementById('crmCount');
  const crmRefresh = document.getElementById('crmRefresh');

  const adoptRefresh = document.getElementById('adoptRefresh');
  const adoptSave = document.getElementById('adoptSave');

  const chgPostTeam = document.getElementById('chgPostTeam');
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
    { key: 'apps', tab: tabApps, panel: panelApps },
    { key: 'adoption', tab: tabAdoption, panel: panelAdoption },
    { key: 'crm', tab: tabCRM, panel: panelCRM },
    { key: 'changelog', tab: tabChangelog, panel: panelChangelog },
    { key: 'features', tab: tabFeatures, panel: panelFeatures },
    { key: 'branding', tab: tabBranding, panel: panelBranding },
    { key: 'bossjobs', tab: tabBossJobs, panel: panelBossJobs },
    { key: 'resolutions', tab: tabResolutions, panel: panelResolutions },
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
    if (k === 'branding') loadBrandingMenu();
    if (k === 'bossjobs') loadBossJobs();
    if (k === 'resolutions') loadResolutions();
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

  async function updateChangelog(mode){
    const saved = document.getElementById('chgSaved');
    try {
      if (saved) saved.textContent = (mode === 'rebuild') ? 'Rebuilding…' : 'Updating…';
      const res = await fetch('/api/changelog/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mode: (mode === 'rebuild') ? 'rebuild' : 'append' })
      });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      if (saved) saved.textContent = 'Updated (added ' + String(j.added || 0) + ').';
      loadChangelog();
    } catch {
      if (saved) saved.textContent = 'Update failed.';
    }
  }

  async function postChangelogToTeamDocs(){
    const saved = document.getElementById('chgSaved');
    try {
      if (saved) saved.textContent = 'Posting to Team Docs…';
      const res = await fetch('/api/admin/changelog/post-team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({})
      });
      const txt = await res.text();
      let j=null; try { j = JSON.parse(txt); } catch {}
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status + ' ' + (txt||'').slice(0,120));
      if (saved) saved.textContent = 'Posted to Team Docs (' + String(j.entries || 0) + ' entries).';
    } catch {
      if (saved) saved.textContent = 'Post failed.';
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

  async function loadBrandingMenu(){
    if (!panelBranding) return;
    if (brandMenuSaved) brandMenuSaved.textContent = '';
    try {
      const res = await fetch('/admin/api/branding/menu', { credentials: 'include', cache: 'no-store' });
      const j = await res.json();
      if (!j || !j.ok) throw new Error('bad');
      const css = (j.branding && typeof j.branding.cssOverrides === 'string') ? j.branding.cssOverrides : '';
      if (brandMenuCss) brandMenuCss.value = css;
      if (brandMenuSaved) brandMenuSaved.textContent = j.branding && j.branding.updatedAt ? ('Loaded: ' + j.branding.updatedAt) : 'Loaded.';
    } catch {
      if (brandMenuSaved) brandMenuSaved.textContent = 'Failed to load.';
    }
  }

  async function loadResolutions(){
    const list = document.getElementById('resList');
    const count = document.getElementById('resCount');
    if (!list) return;
    list.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const res = await fetch('/admin/api/resolutions', { credentials:'include', cache:'no-store' });
      const j = await res.json();
      const items = (j && j.ok && Array.isArray(j.items)) ? j.items : [];
      if (count) count.textContent = items.length ? (items.length + ' card(s)') : 'No cards yet';
      if (!items.length) { list.innerHTML = '<div class="muted">No resolutions yet.</div>'; return; }

      function pill(txt){
        if (!txt) return '';
        return '<span style="display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);font-size:12px;">' + esc(txt) + '</span>';
      }

      list.innerHTML = items.map(it => {
        const title = esc(it.title || '(untitled)');
        const cats = Array.isArray(it.categories) ? it.categories : [];
        const tags = Array.isArray(it.tags) ? it.tags : [];
        const issue = esc(it.issue || '');
        const sol = esc(it.solution || '');
        const refs = Array.isArray(it.refs) ? it.refs : [];
        const meta = [
          ...cats.map(c => pill('cat: ' + c)),
          ...tags.map(t => pill('#' + t)),
        ].join(' ');

        const refHtml = refs.length ? ('<div class="muted" style="margin-top:10px;">Refs: ' + refs.map(r => '<code>' + esc(r) + '</code>').join(' ') + '</div>') : '';

        return `
          <details style="border:1px solid rgba(255,255,255,0.10); border-radius:14px; padding:12px; background: rgba(255,255,255,0.03); margin-top:10px;">
            <summary style="cursor:pointer; font-weight:900;">${title}</summary>
            <div style="margin-top:10px; display:flex; flex-wrap:wrap; gap:8px;">${meta}</div>
            ${issue ? ('<div class="muted" style="margin-top:10px;"><b>Issue:</b><div style="white-space:pre-wrap; margin-top:6px;">' + issue + '</div></div>') : ''}
            ${sol ? ('<div class="muted" style="margin-top:10px;"><b>Resolution:</b><div style="white-space:pre-wrap; margin-top:6px;">' + sol + '</div></div>') : ''}
            ${refHtml}
          </details>
        `;
      }).join('');
    } catch {
      list.innerHTML = '<div class="muted">Failed to load.</div>';
    }
  }

  const resRefresh = document.getElementById('resRefresh');
  if (resRefresh) resRefresh.addEventListener('click', loadResolutions);

  async function loadBossJobs(){
    const list = document.getElementById('bossJobsList');
    const msg = document.getElementById('bossJobsMsg');
    if (msg) msg.textContent = '';
    if (!list) return;
    list.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const res = await fetch('/admin/api/boss-jobs', { credentials: 'include', cache: 'no-store' });
      const j = await res.json();
      const items = (j && j.ok && Array.isArray(j.items)) ? j.items : [];
      if (!items.length) { list.innerHTML = '<div class="muted">No jobs yet.</div>'; return; }

      list.innerHTML = items.map(it => {
        const id = esc(it.id || '');
        const title = esc(it.title || it.id || '');
        const target = esc(it.target || '');
        const notes = esc(it.notes || '');
        const enabled = it.enabled !== false;
        const body = esc(it.body || '');
        return `
          <div style="border:1px solid rgba(255,255,255,0.10); border-radius:12px; padding:10px; margin-bottom:10px; background: rgba(255,255,255,0.03);">
            <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:baseline;">
              <div><b>${title}</b> <span class="muted">${enabled ? '' : '(disabled)'}</span></div>
              <div class="muted">${target ? ('to: ' + target) : ''}</div>
            </div>
            ${notes ? ('<div class="muted" style="margin-top:6px; white-space:pre-wrap;">' + notes + '</div>') : ''}
            <div class="muted" style="margin-top:10px; white-space:pre-wrap;">${body}</div>
            <div class="admRow" style="margin-top:10px;">
              <button class="tabbtn" type="button" style="width:auto;" data-run-bossjob="${id}">Run now</button>
              <span class="muted" data-run-msg="${id}"></span>
            </div>
          </div>
        `;
      }).join('');

      Array.from(list.querySelectorAll('button[data-run-bossjob]')).forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-run-bossjob') || '';
          const out = list.querySelector('[data-run-msg="' + id.replace(/"/g,'') + '"]');
          try {
            if (out) out.textContent = 'Running…';
            const r = await fetch('/admin/api/boss-jobs/run', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ id })
            });
            const jr = await r.json();
            if (!r.ok || !jr || !jr.ok) throw new Error((jr && jr.error) ? jr.error : ('http ' + r.status));
            if (out) out.textContent = 'Sent.';
            setTimeout(() => { if (out) out.textContent = ''; }, 1800);
          } catch (e) {
            if (out) out.textContent = 'Failed: ' + String(e);
          }
        });
      });
    } catch {
      list.innerHTML = '<div class="muted">Failed to load.</div>';
    }
  }

  const bossJobsRefresh = document.getElementById('bossJobsRefresh');
  if (bossJobsRefresh) bossJobsRefresh.addEventListener('click', loadBossJobs);

  async function saveBrandingMenu(){
    try {
      if (brandMenuSaved) brandMenuSaved.textContent = 'Saving…';
      const payload = { cssOverrides: String(brandMenuCss && brandMenuCss.value || '') };
      const res = await fetch('/admin/api/branding/menu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      const j = await res.json();
      if (!j || !j.ok) throw new Error('bad');
      if (brandMenuSaved) brandMenuSaved.textContent = 'Saved.';
      // menu css is served from /static/apps-menu.css with no-store, so a reload shows it everywhere
    } catch {
      if (brandMenuSaved) brandMenuSaved.textContent = 'Save failed.';
    }
  }

  function resetBrandingMenu(){
    if (brandMenuCss) brandMenuCss.value = '';
    if (brandMenuSaved) brandMenuSaved.textContent = 'Reset (not saved yet).';
  }

  if (tabSitemap) tabSitemap.addEventListener('click', () => setTab('sitemap'));
  if (tabApps) tabApps.addEventListener('click', () => setTab('apps'));
  if (tabAdoption) tabAdoption.addEventListener('click', () => setTab('adoption'));
  if (tabCRM) tabCRM.addEventListener('click', () => setTab('crm'));
  if (tabChangelog) tabChangelog.addEventListener('click', () => setTab('changelog'));
  if (tabFeatures) tabFeatures.addEventListener('click', () => setTab('features'));
  if (tabBranding) tabBranding.addEventListener('click', () => setTab('branding'));
  if (tabBossJobs) tabBossJobs.addEventListener('click', () => setTab('bossjobs'));
  if (tabResolutions) tabResolutions.addEventListener('click', () => setTab('resolutions'));
  if (crmRefresh) crmRefresh.addEventListener('click', loadCRM);

  if (brandMenuSave) brandMenuSave.addEventListener('click', saveBrandingMenu);
  if (brandMenuReset) brandMenuReset.addEventListener('click', resetBrandingMenu);

  const chgRefresh = document.getElementById('chgRefresh');
  const chgUpdate = document.getElementById('chgUpdate');
  const chgRebuild = document.getElementById('chgRebuild');
  const chgPostTeamBtn = document.getElementById('chgPostTeam');
  if (chgRefresh) chgRefresh.addEventListener('click', loadChangelog);
  if (chgUpdate) chgUpdate.addEventListener('click', () => updateChangelog('append'));
  if (chgRebuild) chgRebuild.addEventListener('click', () => updateChangelog('rebuild'));
  if (chgPostTeamBtn) chgPostTeamBtn.addEventListener('click', postChangelogToTeamDocs);

  if (adoptRefresh) adoptRefresh.addEventListener('click', loadAdoption);
  if (adoptSave) adoptSave.addEventListener('click', saveAdoption);

  setTab('sitemap');
})();
