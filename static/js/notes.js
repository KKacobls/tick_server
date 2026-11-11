(() => {
  const imageUrls = new Map();
  const bodyText = (ticket) => ticket.note_text ?? [ticket.barcode_text, ticket.barcode_text_2].filter(Boolean).join('\n');
  function linkedText(text) {
    const host = document.createElement('div');
    host.className = 'note-text';
    // Recognize Markdown links first so their parentheses never become part of the URL.
    const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>\[\]]+)/gi;
    let offset = 0;
    for (const match of String(text).matchAll(pattern)) {
      host.append(document.createTextNode(text.slice(offset, match.index)));
      const link = document.createElement('a');
      const url = match[2] || match[3].replace(/[),.;，。；]+$/, '');
      const trailing = match[3] ? match[3].slice(url.length) : '';
      link.href = url;
      link.textContent = match[1] || url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      host.append(link, document.createTextNode(trailing));
      offset = match.index + match[0].length;
    }
    host.append(document.createTextNode(text.slice(offset)));
    return host;
  }
  function imageFor(filename) {
    if (!imageUrls.has(filename)) {
      imageUrls.set(filename, fetch('/api/uploads/' + encodeURIComponent(filename), {headers: headers(false)})
        .then((response) => {
          if (!response.ok) throw new Error('圖片讀取失敗');
          return response.blob();
        }).then((blob) => URL.createObjectURL(blob)));
    }
    return imageUrls.get(filename);
  }
  function button(label, action) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'btn-secondary';
    element.textContent = label;
    element.addEventListener('click', async () => {
      element.disabled = true;
      try { await action(); }
      catch (error) { alert(error.message); }
      finally { element.disabled = false; }
    });
    return element;
  }
  function addTitleImage(host, title, items) {
    const filename = items.find((item) => item.title_image)?.title_image;
    if (filename) {
      const image = document.createElement('img');
      image.className = 'title-image';
      image.alt = title;
      image.loading = 'lazy';
      imageFor(filename).then((url) => { image.src = url; }).catch(() => { image.alt = '圖片讀取失敗'; });
      host.append(image);
    }
    if (window.ticketExchange?.readOnly) return;
    const controls = document.createElement('div');
    controls.className = 'title-image-actions';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.hidden = true;
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const form = new FormData();
        form.append('file', file);
        await api('/api/titles/image?' + new URLSearchParams({name: title}), {method: 'POST', body: form});
        await loadTickets(false);
      } catch (error) { alert(error.message); }
    });
    controls.append(input, button(filename ? '更換標題圖片' : '標題圖片', () => input.click()));
    if (filename) controls.append(button('移除圖片', async () => {
      await api('/api/titles/image?' + new URLSearchParams({name: title}), {method: 'DELETE'});
      await loadTickets(false);
    }));
    host.append(controls);
  }
  function render() {
    const host = document.getElementById('note-list');
    if (!host) return;
    const groups = new Map();
    for (const item of tickets.filter(isNote)) {
      if (!groups.has(item.name)) groups.set(item.name, []);
      groups.get(item.name).push(item);
    }
    host.replaceChildren();
    if (!groups.size) {
      const empty = document.createElement('p');
      empty.className = 'hint-text';
      empty.textContent = '沒有筆記';
      host.append(empty);
    }
    for (const [title, items] of groups) {
      const article = document.createElement('article');
      article.className = 'note-card';
      const heading = document.createElement('h3');
      heading.textContent = title;
      article.append(heading);
      addTitleImage(article, title, items);
      for (const item of items) {
        const section = document.createElement('section');
        section.className = 'note-entry';
        section.append(linkedText(bodyText(item)));
        if (!window.ticketExchange?.readOnly) {
          const edit = button('編輯', () => {
            const textarea = document.createElement('textarea');
            textarea.rows = 6;
            textarea.value = bodyText(item);
            section.replaceChildren(textarea, button('儲存', async () => {
              await api(`/api/tickets/${item.id}`, {method: 'PATCH', body: JSON.stringify({note_text: textarea.value})});
              await loadTickets(false);
            }), button('取消', render));
          });
          const remove = button('刪除', async () => {
            if (!confirm('刪除這筆筆記？')) return;
            await api(`/api/notes/${item.id}`, {method: 'DELETE'});
            await loadTickets(false);
          });
          section.append(edit, remove);
        }
        article.append(section);
      }
      host.append(article);
    }
  }
  document.querySelector('.tab[data-tab="notes"]').addEventListener('click', render);
  document.addEventListener('ticket-auth-ended', () => {
    for (const promise of imageUrls.values()) promise.then((url) => URL.revokeObjectURL(url)).catch(() => {});
    imageUrls.clear();
    document.getElementById('note-list').replaceChildren();
  });
  window.ticketNotes = {render, addTitleImage};
  render();
})();
