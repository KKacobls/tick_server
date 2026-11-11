/* Ticket UI - comments in zh-TW where helpful */

const API = "";
function isNote(ticket) {
  return ticket.note_text !== null && ticket.note_text !== undefined || /http/i.test(ticket.barcode_text || '') || /http/i.test(ticket.barcode_text_2 || '');
}
let token = localStorage.getItem("ticket_token") || "";
let tickets = [];
let displayOrder = []; // stable order; no reorder on state click
let pendingNumpadId = null;
let importPreviewItems = [];
const inflightState = new Set();
let sortMode = localStorage.getItem("ticket_sort_mode") || "item"; // date|item
let drawerMode = localStorage.getItem("drawer_mode") || "categorized";
const expandedTitleDrawers = new Set();
const storedBcType = localStorage.getItem("bc_type") || "qrcode";
const storedHideUsed = localStorage.getItem("hide_used") === "1";
const storedTheme = localStorage.getItem("theme") || "dark";

function todayIso() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const STATE_LABEL = { 0: "正常", 1: "已使用", 2: "部分剩餘" };
const EXPIRY_NOTE_LABEL = {
  etk_promo_end: "活動期限",
  redemption_period: "兌換期限",
  no_insert_date: "缺少日期",
};

function expiryNoteText(note) {
  if (!note) return "";
  if (EXPIRY_NOTE_LABEL[note]) return EXPIRY_NOTE_LABEL[note];
  if (/^insert\+\d+m$/.test(note)) return "新增日+月數";
  return "其他";
}

function headers(json = true) {
  const h = { Authorization: `Bearer ${token}` };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function api(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const baseHeaders = isForm
    ? { Authorization: `Bearer ${token}` }
    : headers(opts.body !== undefined);
  const res = await fetch(API + path, {
    ...opts,
    headers: { ...baseHeaders, ...opts.headers },
  });
  if (res.status === 401) {
    logout();
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || res.statusText);
  }
  const syncStatus = res.headers.get('X-Ticket-Sync');
  if (syncStatus) document.dispatchEvent(new CustomEvent('ticket-sync-status', {detail: syncStatus}));
  if (res.status === 204) return null;
  return res.json();
}

function logout() {
  token = "";
  localStorage.removeItem("ticket_token");
  document.dispatchEvent(new Event('ticket-auth-ended'));
  document.getElementById("app-view").classList.add("hidden");
  document.getElementById("login-view").classList.remove("hidden");
  fetch('/api/auth/logout', {method: 'POST'}).finally(() => location.replace('/login'));
}

function showApp() {
  document.getElementById("login-view").classList.add("hidden");
  document.getElementById("app-view").classList.remove("hidden");
  document.dispatchEvent(new Event("ticket-auth-ready"));
}

function bcType() {
  return document.querySelector('input[name="bc-type"]:checked')?.value || "qrcode";
}

function ticketDateKey(t) {
  return t.expires_at || t.insert_date || "9999-99-99";
}

function sortTicketsByTime(list) {
  return [...list].sort((a, b) => {
    const da = ticketDateKey(a);
    const db = ticketDateKey(b);
    if (da !== db) return da.localeCompare(db);
    return a.id - b.id;
  });
}

function sortTicketsByTimeUsedLast(list) {
  return [...list].sort((a, b) => {
    const ua = a.local_state > 0 ? 1 : 0;
    const ub = b.local_state > 0 ? 1 : 0;
    if (ua !== ub) return ua - ub;
    const da = ticketDateKey(a);
    const db = ticketDateKey(b);
    if (da !== db) return da.localeCompare(db);
    return a.id - b.id;
  });
}

function sortTicketsForInitialLoad(list) {
  const arr = [...list].sort((a, b) => {
    const ua = a.local_state > 0 ? 1 : 0;
    const ub = b.local_state > 0 ? 1 : 0;
    if (ua !== ub) return ua - ub;
    if (sortMode === "item") {
      const na = (a.name || "").localeCompare(b.name || "");
      if (na !== 0) return na;
    }
    const da = ticketDateKey(a);
    const db = ticketDateKey(b);
    if (da !== db) return da.localeCompare(db);
    return a.id - b.id;
  });
  return arr;
}

