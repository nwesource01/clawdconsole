// ClawdPM tags bar (tri-state + manage dialog)
(() => {
  const esc = (s) => String(s||'').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function apiUrl(p){ return new URL(p, window.location.origin).toString(); }

  const tagsEl = document.getElementById('pmTags');
  const clearBtn = document.getElementById('pmTagClear');
  const manageBtn = document.getElementById('pmTagManage');

  const TAGS_LS_KEY = 'claw_pm_tag_state_v1';
  let TAGS = [];
  let tagState = {};

  function triNext(st){
    const s = String(st||'off');
    if (s === 'off') return 'in';
    if (s === 'in') return 'out';
    return 'off';
  }

  function loadTagState(){
    try {
      const raw = localStorage.getItem(TAGS_LS_KEY);
      if (!raw) return {};
      const j = JSON.parse(raw);
      return (j && typeof j === 'object') ? j : {};
    } catch { return {}; }
  }
  function saveTagState(){
    try { localStorage.setItem(TAGS_LS_KEY, JSON.stringify(tagState||{})); } catch {}
  }
  function inTags(){ return Object.entries(tagState||{}).filter(([,v]) => v==='in').map(([k]) => k); }
  function outTags(){ return Object.entries(tagState||{}).filter(([,v]) => v==='out').map(([k]) => k); }

  async function loadTags(){
    tagState = loadTagState();
    try {
      const res = await fetch(apiUrl('/api/tags?namespace=project'), { credentials:'include', cache:'no-store' });
      const j = await res.json();
      if (!res.ok || !j || !j.ok) throw new Error('http ' + res.status);
      TAGS = Array.isArray(j.tags) ? j.tags : [];
      const known = new Set(TAGS.map(t => String(t && t.id || '')));
      for (const k of Object.keys(tagState||{})) { if (!known.has(k)) delete tagState[k]; }
      saveTagState();
    } catch {
      TAGS = [];
    }
    renderTagRow();
  }

  function renderTagRow(){
    if (!tagsEl) return;
    const tags = (TAGS||[]).slice().sort((a,b) => String(a.title||a.id||'').localeCompare(String(b.title||b.id||'')));
    tagsEl.innerHTML = tags.map(t => {
      const id = String(t.id||'');
      const title = String(t.title||id||'');
      const st = (tagState && tagState[id]) ? tagState[id] : 'off';
      return '<button type="button" class="pillbtn ' + esc(st) + '" data-tag="' + esc(id) + '" data-state="' + esc(st) + '">' + esc(title) + '</button>';
    }).join('');

    Array.from(tagsEl.querySelectorAll('button[data-tag]')).forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-tag') || '';
        const cur = (tagState && tagState[id]) ? tagState[id] : 'off';
        const nxt = triNext(cur);
        if (nxt === 'off') delete tagState[id];
        else tagState[id] = nxt;
        saveTagState();
        renderTagRow();
        // Trigger PM re-render (pm.js listens)
        window.dispatchEvent(new CustomEvent('claw_pm_tags_changed', { detail: { in: inTags(), out: outTags() } }));
      });
    });

    if (clearBtn) {
      clearBtn.onclick = () => {
        tagState = {};
        saveTagState();
        renderTagRow();
        window.dispatchEvent(new CustomEvent('claw_pm_tags_changed', { detail: { in: inTags(), out: outTags() } }));
      };
    }
  }

  function ensureManageDialog(){
    let host = document.getElementById('tagManageModal');
    if (host) return host;

    host = document.createElement('div');
    host.id = 'tagManageModal';
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.zIndex = '9999';
    host.style.display = 'none';
    host.style.background = 'rgba(0,0,0,0.55)';

    host.innerHTML = ''
      + '<div style="width:min(920px,96vw); max-height:calc(100vh - 36px); margin:18px auto; border:1px solid rgba(255,255,255,.14); border-radius:16px; background:rgba(11,15,26,.96); box-shadow: 0 25px 70px rgba(0,0,0,.55); overflow:hidden; display:flex; flex-direction:column;">'
      +   '<div style="padding:14px; border-bottom:1px solid rgba(255,255,255,.10); display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">'
      +     '<div><div style="font-weight:900; font-size:16px;">Manage Tags</div><div class="muted" style="font-size:12px; margin-top:4px;">Custom tags can be deleted. Auto-tags (workspace) cannot.</div></div>'
      +     '<button id="tagManageClose" class="close" type="button">Close</button>'
      +   '</div>'
      +   '<div style="padding:14px; overflow:auto;">'
      +     '<div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">'
      +       '<input id="tagManageNewTitle" placeholder="New Tag Name" style="flex:1; min-width:260px; padding:10px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.14); background:#0d1426; color:#e8eefc;" />'
      +       '<input id="tagManageNewDisplayName" placeholder="Tag Display Name" style="flex:1; min-width:260px; padding:10px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.14); background:#0d1426; color:#e8eefc;" />'
      +       '<button id="tagManageCreate" class="btn" type="button">+ Tag</button>'
      +     '</div>'
      +     '<div class="muted" id="tagManageMsg" style="margin-top:10px; font-size:12px;"></div>'
      +     '<div style="margin-top:14px; display:grid; grid-template-columns: 1fr 1fr; gap:12px;">'
      +       '<div style="border:1px solid rgba(255,255,255,0.10); border-radius:14px; padding:12px; background: rgba(255,255,255,0.03);">'
      +         '<div style="font-weight:900;">Custom Tags</div>'
      +         '<div id="tagManageCustom" style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;"></div>'
      +       '</div>'
      +       '<div style="border:1px solid rgba(255,255,255,0.10); border-radius:14px; padding:12px; background: rgba(255,255,255,0.03);">'
      +         '<div style="font-weight:900;">Auto-tags</div>'
      +         '<div id="tagManageAuto" style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;"></div>'
      +       '</div>'
      +     '</div>'
      +   '</div>'
      + '</div>';

    document.body.appendChild(host);

    const closeBtn = host.querySelector('#tagManageClose');
    if (closeBtn) closeBtn.addEventListener('click', () => { host.style.display = 'none'; });
    host.addEventListener('click', (e) => { if (e && e.target === host) host.style.display = 'none'; });
    return host;
  }

  async function openManageDialog(){
    const modal = ensureManageDialog();
    const msgEl = modal.querySelector('#tagManageMsg');
    const customEl = modal.querySelector('#tagManageCustom');
    const autoEl = modal.querySelector('#tagManageAuto');
    const newTitle = modal.querySelector('#tagManageNewTitle');
    const newDisplay = modal.querySelector('#tagManageNewDisplayName');
    const btnCreate = modal.querySelector('#tagManageCreate');

    function setM(t){ try { if (msgEl) msgEl.textContent = String(t||''); } catch {} }

    async function reloadTags(){
      await loadTags();
      const custom = (TAGS||[]).filter(t => String(t.source||'manual') === 'manual');
      const auto = (TAGS||[]).filter(t => String(t.source||'manual') !== 'manual');

      function pill(t, canEdit){
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.gap = '6px';
        wrap.style.alignItems = 'center';

        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pillbtn off';
        b.textContent = String(t.displayName||t.title||t.id);
        b.title = canEdit ? 'Rename / delete tag' : 'Auto-tag (cannot edit)';
        b.disabled = !canEdit;

        const btnEdit = document.createElement('button');
        btnEdit.type = 'button';
        btnEdit.className = 'pillbtn off';
        btnEdit.textContent = '✎';
        btnEdit.title = 'Rename';
        btnEdit.disabled = !canEdit;

        const btnDel = document.createElement('button');
        btnDel.type = 'button';
        btnDel.className = 'pillbtn off';
        btnDel.textContent = '🗑';
        btnDel.title = 'Delete';
        btnDel.disabled = !canEdit;

        function openEditor(){
          const isWs = String(t.source||'') === 'workspace';
          const curName = String(t.title||t.id);
          const curDisp = String(t.displayName||t.title||t.id);

          wrap.innerHTML = '';
          const nameIn = document.createElement('input');
          nameIn.value = curName;
          nameIn.placeholder = 'New Tag Name';
          nameIn.style.flex = '1';
          nameIn.style.minWidth = '180px';
          nameIn.style.padding = '8px 10px';
          nameIn.style.borderRadius = '10px';
          nameIn.style.border = '1px solid rgba(255,255,255,0.14)';
          nameIn.style.background = '#0d1426';
          nameIn.style.color = '#e8eefc';
          if (isWs) {
            nameIn.disabled = true;
            nameIn.title = 'Workspace tag name is locked (display name only)';
            nameIn.style.opacity = '0.6';
          }

          const dispIn = document.createElement('input');
          dispIn.value = curDisp;
          dispIn.placeholder = 'Tag Display Name';
          dispIn.style.flex = '1';
          dispIn.style.minWidth = '180px';
          dispIn.style.padding = '8px 10px';
          dispIn.style.borderRadius = '10px';
          dispIn.style.border = '1px solid rgba(255,255,255,0.14)';
          dispIn.style.background = '#0d1426';
          dispIn.style.color = '#e8eefc';

          const saveBtn = document.createElement('button');
          saveBtn.type = 'button';
          saveBtn.className = 'pillbtn';
          saveBtn.textContent = 'Save';

          const cancelBtn = document.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.className = 'pillbtn off';
          cancelBtn.textContent = 'Cancel';

          cancelBtn.onclick = async () => { await reloadTags(); };
          saveBtn.onclick = async () => {
            const payload = { id: String(t.id) };
            if (!isWs) payload.title = String(nameIn.value||'').trim();
            payload.displayName = String(dispIn.value||'').trim();

            if (!isWs && !payload.title) return alert('Tag name is required.');
            if (!payload.displayName) return alert('Display name is required.');

            try {
              const res = await fetch(apiUrl('/api/tags/update'), { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', cache:'no-store', body: JSON.stringify(payload) });
              const j = await res.json().catch(() => null);
              if (!res.ok || !j || !j.ok) throw new Error((j && (j.message || j.error)) ? (j.message || j.error) : ('http ' + res.status));
              setM('Saved.');
              await reloadTags();
            } catch (e) { alert(String(e)); }
          };

          wrap.appendChild(nameIn);
          wrap.appendChild(dispIn);
          wrap.appendChild(saveBtn);
          wrap.appendChild(cancelBtn);
          try { (isWs ? dispIn : nameIn).focus(); } catch {}
        }

        async function doDelete(){
          const ok = confirm('Delete tag "' + String(t.title||t.id) + '"?');
          if (!ok) return;
          try {
            const res = await fetch(apiUrl('/api/tags/delete'), { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', cache:'no-store', body: JSON.stringify({ id: String(t.id) }) });
            const j = await res.json().catch(() => null);
            if (!res.ok || !j || !j.ok) throw new Error((j && (j.message || j.error)) ? (j.message || j.error) : ('http ' + res.status));
            setM('Deleted.');
            try { if (tagState && tagState[t.id]) delete tagState[t.id]; saveTagState(); } catch {}
            await reloadTags();
          } catch (e) { alert(String(e)); }
        }

        if (canEdit) {
          b.addEventListener('click', openEditor);
          btnEdit.addEventListener('click', openEditor);
          btnDel.addEventListener('click', doDelete);
        }

        wrap.appendChild(b);
        wrap.appendChild(btnEdit);
        wrap.appendChild(btnDel);
        return wrap;
      }

      if (customEl) {
        customEl.innerHTML = '';
        if (!custom.length) customEl.innerHTML = '<div class="muted" style="font-size:12px;">(none)</div>';
        else custom.forEach(t => customEl.appendChild(pill(t, true)));
      }
      if (autoEl) {
        autoEl.innerHTML = '';
        if (!auto.length) autoEl.innerHTML = '<div class="muted" style="font-size:12px;">(none)</div>';
        else auto.forEach(t => autoEl.appendChild(pill(t, String(t.source||'') === 'workspace' ? true : false)));
      }

      renderTagRow();
      window.dispatchEvent(new CustomEvent('claw_pm_tags_changed', { detail: { in: inTags(), out: outTags() } }));
    }

    if (btnCreate) {
      btnCreate.onclick = async () => {
        const title = String(newTitle && newTitle.value || '').trim();
        const displayName = String(newDisplay && newDisplay.value || '').trim();
        if (!title) return;
        setM('Creating…');
        try {
          const res = await fetch(apiUrl('/api/tags/create'), { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', cache:'no-store', body: JSON.stringify({ title, displayName }) });
          const j = await res.json().catch(() => null);
          if (!res.ok || !j || !j.ok) throw new Error((j && (j.message || j.error)) ? (j.message || j.error) : ('http ' + res.status));
          if (newTitle) newTitle.value = '';
          if (newDisplay) newDisplay.value = '';
          setM('Created.');
          await reloadTags();
        } catch (e) { alert('Tag create failed: ' + String(e)); setM('Create failed.'); }
      };
    }

    modal.style.display = 'block';
    setM('');
    await reloadTags();
    try { newTitle && newTitle.focus(); } catch {}
  }

  if (manageBtn) manageBtn.addEventListener('click', openManageDialog);

  function allTags(){ return TAGS || []; }

  // expose helpers so pm.js can filter + pick
  window.__clawPmTags = { inTags, outTags, loadTags, allTags };

  loadTags();
})();
