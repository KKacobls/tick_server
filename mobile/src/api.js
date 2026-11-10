/** Main is the only source of truth. Phones ALWAYS act as clients. */
export async function mainRequest(connection, path, options = {}) {
  if (!connection?.server || !connection?.token) throw Error("請先掃描 Main 配對 QR Code");
  const res = await fetch(connection.server + "/api/mobile" + path, {
    method: options.method || "GET",
    body: options.body,
    headers: {
      Authorization: "Bearer " + connection.token,
      ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) {
    let body;
    try { body = await res.json(); } catch { body = null; }
    const detail = body?.detail;
    const message = typeof detail === "string" ? detail :
      Array.isArray(detail) ? detail.map(e => e.msg).join("、") : "HTTP " + res.status;
    const err = Error(message);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

export function imageSource(connection, filename) {
  return { uri: connection.server + "/api/mobile/uploads/" + encodeURIComponent(filename),
    headers: { Authorization: "Bearer " + connection.token } };
}
