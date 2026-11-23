// Smoke test for the extension's own screens: the popup, tabs and memory,
// sessions, downloads and settings. Loads them in a throwaway Brave profile,
// uses them the way a person would, and saves a screenshot of each.
//
//   PUPPETEER_FROM=<folder with node_modules> node tools/pages-smoke.mjs [outDir]
//
// Needs `gamblium install-host` to have been run once (the installer does it).
// Uses a fresh profile folder and closes the browser when done, pass or fail.
// The window is never brought to the front.

import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(path.join(process.env.PUPPETEER_FROM || process.cwd(), "package.json"));
const puppeteer = require("puppeteer-core");
const GAMBLIUM = path.resolve("target/release/gamblium.exe");

// Settings clicks reach the look files the owner's own Gamblium reads. They are
// saved here and put back when the run ends, however it ends.
const LOOK_DIR = path.join(process.env.LOCALAPPDATA || "", "Gamblium");
const LOOK_FILES = ["theme.txt", "keep-websites-light", "own-colours.json"];
const lookBefore = LOOK_FILES.map((f) => {
  try {
    return fs.readFileSync(path.join(LOOK_DIR, f));
  } catch {
    return null;
  }
});
process.on("exit", () => {
  LOOK_FILES.forEach((f, i) => {
    const file = path.join(LOOK_DIR, f);
    try {
      if (lookBefore[i] === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, lookBefore[i]);
    } catch {
      // nothing more to do at exit
    }
  });
});
const EXT = path.resolve("extension");
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), "gamblium-pages-shots"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "gamblium-pages-"));
const port = 9300 + Math.floor(Math.random() * 200);
const sitePort = 8096;
const server = spawn(process.execPath, ["tools/vuln-server.mjs", String(sitePort)], { stdio: "ignore" });
const site = `http://127.0.0.1:${sitePort}`;

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(!!ok);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
};

