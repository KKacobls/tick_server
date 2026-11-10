(() => {
  const byId = (id) => document.getElementById(id);
  const raw = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  const headers = {Authorization: `Bearer ${raw}`};
  const status = (text) => { byId('reader-status').textContent = text; };
  async function download(format) {
    const response = await fetch(`/api/sharing/export?format=${format}`, {headers});
    if (!response.ok) throw new Error('分享連結無效、到期或已撤銷');
    const blob = await response.blob();
    if (window.TicketScanner?.saveExport) {
      const reader = new FileReader();
      const encoded = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      window.TicketScanner.saveExport(encoded, blob.type || 'application/octet-stream', `tickets.${format}`);
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tickets.${format}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function load() {
    if (!raw) throw new Error('分享網址缺少 Token');
    const response = await fetch('/api/v1/tickets', {headers});
    if (!response.ok) throw new Error('分享連結無效、到期或已撤銷');
    const items = await response.json();
    const groups = new Map();
    const host = byId('reader-tickets');
    host.replaceChildren();
    for (const item of items) {
      if (!groups.has(item.name)) groups.set(item.name, []);
      const card = document.createElement('article');
      const title = document.createElement('h2');
      title.textContent = item.name;
      const state = document.createElement('p');
      state.textContent = ['正常', '已使用', '部分剩餘'][item.local_state] || '';
      card.append(title, state);
      for (const code of [item.barcode_text, item.barcode_text_2]) {
        if (!code) continue;
        groups.get(item.name).push(code);
        const text = document.createElement('p');
        text.className = 'barcode';
        text.textContent = code;
        const qr = document.createElement('div');
        qr.className = 'ticket-qr';
        card.append(text, qr);
        new QRCode(qr, {text: code, width: 180, height: 180});
      }
      if (item.barcode_image) {
        const imageResponse = await fetch('/api/v1/uploads/' + encodeURIComponent(item.barcode_image), {headers});
        if (imageResponse.ok) {
          const image = document.createElement('img');
          const url = URL.createObjectURL(await imageResponse.blob());
          image.alt = item.name;
          image.addEventListener('load', () => URL.revokeObjectURL(url), {once: true});
          image.src = url;
          card.append(image);
        }
      }
      host.append(card);
    }
    byId('reader-text').value = [...groups].map(([name, codes]) => [name, ...codes].join('\n')).join('\n\n');
    byId('reader-text').hidden = false;
    byId('reader-actions').hidden = false;
    const cached = response.headers.get('X-Ticket-Sync') === 'cached';
    status(`${items.length} 張票券 · 唯讀${cached ? ' · Main 無回應，顯示本機保留票券' : ''}`);
  }
  async function run(work) {
    try { await work(); }
    catch (error) { status(error.message); }
  }
  byId('reader-refresh').addEventListener('click', () => run(load));
  byId('reader-copy').addEventListener('click', () => run(async () => {
    const input = byId('reader-text');
    if (navigator.clipboard && isSecureContext) await navigator.clipboard.writeText(input.value);
    else { input.focus(); input.select(); document.execCommand('copy'); }
    status('已複製票券文字');
  }));
  for (const format of ['txt', 'json', 'zip']) byId('reader-' + format).addEventListener('click', () => run(() => download(format)));
  window.addEventListener('pageshow', (event) => { if (event.persisted) run(load); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') run(load); });
  run(load);
})();
