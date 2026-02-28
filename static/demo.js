(function(){
  const chatEl = document.getElementById('chat');
  const delEl = document.getElementById('del');

  function esc(s){
    return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function renderMessages(msgs){
    chatEl.innerHTML = '';
    for(const m of msgs){
      const role = m.r === 'assistant' ? 'assistant' : 'user';
      const node = document.createElement('div');
      node.className = 'msg ' + role;
      node.innerHTML = `
        <div class="meta">
          <div class="name">${role === 'assistant' ? 'Clawd' : 'You'}</div>
          <div class="ts">${esc(m.t)}</div>
        </div>
        <div class="txt">${esc(m.x)}</div>
      `;
      if (Array.isArray(m.d) && m.d.length){
        const ul = document.createElement('ul');
        ul.className = 'list';
        for(const it of m.d){
          const li = document.createElement('li');
          li.textContent = it;
          ul.appendChild(li);
        }
        node.appendChild(ul);
      }
      chatEl.appendChild(node);
    }
  }

  function renderDEL(state){
    delEl.innerHTML = '';
    const active = state && state.lists && state.lists[state.activeIndex];
    if(!active){
      delEl.textContent = 'No DEL state.';
      return;
    }
    const title = document.createElement('div');
    title.className = 'dtitle';
    title.textContent = active.title || 'DEL';
    delEl.appendChild(title);

    const items = Array.isArray(active.items) ? active.items : [];
    for(const it of items){
      const row = document.createElement('div');
      row.className = 'drow' + (it.done ? ' done' : '');
      row.innerHTML = `<span class="cb">${it.done ? '✓' : '•'}</span><span>${esc(it.text)}</span>`;
      delEl.appendChild(row);
    }
  }

  async function load(){
    const [m, d] = await Promise.all([
      fetch('/demo/api/messages').then(r=>r.json()),
      fetch('/demo/api/del').then(r=>r.json()),
    ]);
    renderMessages(m.messages || []);
    renderDEL((d && d.state) || null);
  }

  load().catch(err => {
    chatEl.innerHTML = '<div class="muted">Demo failed to load.</div>';
    console.error(err);
  });
})();