async function loadTickets(rebuildOrder = true) {
  const params = new URLSearchParams({ include_hidden_used: "true" });
  const list = await api(`/api/tickets?${params}`);
  tickets = list;
  if (rebuildOrder) {
    const sorted = sortTicketsForInitialLoad(list);
    displayOrder = sorted.map((t) => t.id);
  } else {
    const map = Object.fromEntries(list.map((t) => [t.id, t]));
    tickets = displayOrder.map((id) => map[id]).filter(Boolean);
    list.forEach((t) => {
      if (!displayOrder.includes(t.id)) displayOrder.push(t.id);
    });
    tickets = displayOrder.map((id) => map[id]).filter(Boolean);
  }
  renderList();
  window.ticketNotes?.render();
}

function filteredTickets() {
  const hideUsed = document.getElementById("hide-used-chk").checked;
  return displayOrder
    .map((id) => tickets.find((t) => t.id === id))
    .filter(Boolean)
    .filter((t) => !isNote(t))
    .filter((t) => {
      if (hideUsed && t.local_state > 0) return false;
      if (drawerMode.startsWith("brand:")) {
        const brand = drawerMode.slice(6);
        if ((t.brand_tag || "") !== brand) return false;
      }
      return true;
    });
}

function renderBarcodeInto(wrap, text, imageName) {
  const canvas = wrap.querySelector(".bc-canvas");
  const img = wrap.querySelector(".bc-image");
  const qrBox = wrap.querySelector(".qr-box");
  const textEl = wrap.querySelector(".bc-text");
  canvas.classList.add("hidden");
  img.classList.add("hidden");
  if (qrBox) qrBox.classList.add("hidden");
  if (textEl) textEl.textContent = "";

  if (imageName && !text) {
    const prefix = "/api/uploads/";
    fetch(prefix + encodeURIComponent(imageName), { headers: headers(false) })
      .then((response) => {
        if (!response.ok) throw new Error("圖片讀取失敗");
        return response.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        img.onload = () => URL.revokeObjectURL(url);
        img.onerror = () => URL.revokeObjectURL(url);
        img.src = url;
        img.classList.remove("hidden");
        if (textEl) textEl.textContent = "圖片票券";
      })
      .catch(() => { if (textEl) textEl.textContent = "圖片讀取失敗，請重新載入"; });
    return;
  }
  if (!text) return;
  if (textEl) textEl.textContent = text;

  canvas.classList.remove("hidden");
  const type = bcType();
  try {
    if (type === "qrcode") {
      if (!window.QRCode || !qrBox) throw new Error("qrcode_lib_missing");
      canvas.classList.add("hidden");
      qrBox.classList.remove("hidden");
      qrBox.innerHTML = "";
      // qrcodejs renders into a DOM container (img or canvas)
      // eslint-disable-next-line no-new
      new window.QRCode(qrBox, {
        text,
        width: 220,
        height: 220,
        correctLevel: window.QRCode.CorrectLevel.M,
      });
    } else {
      JsBarcode(canvas, text, {
        format: "CODE128",
        width: 2,
        height: 80,
        displayValue: false,
      });
    }
  } catch (e) {
    console.warn("barcode render", e);
  }
}

function renderBarcode(el, t) {
  renderBarcodeInto(el.querySelector(".barcode-wrap"), t.barcode_text, t.barcode_image);

  const wrap2 = el.querySelector(".barcode-wrap-2");
  if (!wrap2) return;
  if (t.barcode_text_2) {
    wrap2.classList.remove("hidden");
    renderBarcodeInto(wrap2, t.barcode_text_2, null);
  } else {
    wrap2.classList.add("hidden");
  }
}

function buildNumpad(host, ticket, onDone) {
  host.innerHTML = "";
  host.classList.remove("hidden");
  let val = ticket.remaining_amount != null ? String(ticket.remaining_amount) : "";

  const wrap = document.createElement("div");
  wrap.className = "numpad";
  const display = document.createElement("div");
  display.className = "display";
  display.textContent = val || "0";
  wrap.appendChild(display);

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"];
  keys.forEach((k) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = k;
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (k === "⌫") val = val.slice(0, -1);
      else val += k;
      display.textContent = val || "0";
    });
    wrap.appendChild(b);
  });

  const actions = document.createElement("div");
  actions.className = "actions";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.textContent = "確認";
  ok.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const num = parseFloat(val);
    if (Number.isNaN(num)) return;
    await onDone(num);
    host.classList.add("hidden");
  });
  const slash = document.createElement("button");
  slash.type = "button";
  slash.textContent = "/其他";
  slash.addEventListener("click", (ev) => {
    ev.stopPropagation();
    val = "other";
    display.textContent = "other";
  });
  actions.append(ok, slash);
  wrap.appendChild(actions);
  host.appendChild(wrap);
}

