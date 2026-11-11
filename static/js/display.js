// Public display: URL data only; never contacts the ticket APIs or browser storage.
function displayItems() {
  const params = new URLSearchParams(location.search);
  const values = params.getAll('list');
  const items = values.length ? values.flatMap((value) => {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  }) : [{name: params.get('name') || '', barcode: params.get('barcode') || ''}];
  if (items.length > 100 || location.search.length > 50000) throw new Error('最多 100 筆');
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    if (!item || typeof item !== 'object') throw new Error('list 格式錯誤');
    const name = String(item.name ?? item.text ?? '');
    const codes = item.barcodes ?? [item.barcode ?? item.barcode_text ?? '', item.barcode_text_2 ?? ''];
    if (!Array.isArray(codes) || codes.length > 20 || name.length > 512) throw new Error('名稱或條碼格式錯誤');
    const article = document.createElement('article');
    const heading = document.createElement('h1');
    heading.textContent = name;
    article.append(heading);
    for (const value of codes) {
      const code = String(value);
      if (!code) continue;
      if (code.length > 128) throw new Error('條碼最多 128 字');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', code);
      const text = document.createElement('p');
      text.className = 'code';
      text.textContent = code;
      try { JsBarcode(svg, code, {format: 'CODE128', width: 2, height: 90, displayValue: false, background: '#ffffff', lineColor: '#000000', margin: 12}); }
      catch { throw new Error('條碼含有 CODE128 不支援的文字'); }
      article.append(svg, text);
    }
    fragment.append(article);
  }
  document.querySelector('#items').replaceChildren(fragment);
}
try { displayItems(); }
catch (error) { document.querySelector('#error').textContent = error.message; }
