// Real-browser test of `gamblium ctl`: starts an agent profile in a fresh
// throwaway folder and drives it only through the command line, the way an
// AI agent would. Pages come from a small local server.
//
//   node tools/ctl-smoke.mjs
//
// Closes the browser and removes the folder when done, pass or fail.

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const GAMBLIUM = path.resolve("target/release/gamblium.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = fs.mkdtempSync(path.join(os.tmpdir(), "gamblium-ctl-"));
const tag = path.basename(prof);
// The user's answer about agents changing settings lives in a file; the test
// uses one of its own (the helper inherits this from the launcher).
const PERMISSION_FILE = path.join(prof, "test-permission.json");
process.env.GAMBLIUM_PERMISSION_FILE = PERMISSION_FILE;

// A page with a form, a link, a select, a checkbox, a download and some storage.
const PAGE = `<!doctype html><meta charset=utf-8><title>Ctl test page</title>
<h1 id=h>Hello agent</h1>
<p class=note>First paragraph.</p>
<a id=next href="/second">Go to second</a>
<form id=f action="/submitted" method=get>
  <label for=q>Query</label> <input id=q name=q placeholder="type here">
  <select id=color name=color><option value=r>Red</option><option value=g>Green</option></select>
  <label><input type=checkbox id=agree name=agree> I agree</label>
  <button id=go type=submit>Send</button>
</form>
<div id=late></div>
<script>
  localStorage.setItem("greeting", "hi");
  setTimeout(() => { document.getElementById("late").innerHTML = "<span id=arrived>arrived</span>"; }, 700);
  document.getElementById("h").addEventListener("mouseover", () => { document.title = "hovered"; });
</script>`;
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/file.bin")) {
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="file.bin"' });
    return res.end(Buffer.alloc(4096, 7));
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": "seen=1; Path=/" });
  if (req.url.startsWith("/second")) return res.end("<!doctype html><title>Second</title><p id=p2>Second page</p>");
  if (req.url.startsWith("/submitted")) return res.end(`<!doctype html><title>Submitted</title><pre id=got>${req.url.replace(/[<&]/g, "")}</pre>`);
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const site = `http://127.0.0.1:${server.address().port}`;

function ctl(...args) {
  return new Promise((res) => {
    execFile(GAMBLIUM, ["ctl", ...args, "--profile", tag], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      try {
        res(JSON.parse(stdout));
      } catch {
        res({ ok: false, error: "not JSON: " + String(stdout).slice(0, 200) + (err ? " / " + err.message : "") });
      }
    });
  });
}

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(!!ok);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + String(detail).slice(0, 110) : ""}`);
};

try {
  execFileSync(GAMBLIUM, ["launch", "--agent", "--user-data-dir", prof, "--", "about:blank"], { encoding: "utf8" });

  // The bridge comes up once the extension has started.
  let info = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    info = await ctl("info");
    if (info.ok) break;
  }
  check("an agent profile accepts commands with no extra setup", info.ok && info.agentProfile === true && info.pageAccess === true,
    info.ok ? `${info.commands} commands, helper ${info.helper}` : info.error);
  if (!info.ok) throw new Error("no bridge");
  check("info names the profile folder", info.profile && String(info.profile.userDataDir).includes(tag));

  // ---- tabs and reading
  const opened = await ctl("open", `url=${site}/`, "wait=true");
  const tab = opened.tab && opened.tab.id;
  check("open returns a loaded tab", opened.ok && opened.tab.loading === false && tab > 0, `tab ${tab}`);
  const T = `tab=${tab}`;
  const page = await ctl("page", T);
  check("page reports title and counts", page.ok && page.title === "Ctl test page" && page.forms === 1 && page.links === 1);
  const text = await ctl("text", T, "selector=#h");
  check("text reads one element", text.ok && text.text === "Hello agent");
  const links = await ctl("links", T);
  check("links lists the link", links.ok && links.links[0].href === `${site}/second`);
  const forms = await ctl("forms", T);
  const fields = (forms.elements || []).map((e) => e.selector);
  check("forms lists every field with a selector", forms.ok && ["#q", "#color", "#agree", "#go"].every((s) => fields.includes(s)), fields.join(" "));
  const found = await ctl("find", T, "text=First paragraph");
  check("find locates text", found.ok && found.elements[0].tag === "p");
  const attr = await ctl("attr", T, "selector=#q", "name=placeholder");
  check("attr reads an attribute", attr.ok && attr.value === "type here");
  const store = await ctl("storage", T);
  check("storage reads localStorage", store.ok && store.items.greeting === "hi");

  // ---- acting
  const waited = await ctl("wait", T, "selector=#arrived", "ms=5000");
  check("wait sees an element that appears later", waited.ok && waited.found === true);
  await ctl("hover", T, "selector=#h");
  check("hover reaches the page", (await ctl("page", T)).title === "hovered");
  check("type fills a field", (await ctl("type", T, "selector=#q", "text=hello world")).ok);
  const sel = await ctl("select", T, "selector=#color", "value=Green");
  check("select chooses by label", sel.ok && sel.value === "g");
  const chk = await ctl("check", T, "selector=#agree");
  check("check ticks a box", chk.ok && chk.checked === true);
  check("click by visible text submits the form", (await ctl("click", T, "text=Send")).ok);
  await ctl("wait", T, "selector=#got", "ms=8000");
  const got = await ctl("text", T, "selector=#got");
  check("the submitted form carried all three values", got.ok && /q=hello\+world/.test(got.text) && /color=g/.test(got.text) && /agree=on/.test(got.text), got.text);
  const backed = await ctl("back", T);
  const afterBack = await ctl("page", T);
  check("back returns to the first page", backed.ok && afterBack.ok && !/submitted/.test(afterBack.url), JSON.stringify(backed.ok ? afterBack : backed));
  const nav = await ctl("navigate", T, `url=${site}/second`, "wait=true");
  check("navigate goes to another page", nav.ok && (await ctl("text", T, "selector=#p2")).text === "Second page");
  const ev = await ctl("eval", T, "code=1+2");
  check("eval runs code in the page", ev.ok && ev.value === 3);
  const shot = path.join(prof, "shot.png");
  const sc = await ctl("screenshot", T, `out=${shot}`);
  const png = fs.existsSync(shot) ? fs.readFileSync(shot) : Buffer.alloc(0);
  check("screenshot saves a PNG", sc.ok && png.length > 1000 && png.subarray(1, 4).toString() === "PNG", `${png.length} bytes`);

  // ---- tab and window management
  const dup = await ctl("duplicate", T);
  check("duplicate makes a second tab", dup.ok && dup.tab.id !== tab);
  check("pin and mute change the tab", (await ctl("pin", `tab=${dup.tab.id}`)).tab.pinned === true && (await ctl("mute", `tab=${dup.tab.id}`)).tab.muted === true);
  const z = await ctl("zoom", T, "factor=1.25");
  check("zoom is set and read back", z.ok && Math.abs(z.factor - 1.25) < 0.01);
  const q = await ctl("tabs", "q=second");
  check("tabs filters by text", q.ok && q.tabs.length >= 2 && q.tabs.every((t) => /second/i.test(t.title + t.url)));
  const slept = await ctl("sleep", `tab=${dup.tab.id}`);
  check("sleep puts a hidden tab to sleep", slept.ok && slept.slept.length === 1);
  const win = await ctl("window-open", `url=${site}/second`, "left=40", "top=40", "width=700", "height=500");
  check("window-open places a window", win.ok && win.window.width === 700, JSON.stringify(win.window || win.error));
  const wset = await ctl("window-set", `window=${win.window.id}`, "width=820", "height=560");
  check("window-set resizes it", wset.ok && wset.window.width === 820);
  check("window-close closes it", (await ctl("window-close", `window=${win.window.id}`)).ok);

  // ---- downloads
  const dl = await ctl("download", `url=${site}/file.bin`, "wait=true");
  check("download starts and finishes", dl.ok && dl.download.state === "complete" && dl.download.totalBytes === 4096, JSON.stringify(dl.download || dl.error));
  const dls = await ctl("downloads", "limit=5");
  const dlRow = dls.ok && dls.downloads.find((d) => d.id === dl.download.id);
  check("downloads lists it", dlRow && /file( \(\d+\))?\.bin$/.test(dlRow.filename), dlRow && dlRow.filename);
  // Do not leave test files in the owner's download folder.
  const del = await ctl("download-delete", `id=${dl.download.id}`);
  check("download-delete removes the file", del.ok && dlRow && !fs.existsSync(dlRow.filename));

  // ---- network capture
  check("capture starts without a prompt in the agent profile", (await ctl("capture-start")).ok);
  await ctl("navigate", T, `url=${site}/?captured=1`, "wait=true");
  await sleep(2500);
  const cap = await ctl("capture-list", "q=captured=1");
  check("capture records the request", cap.ok && cap.requests.length >= 1 && cap.requests[0].status === 200, `${cap.requests && cap.requests.length} requests`);
  if (cap.ok && cap.requests[0]) {
    const one = await ctl("capture-get", `id=${cap.requests[0].id}`);
    check("capture-get gives headers and a curl command", one.ok && /^curl -X GET/.test(one.curl) && one.record.responseHeaders.length > 0);
  }
  check("capture stops", (await ctl("capture-stop")).ok);

  // ---- security tools
  const scope = await ctl("scope-check", "host=127.0.0.1");
  check("scope-check: this machine is in scope", scope.ok && scope.inScope === true);
  const audit = await ctl("audit", `url=${site}/`);
  check("audit runs through the browser", audit.ok && audit.findings.some((f) => f.id === "csp-missing"), `${audit.findings && audit.findings.length} findings`);
  const refused = await ctl("audit", "url=http://93.184.216.34/");
  check("audit of a public address is refused", refused.ok === false && /scope/.test(refused.error));
  check("there is no command to widen the scope", (await ctl("scope-add", "entry=example.com")).ok === false);
  const scan = await ctl("scan", "target=127.0.0.1", `ports=${server.address().port}`);
  check("scan finds the test server", scan.ok && scan.open.length === 1);

  // ---- settings: only with the user's permission
  const denied = await ctl("settings-set", "delaySec=120");
  check("settings-set is refused without the user's permission", denied.ok === false && denied.needsPermission === true, denied.error);
  check("and so is proxy-set", (await ctl("proxy-set", "mode=system")).needsPermission === true);
  // The user's answer, as the prompt page would leave it: allowed for 30 minutes.
  fs.writeFileSync(PERMISSION_FILE, JSON.stringify({ settings: { until: Math.floor(Date.now() / 1000) + 1800 } }));
  const set = await ctl("settings-set", "delaySec=120", "allowlist=example.com,docs.example.com");
  check("settings-set changes settings", set.ok && set.settings.delaySec === 120 && set.settings.allowlist.length === 2);
  check("a bad setting is refused", (await ctl("settings-set", "delaySec=1")).ok === false);
  const px = await ctl("proxy-set", "mode=fixed", "scheme=http", "host=127.0.0.1", "port=9", "bypass=127.0.0.1");
  check("proxy-set switches the proxy", px.ok && px.mode === "fixed");
  check("and back", (await ctl("proxy-set", "mode=system")).mode === "system");

  // ---- cookies, memory, sessions
  const ck = await ctl("cookies", `url=${site}/`);
  check("cookies reads the site's cookie", ck.ok && ck.cookies.some((c) => c.name === "seen" && c.value === "1"));
  check("cookie-set adds one", (await ctl("cookie-set", `url=${site}/`, "name=agent", "value=yes")).ok && (await ctl("cookies", `url=${site}/`)).cookies.some((c) => c.name === "agent"));
  await ctl("stats");
  await sleep(1500);
  const stats = await ctl("stats");
  const mine = (stats.tabs || []).find((t) => t.tabId === tab);
  check("stats gives memory and CPU for the tab", stats.ok && mine && mine.memoryMb > 0 && mine.cpuPct !== null, mine ? `${mine.memoryMb} MB, ${mine.cpuPct}%` : "");
  const saved = await ctl("session-save", "name=ctl smoke");
  check("session-save makes a checkpoint with page state", saved.ok && saved.tabs >= 2 && saved.pagesCaptured >= 1, JSON.stringify(saved));
  // On disk the checkpoint is packed and sealed: its name and addresses are not readable.
  await sleep(1500);
  const stored = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (e.name !== "LOCK") stored.push(fs.readFileSync(path.join(dir, e.name)).toString("latin1"));
    }
  };
  const settingsDir = path.join(prof, "Default", "Local Extension Settings");
  if (fs.existsSync(settingsDir)) walk(settingsDir);
  const disk = stored.join(" ");
  check("the checkpoint is stored packed and sealed", disk.includes("sessionsPacked") && /"sealed":\s*true/.test(disk), `${disk.length} bytes of extension storage`);
  check("and its name is nowhere in plain text", !disk.includes("ctl smoke"));
  const file = path.join(prof, "session.json");
  const exp = await ctl("session-export", "name=ctl smoke", `out=${file}`);
  const session = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  check("session-export writes the checkpoint", exp.ok && session.version === 2 && session.windows.length >= 1 && session.profile && session.windows[0].bounds);
  check("session-delete removes it", (await ctl("session-delete", "name=ctl smoke")).ok && !(await ctl("session-list")).sessions.some((s) => s.name === "ctl smoke"));
  const imp = await ctl("session-import", `file=${file}`);
  check("session-import brings it back", imp.ok && (await ctl("session-list")).sessions.some((s) => s.name === "ctl smoke"));
  const before = (await ctl("tabs")).tabs.length;
  const rest = await ctl("session-restore", "name=ctl smoke");
  await sleep(1500);
  const after = (await ctl("tabs")).tabs;
  check("session-restore reopens the tabs, most of them asleep", rest.ok && after.length === before + rest.tabs && after.filter((t) => t.state === "asleep").length >= 1,
    `${before} -> ${after.length} tabs, ${after.filter((t) => t.state === "asleep").length} asleep`);

  const help = await ctl("help");
  check("help lists every command", help.ok && Object.keys(help.ops).length === info.commands);
  check("close closes the tab", (await ctl("close", T)).ok);
} catch (e) {
  check("no exception", false, e.message);
} finally {
  try {
    execFileSync(GAMBLIUM, ["close", "--user-data-dir", prof], { encoding: "utf8" });
  } catch {
    // Nothing was running.
  }
  server.close();
  await sleep(1500);
  fs.rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
const ok = checks.length > 0 && checks.every(Boolean);
console.log(`${checks.filter(Boolean).length} of ${checks.length} checks passed`);
console.log(ok ? "CTL SMOKE OK" : "CTL SMOKE FAILED");
process.exit(ok ? 0 : 1);