const ACTION_LABEL = {
  save: "存入",
  delete: "刪除",
  create: "存入",
  create_image: "存入",
  state: "狀態",
  update: "更新",
  import_json_commit: "批次匯入",
  delete_used: "批次刪除",
  upload_image: "上傳圖片",
};

function appendTicketRow(parent, t, tpl, opts = {}) {
  const { showPrefix = true, compact = false, index = 1, total = 1 } = opts;
  const node = tpl.content.cloneNode(true);
  const row = node.querySelector(".ticket-row");
  row.dataset.id = t.id;
  row.classList.add(`state-${t.local_state}`);
  if (compact) row.classList.add("ticket-row-compact");

  const titleEl = row.querySelector(".ticket-title");
  if (compact) {
    const prefix = total > 1 ? `[${index}/${total}] ` : "";
    titleEl.textContent = prefix + (t.barcode_text || t.name);
  } else if (showPrefix) {
    const siblings = tickets.filter((x) => ticketGroupKey(x) === ticketGroupKey(t));
    const cnt = siblings.length || 1;
    const idx = siblings.findIndex((x) => x.id === t.id) + 1;
    const prefix = cnt > 1 ? `[${idx}/${cnt}] ` : "";
    titleEl.textContent = prefix + t.name;
  } else {
    titleEl.textContent = t.barcode_text || t.name;
  }

  const sub = [
    !compact ? t.brand_tag : null,
    t.insert_date ? `新增 ${t.insert_date}` : "",
    t.expires_at ? `期限 ${t.expires_at}` : t.no_expiry ? "無期限" : "",
    expiryNoteText(t.expiry_note),
  ]
    .filter(Boolean)
    .join(" · ");
  row.querySelector(".ticket-sub").textContent = sub;

  let amt = "";
  if (t.face_value != null) amt += `面額 ${t.face_value}`;
  if (t.local_state === 2 && t.remaining_amount != null) amt += ` · 剩餘 ${t.remaining_amount}`;
  row.querySelector(".ticket-amount").textContent = amt;

  row.querySelector(".state-badge").textContent = STATE_LABEL[t.local_state] || "";

  const barcodeWrap = row.querySelector(".barcode-wrap");
  barcodeWrap.classList.remove("hidden");
  renderBarcode(row, t);

  if (pendingNumpadId === t.id && t.local_state === 2) {
    const host = row.querySelector(".numpad-host");
    buildNumpad(host, t, async (num) => {
      const updated = await api(`/api/tickets/${t.id}/state`, {
        method: "PATCH",
        body: JSON.stringify({ local_state: 2, remaining_amount: num }),
      });
      mergeTicket(updated);
      pendingNumpadId = null;
      patchRowOnly(updated);
    });
  }

  row.addEventListener("click", (ev) => {
    if (ev.target.closest(".numpad")) return;
    onRowClick(t.id);
  });
  parent.appendChild(node);
  return row;
}

function renderTitleDrawer(listEl, tpl, title, items, groupKey = title) {
  const drawer = document.createElement("article");
  drawer.className = "title-drawer";
  const isOpen = expandedTitleDrawers.has(groupKey);

  const usedCount = items.filter((t) => t.local_state > 0).length;
  const header = document.createElement("button");
  header.type = "button";
  header.className = "title-drawer-header" + (isOpen ? " open" : "");
  header.innerHTML = `
    <span class="title-drawer-chevron" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><polyline points="9 18 15 12 9 6"/></svg>
    </span>
    <span class="title-drawer-name">${escapeHtml(title)}</span>
    <span class="title-drawer-meta">${items.length} 張${usedCount ? ` · ${usedCount} 已用` : ""}</span>
  `;
  header.addEventListener("click", () => {
    if (expandedTitleDrawers.has(groupKey)) expandedTitleDrawers.delete(groupKey);
    else expandedTitleDrawers.add(groupKey);
    renderList();
  });
  drawer.appendChild(header);
  window.ticketNotes?.addTitleImage(drawer, title, items);

  const body = document.createElement("div");
  body.className = "title-drawer-body" + (isOpen ? "" : " hidden");
  if (isOpen) {
    items.forEach((t, i) =>
      appendTicketRow(body, t, tpl, { compact: true, index: i + 1, total: items.length })
    );
  }
  drawer.appendChild(body);
  listEl.appendChild(drawer);
}

