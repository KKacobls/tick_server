/* Pure helpers shared with the Expo UI; tested with node (no phone required). */
function uniqueCodes(values) {
  const seen = new Set();
  return values.map(v => String(v ?? "").trim()).filter(code => {
    if (!code || code.length > 128 || /[\x00-\x1f\x7f]/.test(code) || seen.has(code)) return false;
    seen.add(code);
    return true;
  });
}

function is711Pair(a, b) {
  const main = /^7100\d{12}$/;
  const second = /^(?=.*[A-Za-z])[A-Za-z0-9]{8}$/;
  return (main.test(a) && second.test(b)) || (main.test(b) && second.test(a));
}

function is711Batch(codes) {
  return codes.length > 0 && codes.length % 2 === 0 &&
    codes.every((_, i) => i % 2 || is711Pair(codes[i], codes[i + 1]));
}

function is711Title(title) {
  return /7\s*[-－]\s*11\s*商品卡|#711/i.test(title || "");
}

function previewText(title, codes) {
  return [title.trim(), ...uniqueCodes(codes)].filter(Boolean).join("\n");
}

function mergeTickets(local, remote, mode) {
  if (!Array.isArray(remote)) throw Error("Main 回傳的票券資料無效，已保留原本快取");
  if (mode === "mirror") return [...remote];
  // Append-only: existing local items (and their states) are NOT overwritten or deleted.
  const seen = new Set(local.map(item => String(item.id)));
  return [...local, ...remote.filter(item => !seen.has(String(item.id)))];
}

function parsePairQR(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw Error("這不是 Main 手機配對 QR Code"); }
  if (value?.type !== "tick_server_pair_v1" || typeof value.token !== "string" ||
      !/^mob_[A-Za-z0-9_-]{40,}$/.test(value.token)) {
    throw Error("配對 QR Code 格式或權杖無效");
  }
  let url;
  try { url = new URL(value.server); } catch { throw Error("Main 網址無效"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw Error("Main 配對必須使用 HTTPS 網址，不可含額外路徑或參數");
  }
  return { server: url.origin, token: value.token };
}

module.exports = { uniqueCodes, is711Pair, is711Batch, is711Title, previewText, mergeTickets, parsePairQR };
