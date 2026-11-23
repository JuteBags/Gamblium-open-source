// Can an agent drive Gamblium without the window ever being in front?
// Runs the same commands twice through `gamblium ctl` only:
//   1. minimised: an agent profile whose window is minimised straight away
//   2. hidden:    `gamblium launch --agent --hidden`, no window at all
// Each run clicks by selector and by point, sends real mouse and keyboard
// input, runs JavaScript (also on a page that forbids eval) and takes pictures.
//
//   node tools/background-check.mjs [minimised|hidden]
//
// Fresh throwaway folder per run; the browser is closed and the folder removed
// when done, pass or fail.

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const GAMBLIUM = path.resolve("target/release/gamblium.exe");
const HOME = path.resolve(".");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A button and a field at known places; every event notes whether the browser
// counts it as coming from a person (isTrusted).
const PAGE = `<!doctype html><meta charset=utf-8><title>Background test</title>
<style>body{margin:0} #b{position:absolute;left:40px;top:40px;width:120px;height:40px} #q{position:absolute;left:40px;top:120px;width:200px}</style>
<button id=b>Go</button><input id=q>
<script>
  window.log = [];
  window.frames_ = 0;
  const b = document.getElementById("b"), q = document.getElementById("q");
  b.addEventListener("click", (e) => log.push("click:" + e.isTrusted));
  b.addEventListener("dblclick", (e) => log.push("double:" + e.isTrusted));
  b.addEventListener("contextmenu", (e) => { log.push("menu:" + e.isTrusted); e.preventDefault(); });
  q.addEventListener("keydown", (e) => log.push("key:" + e.key + ":" + e.isTrusted));
  (function tick() { window.frames_++; requestAnimationFrame(tick); })();
</script>`;
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/strict")) {
    // No script may run here and eval is forbidden.
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "script-src 'none'" });
    return res.end("<!doctype html><title>Strict</title><p id=s>strict page</p>" + "<p>line</p>".repeat(200));
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const site = `http://127.0.0.1:${server.address().port}`;

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(!!ok);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + String(detail).slice(0, 120) : ""}`);
};

// The process that owns the window in front, to prove ours never takes it.
const foregroundPid = () => {
  try {
    return Number(execFileSync("powershell.exe", ["-NoProfile", "-Command",
      "Add-Type -Namespace W -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);'; $p = 0; [void][W.U]::GetWindowThreadProcessId([W.U]::GetForegroundWindow(), [ref]$p); $p"],
      { encoding: "utf8" }).trim());
  } catch {
    return null;
  }
};

async function run(mode) {
  console.log(`\n== ${mode} ==`);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "gamblium-bg-"));
  const tag = path.basename(prof);
  const shots = fs.mkdtempSync(path.join(os.tmpdir(), "gamblium-bg-shots-"));
  const ctl = (...args) =>
    new Promise((res) => {
      execFile(GAMBLIUM, ["ctl", ...args, "--profile", tag], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        try {
          res(JSON.parse(stdout));
        } catch {
          res({ ok: false, error: "not JSON: " + String(stdout).slice(0, 200) + (err ? " / " + err.message : "") });
        }
      });
    });
  const log = async (T) => (await ctl("eval", T, "code=log.join(' ')")).value || "";

  try {
    const args = ["launch", "--agent", "--user-data-dir", prof, ...(mode === "hidden" ? ["--hidden"] : []), "--", "about:blank"];
    execFileSync(GAMBLIUM, args, { encoding: "utf8", env: { ...process.env, GAMBLIUM_HOME: HOME } });
    let info = null;
    for (let i = 0; i < 50; i++) {
      await sleep(500);
      info = await ctl("info");
      if (info.ok) break;
    }
    check(`${mode}: the browser accepts commands`, info.ok && info.agentProfile === true, info.ok ? `helper ${info.helper}` : info.error);
    if (!info.ok) throw new Error("no bridge");
    check(`${mode}: real input is available`, info.realInput === true);
    check(`${mode}: info says whether a window exists`, info.hidden === (mode === "hidden"), `hidden=${info.hidden}`);

    if (mode === "minimised") {
      const wins = await ctl("windows");
      for (const w of wins.windows || []) await ctl("window-set", `window=${w.id}`, "state=minimized");
      await sleep(800);
      const after = await ctl("windows");
      check("minimised: every window is minimised", (after.windows || []).every((w) => w.state === "minimized"), JSON.stringify((after.windows || []).map((w) => w.state)));
    }
    const browserPid = info.browserPid;

    const opened = await ctl("open", `url=${site}/`, "wait=true");
    check(`${mode}: a page opens`, opened.ok && opened.tab, opened.error);
    const T = `tab=${opened.tab.id}`;
    await sleep(500);

    check(`${mode}: click by selector`, (await ctl("click", T, "selector=#b")).ok && /click:false/.test(await log(T)));
    const pointClick = await ctl("click", T, "x=100", "y=60");
    // A minimised window has no page area, so there the click is made with real input instead.
    check(`${mode}: click at a point`, pointClick.ok && (pointClick.clicked === "button" || pointClick.real === true), JSON.stringify(pointClick));
    const realClick = await ctl("click", T, "selector=#b", "real=true");
    check(`${mode}: real click on an element`, realClick.ok && realClick.real === true && /click:true/.test(await log(T)), realClick.error || (await log(T)));
    const mouse = await ctl("mouse", T, "x=100", "y=60");
    check(`${mode}: real mouse click at a point`, mouse.ok && ((await log(T)).match(/click:true/g) || []).length >= 2, mouse.error || (await log(T)));
    const dbl = await ctl("mouse", T, "x=100", "y=60", "action=double");
    check(`${mode}: real double click`, dbl.ok && /double:true/.test(await log(T)), dbl.error || (await log(T)));
    const right = await ctl("mouse", T, "x=100", "y=60", "action=right");
    check(`${mode}: real right click`, right.ok && /menu:true/.test(await log(T)), right.error || (await log(T)));
    const typed = await ctl("type", T, "selector=#q", "text=hello there", "real=true");
    const value = (await ctl("eval", T, "code=document.getElementById('q').value")).value;
    check(`${mode}: real typing fills the field`, typed.ok && value === "hello there", typed.error || value);
    const key = await ctl("press", T, "selector=#q", "key=a", "real=true");
    check(`${mode}: a real key press reaches the page`, key.ok && /key:a:true/.test(await log(T)), key.error || (await log(T)));
    check(`${mode}: an unknown key is refused`, (await ctl("press", T, "key=NoSuchKey", "real=true")).ok === false);

    const js = await ctl("eval", T, "code=({ title: document.title, sum: 1 + 2 })");
    check(`${mode}: JavaScript runs and returns a value`, js.ok && js.value && js.value.sum === 3 && js.value.title === "Background test", JSON.stringify(js));
    const promised = await ctl("eval", T, "code=new Promise((r) => setTimeout(() => r(7), 50))", "real=true");
    check(`${mode}: JavaScript may return a promise`, promised.ok && promised.value === 7, JSON.stringify(promised));

    const f1 = (await ctl("eval", T, "code=frames_")).value;
    await sleep(1000);
    const f2 = (await ctl("eval", T, "code=frames_")).value;
    console.log(`     ${mode}: the page drew ${f2 - f1} frames in one second`);
    if (mode === "hidden") check("hidden: the page keeps drawing", f2 - f1 > 10, `${f2 - f1} frames`);

    const shot = path.join(shots, "page.png");
    const sc = await ctl("screenshot", T, `out=${shot}`);
    check(`${mode}: a picture of the page`, sc.ok && fs.existsSync(shot) && fs.statSync(shot).size > 800, sc.error || `${fs.existsSync(shot) ? fs.statSync(shot).size : 0} bytes`);

    const strict = await ctl("open", `url=${site}/strict`, "wait=true", "background=true");
    const S = `tab=${strict.tab.id}`;
    const strictEval = await ctl("eval", S, "code=document.querySelector('#s').textContent + '/' + (1 + 2)");
    check(`${mode}: JavaScript runs on a page that forbids eval`, strictEval.ok && strictEval.value === "strict page/3", JSON.stringify(strictEval));
    const full = path.join(shots, "full.png");
    const fsc = await ctl("screenshot", S, "full=true", `out=${full}`);
    check(`${mode}: a picture of the whole page`, fsc.ok && fs.existsSync(full) && fs.statSync(full).size > fs.statSync(shot).size, fsc.error || "");

    if (mode === "minimised") {
      const end = await ctl("windows");
      check("minimised: the window stayed minimised throughout", (end.windows || []).every((w) => w.state === "minimized"), JSON.stringify((end.windows || []).map((w) => w.state)));
    }
    const front = foregroundPid();
    check(`${mode}: the browser is not the window in front`, front !== null && front !== browserPid, `front pid ${front}, browser pid ${browserPid}`);
  } catch (e) {
    check(`${mode}: the run finished`, false, String(e && e.stack ? e.stack : e).slice(0, 400));
  } finally {
    try {
      console.log(execFileSync(GAMBLIUM, ["close", "--user-data-dir", prof], { encoding: "utf8" }).trim());
    } catch (e) {
      console.log("close failed:", e.message);
    }
    for (const dir of [prof, shots]) {
      for (let i = 0; i < 5; i++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
          break;
        } catch {
          await sleep(700);
        }
      }
    }
  }
}

const only = process.argv[2];
for (const mode of ["minimised", "hidden"]) if (!only || only === mode) await run(mode);
server.close();

const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed} of ${checks.length} passed.`);
process.exit(failed ? 1 : 0);