function renderList() {
  const listEl = document.getElementById("ticket-list");
  listEl.innerHTML = "";
  const tpl = document.getElementById("ticket-row-tpl");
  const pie = document.getElementById("brand-pie");
  renderDrawerBar();

  if (drawerMode === "categorized") {
    const brandBuckets = new Map();
    tickets.filter((t) => !isNote(t)).forEach((t) => {
      const brand = (t.brand_tag || "其他").trim() || "其他";
      if (!brandBuckets.has(brand)) brandBuckets.set(brand, []);
      brandBuckets.get(brand).push(t);
    });
    const counts = new Map([...brandBuckets.entries()].map(([k, v]) => [k, v.length]));
    [...brandBuckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([brand, items]) => {
        const sub = new Map();
        items.forEach((t) => {
          const name = normalizeNameForBrandView(t.name);
          sub.set(name, (sub.get(name) || 0) + 1);
        });
        const subText = [...sub.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 5)
          .map(([name, c]) => `${c}張\t${escapeHtml(name)}`)
          .join("<br>");
        const card = document.createElement("article");
        card.className = "group-card group-card-clickable";
        card.innerHTML = `<div class="group-title">${escapeHtml(brand)}</div><div class="group-sub">${subText || `${items.length} 張票券`}</div>`;
        card.addEventListener("click", () => {
          drawerMode = `brand:${brand}`;
          localStorage.setItem("drawer_mode", drawerMode);
          expandedTitleDrawers.clear();
          renderList();
        });
        listEl.appendChild(card);
      });
    renderBrandPie(counts);
    return;
  }
  pie?.classList.add("hidden");

  const list = filteredTickets();

  const grouped = new Map();
  for (const ticket of list) {
    const key = ticketGroupKey(ticket);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(ticket);
  }
  const entries = [...grouped.entries()].sort((a, b) => {
    const left = a[1][0];
    const right = b[1][0];
    if (sortMode === "item") {
      const nameOrder = left.name.localeCompare(right.name);
      if (nameOrder) return nameOrder;
    }
    return ticketDateKey(left).localeCompare(ticketDateKey(right)) || a[0].localeCompare(b[0]);
  });
  for (const [key, items] of entries) {
    const ticket = items[0];
    const title = ticket.name;
    renderTitleDrawer(listEl, tpl, title, sortTicketsByTimeUsedLast(items), key);
  }
}

function ticketGroupKey(ticket) {
  return JSON.stringify([(ticket.name || "").normalize("NFC").trim(), ticket.face_value == null ? null : String(Number(ticket.face_value)), ticket.insert_date || null, ticket.expires_at || null, Boolean(ticket.no_expiry)]);
}

function normalizeNameForBrandView(name) {
  const n = (name || "").trim();
  return n.replace(/^【[^】]+】\s*/, "").trim() || n;
}

function renderBrandPie(counts) {
  const host = document.getElementById("brand-pie");
  if (!host) return;
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const total = entries.reduce((n, [, c]) => n + c, 0) || 1;
  const colors = ["#60a5fa", "#34d399", "#fbbf24", "#f87171", "#a78bfa", "#22d3ee", "#fb7185", "#4ade80"];
  let start = 0;
  const segs = entries.map(([, c], i) => {
    const p = (c / total) * 100;
    const seg = `${colors[i]} ${start}% ${start + p}%`;
    start += p;
    return seg;
  });
  const legend = entries
    .map(([k, v], i) => `<div><span class="dot" style="background:${colors[i]}"></span>${escapeHtml(k)} ${v}張</div>`)
    .join("");
  host.classList.remove("hidden");
  host.innerHTML = `<div class="pie-card"><div class="pie-wrap" style="background:conic-gradient(${segs.join(
    ","
  )})"></div><div class="pie-legend">${legend}</div></div>`;
}

