// Live check of the screenshot engine (extension/shot.js): asks it from the extension's
// content-script world in a real page, as the right-click menu does, and reports picture sizes.
// Usage: start a test window with --debug-port <n>, then: node tools/shot-check.mjs <n> [out-prefix] [url]
import fs from "node:fs";
const port = Number(process.argv[2] || 9481);
const out = process.argv[3];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ver;
for (let i = 0; i < 60 && !ver; i++) { ver = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json(), () => null); if (!ver) await wait(500); }
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const pending = new Map(); const events = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method) events.push(d); };
const send = (method, params = {}, sessionId) => new Promise((res) => { const id = ++n; pending.set(id, res); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });

const created = await send("Target.createTarget", { url: process.argv[4] || "https://en.wikipedia.org/wiki/Web_browser" });
await wait(9000);
const sid = (await send("Target.attachToTarget", { targetId: created.result.targetId, flatten: true })).result.sessionId;
await send("Page.enable", {}, sid);
await send("Page.reload", {}, sid);
await wait(4000);
await send("Runtime.enable", {}, sid);
await wait(800);
const ctx = events.filter((e) => e.method === "Runtime.executionContextCreated" && e.sessionId === sid).map((e) => e.params.context).find((c) => c.auxData && c.auxData.type === "isolated" && /chrome-extension:\/\/pbgbdlkc/.test(c.origin || ""));
if (!ctx) { console.log("FAIL no extension content-script world in the page"); process.exit(1); }
const ask = async (msg) => (await send("Runtime.evaluate", { contextId: ctx.id, expression: `chrome.runtime.sendMessage(${JSON.stringify({ type: "menu-do", ...msg })}).then((r) => JSON.stringify(r ? { ...r, dataUrl: r.dataUrl ? r.dataUrl.length + " chars" : undefined, png: r.dataUrl ? r.dataUrl.slice(0, 64) : undefined } : r))`, awaitPromise: true, returnByValue: true }, sid)).result?.result?.value;
const big = async (msg) => (await send("Runtime.evaluate", { contextId: ctx.id, expression: `chrome.runtime.sendMessage(${JSON.stringify({ type: "menu-do", ...msg })}).then((r) => r && r.dataUrl)`, awaitPromise: true, returnByValue: true }, sid)).result?.result?.value;
const size = (dataUrl) => { const b = Buffer.from(dataUrl.split(",")[1], "base64"); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length }; };

console.log("visible:", await ask({ what: "screenshot", mode: "visible" }));
const page = await big({ what: "screenshot", mode: "page" });
console.log("page:", page ? size(page) : "none");
if (page && out) fs.writeFileSync(out + "-page.png", Buffer.from(page.split(",")[1], "base64"));
const area = await big({ what: "screenshot", mode: "area", rect: { x: 0, y: 200, width: 600, height: 3000 } });
console.log("area 600x3000 from y=200:", area ? size(area) : "none");
if (area && out) fs.writeFileSync(out + "-area.png", Buffer.from(area.split(",")[1], "base64"));
// An area that does not start at the left edge must be exactly that part of the page:
// compare it with the same crop of the whole-page picture (review, Nov 13: x was lost).
// Scrolled down first, as a person would be: sticky parts are drawn relative to the scroll.
await send("Runtime.evaluate", { expression: "scrollTo(0, 3000)" }, sid);
await wait(500);
const off = await big({ what: "screenshot", mode: "area", rect: { x: 280, y: 3200, width: 400, height: 500 } });
if (off && page && out) {
  fs.writeFileSync(out + "-offset.png", Buffer.from(off.split(",")[1], "base64"));
  console.log("offset area written: compare with the page crop at (280,400) x scale");
}
const box = await big({ what: "screenshot", mode: "area", scroller: "#box", rect: { x: 0, y: 0, width: 500, height: 6200 } });
console.log("inner box rows 0-6200:", box ? size(box) : "none");
if (box && out) fs.writeFileSync(out + "-box.png", Buffer.from(box.split(",")[1], "base64"));
ws.close();
