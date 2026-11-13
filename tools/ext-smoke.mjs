// Smoke test: load the extension in a throwaway Brave profile and exercise the
// background's messages for real: tab handling, downloads, capture, sessions,
// proxy, the native helper, per-tab stats and the security audit.
//
//   PUPPETEER_FROM=<folder with node_modules> node tools/ext-smoke.mjs
//
// Needs `gamblium install-host` to have been run once (the installer does it).
// Uses a fresh profile folder and closes the browser when done, pass or fail.

import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(path.join(process.env.PUPPETEER_FROM || process.cwd(), "package.json"));
const puppeteer = require("puppeteer-core");
const GAMBLIUM = path.resolve("target/release/gamblium.exe");
const EXT = path.resolve(process.argv[2] || "extension");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "gamblium-smoke-"));
const port = 9300 + Math.floor(Math.random() * 200);
const sitePort = 8097;
const server = spawn(process.execPath, ["tools/vuln-server.mjs", String(sitePort)], { stdio: "ignore" });
const site = `http://127.0.0.1:${sitePort}`;

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(!!ok);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
};

try {
  // The launcher is part of what is being tested: it must not block and must
  // load the extension by itself. Plain preset so nothing sleeps mid-test.
  execFileSync(GAMBLIUM, [
    "launch", "--preset", "performance", "--no-debloat", "--user-data-dir", prof, "--debug-port", String(port),
    "--", `--load-extension=${EXT}`, "about:blank",
  ], { env: { ...process.env, GAMBLIUM_HOME: path.dirname(EXT) + path.sep + "no-such-folder" }, encoding: "utf8" });

  let browser;
  for (let i = 0; i < 40 && !browser; i++) {
    await sleep(500);
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null }).catch(() => null);
  }
  if (!browser) throw new Error("could not connect to Brave");
  const worker = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 15000 });
  const id = new URL(worker.url()).host;
  check("extension loaded with its fixed id", id === "pbgbdlkcienglhbfadbjolphinilbpia", id);

  // Two real pages so there is something to measure and to save.
  const a = await browser.newPage();
  await a.goto(`${site}/`);
  const b = await browser.newPage();
  await b.goto(`${site}/secure`);

  // Messages must come from one of the extension's own pages.
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  const ask = (msg) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg);

  const status = await ask({ type: "status" });
  check("status lists tabs and the delay in use", status && status.total >= 3 && typeof status.delaySecNow === "number", `${status.total} tabs`);

  check("downloads list answers", Array.isArray(await ask({ type: "downloads-list", limit: 5 })));

  const capStart = await ask({ type: "capture-start" });
  check("capture refuses to start without the permission", capStart.ok === false && capStart.needPermission === true);

  const saved = await ask({ type: "session-save", name: "smoke test", scope: "all" });
  check("a session is saved", saved.ok && saved.tabs >= 2, `${saved.tabs} tabs, ${saved.skipped} skipped`);
  const list = await ask({ type: "session-list" });
  check("the session is listed with its sites", list.some((s) => s.name === "smoke test" && s.hosts.includes("127.0.0.1")));
  await ask({ type: "session-delete", name: "smoke test" });
  check("the session is deleted", !(await ask({ type: "session-list" })).some((s) => s.name === "smoke test"));

  const proxy = await ask({ type: "proxy-get" });
  check("proxy reads as the system setting", proxy.ok && proxy.mode === "system", proxy.mode);
  const set = await ask({ type: "proxy-set", proxy: { mode: "fixed", scheme: "http", host: "127.0.0.1", port: 9, bypass: ["127.0.0.1"] } });
  check("proxy can be switched to a fixed server", set.ok && set.mode === "fixed" && set.port === 9);
  const cleared = await ask({ type: "proxy-set", proxy: { mode: "system" } });
  check("and back to the system setting", cleared.ok && cleared.mode === "system");

  const ping = await ask({ type: "native", request: { type: "ping" } });
  check("the helper answers from inside the browser", ping.ok && ping.version, ping.ok ? `v${ping.version}, browser pid ${ping.browserPid}` : ping.error);

  if (ping.ok) {
    await ask({ type: "tab-stats" });
    await sleep(2000);
    const stats = await ask({ type: "tab-stats" });
    const mine = (stats.tabs || []).filter((t) => t.url.startsWith(site));
    check("each page tab is matched to a process with memory", stats.ok && mine.length === 2 && mine.every((t) => t.memoryMb > 0 && t.pids.length > 0),
      mine.map((t) => `${t.memoryMb} MB`).join(", "));
    check("the second reading has CPU figures", stats.ok && stats.total.cpuPct !== null && mine.every((t) => t.cpuPct !== null), `total ${stats.total?.cpuPct}% of one core`);
    check("the helper reported only this browser", stats.ok && stats.kinds.browser && stats.kinds.browser.processes === 1);

    const audit = await ask({ type: "native", request: { type: "audit", url: `${site}/` } });
    check("audit through the browser finds the cross-origin flaw", audit.ok && audit.findings.some((f) => f.id === "cors-reflect-credentials"), `${audit.findings?.length} findings`);
    const refused = await ask({ type: "native", request: { type: "audit", url: "http://93.184.216.34/" } });
    check("audit of a public address is refused", refused.ok === false && /scope/.test(refused.error));
  }

  // The dashboard page must load and show the scope banner for a local target.
  const dash = await browser.newPage();
  await dash.goto(`chrome-extension://${id}/ui/security.html?raw&url=${encodeURIComponent(site + "/")}&panel=audit`);
  await dash.waitForFunction(() => /findings/.test(document.getElementById("auditOut").textContent), { timeout: 20000 }).catch(() => {});
  const banner = await dash.$eval("#scope", (e) => e.textContent);
  const auditText = await dash.$eval("#auditOut", (e) => e.textContent);
  check("dashboard shows the target as in scope", /in scope/.test(banner), banner.slice(0, 70));
  check("dashboard runs the audit when opened from the menu", /findings: 10 /.test(auditText), auditText.slice(0, 60));
} catch (e) {
  check("no exception", false, e.message);
} finally {
  try {
    execFileSync(GAMBLIUM, ["close", "--user-data-dir", prof], { encoding: "utf8" });
  } catch {
    // Nothing was running.
  }
  server.kill();
  await sleep(1500);
  fs.rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
const ok = checks.length > 0 && checks.every(Boolean);
console.log(ok ? "SMOKE OK" : "SMOKE FAILED");
process.exit(ok ? 0 : 1);
