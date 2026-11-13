import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_RECORDS, applyEvent, emptyState, listRecords, toCurl } from "./capture.js";

function full(state, id, over = {}) {
  const base = { requestId: id, method: "GET", url: "https://api.example.com/v1/users?id=7", type: "xmlhttprequest", tabId: 3, ...over };
  applyEvent(state, "before", { ...base, timeStamp: 1000 });
  applyEvent(state, "sendHeaders", { ...base, timeStamp: 1001, requestHeaders: [{ name: "Authorization", value: "Bearer abc" }, { name: "Host", value: "api.example.com" }] });
  applyEvent(state, "headersReceived", {
    ...base, timeStamp: 1100, statusCode: over.statusCode ?? 200, statusLine: "HTTP/1.1 200 OK",
    responseHeaders: [{ name: "Content-Type", value: "application/json; charset=utf-8" }, { name: "Content-Length", value: "512" }],
  });
  applyEvent(state, "completed", { ...base, timeStamp: 1150, statusCode: over.statusCode ?? 200, ip: "93.184.216.34", fromCache: false });
  return state;
}

test("events for one request fold into one record", () => {
  const s = full(emptyState(), "1");
  const [r] = listRecords(s);
  assert.equal(s.order.length, 1);
  assert.equal(r.method, "GET");
  assert.equal(r.status, 200);
  assert.equal(r.mime, "application/json");
  assert.equal(r.contentLength, 512);
  assert.equal(r.ip, "93.184.216.34");
  assert.equal(r.durationMs, 150);
  assert.equal(r.done, true);
  assert.equal(r.requestHeaders[0].name, "Authorization");
});

test("an error ends the record", () => {
  const s = emptyState();
  applyEvent(s, "before", { requestId: "9", method: "POST", url: "https://x.test/", type: "main_frame", tabId: 1, timeStamp: 10 });
  applyEvent(s, "error", { requestId: "9", timeStamp: 60, error: "net::ERR_CONNECTION_REFUSED" });
  const [r] = listRecords(s, { errorsOnly: true });
  assert.equal(r.error, "net::ERR_CONNECTION_REFUSED");
  assert.equal(r.durationMs, 50);
});

test("a request seen from the middle is kept and marked partial", () => {
  const s = emptyState();
  applyEvent(s, "completed", { requestId: "5", method: "GET", url: "https://x.test/a", timeStamp: 500, statusCode: 204 });
  assert.equal(listRecords(s)[0].partial, true);
});

test("filters by text, method, status class and tab; newest first", () => {
  const s = emptyState();
  full(s, "1");
  full(s, "2", { method: "POST", url: "https://shop.example.com/cart", statusCode: 403, tabId: 8 });
  assert.deepEqual(listRecords(s).map((r) => r.id), ["2", "1"]);
  assert.deepEqual(listRecords(s, { text: "CART" }).map((r) => r.id), ["2"]);
  assert.deepEqual(listRecords(s, { method: "GET" }).map((r) => r.id), ["1"]);
  assert.deepEqual(listRecords(s, { statusClass: 4 }).map((r) => r.id), ["2"]);
  assert.deepEqual(listRecords(s, { tabId: 3 }).map((r) => r.id), ["1"]);
  assert.deepEqual(listRecords(s, { errorsOnly: true }).map((r) => r.id), ["2"]);
});

test("the buffer drops the oldest records past the limit", () => {
  const s = emptyState();
  for (let i = 0; i < MAX_RECORDS + 5; i++) applyEvent(s, "before", { requestId: String(i), method: "GET", url: "https://x.test/" + i, timeStamp: i });
  assert.equal(s.order.length, MAX_RECORDS);
  assert.equal(s.byId["0"], undefined);
  assert.ok(s.byId[String(MAX_RECORDS + 4)]);
});

test("curl export quotes safely and skips headers curl sets itself", () => {
  const s = full(emptyState(), "1", { url: "https://x.test/it's" });
  const cmd = toCurl(listRecords(s)[0]);
  assert.equal(cmd, "curl -X GET 'https://x.test/it'\\''s' -H 'Authorization: Bearer abc'");
});