function renderDrawerBar() {
  const host = document.getElementById("drawer-bar");
  if (!host) return;
  const brands = [...new Set(tickets.filter((t) => !isNote(t)).map((t) => t.brand_tag).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
  const items = [
    { key: "categorized", label: "抽屜分類" },
    { key: "none", label: "不分類(全部)" },
    ...brands.map((b) => ({
      key: `brand:${b}`,
      label: `${b}${tickets.filter((t) => !isNote(t) && (t.brand_tag || "") === b).length}張`,
    })),
  ];
  host.innerHTML = "";
  items.forEach((it) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "drawer-btn" + (drawerMode === it.key ? " active" : "");
    b.textContent = it.label;
    b.addEventListener("click", () => {
      drawerMode = it.key;
      localStorage.setItem("drawer_mode", drawerMode);
      expandedTitleDrawers.clear();
      renderList();
    });
    host.appendChild(b);
  });
  document.dispatchEvent(new Event("ticket-drawers-rendered"));
}

// 搜尋 UI 已移除

function mergeTicket(updated) {
  const i = tickets.findIndex((x) => x.id === updated.id);
  if (i >= 0) tickets[i] = updated;
}

function patchRowOnly(t) {
  const row = document.querySelector(`.ticket-row[data-id="${t.id}"]`);
  if (!row) return;
  row.className = `ticket-row state-${t.local_state}`;
  row.querySelector(".state-badge").textContent = STATE_LABEL[t.local_state];
  let amt = "";
  if (t.face_value != null) amt += `面額 ${t.face_value}`;
  if (t.local_state === 2 && t.remaining_amount != null) amt += ` · 剩餘 ${t.remaining_amount}`;
  row.querySelector(".ticket-amount").textContent = amt;
  renderBarcode(row, t);
}

async function onRowClick(id) {
  if (window.ticketExchange?.readOnly) return;
  if (inflightState.has(id)) return;
  const t = tickets.find((x) => x.id === id);
  if (!t) return;
  const next = (t.local_state + 1) % 3;
  let body = { local_state: next };
  if (next === 2) {
    pendingNumpadId = id;
    body.remaining_amount = t.remaining_amount;
  } else {
    pendingNumpadId = null;
  }
  inflightState.add(id);
  try {
    const updated = await api(`/api/tickets/${id}/state`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    mergeTicket(updated);
    // 不重建 displayOrder，只更新該列
    patchRowOnly(updated);
    if (next === 2) {
      const row = document.querySelector(`.ticket-row[data-id="${id}"]`);
      const host = row?.querySelector(".numpad-host");
      if (row && host) {
        buildNumpad(host, updated, async (num) => {
          const updated2 = await api(`/api/tickets/${updated.id}/state`, {
            method: "PATCH",
            body: JSON.stringify({ local_state: 2, remaining_amount: num }),
          });
          mergeTicket(updated2);
          pendingNumpadId = null;
          patchRowOnly(updated2);
        });
      }
    } else {
      document
        .querySelector(`.ticket-row[data-id="${id}"] .numpad-host`)
        ?.classList.add("hidden");
    }
  } finally {
    inflightState.delete(id);
  }
}

function renderImportEditTable(items) {
  const host = document.getElementById("import-edit-table");
  const saveAllBtn = document.getElementById("json-save-all-btn");
  if (!items.length) {
    host.innerHTML = "<p>無可預覽項目</p>";
    saveAllBtn.classList.add("hidden");
    return;
  }
  const newRows = items.filter((x) => x.status === "new");
  const duplicateRows = items.filter((x) => x.status === "duplicate");
  saveAllBtn.classList.toggle("hidden", newRows.length === 0);

  let html = `<table class="edit-table"><thead><tr>
    <th>#</th><th>選取</th><th>名稱</th><th>條碼</th><th>條碼2</th><th>標籤</th><th>期限</th><th>面額</th><th>狀態</th>
  </tr></thead><tbody>`;
  newRows.forEach((row) => {
    const t = row.ticket;
    const expiryLabel = t.no_expiry ? "無期限" : (t.expires_at || "未設定");
    html += `<tr data-temp-id="${row.temp_id}">
      <td>${Number(row.temp_id) + 1}</td>
      <td><input type="checkbox" class="pick-row" checked /></td>
      <td><input data-f="name" value="${escapeAttr(t.name)}" /></td>
      <td>${isNote(t) ? `<textarea data-f="note_text" rows="4">${escapeHtml(t.note_text || '')}</textarea>` : `<input value="${escapeAttr(t.barcode_text || "")}" readonly />`}</td>
      <td><input value="${escapeAttr(t.barcode_text_2 || "")}" readonly /></td>
      <td><input data-f="brand_tag" value="${escapeAttr(t.brand_tag)}" /></td>
      <td>
        <button type="button" class="expiry-toggle" data-no-expiry="${t.no_expiry ? "1" : "0"}">${expiryLabel}</button>
        <input data-f="expires_at" type="date" value="${t.expires_at || ""}" class="${t.no_expiry ? "hidden" : ""}" />
      </td>
      <td><input data-f="face_value" type="number" value="${t.face_value ?? ""}" /></td>
      <td>${isNote(t) ? '筆記' : '待新增'}</td>
    </tr>`;
  });
  duplicateRows.forEach((row) => {
    const src = row.ticket || {};
    const ex = row.existing_ticket || {};
    html += `<tr class="duplicate-row">
      <td>${Number(row.temp_id) + 1}</td>
      <td>-</td>
      <td>${escapeAttr(src.name || "")}</td>
      <td>${escapeAttr(src.barcode_text || "")}</td>
      <td>${escapeAttr(src.barcode_text_2 || "")}</td>
      <td>${escapeAttr(src.brand_tag || "")}</td>
      <td>${escapeAttr(src.expires_at || "")}</td>
      <td>${src.face_value ?? ""}</td>
      <td>已存在：#${ex.id || "-"} ${escapeAttr(ex.name || "")}（${escapeAttr(ex.barcode_text || "")}）</td>
    </tr>`;
  });
  html += "</tbody></table>";
  host.innerHTML = html;
  const labels = ['#', '選取', '名稱', '條碼／筆記', '條碼2', '標籤', '期限', '面額', '狀態'];
  host.querySelectorAll('tbody tr').forEach((row) => [...row.cells].forEach((cell, index) => { cell.dataset.label = labels[index]; }));
  host.querySelectorAll(".expiry-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const td = btn.closest("td");
      const input = td.querySelector('input[data-f="expires_at"]');
      const isNoExpiry = btn.dataset.noExpiry === "1";
      if (isNoExpiry) {
        btn.dataset.noExpiry = "0";
        btn.textContent = input.value || "未設定";
        input.classList.remove("hidden");
      } else {
        btn.dataset.noExpiry = "1";
        btn.textContent = "無期限";
        input.value = "";
        input.classList.add("hidden");
      }
    });
  });
  host.querySelectorAll('input[data-f="expires_at"]').forEach((input) => {
    input.addEventListener("change", () => {
      const td = input.closest("td");
      const btn = td.querySelector(".expiry-toggle");
      if (btn.dataset.noExpiry === "1") return;
      btn.textContent = input.value || "未設定";
    });
  });
}

