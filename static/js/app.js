/* Ticket UI - comments in zh-TW where helpful */

const API = "";
let token = localStorage.getItem("ticket_token") || "";
let tickets = [];
let displayOrder = []; // stable order; no reorder on state click
let pendingNumpadId = null;
let pastedImageFile = null;
let pastedImageUrl = null;
let importPreviewItems = [];
const inflightState = new Set();
let sortMode = localStorage.getItem("ticket_sort_mode") || "item"; // date|item
let croppedImageBlob = null;
let nameSuggestOpen = false;
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
  if (res.status === 204) return null;
  return res.json();
}

function logout() {
  token = "";
  localStorage.removeItem("ticket_token");
  document.getElementById("app-view").classList.add("hidden");
  document.getElementById("login-view").classList.remove("hidden");
}

function showApp() {
  document.getElementById("login-view").classList.add("hidden");
  document.getElementById("app-view").classList.remove("hidden");
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
}

function filteredTickets() {
  const hideUsed = document.getElementById("hide-used-chk").checked;
  return displayOrder
    .map((id) => tickets.find((t) => t.id === id))
    .filter(Boolean)
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
    img.src = `/api/uploads/${imageName}`;
    img.classList.remove("hidden");
    if (textEl) textEl.textContent = "(image)";
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
    const siblings = tickets.filter((x) => x.name === t.name);
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

function renderTitleDrawer(listEl, tpl, title, items) {
  const drawer = document.createElement("article");
  drawer.className = "title-drawer";
  const isOpen = expandedTitleDrawers.has(title);

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
    if (expandedTitleDrawers.has(title)) expandedTitleDrawers.delete(title);
    else expandedTitleDrawers.add(title);
    renderList();
  });
  drawer.appendChild(header);

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
    tickets.forEach((t) => {
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
          .map(([name, c]) => `${c}張\t${name}`)
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

  // 依時間：解除標題抽屜，改為時間排序的平鋪列表
  if (drawerMode.startsWith("brand:") && sortMode === "item") {
    const byTitle = new Map();
    list.forEach((t) => {
      const key = t.name;
      if (!byTitle.has(key)) byTitle.set(key, []);
      byTitle.get(key).push(t);
    });
    [...byTitle.entries()]
      .sort((a, b) => {
        const da = ticketDateKey(sortTicketsByTime(a[1])[0]);
        const db = ticketDateKey(sortTicketsByTime(b[1])[0]);
        if (da !== db) return da.localeCompare(db);
        return a[0].localeCompare(b[0]);
      })
      .forEach(([title, items]) => renderTitleDrawer(listEl, tpl, title, sortTicketsByTimeUsedLast(items)));
    return;
  }

  list.forEach((t) => appendTicketRow(listEl, t, tpl, { showPrefix: true }));
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
    .map(([k, v], i) => `<div><span class="dot" style="background:${colors[i]}"></span>${k} ${v}張</div>`)
    .join("");
  host.classList.remove("hidden");
  host.innerHTML = `<div class="pie-card"><div class="pie-wrap" style="background:conic-gradient(${segs.join(
    ","
  )})"></div><div class="pie-legend">${legend}</div></div>`;
}

function renderDrawerBar() {
  const host = document.getElementById("drawer-bar");
  if (!host) return;
  const brands = [...new Set(tickets.map((t) => t.brand_tag).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
  const items = [
    { key: "categorized", label: "抽屜分類" },
    { key: "none", label: "不分類(全部)" },
    ...brands.map((b) => ({
      key: `brand:${b}`,
      label: `${b}${tickets.filter((t) => (t.brand_tag || "") === b).length}張`,
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
      <td><input value="${escapeAttr(t.barcode_text || "")}" readonly /></td>
      <td><input value="${escapeAttr(t.barcode_text_2 || "")}" readonly /></td>
      <td><input data-f="brand_tag" value="${escapeAttr(t.brand_tag)}" /></td>
      <td>
        <button type="button" class="expiry-toggle" data-no-expiry="${t.no_expiry ? "1" : "0"}">${expiryLabel}</button>
        <input data-f="expires_at" type="date" value="${t.expires_at || ""}" class="${t.no_expiry ? "hidden" : ""}" />
      </td>
      <td><input data-f="face_value" type="number" value="${t.face_value ?? ""}" /></td>
      <td>待新增</td>
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

function setImagePreviewFromFile(file, label = "image") {
  if (!file) return;
  pastedImageFile = file;
  croppedImageBlob = null;
  const pasteZone = document.getElementById("paste-zone");
  const cropBtn = document.getElementById("crop-btn");
  const clearBtn = document.getElementById("clear-img-btn");
  if (pastedImageUrl) URL.revokeObjectURL(pastedImageUrl);
  pastedImageUrl = URL.createObjectURL(file);
  pasteZone.innerHTML = "";
  const img = document.createElement("img");
  img.src = pastedImageUrl;
  img.style.maxWidth = "100%";
  img.style.maxHeight = "200px";
  img.style.display = "block";
  img.style.borderRadius = "8px";
  const meta = document.createElement("div");
  meta.style.marginTop = "6px";
  meta.style.color = "#8b9cb3";
  meta.style.fontSize = "12px";
  meta.textContent = `${label}: ${file.type} ${Math.round(file.size / 1024)}KB`;
  pasteZone.appendChild(img);
  pasteZone.appendChild(meta);
  cropBtn?.classList.remove("hidden");
  clearBtn?.classList.remove("hidden");
}

function clearImagePreview() {
  pastedImageFile = null;
  croppedImageBlob = null;
  if (pastedImageUrl) {
    URL.revokeObjectURL(pastedImageUrl);
    pastedImageUrl = null;
  }
  const pasteZone = document.getElementById("paste-zone");
  if (pasteZone) {
    pasteZone.innerHTML = `<svg class="paste-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg><span>點此或 Ctrl+V</span>`;
  }
  document.getElementById("crop-btn")?.classList.add("hidden");
  document.getElementById("clear-img-btn")?.classList.add("hidden");
  const fileInput = document.getElementById("manual-image");
  if (fileInput) fileInput.value = "";
}

function openCropper() {
  if (!pastedImageUrl || !window.Cropper) return;
  const modal = document.createElement("div");
  modal.className = "crop-modal";
  modal.innerHTML = `
    <div class="crop-card">
      <img id="crop-img" alt="crop" />
      <div class="actions">
        <button type="button" id="crop-cancel">取消</button>
        <button type="button" class="primary" id="crop-ok">完成</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const img = modal.querySelector("#crop-img");
  img.src = pastedImageUrl;
  const cropper = new window.Cropper(img, {
    viewMode: 1,
    autoCropArea: 0.9,
    responsive: true,
    background: false,
    movable: true,
    zoomable: true,
  });
  modal.querySelector("#crop-cancel").addEventListener("click", () => {
    cropper.destroy();
    modal.remove();
  });
  modal.querySelector("#crop-ok").addEventListener("click", async () => {
    const canvas = cropper.getCroppedCanvas({ maxWidth: 1024, maxHeight: 1024 });
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png", 0.92));
    if (blob) {
      croppedImageBlob = blob;
      const file = new File([blob], "cropped.png", { type: "image/png" });
      setImagePreviewFromFile(file, "cropped");
    }
    cropper.destroy();
    modal.remove();
  });
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

document.getElementById("manual-image")?.addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (f) setImagePreviewFromFile(f, "upload");
});
document.getElementById("crop-btn")?.addEventListener("click", () => openCropper());
document.getElementById("clear-img-btn")?.addEventListener("click", () => clearImagePreview());

// Merge click-upload and paste into one zone
document.addEventListener("click", (e) => {
  const zone = e.target?.closest?.("#paste-zone");
  if (!zone) return;
  document.getElementById("manual-image")?.click();
});

document.getElementById("export-btn")?.addEventListener("click", () => exportJson());
document.getElementById("import-btn")?.addEventListener("click", () => {
  const importTabBtn = document.querySelector('.tab[data-tab="settings"]');
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
  const rows = displayOrder.map((id) => tickets.find((t) => t.id === id)).filter(Boolean);
  const payload = {
    rtnCode: "200",
    rtnMsg: "export",
    totpage: "1",
    results: rows.map((t) => ({
      name: t.name,
      barcode_text: t.barcode_text,
      barcode_text_2: t.barcode_text_2,
      insertDate: t.insert_date,
      expiresAt: t.expires_at,
      noExpiry: t.no_expiry,
      faceValue: t.face_value,
      remainingAmount: t.remaining_amount,
      brandTag: t.brand_tag,
      localState: t.local_state,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tickets_${todayIso()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  const counts = new Map();
  rows.forEach((t) => {
    const key = t.brand_tag || "其他";
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const breakdown = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, c]) => `${k} ${c}筆`)
    .join("、");
  document.getElementById("import-summary").textContent = `已匯出全部 ${rows.length} 筆：${breakdown}`;
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

document.getElementById("json-import-btn").addEventListener("click", async () => {
  const raw = document.getElementById("json-input").value.trim();
  if (!raw) {
    alert("請貼上內容");
    return;
  }
  let res;
  try {
    const payload = JSON.parse(raw);
    res = await api("/api/tickets/import-json", {
      method: "POST",
      body: JSON.stringify({ payload }),
    });
  } catch {
    res = await api("/api/tickets/import-text", {
      method: "POST",
      body: JSON.stringify({ text: raw }),
    });
  }
  importPreviewItems = res.items || [];
  const s = res.summary || {};
  document.getElementById("import-summary").textContent =
    `總數 ${s.total || 0}，可新增 ${s.new || 0}，重複 ${s.duplicate || 0}，略過 ${s.skipped || 0}`;
  renderImportEditTable(importPreviewItems);
});

document.getElementById("delete-used-btn")?.addEventListener("click", async () => {
  const ok = confirm("確定刪除已使用票券？有餘額的不會刪除。");
  if (!ok) return;
  const res = await api("/api/tickets/delete-used", { method: "POST" });
  document.getElementById("import-summary").textContent = `已刪除 ${res.deleted || 0} 張已使用票券`;
  await loadTickets(true);
});

document.getElementById("json-save-all-btn").addEventListener("click", async () => {
  const rows = [...document.querySelectorAll("#import-edit-table tr[data-temp-id]")];
  const commitItems = [];
  rows.forEach((tr) => {
    const picked = tr.querySelector(".pick-row")?.checked;
    if (!picked) return;
    const body = { remaining_amount: null, barcode_text: null, barcode_text_2: null, insert_date: null, expiry_note: null };
    tr.querySelectorAll("input[data-f]").forEach((inp) => {
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
    const expiryBtn = tr.querySelector(".expiry-toggle");
    body.no_expiry = expiryBtn?.dataset.noExpiry === "1";
    if (body.no_expiry) body.expires_at = null;
    commitItems.push(body);
  });
  if (!commitItems.length) {
    alert("沒有勾選要儲存的項目");
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
});

document.getElementById("manual-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const fileInput = document.getElementById("manual-image");
  const file = pastedImageFile || fileInput.files[0];
  const barcodeText = (fd.get("barcode_text") || "").toString().trim();
  // 至少要有條碼文字或圖片
  if (!barcodeText && !file) {
    alert("請輸入條碼文字或貼上/選取圖片");
    return;
  }
  const body = {
    name: fd.get("name"),
    brand_tag: fd.get("brand_tag") || "其他",
    barcode_text: barcodeText || null,
    insert_date: fd.get("insert_date") || todayIso(),
    expires_at: fd.get("expires_at") || null,
    face_value: fd.get("face_value") ? parseFloat(fd.get("face_value")) : null,
    source: "manual_text",
    no_expiry: !fd.get("expires_at") && !fd.get("insert_date"),
  };
  let created;
  if (file && !body.barcode_text) {
    const q = new URLSearchParams({
      name: body.name,
      brand_tag: body.brand_tag,
    });
    if (body.insert_date) q.set("insert_date", body.insert_date);
    if (body.expires_at) q.set("expires_at", body.expires_at);
    if (body.face_value != null) q.set("face_value", body.face_value);
    const form = new FormData();
    form.append("file", file);
    created = await api(`/api/tickets/with-image?${q}`, { method: "POST", body: form });
  } else {
    created = await api("/api/tickets", { method: "POST", body: JSON.stringify(body) });
    if (file) {
      const form = new FormData();
      form.append("file", file);
      await api(`/api/tickets/${created.id}/image`, { method: "POST", body: form });
    }
  }
  e.target.reset();
  clearImagePreview();
  await loadTickets(true);
  document.querySelector('.tab[data-tab="list"]').click();
});

const pasteZone = document.getElementById("paste-zone");
pasteZone.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (!item) return;
  e.preventDefault();
  const file = item.getAsFile();
  setImagePreviewFromFile(file, "paste");
});

if (token) {
  showApp();
  loadTickets(true).catch(logout);
}

function getUniqueTicketNames() {
  const map = new Map();
  tickets.forEach((t) => {
    const n = (t.name || "").trim();
    if (!n) return;
    map.set(n, (map.get(n) || 0) + 1);
  });
  return [...map.keys()].sort((a, b) => a.localeCompare(b));
}

function getMostCommonBrandTagForName(name) {
  const target = (name || "").trim();
  if (!target) return "";
  const counts = new Map();
  tickets.forEach((t) => {
    if (((t.name || "").trim() || "") !== target) return;
    const tag = (t.brand_tag || "").trim();
    if (!tag) return;
    counts.set(tag, (counts.get(tag) || 0) + 1);
  });
  let best = "";
  let bestCount = 0;
  counts.forEach((c, tag) => {
    if (c > bestCount) {
      best = tag;
      bestCount = c;
    }
  });
  return best;
}

function showNameSuggest(filter = "") {
  const panel = document.getElementById("name-suggest");
  if (!panel) return;
  const q = (filter || "").toLowerCase();
  const names = getUniqueTicketNames()
    .filter((n) => (q ? n.toLowerCase().includes(q) : true))
    .slice(0, 30);
  panel.innerHTML = "";
  if (!names.length) {
    const div = document.createElement("div");
    div.className = "suggest-empty";
    div.textContent = "沒有建議";
    panel.appendChild(div);
  } else {
    names.forEach((n) => {
      const div = document.createElement("div");
      div.className = "suggest-item";
      div.textContent = n;
      div.addEventListener("click", () => {
        const input = document.getElementById("manual-name");
        input.value = n;
        const brandInput = document.querySelector('#manual-form input[name="brand_tag"]');
        const bestTag = getMostCommonBrandTagForName(n);
        if (brandInput && bestTag) brandInput.value = bestTag;
        hideNameSuggest();
      });
      panel.appendChild(div);
    });
  }
  panel.classList.remove("hidden");
  nameSuggestOpen = true;
}

function hideNameSuggest() {
  const panel = document.getElementById("name-suggest");
  if (!panel) return;
  panel.classList.add("hidden");
  nameSuggestOpen = false;
}

function wireNameSuggest() {
  const input = document.getElementById("manual-name");
  const panel = document.getElementById("name-suggest");
  if (!input || !panel) return;
  input.addEventListener("focus", () => showNameSuggest(input.value));
  input.addEventListener("input", () => showNameSuggest(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideNameSuggest();
      input.blur();
    }
  });
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!nameSuggestOpen) return;
      if (panel.contains(e.target) || input.contains(e.target)) return;
      hideNameSuggest();
    },
    true
  );
}

// 預設手動新增日期為今天
document.addEventListener("DOMContentLoaded", () => {
  const input = document.querySelector('#manual-form input[name="insert_date"]');
  if (input && !input.value) input.value = todayIso();
  wireNameSuggest();
  document.querySelector(`input[name="bc-type"][value="${storedBcType}"]`)?.click();
  const hideChk = document.getElementById("hide-used-chk");
  if (hideChk) hideChk.checked = storedHideUsed;
  const sortSel = document.getElementById("sort-select");
  if (sortSel) sortSel.value = sortMode;
  applyTheme(storedTheme);
});
