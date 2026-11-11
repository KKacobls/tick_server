(() => {
  const byId = (id) => document.getElementById(id);
  let enabled = false;
  let mode = 'main';
  let pendingProposal = null;
  const status = (text) => { byId('auxiliary-status').textContent = text; };
  async function run(button, action) {
    button.disabled = true;
    try { await action(); }
    catch (error) { status(error.message); }
    finally { button.disabled = false; }
  }
  function button(label, action) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'btn-secondary';
    element.textContent = label;
    element.addEventListener('click', () => run(element, action));
    return element;
  }
  async function refreshRequests() {
    if (mode !== 'main') return;
    const requests = await api('/api/auxiliary/requests');
    byId('auxiliary-count').textContent = String(requests.length);
    const host = byId('auxiliary-requests');
    host.replaceChildren();
    for (const request of requests) {
      const details = document.createElement('details');
      details.className = 'upload-request';
      const summary = document.createElement('summary');
      summary.textContent = `${request.source_name} · ${request.tickets.length} 張 · ${new Date(request.created_at).toLocaleString()}`;
      details.append(summary);
      request.tickets.forEach((ticket, index) => {
        const text = document.createElement('pre');
        text.textContent = JSON.stringify(ticket, null, 2);
        details.append(text);
        if (request.image_indices.includes(String(index))) {
          details.append(button('檢視圖片', async () => {
            const response = await fetch(`/api/auxiliary/requests/${request.id}/images/${index}`, {headers: headers(false)});
            if (!response.ok) throw new Error('圖片讀取失敗');
            const image = document.createElement('img');
            const url = URL.createObjectURL(await response.blob());
            image.addEventListener('load', () => URL.revokeObjectURL(url), {once: true});
            image.src = url;
            image.alt = ticket.name;
            details.append(image);
          }));
        }
      });
      for (const [label, decision] of [['接受', 'accept'], ['拒絕', 'reject']]) {
        details.append(button(label, async () => {
          const result = await api(`/api/auxiliary/requests/${request.id}/${decision}`, {method: 'POST'});
          await refreshRequests();
          await loadTickets(true);
          status(decision === 'accept' ? `已接受：新增 ${result.result.created} 張，重複略過 ${result.result.skipped} 張` : '已拒絕');
        }));
      }
      host.append(details);
    }
  }
  async function refreshDrafts() {
    const host = byId('auxiliary-drafts');
    host.replaceChildren();
    if (mode !== 'client') return;
    const drafts = await api('/api/auxiliary/drafts');
    host.replaceChildren();
    host.classList.toggle('hidden', drafts.length === 0);
    for (const draft of drafts) {
      const row = document.createElement('div');
      const title = document.createElement('p');
      title.textContent = `未送出：${draft.tickets.map((ticket) => ticket.name).join('、')}`;
      row.append(title, button('重送', async () => {
        await api('/api/auxiliary/submit', {method: 'POST', body: JSON.stringify(draft)});
        status('已送交 Main 審核');
        await refreshDrafts();
      }));
      host.append(row);
    }
  }
  async function initialize() {
    if (!token) return;
    try {
      const settings = await api('/api/auxiliary/settings');
      enabled = settings.enabled;
      mode = settings.mode;
      byId('auxiliary-enabled').checked = enabled;
      byId('auxiliary-enabled-label').textContent = mode === 'main' ? '接受輔助上傳申請' : '啟用此輔助上傳';
      byId('auxiliary-review').classList.toggle('hidden', mode !== 'main');
      window.ticketExchange?.applyPermissions();
      await Promise.all([refreshRequests(), refreshDrafts()]);
    } catch (error) { status(error.message); }
  }
  async function submitItems(items, file) {
    if (!enabled || mode !== 'client') throw new Error('請先在設定啟用輔助上傳');
    const images = {};
    if (file) {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      images['0'] = data;
    }
    // Keep the same request id across a network retry to prevent duplicate approvals.
    const contents = JSON.stringify({tickets: items, images});
    if (!pendingProposal || pendingProposal.contents !== contents) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      pendingProposal = {contents, body: {id, source_name: '手機／輔助', tickets: items, images}};
    }
    try {
      await api('/api/auxiliary/submit', {method: 'POST', body: JSON.stringify(pendingProposal.body)});
      pendingProposal = null;
      status('已送交 Main 審核');
    } finally { await refreshDrafts(); }
  }
  byId('auxiliary-enabled').addEventListener('change', (event) => run(event.currentTarget, async () => {
    await api('/api/auxiliary/settings', {method: 'PUT', body: JSON.stringify({enabled: event.currentTarget.checked})});
    await initialize();
    status('已儲存');
  }));
  byId('auxiliary-refresh').addEventListener('click', (event) => run(event.currentTarget, refreshRequests));
  document.querySelector('.tab[data-tab="settings"]').addEventListener('click', initialize);
  document.addEventListener('ticket-auth-ready', initialize);
  window.ticketAuxiliary = {initialize, submitItems, get canUpload() { return enabled && mode === 'client'; }};
  if (token) initialize();
})();