function escapeAttr(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

async function loadLogs(opts = {}) {
  const params = new URLSearchParams({ limit: String(opts.limit || 150) });
  if (opts.q) params.set("q", opts.q);
  if (opts.action) params.set("action", opts.action);
  const logs = await api(`/api/logs?${params}`);
  const html = logs.length ? logs.map(formatLogItem).join("") : "<li class=\"log-empty\">沒有符合的紀錄</li>";
  if (opts.target === "settings") {
    const ul = document.getElementById("settings-log-list");
    if (ul) ul.innerHTML = html;
    return;
  }
  const ul = document.getElementById("log-list");
  if (ul) ul.innerHTML = html;
}

function formatLogItem(l) {
  const actionText = ACTION_LABEL[l.action] || l.action;
  let detail = l.detail || "";
  try {
    const obj = JSON.parse(detail);
    if (l.action === "import_json_commit") {
      const items = (obj.items || []).map((x) => `#${x.id} ${x.name}`).join("、");
      const exist = (obj.existing_items || []).map((x) => `#${x.id} ${x.name}`).join("、");
      detail =
        `新增 ${obj.created || 0} 筆` +
        (items ? `：${items}` : "") +
        `；重複 ${obj.duplicates || 0} 筆` +
        (exist ? `：${exist}` : "");
    } else if (l.action === "delete_used") {
      const names = (obj.names || []).join("、");
      detail = `刪除 ${obj.deleted || 0} 筆` + (names ? `：${names}` : "");
    } else if (l.action === "state") {
      const from = STATE_LABEL[obj.from] || obj.from;
      const to = STATE_LABEL[obj.to] || obj.to;
      detail =
        `${obj.name || ""}（${from} → ${to}）` +
        (obj.remaining != null ? `，剩餘 ${obj.remaining}` : "");
    } else if (typeof obj === "object") {
      detail = JSON.stringify(obj);
    }
  } catch {
    // 純文字 detail（存入 XXX、刪除 XXX）
  }
  return `<li><time>${l.created_at}</time> · <span class="log-action">${escapeHtml(actionText)}</span> · ${escapeHtml(detail)}</li>`;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- events ---
document.getElementById("login-btn").addEventListener("click", async () => {
  const username = document.getElementById("login-user").value;
  const password = document.getElementById("login-pass").value;
  try {
    const data = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }).then((r) => r.json());
    if (!data.access_token) throw new Error("login failed");
    token = data.access_token;
    localStorage.setItem("ticket_token", token);
    showApp();
    await loadTickets(true);
  } catch (e) {
    document.getElementById("login-error").textContent = "登入失敗";
  }
});