try {
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
  const ext = (file) => `chrome-extension://${id}/${file}`;

  // Real pages, so there is something to list, measure and save.
  const web = [];
  for (const p of ["/", "/secure", "/", "/secure"]) {
    const t = await browser.newPage();
    await t.goto(site + p);
    web.push(t);
  }

  const errors = [];
  const open = async (file, width = 1280, height = 900) => {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(`${file}: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && errors.push(`${file}: ${m.text()}`));
    await page.setViewport({ width, height });
    await page.goto(ext(file));
    return page;
  };
  const shot = async (page, name) => {
    for (const mode of ["dark", "light"]) {
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: mode }]);
      await sleep(150);
      await page.screenshot({ path: path.join(OUT, `${name}-${mode}.png`), fullPage: true });
    }
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  };
  const text = (page, sel) => page.$eval(sel, (e) => e.textContent.trim());
  const stored = (page, keys) => page.evaluate((k) => chrome.storage.local.get(k), keys);
  const setValue = (page, sel, value) =>
    page.$eval(sel, (e, v) => {
      e.value = v;
      e.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);

  // ---- Tabs and memory ----
  const dash = await open("ui/dashboard.html?raw");
  await sleep(7500); // two readings, so processor use is known
  const tabsShown = Number(await text(dash, "#fTabs"));
  const rowCount = await dash.$$eval("#rows tr", (r) => r.length);
  check("dashboard counts the open tabs", tabsShown >= 5 && rowCount === tabsShown, `${tabsShown} tabs, ${rowCount} rows`);
  check("dashboard shows memory and processor totals", /MB|GB/.test(await text(dash, "#fMem")) && /%/.test(await text(dash, "#fCpu")), `${await text(dash, "#fMem")}, ${await text(dash, "#fCpu")}`);
  check("the helper note stays hidden when the helper answers", await dash.$eval("#helperNote", (e) => e.hidden));
  check("per-tab memory is filled in", (await dash.$$eval("#rows td.num", (c) => c.filter((x) => /MB/.test(x.textContent)).length)) >= 4);
  check("memory by part is listed", (await dash.$$eval("#kinds tbody tr", (r) => r.length)) >= 3);
  check("sleep rules are listed", (await dash.$$eval("#reasons li", (r) => r.length)) >= 1);
  await dash.click('th[data-sort="title"] button');
  check("a column header sorts the table", (await dash.$eval('th[data-sort="title"]', (e) => e.getAttribute("aria-sort"))) === "ascending");
  await dash.click('th[data-sort="memory"] button');
  await shot(dash, "1-tabs-and-memory");

  // ---- Sessions ----
  const ses = await open("ui/sessions.html?raw");
  check("sessions starts with the empty note", !(await ses.$eval("#none", (e) => e.hidden)));
  await ses.$eval("#name", (e) => (e.value = "Morning work"));
  await ses.click("#saveForm button.primary");
  await ses.waitForSelector("#rows > li", { timeout: 8000 });
  check("a checkpoint is saved and listed", /Saved "Morning work": \d+ tabs/.test(await text(ses, "#said")), await text(ses, "#said"));
  check("its row shows the sites", /127\.0\.0\.1/.test(await text(ses, "#rows > li .sub")));
  check("its windows are drawn as rows of site icons", (await ses.$$eval("#rows > li .win .tabicon img", (i) => i.length)) >= 1);
  check("the open windows are drawn the same way", (await ses.$$eval("#nowWins .win .tabicon img", (i) => i.length)) >= 1, await text(ses, "#nowLine"));
  await ses.$eval("#name", (e) => (e.value = "Reading list"));
  await ses.click("#saveForm button.primary");
  await ses.waitForFunction(() => document.querySelectorAll("#rows > li").length === 2, { timeout: 8000 });
  await shot(ses, "2-sessions");
  // Open the first session: its tabs are listed, and Delete sits there and asks twice.
  await ses.click("#rows > li:first-child [aria-expanded]");
  await ses.waitForSelector("#rows > li:first-child .stab", { timeout: 8000 });
  check("an opened session lists its tabs", (await ses.$$eval("#rows > li:first-child .stab", (t) => t.length)) >= 1);
  const tool = async (label) => {
    for (const b of await ses.$$("#rows > li:first-child .stools button")) if ((await b.evaluate((e) => e.textContent)) === label) return b;
    return null;
  };
  await (await tool("Delete")).click();
  await ses.waitForFunction(() => /Delete for good/.test(document.querySelector("#rows > li:first-child .stools").textContent), { timeout: 5000 }).catch(() => {});
  check("delete asks a second time", /Delete for good/.test(await text(ses, "#rows > li:first-child .stools")));
  await (await tool("Delete for good")).click();
  await ses.waitForFunction(() => document.querySelectorAll("#rows > li").length === 1, { timeout: 8000 });
  check("a checkpoint is deleted", /Deleted/.test(await text(ses, "#said")));

  // ---- Downloads ----
  const dl = await open("ui/downloads.html?raw");
  await sleep(600);
  check("downloads starts with the empty note", !(await dl.$eval("#none", (e) => e.hidden)));
  check("the built-in folder rules are listed", (await dl.$$eval("#rules tr", (r) => r.length)) === 8);
  await dl.click("#routing");
  await sleep(300);
  check("switching sorting on is stored", (await stored(dl, ["routingEnabled"])).routingEnabled === true);
  await dl.click("#addRule");
  await dl.$$eval("#rules tr:last-child input", (inputs) => {
    const values = ["Work", "", "bad host!"];
    inputs.forEach((i, n) => {
      i.value = values[n];
      i.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
  await sleep(300);
  check("a wrong rule is refused with a reason", !(await dl.$eval("#rulesError", (e) => e.hidden)), await text(dl, "#rulesError"));
  await dl.$$eval("#rules tr:last-child input", (inputs) => {
    const values = ["Work", "", "https://github.com/x"];
    inputs.forEach((i, n) => {
      i.value = values[n];
      i.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
  await sleep(400);
  const rules = (await stored(dl, ["rules"])).rules || [];
  check("a corrected rule is stored", rules.length === 9 && rules[8].folder === "Work" && rules[8].hosts[0] === "github.com");
  check("the box shows what was stored", (await dl.$eval("#rules tr:last-child td:nth-child(3) input", (e) => e.value)) === "github.com");
  await dl.$eval("#url", (e) => (e.value = "not an address"));
  await dl.click("#startForm button.primary");
  check("a bad address is refused", /http/.test(await text(dl, "#said")));
  await dl.$eval("#url", (e) => (e.value = ""));
  await dl.$eval("#said", (e) => (e.hidden = true));
  await shot(dl, "3-downloads");

  // ---- Settings ----
  const set = await open("ui/settings.html?raw#all");
  await sleep(1500);
  await setValue(set, "#delayMin", "5");
  await setValue(set, "#allowlist", "https://mail.google.com/mail/u/0\nbad host!\nlocalhost");
  await sleep(400);
  const s1 = await stored(set, ["delaySec", "allowlist"]);
  check("the sleep delay is stored in seconds", s1.delaySec === 300);
  check("the never-sleep list keeps only site names", JSON.stringify(s1.allowlist) === '["mail.google.com","localhost"]' && /Left out/.test(await text(set, "#allowlistHint")), JSON.stringify(s1.allowlist));
  await setValue(set, "#lightSites", "docs.google.com");
  await sleep(600);
  const light = await set.evaluate(() => chrome.scripting.getRegisteredContentScripts({ ids: ["keep-light"] }));
  check("a keep-light site registers its stylesheet", light.length === 1 && light[0].matches.includes("*://docs.google.com/*"));
  // The helper gets its own line only when its version differs from Gamblium's; the folder always shows.
  check("the version and profile folder are shown", /^Gamblium\d/.test(await text(set, "#about")) && /gamblium-pages-/.test(await text(set, "#about")), await text(set, "#about"));

  await set.click('input[name="mode"][value="fixed"]');
  await set.$eval("#pHost", (e) => (e.value = "127.0.0.1"));
  await set.$eval("#pPort", (e) => (e.value = "99999"));
  await set.click("#proxyForm button.primary");
  await sleep(400);
  check("a wrong proxy port is refused", !(await set.$eval("#proxyError", (e) => e.hidden)), await text(set, "#proxyError"));
  await set.$eval("#pPort", (e) => (e.value = "8080"));
  await set.click("#proxyForm button.primary");
  await sleep(600);
  check("a proxy is applied and shown", /http:\/\/127\.0\.0\.1:8080/.test(await text(set, "#proxyNow")), await text(set, "#proxyNow"));

  await set.click("#bridge");
  await sleep(3000);
  check("agent control switches on and says so", /^On\./.test(await text(set, "#bridgeNow")) && (await set.$eval("#bridgeNow", (e) => e.classList.contains("warn"))), await text(set, "#bridgeNow"));
  await shot(set, "4-settings");

  // The popup, shown for a web tab, while agent control is still on.
  const webId = await dash.evaluate((u) => chrome.tabs.query({}).then((t) => t.find((x) => x.url === u).id), site + "/secure");
  const pop = await open(`popup.html?tab=${webId}`, 360, 640);
  await sleep(1200);
  check("the popup counts tabs", /^\d+ tabs$/.test(await text(pop, "#count")), await text(pop, "#count"));
  check("the popup shows memory", /(Gamblium uses|used) .*free/.test(await text(pop, "#memory")), await text(pop, "#memory"));
  check("the popup names the site in front", (await text(pop, "#siteHost")) === "127.0.0.1" && (await pop.$eval("#keepLightRow", (e) => e.hidden)));
  check("the popup warns while agents have control", !(await pop.$eval("#agent", (e) => e.hidden)));
  // The popup opens on the site in front (the browser's own menu is the button beside ours, #116);
  // its menu and the tabs are the other two views.
  check("the popup opens on this site", !(await pop.$eval("#viewSite", (e) => e.hidden)) && (await pop.$eval("#viewMenu", (e) => e.hidden)));
  await pop.$eval("#vMenu", (e) => e.click());
  await sleep(300);
  // 14 rows: Browser settings, Clear browsing data, About and Exit joined the list (Exit last, after a line).
  check("its menu view has its rows", (await pop.$$eval("#menuRows .mrow", (e) => e.length)) === 14 && (await pop.$eval("#menuRows .mrow:last-child", (e) => e.dataset.go)) === "exit" && (await pop.$$eval(".menu button", (e) => e.length)) === 3, await text(pop, "#zoomNow"));
  check("the menu shows the page's zoom", /^\d+%$/.test(await text(pop, "#zoomNow")), await text(pop, "#zoomNow"));
  await pop.$eval("#vSite", (e) => e.click());
  await sleep(300);
  await pop.click("#neverSleep");
  await sleep(300);
  check("never-sleep from the popup is stored", (await stored(pop, ["allowlist"])).allowlist.includes("127.0.0.1"));
  // The sleep button is in the tabs view.
  await pop.$eval("#vBrowser", (e) => e.click());
  await sleep(300);
  await pop.click("#thisWindow");
  await sleep(800);
  check("the sleep button answers", (await text(pop, "#said")).length > 0, await text(pop, "#said"));
  await shot(pop, "5-popup");

  // Every test window wears the default look, moon (owner, Nov 12 2026): no other scheme
  // is clicked or launched here. Earlier pages are now background tabs, so they are driven
  // without clicks and never brought forward; the screenshots come from fresh tabs.
  const press = (page, sel) => page.$eval(sel, (e) => e.click());
  const wears = await set.evaluate(() => ({ scheme: document.documentElement.dataset.scheme ?? null, picked: document.querySelector('input[name="scheme"]:checked')?.value ?? null }));
  check("the pages wear the default scheme, moon", (wears.scheme ?? "moon") === "moon" && (wears.picked ?? "moon") === "moon", JSON.stringify(wears));
  const set2 = await open("ui/settings.html?raw#all");
  await sleep(1500);
  await shot(set2, "6-settings");
  const dash2 = await open("ui/dashboard.html?raw");
  await sleep(7000);
  await shot(dash2, "7-tabs-and-memory");

  // Put things back so nothing outlives the test.
  await press(set2, "#bridge");
  await press(set2, 'input[name="mode"][value="system"]');
  await press(set2, "#proxyForm button.primary");
  await sleep(2500);
  await sleep(1800);
  check("agent control switches off again", /^Off\./.test(await text(set2, "#bridgeNow")), await text(set2, "#bridgeNow"));
  check("the proxy goes back to the system setting", /system/.test(await text(set2, "#proxyNow")), await text(set2, "#proxyNow"));

  check("no page reported an error", errors.length === 0, errors.slice(0, 3).join(" | "));
  browser.disconnect();
} catch (e) {
  check("the run finished", false, String(e && e.stack ? e.stack : e).slice(0, 600));
} finally {
  try {
    console.log(execFileSync(GAMBLIUM, ["close", "--user-data-dir", prof], { encoding: "utf8" }).trim());
  } catch (e) {
    console.log("close failed:", e.message);
  }
  server.kill();
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      break;
    } catch {
      await sleep(700);
    }
  }
}

// ---- Second, short run: a profile started with no theme named wears the default, moon ----
const prof2 = fs.mkdtempSync(path.join(os.tmpdir(), "gamblium-pages-"));
try {
  execFileSync(GAMBLIUM, [
    "launch", "--preset", "performance", "--user-data-dir", prof2, "--debug-port", String(port + 1), "--", "about:blank",
  ], { env: { ...process.env, GAMBLIUM_HOME: path.resolve(".") }, encoding: "utf8" });
  let browser;
  for (let i = 0; i < 40 && !browser; i++) {
    await sleep(500);
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port + 1}`, defaultViewport: null }).catch(() => null);
  }
  if (!browser) throw new Error("could not connect to Brave");
  const worker = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 15000 });
  const id = new URL(worker.url()).host;
  await sleep(2500); // the background asks the helper once at start
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`chrome-extension://${id}/ui/sessions.html?raw`);
  await sleep(800);
  const got = await page.evaluate(async () => ({
    stored: (await chrome.storage.local.get(["scheme", "launchTheme"])),
    applied: document.documentElement.dataset.scheme,
  }));
  check("a profile launched with no theme named wears moon", (got.applied ?? "moon") === "moon" && (got.stored.scheme ?? "moon") === "moon" && /^moon/.test(got.stored.launchTheme ?? "moon"), JSON.stringify(got));
  await page.screenshot({ path: path.join(OUT, "8-sessions-launched.png") });
  browser.disconnect();
} catch (e) {
  check("the second run finished", false, String(e && e.stack ? e.stack : e).slice(0, 600));
} finally {
  try {
    console.log(execFileSync(GAMBLIUM, ["close", "--user-data-dir", prof2], { encoding: "utf8" }).trim());
  } catch (e) {
    console.log("close failed:", e.message);
  }
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(prof2, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      break;
    } catch {
      await sleep(700);
    }
  }
}

const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed} of ${checks.length} passed. Screenshots: ${OUT}`);
process.exit(failed ? 1 : 0);
