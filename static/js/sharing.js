(() => {
  const byId = (id) => document.getElementById(id);
  const message = (text) => { byId('exchange-status').textContent = text; };
  const run = async (button, work) => {
    button.disabled = true;
    try { await work(); }
    catch (error) { message(error.message); }
    finally { button.disabled = false; }
  };

  function defaultExpiry() {
    const expiry = new Date(Date.now() + 30 * 86400000);
    expiry.setMinutes(expiry.getMinutes() - expiry.getTimezoneOffset());
    byId('share-expiry').value = expiry.toISOString().slice(0, 16);
  }

  async function copyField(id) {
    const input = byId(id);
    if (navigator.clipboard && isSecureContext) {
      await navigator.clipboard.writeText(input.value);
      message('已複製');
    } else {
      input.focus();
      input.select();
      message(document.execCommand('copy') ? '已複製' : '已選取文字，請複製');
    }
  }

  function refreshText() {
    const groups = new Map();
    for (const item of tickets) {
      if (!groups.has(item.name)) groups.set(item.name, []);
      for (const code of [item.barcode_text, item.barcode_text_2]) {
        if (code) groups.get(item.name).push(code);
      }
      if (item.note_text) groups.get(item.name).push(item.note_text);
    }
    byId('ticket-text-export').value = [...groups].map(([name, codes]) => [name, ...codes].join('\n')).join('\n\n');
  }

  async function refreshTokens() {
    const entries = await api('/api/sharing/tokens');
    const host = byId('share-token-list');
    host.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'share-token-row';
      const label = document.createElement('span');
      const state = entry.revoked ? '已撤銷' : entry.expired ? '已到期' : '有效';
      label.textContent = `${entry.name} · ${entry.prefix}… · ${new Date(entry.expires_at).toLocaleString()} · ${state}`;
      row.append(label);
      if (!entry.revoked && !entry.expired) {
        const button = document.createElement('button');
        button.className = 'btn-danger';
        button.type = 'button';
        button.textContent = '撤銷';
        button.addEventListener('click', () => run(button, async () => {
          await api(`/api/sharing/tokens/${encodeURIComponent(entry.id)}/revoke`, {method: 'POST'});
          await refreshTokens();
          message('已撤銷，該分享網址及 Token 已失效');
        }));
        row.append(button);
      }
      host.append(row);
    }
  }

  byId('create-share-btn').addEventListener('click', (event) => run(event.currentTarget, async () => {
    const value = byId('share-expiry').value;
    if (!value) throw new Error('請設定有效期限');
    const item = await api('/api/sharing/tokens', {method: 'POST', body: JSON.stringify({
      name: byId('share-name').value.trim(), expires_at: new Date(value).toISOString(),
    })});
    const url = new URL('/share', location.origin);
    url.search = new URLSearchParams({token: item.token}).toString();
    byId('share-link').value = url.href;
    byId('share-token').value = item.token;
    byId('share-qr').replaceChildren();
    new QRCode(byId('share-qr'), {text: url.href, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M});
    byId('share-created').classList.remove('hidden');
    await refreshTokens();
    message('已新增讀取 Token');
  }));
  for (const [button, field] of [['copy-share-link-btn', 'share-link'], ['copy-share-token-btn', 'share-token'], ['copy-ticket-text-btn', 'ticket-text-export']]) {
    byId(button).addEventListener('click', (event) => run(event.currentTarget, () => copyField(field)));
  }
  byId('export-txt-btn').addEventListener('click', (event) => run(event.currentTarget, () => window.ticketExchange.exportFile('txt')));
  byId('print-share-btn').addEventListener('click', () => {
    const canvas = byId('share-qr').querySelector('canvas');
    if (!canvas) return;
    const popup = window.open('', '_blank', 'width=500,height=650');
    if (!popup) { message('請允許開啟列印視窗'); return; }
    popup.document.title = '票券分享 QR Code';
    const heading = popup.document.createElement('h1');
    heading.textContent = byId('share-name').value || '票券分享';
    const image = popup.document.createElement('img');
    image.width = 300;
    image.height = 300;
    image.addEventListener('load', () => popup.print(), {once: true});
    image.src = canvas.toDataURL('image/png');
    const text = popup.document.createElement('p');
    text.style.overflowWrap = 'anywhere';
    text.textContent = byId('share-link').value;
    popup.document.body.append(heading, image, text);
  });
  async function initialize() {
    defaultExpiry();
    refreshText();
    try { await refreshTokens(); }
    catch (error) { message(error.message); }
  }
  document.addEventListener('ticket-auth-ready', initialize);
  document.addEventListener('ticket-drawers-rendered', refreshText);
  document.addEventListener('ticket-auth-ended', () => {
    for (const id of ['share-link', 'share-token', 'ticket-text-export']) byId(id).value = '';
    byId('share-created').classList.add('hidden');
    byId('share-qr').replaceChildren();
  });
  if (token) initialize();
  else defaultExpiry();
})();