document.getElementById("logout-btn")?.addEventListener("click", logout);
document.getElementById("settings-logout-btn").addEventListener("click", logout);
document.getElementById("refresh-btn").addEventListener("click", () => loadTickets(true));
document.getElementById("hide-used-chk").addEventListener("change", () => renderList());
document.querySelectorAll('input[name="bc-type"]').forEach((el) => {
  el.addEventListener("change", () => {
    localStorage.setItem("bc_type", bcType());
    renderList();
  });
});
document.getElementById("hide-used-chk").addEventListener("change", (e) => {
  localStorage.setItem("hide_used", e.target.checked ? "1" : "0");
});

document.getElementById("export-btn")?.addEventListener("click", () => exportJson());
document.getElementById("import-btn")?.addEventListener("click", () => {
  const importTabBtn = document.querySelector('.tab[data-tab="manual"]');
  if (importTabBtn) {
    importTabBtn.click();
  }
});

function applyTheme(theme) {
  const isLight = theme === "light";
  document.body.classList.toggle("light-theme", isLight);
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    btn.querySelector(".icon-moon")?.classList.toggle("hidden", isLight);
    btn.querySelector(".icon-sun")?.classList.toggle("hidden", !isLight);
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = isLight ? "#F8FAFC" : "#0F172A";
  localStorage.setItem("theme", theme);
}

document.getElementById("theme-toggle")?.addEventListener("click", () => {
  const next = document.body.classList.contains("light-theme") ? "dark" : "light";
  applyTheme(next);
});

document.getElementById("sort-select")?.addEventListener("change", (e) => {
  sortMode = e.target.value || "item";
  localStorage.setItem("ticket_sort_mode", sortMode);
  expandedTitleDrawers.clear();
  loadTickets(true);
});

function exportJson() {
  window.ticketExchange?.exportFile("json").catch((error) => {
    document.getElementById("exchange-status").textContent = error.message;
  });
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    document.getElementById(`tab-${tab}`).classList.remove("hidden");
    if (tab === "logs") loadLogs();
  });
});

document.getElementById("toggle-log-search-btn")?.addEventListener("click", () => {
  const panel = document.getElementById("settings-log-panel");
  const btn = document.getElementById("toggle-log-search-btn");
  if (!panel) return;
  const isHidden = panel.classList.toggle("hidden");
  if (btn) btn.textContent = isHidden ? "查看操作紀錄" : "收起操作紀錄";
  if (!isHidden) loadLogs({ target: "settings" });
});

function wireLogSearch(btnId, inputId, filterId, target) {
  const btn = document.getElementById(btnId);
  const input = document.getElementById(inputId);
  const filter = document.getElementById(filterId);
  if (!btn) return;
  const run = () =>
    loadLogs({
      q: input?.value?.trim() || "",
      action: filter?.value || "",
      target,
    });
  btn.addEventListener("click", run);
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") run();
  });
}

wireLogSearch("log-search-btn", "log-search-input", "log-action-filter", "settings");
wireLogSearch("tab-log-search-btn", "tab-log-search-input", "tab-log-action-filter", "list");

document.getElementById("json-pick-file-btn")?.addEventListener("click", () => {
  document.getElementById("json-file-input")?.click();
});

document.getElementById("json-file-input")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    document.getElementById("json-input").value = text;
    document.getElementById("import-summary").textContent = `已載入檔案：${file.name}`;
  } catch {
    document.getElementById("import-summary").textContent = "讀取檔案失敗";
  } finally {
    e.target.value = "";
  }
});

