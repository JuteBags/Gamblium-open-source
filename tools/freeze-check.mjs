// Does the extension's freezer do what the owner asked ("0 Kelvin")?
//   - a hidden tab is frozen within about a minute and stops working
//   - a tab marked "keep awake" keeps working while hidden
//   - a site on the always-awake list keeps working while hidden
//   - a frozen tab comes back when it is shown
//   - marking a frozen tab "keep awake" wakes it while it stays hidden
// Each test page calls the local server once a second, so the server can see
// which pages are running without touching them.
//
//   PUPPETEER_FROM=<folder with node_modules> node tools/freeze-check.mjs
//
// Fresh throwaway folder; the browser is closed and the folder removed when
// done, pass or fail. Takes about two minutes.

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const require = createRequire(path.join(process.env.PUPPETEER_FROM || process.cwd(), "package.json"));
const puppeteer = require("puppeteer-core");
const GAMBLIUM = path.resolve("target/release/gamblium.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const last = {}; // page id -> time of its last call
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/tick") {
    last[u.searchParams.get("id")] = Date.now();
    res.writeHead(204);
    return res.end();
  }
  const id = u.searchParams.get("id") || "?";
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>page ${id}</title><h1>page ${id}</h1><script>setInterval(() => fetch("/tick?id=${id}").catch(() => {}), 1000);</script>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const quietFor = (id) => (last[id] ? (Date.now() - last[id]) / 1000 : Infinity);

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(!!ok);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + String(detail).slice(0, 140) : ""}`);
};

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "gamblium-freeze-"));
const debug = 9300 + Math.floor(Math.random() * 200);
const connect = async () => {
  for (let i = 0; i < 40; i++) {
    const b = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debug}`, defaultViewport: null }).catch(() => null);
    if (b) return b;
    await sleep(500);
  }
  throw new Error("could not connect to Brave");
};

try {
  const out = execFileSync(GAMBLIUM, ["launch", "--preset", "lean", "--no-debloat", "--user-data-dir", prof, "--debug-port", String(debug), "--", "about:blank"],
    { env: { ...process.env, GAMBLIUM_HOME: path.resolve(".") }, encoding: "utf8" });
  check("the launcher hands freezing to the extension", /silent-debugger-extension-api/.test(out) && !/InfiniteTabsFreezing/.test(out), out.split("\n").find((l) => /brave/i.test(l)) || "");

  let browser = await connect();
  const worker = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 15000 });
  const id = new URL(worker.url()).host;

  // a: plain. b: marked "keep awake". c: on the always-awake site list (localhost). d: plain, marked awake later.
  const urls = { a: `http://127.0.0.1:${port}/?id=a`, b: `http://127.0.0.1:${port}/?id=b`, c: `http://localhost:${port}/?id=c`, d: `http://127.0.0.1:${port}/?id=d` };
  for (const u of Object.values(urls)) await (await browser.newPage()).goto(u);
  const ctl = await browser.newPage(); // one of our own pages, to talk to the background; stays in front
  await ctl.goto(`chrome-extension://${id}/ui/sessions.html?raw`);
  const ask = (msg) => ctl.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  const tabs = await ctl.evaluate(() => chrome.tabs.query({}));
  const tabOf = (k) => tabs.find((t) => t.url === urls[k]).id;

  const b = await ask({ type: "awake-set", tabId: tabOf("b"), tab: true });
  check("a tab can be marked keep awake", b.ok && b.tab === true && b.freezing === true, JSON.stringify(b));
  const c = await ask({ type: "awake-set", tabId: tabOf("c"), site: true });
  check("a site can be put on the always-awake list", c.ok && c.site === true && c.host === "localhost", JSON.stringify(c));
  check("the background knows the launcher set freezing up", (await ctl.evaluate(() => chrome.storage.local.get("launchFreeze"))).launchFreeze === true);

  // Let go of the pages, so nothing but the extension touches them.
  browser.disconnect();
  console.log("     waiting 80 s for hidden tabs to freeze…");
  await sleep(80000);

  check("a hidden tab is frozen and stops working", quietFor("a") > 15, `page a last called ${quietFor("a").toFixed(0)} s ago`);
  check("another hidden tab is frozen too", quietFor("d") > 15, `page d last called ${quietFor("d").toFixed(0)} s ago`);
  check("the tab marked keep awake keeps working", quietFor("b") < 4, `page b last called ${quietFor("b").toFixed(1)} s ago`);
  check("the always-awake site keeps working", quietFor("c") < 4, `page c last called ${quietFor("c").toFixed(1)} s ago`);

  browser = await connect();
  const again = (await browser.pages()).find((p) => p.url().includes("/ui/sessions.html?raw"));
  const ask2 = (msg) => again.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  const stateA = await ask2({ type: "awake-get", tabId: tabOf("a") });
  check("the extension reports the tab as frozen", stateA.ok && stateA.frozen === true, JSON.stringify(stateA));

  // Mark frozen tab d "keep awake": it must start working again while still hidden.
  await ask2({ type: "awake-set", tabId: tabOf("d"), tab: true });
  await sleep(4000);
  check("marking a frozen tab keep awake wakes it, still hidden", quietFor("d") < 3, `page d last called ${quietFor("d").toFixed(1)} s ago`);

  // Show frozen tab a: it must come back by itself.
  const t0 = Date.now();
  await again.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), tabOf("a"));
  let back = null;
  for (let i = 0; i < 50 && back === null; i++) {
    await sleep(100);
    if (last.a && last.a > t0) back = last.a - t0;
  }
  check("a frozen tab comes back when it is shown", back !== null, back === null ? "no call within 5 s" : `first call ${back} ms after showing it (pages call once a second)`);
  browser.disconnect();
} catch (e) {
  check("the run finished", false, String(e && e.stack ? e.stack : e).slice(0, 500));
} finally {
  try {
    console.log(execFileSync(GAMBLIUM, ["close", "--user-data-dir", prof], { encoding: "utf8" }).trim());
  } catch (e) {
    console.log("close failed:", e.message);
  }
  server.close();
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      break;
    } catch {
      await sleep(700);
    }
  }
}

const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed} of ${checks.length} passed.`);
process.exit(failed ? 1 : 0);
