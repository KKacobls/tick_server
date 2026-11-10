/* Authenticated Main creates one-time QR pairing codes for the mobile companion. */
(() => {
  const list = document.getElementById("mobile-device-list");
  const output = document.getElementById("mobile-pair-result");
  const qrBox = document.getElementById("mobile-pair-qr");
  if (!list || !output || !qrBox) return;

  async function refreshDevices() {
    try {
      const items = await api("/api/mobile/devices");
      list.replaceChildren();
      if (!items.length) {
        list.textContent = "尚無已配對裝置";
        return;
      }
      for (const item of items) {
        const row = document.createElement("div");
        row.className = "mobile-device-row";
        const label = document.createElement("span");
        label.textContent = item.name + " · " + (item.revoked ? "已撤銷" : "使用中");
        row.appendChild(label);
        if (!item.revoked) {
          const revoke = document.createElement("button");
          revoke.type = "button";
          revoke.className = "btn-danger";
          revoke.textContent = "撤銷此裝置";
          revoke.addEventListener("click", async () => {
            if (!confirm("撤銷「" + item.name + "」的手機存取權？")) return;
            try {
              await api("/api/mobile/devices/" + encodeURIComponent(item.id) + "/revoke", { method: "POST" });
              output.classList.add("hidden");
              qrBox.replaceChildren();
              await refreshDevices();
            } catch (err) {
              alert("撤銷失敗：" + err.message);
            }
          });
          row.appendChild(revoke);
        }
        list.appendChild(row);
      }
    } catch (err) {
      list.textContent = "取得裝置失敗：" + err.message;
    }
  }

  document.getElementById("mobile-pair-create").addEventListener("click", async () => {
    const name = document.getElementById("mobile-device-name").value.trim() || "我的手機";
    try {
      const result = await api("/api/mobile/devices", { method: "POST", body: JSON.stringify({ name }) });
      if (!location.origin.startsWith("https://")) {
        alert("請以 HTTPS 開啟 Main 再配對：手機正式版會拒絕 HTTP，避免裝置權杖外洩。");
      }
      output.classList.remove("hidden");
      qrBox.replaceChildren();
      new QRCode(qrBox, {
        text: JSON.stringify({ type: "tick_server_pair_v1", server: location.origin, token: result.token }),
        width: 220, height: 220,
      });
      await refreshDevices();
    } catch (err) {
      alert("配對碼建立失敗：" + err.message);
    }
  });

  document.addEventListener("ticket-auth-ready", refreshDevices);
})();