document.getElementById("json-import-btn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const raw = document.getElementById("json-input").value.trim();
  if (!raw) {
    alert("請貼上內容");
    return;
  }
  button.disabled = true;
  try {
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = undefined; }
  const asNote = document.getElementById('import-as-note').checked;
  const res = payload !== undefined && !asNote
    ? await api('/api/tickets/import-json', {method: 'POST', body: JSON.stringify({payload})})
    : await api('/api/tickets/import-text', {method: 'POST', body: JSON.stringify({text: raw, as_note: asNote})});
  importPreviewItems = res.items || [];
  const s = res.summary || {};
  document.getElementById("import-summary").textContent =
    `總數 ${s.total || 0}，可新增 ${s.new || 0}，重複 ${s.duplicate || 0}，略過 ${s.skipped || 0}`;
  renderImportEditTable(importPreviewItems);
  } catch (error) { document.getElementById('import-summary').textContent = error.message; }
  finally { button.disabled = false; }
});

document.getElementById("delete-used-btn")?.addEventListener("click", async () => {
  const ok = confirm("確定刪除已使用票券？有餘額的不會刪除。");
  if (!ok) return;
  const res = await api("/api/tickets/delete-used", { method: "POST" });
  document.getElementById("import-summary").textContent = `已刪除 ${res.deleted || 0} 張已使用票券`;
  await loadTickets(true);
});

document.getElementById("json-save-all-btn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const rows = [...document.querySelectorAll("#import-edit-table tr[data-temp-id]")];
  const commitItems = [];
  rows.forEach((tr) => {
    const picked = tr.querySelector(".pick-row")?.checked;
    if (!picked) return;
    const body = { remaining_amount: null, barcode_text: null, barcode_text_2: null, insert_date: null, expiry_note: null };
    tr.querySelectorAll("input[data-f], textarea[data-f]").forEach((inp) => {
      let v = inp.value;
      if (inp.dataset.f === "face_value") v = v === "" ? null : parseFloat(v);
      if (inp.dataset.f === "expires_at") v = v || null;
      body[inp.dataset.f] = v;
    });
    const tempId = Number(tr.dataset.tempId);
    const src = importPreviewItems.find((x) => x.temp_id === tempId)?.ticket || {};
    body.barcode_text = src.barcode_text || null;
    body.barcode_text_2 = src.barcode_text_2 || null;
    body.insert_date = src.insert_date || null;
    body.expiry_note = src.expiry_note || null;
    if (src.note_text !== null && src.note_text !== undefined && body.note_text === undefined) body.note_text = src.note_text;
    const expiryBtn = tr.querySelector(".expiry-toggle");
    body.no_expiry = expiryBtn?.dataset.noExpiry === "1";
    if (body.no_expiry) body.expires_at = null;
    commitItems.push(body);
  });
  if (!commitItems.length) {
    alert("沒有勾選要儲存的項目");
    return;
  }
  button.disabled = true;
  try {
  if (window.ticketExchange?.isAuxiliary) {
    await window.ticketAuxiliary.submitItems(commitItems);
    document.getElementById('import-summary').textContent = '已送交 Main 審核';
    importPreviewItems = [];
    document.getElementById('import-edit-table').replaceChildren();
    button.classList.add('hidden');
    return;
  }
  const res = await api("/api/tickets/import-json-commit", {
    method: "POST",
    body: JSON.stringify({ items: commitItems }),
  });
  const createdList = (res.items || []).map((x) => `#${x.id} ${x.name}`).join("、");
  const dupList = (res.existing_items || []).map((x) => `#${x.id} ${x.name}`).join("、");
  document.getElementById("import-summary").textContent =
    `已新增 ${res.created || 0} 筆` +
    (createdList ? `：${createdList}` : "") +
    `；重複 ${res.duplicates || 0} 筆` +
    (dupList ? `：${dupList}` : "");
  importPreviewItems = [];
  document.getElementById("import-edit-table").innerHTML = "";
  document.getElementById("json-save-all-btn").classList.add("hidden");
  await loadTickets(true);
  } catch (error) { document.getElementById('import-summary').textContent = error.message; }
  finally { button.disabled = false; }
});

if (token) {
  showApp();
  loadTickets(true).catch(logout);
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelector(`input[name="bc-type"][value="${storedBcType}"]`)?.click();
  const hideChk = document.getElementById("hide-used-chk");
  if (hideChk) hideChk.checked = storedHideUsed;
  const sortSel = document.getElementById("sort-select");
  if (sortSel) sortSel.value = sortMode;
  applyTheme(storedTheme);
});
