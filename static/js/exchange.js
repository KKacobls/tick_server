/* Ticket exchange controls. No credentials are placed in URLs or access logs. */
(() => {
  const byId = (id) => document.getElementById(id);
  let serverMode = "main";
  let serverSettings = null;
  let lastOpenSync = null;
  const status = (text, error = false) => {
    byId("exchange-status").textContent = text;
    byId("exchange-status").classList.toggle("error", error);
  };
  const execute = async (button, action) => {
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try { await action(); }
    catch (error) { status(error.message || "操作失敗", true); }
    finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      applyPermissions();
    }
  };
  function applyPermissions() {
    const readOnly = serverMode === "client";
    document.body.classList.toggle("tickets-readonly", readOnly);
    byId("read-only-notice").classList.toggle("hidden", !readOnly);
    byId("read-only-notice").textContent = lastOpenSync === 'cached'
      ? '輔助：Main 暫時無法更新，顯示本機保留票券。'
      : '輔助：每次開啟向 Main 更新票券。';
    document.querySelectorAll('#manual-form input, #manual-form button, #delete-used-btn, #json-import-btn, #json-save-all-btn, #snapshot-import-file').forEach((el) => { el.disabled = readOnly; });
    document.querySelector('.tab[data-tab="manual"]').disabled = readOnly;
    byId("pull-now-btn").disabled = serverMode !== "client";
  }

  async function initialize() {
    if (!token) return;
    try {
      serverSettings = await api("/api/exchange/settings");
      serverMode = serverSettings.mode;
      byId("server-mode").value = serverMode;
      byId("main-server-url").value = serverSettings.upstream_url || "";
      byId("sync-interval").value = serverSettings.interval_seconds;
      byId("main-server-password").placeholder = serverSettings.has_upstream_credentials ? "已保存；帳密皆留空則保持原設定" : "Main 登入密碼";
      const result = serverSettings.last_result;
      const summary = result ? `新增 ${result.created}、更新 ${result.updated}、衝突 ${result.conflicts.length}` : "尚未同步";
      status(serverSettings.last_error || `${serverMode === 'main' ? 'Main' : '輔助'} · ${summary}${serverSettings.last_success ? ` · 最近成功 ${serverSettings.last_success} UTC` : ""}`, Boolean(serverSettings.last_error));
    } catch (error) { status(error.message, true); }
    applyPermissions();
  }
  async function exportFile(format = "json") {
    const url = `/api/exchange/export?format=${format}`;
    const response = await fetch(url, { headers: headers(false) });
    if (!response.ok) throw new Error(`匯出失敗 HTTP ${response.status}`);
    const blob = await response.blob();
    const filename = `tickets_${todayIso()}.${format}`;
    if (window.TicketScanner?.saveExport) {
      const reader = new FileReader();
      const encoded = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      window.TicketScanner.saveExport(encoded, blob.type || "application/octet-stream", filename);
    } else {
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    }
    status(`已準備 ${format.toUpperCase()} 匯出；JSON／ZIP 會保留每張票券、狀態與圖片。`);
  }
  byId("export-zip-btn").addEventListener("click", (event) => execute(event.currentTarget, () => exportFile("zip")));
  byId("export-csv-btn").addEventListener("click", (event) => execute(event.currentTarget, () => exportFile("csv")));
  byId("save-sync-btn").addEventListener("click", (event) => execute(event.currentTarget, async () => {
    const replacing = byId('server-mode').value === 'client';
    if (replacing && !confirm('輔助模式會在每次開啟時以 Main 票券完整更新本機；替換前自動備份。確定啟用？')) return;
    await api("/api/exchange/settings", { method: "PUT", body: JSON.stringify({
      mode: byId("server-mode").value, upstream_url: byId("main-server-url").value.trim(),
      upstream_username: byId("main-server-username").value.trim() || null,
      upstream_password: byId("main-server-password").value || null,
      interval_seconds: Number(byId("sync-interval").value),
      confirm_replace: replacing,
    }) });
    byId("main-server-username").value = "";
    byId("main-server-password").value = "";
    await initialize();
    await loadTickets(true);
    status(lastOpenSync === 'cached' ? '模式已儲存；Main 暫時無法更新，保留本機票券。' : '模式已儲存。');
  }));
  byId("pull-now-btn").addEventListener("click", (event) => execute(event.currentTarget, async () => {
    await loadTickets(true);
    await initialize();
    status(lastOpenSync === 'cached' ? 'Main 暫時無法更新，顯示本機保留票券。' : '已向 Main 更新票券。');
  }));
  byId("snapshot-import-file").addEventListener("change", (event) => execute(byId("snapshot-import-btn"), async () => {
    const file = event.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    const result = await api("/api/exchange/import-file", { method: "POST", body: form });
    await loadTickets(true);
    status(`匯入完成：新增 ${result.created}、略過 ${result.unchanged}、衝突 ${result.conflicts.length}。原有不同資料保留。`);
    event.target.value = "";
  }));
  byId("snapshot-import-btn").addEventListener("click", () => byId("snapshot-import-file").click());
  const bar = byId("drawer-bar");
  function updateArrows() {
    byId("drawer-left").disabled = bar.scrollLeft <= 1;
    byId("drawer-right").disabled = bar.scrollLeft + bar.clientWidth >= bar.scrollWidth - 1;
  }
  for (const [id, direction] of [["drawer-left", -1], ["drawer-right", 1]]) {
    byId(id).addEventListener("click", () => bar.scrollBy({
      left: direction * Math.max(180, bar.clientWidth * 0.75),
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    }));
  }
  bar.addEventListener("scroll", updateArrows, { passive: true });
  document.addEventListener("ticket-drawers-rendered", () => requestAnimationFrame(updateArrows));
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(updateArrows).observe(bar);
  window.addEventListener("resize", updateArrows);
  byId("scan-ticket-btn").addEventListener("click", () => {
    if (window.TicketScanner?.scan) window.TicketScanner.scan();
    else {
      const code = prompt("輸入或貼上掃描器讀取的條碼（手機 APK 可直接開啟相機掃描）");
      if (code) acceptScan(code);
    }
  });
  function acceptScan(raw) {
    const code = String(raw || "").trim();
    if (!code) return;
    const matches = tickets.filter((ticket) => ticket.barcode_text === code || ticket.barcode_text_2 === code);
    if (matches.length) {
      drawerMode = "none";
      localStorage.setItem("drawer_mode", drawerMode);
      for (const ticket of matches) expandedTitleDrawers.add(ticketGroupKey(ticket));
      renderList();
      document.querySelector('.tab[data-tab="list"]').click();
      const row = document.querySelector(`.ticket-row[data-id="${matches[0].id}"]`);
      row?.classList.add("scan-match");
      row?.scrollIntoView({ block: "center", behavior: "smooth" });
      status(`找到 ${matches.length} 張對應票券。掃描不會自動兌換或修改狀態。`);
    } else if (!window.ticketExchange.readOnly) {
      document.querySelector('.tab[data-tab="manual"]').click();
      document.querySelector('#manual-form input[name="barcode_text"]').value = code;
      status("尚未找到票券，已將條碼填入新增表單，填寫後再手動儲存。");
    } else status("目前票券中沒有此條碼，請向 main server 更新後重試。", true);
  }
  window.acceptTicketScan = acceptScan;
  window.ticketExchange = { exportFile, initialize, get readOnly() { return serverMode === "client"; }, get isAuxiliary() { return serverMode === 'client'; } };
  document.addEventListener('ticket-sync-status', (event) => { lastOpenSync = event.detail; applyPermissions(); });
  function refreshOnReturn() {
    if (token && serverMode === 'client') loadTickets(true).catch((error) => status(error.message, true));
  }
  window.addEventListener('pageshow', (event) => { if (event.persisted) refreshOnReturn(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshOnReturn(); });
  document.addEventListener("ticket-auth-ready", initialize);
  if (token) initialize();
  updateArrows();
})();
