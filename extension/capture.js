// Request capture: folds browser network events into one record per request.
// Pure logic, no chrome.* calls, tested with node.
//
// The events come from chrome.webRequest, which sees method, URL, headers,
// status, timing and the server address, but not response bodies. Bodies need
// a proxy (Burp, mitmproxy) and are a separate feature.

export const MAX_RECORDS = 1000;

export function emptyState() {
  return { order: [], byId: {} };
}

function headerList(headers) {
  return (headers || []).map((h) => ({ name: h.name, value: h.value ?? "" }));
}

function headerValue(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : null;
}

// Applies one event to the state (mutates and returns it).
// kind: before | sendHeaders | headersReceived | completed | error
export function applyEvent(state, kind, d) {
  let r = state.byId[d.requestId];
  if (!r) {
    if (kind !== "before") {
      // Capture was switched on mid-flight; start the record from what we have.
      r = { id: d.requestId, startTime: d.timeStamp, partial: true };
    } else {
      r = { id: d.requestId, startTime: d.timeStamp };
    }
    state.byId[d.requestId] = r;
    state.order.push(d.requestId);
    while (state.order.length > MAX_RECORDS) delete state.byId[state.order.shift()];
  }
  r.method = d.method ?? r.method;
  r.url = d.url ?? r.url; // a redirect keeps the id and changes the URL
  r.type = d.type ?? r.type;
  r.tabId = d.tabId ?? r.tabId;
  r.initiator = d.initiator ?? r.initiator ?? null;

  if (kind === "before" && d.requestBody) {
    if (d.requestBody.formData) r.requestForm = d.requestBody.formData;
    else if (d.requestBody.raw) r.requestBodyBytes = d.requestBody.raw.reduce((n, p) => n + (p.bytes ? p.bytes.byteLength : 0), 0);
  }
  if (kind === "sendHeaders") r.requestHeaders = headerList(d.requestHeaders);
  if (kind === "headersReceived" || kind === "completed") {
    r.status = d.statusCode ?? r.status;
    r.statusLine = d.statusLine ?? r.statusLine;
    if (d.responseHeaders) {
      r.responseHeaders = headerList(d.responseHeaders);
      r.mime = (headerValue(d.responseHeaders, "content-type") || "").split(";")[0].trim() || null;
      const len = headerValue(d.responseHeaders, "content-length");
      r.contentLength = len === null ? null : Number(len);
    }
  }
  if (kind === "completed") {
    r.ip = d.ip ?? null;
    r.fromCache = !!d.fromCache;
    r.endTime = d.timeStamp;
    r.durationMs = Math.round(d.timeStamp - r.startTime);
    r.done = true;
  }
  if (kind === "error") {
    r.error = d.error;
    r.endTime = d.timeStamp;
    r.durationMs = Math.round(d.timeStamp - r.startTime);
    r.done = true;
  }
  return state;
}

// Records newest first, optionally filtered.
// filter: { text, method, type, tabId, statusClass (2|3|4|5), errorsOnly }
export function listRecords(state, filter = {}, limit = 500) {
  const text = (filter.text || "").toLowerCase();
  const out = [];
  for (let i = state.order.length - 1; i >= 0 && out.length < limit; i--) {
    const r = state.byId[state.order[i]];
    if (!r) continue;
    if (text && !(r.url || "").toLowerCase().includes(text)) continue;
    if (filter.method && r.method !== filter.method) continue;
    if (filter.type && r.type !== filter.type) continue;
    if (filter.tabId !== undefined && r.tabId !== filter.tabId) continue;
    if (filter.statusClass && Math.floor((r.status || 0) / 100) !== filter.statusClass) continue;
    if (filter.errorsOnly && !r.error && !((r.status || 0) >= 400)) continue;
    out.push(r);
  }
  return out;
}

// A request as a curl command, for replay outside the browser.
export function toCurl(r) {
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const parts = ["curl", "-X", r.method || "GET", q(r.url)];
  for (const h of r.requestHeaders || []) {
    // curl sets these itself; sending them by hand breaks compression and HTTP/2.
    if (/^(host|content-length|accept-encoding|connection)$/i.test(h.name) || h.name.startsWith(":")) continue;
    parts.push("-H", q(h.name + ": " + h.value));
  }
  if (r.requestForm) {
    for (const [k, vals] of Object.entries(r.requestForm)) for (const v of vals) parts.push("--data-urlencode", q(k + "=" + v));
  }
  return parts.join(" ");
}
