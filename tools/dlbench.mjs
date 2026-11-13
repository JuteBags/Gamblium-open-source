// Download speed comparison: Brave (single connection), Brave with parallel
// downloading, and aria2. Every run uses a fresh throwaway Brave profile.
//
//   node tools/dlbench.mjs --url <file url> --mode full|window [--window 45]
//        [--variants brave,brave-parallel,aria2-16] [--label name] [--out results.jsonl]
//
// full:   time until the whole file is on disk.
// window: bytes received between second 8 and second <window>, then cancel.
//         Use it for slow servers so one run stays short.
//
// Needs puppeteer-core. Set PUPPETEER_FROM to a folder whose node_modules has it.

import { createRequire } from "node:module";
import { spawn, execFile } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(path.join(process.env.PUPPETEER_FROM || process.cwd(), "package.json"));
const puppeteer = require("puppeteer-core");

const BRAVE = process.env.BRAVE_EXE || "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
const ARIA2 = process.env.ARIA2_EXE || "S:\\tools\\aria2\\aria2-1.37.0-win-64bit-build1\\aria2c.exe";
const WORK = process.env.DLBENCH_DIR || "S:\\projects\\Gamblium\\target\\dlbench";

const argv = {};
for (let i = 2; i < process.argv.length; i += 2) argv[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const url = argv.url;
const mode = argv.mode || "full";
const windowSec = Number(argv.window || 45);
const variants = (argv.variants || "brave,brave-parallel,aria2-16").split(",");
const WARMUP_SEC = 8;
if (!url) throw new Error("--url is required");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = 1024 * 1024;

// A file the browser has not let go of yet must not cost us the measurement.
function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
  } catch (e) {
    console.error(`could not remove ${dir}: ${e.code}`);
  }
}

function run(cmd, args) {
  return new Promise((res) => execFile(cmd, args, { windowsHide: true }, (_e, out) => res(String(out || ""))));
}

async function serverIps() {
  const host = new URL(url).hostname;
  // The system resolver, the same one the browser and aria2 end up using.
  const all = await dns.lookup(host, { all: true }).catch(() => []);
  return all.map((x) => x.address);
}

// Established TCP connections from this machine to the download server.
async function connectionCount(ips) {
  const list = ips.map((x) => `'${x}'`).join(",");
  const ps = `$ips=@(${list}); @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Where-Object { $ips -contains $_.RemoteAddress }).Count`;
  return Number((await run("powershell.exe", ["-NoProfile", "-Command", ps])).trim()) || 0;
}

// Speed from a list of {t, bytes} samples, per mode.
function summarise(samples, t0, done) {
  const last = samples[samples.length - 1];
  if (!last) return { error: "no progress" };
  if (mode === "full") {
    if (!done) return { error: "did not complete" };
    const sec = (last.t - t0) / 1000;
    return { bytes: last.bytes, sec: +sec.toFixed(1), mbPerSec: +(last.bytes / MB / sec).toFixed(2) };
  }
  const first = samples.find((s) => s.t - t0 >= WARMUP_SEC * 1000) || samples[0];
  const sec = (last.t - first.t) / 1000;
  return {
    bytes: last.bytes - first.bytes,
    sec: +sec.toFixed(1),
    mbPerSec: +((last.bytes - first.bytes) / MB / sec).toFixed(2),
  };
}

async function runBrave(parallel, ips) {
  const stamp = Date.now();
  const prof = path.join(WORK, `prof-${stamp}`);
  const dl = path.join(WORK, `dl-${stamp}`);
  fs.mkdirSync(prof, { recursive: true });
  fs.mkdirSync(dl, { recursive: true });
  const port = 9600 + Math.floor(Math.random() * 300);
  const child = spawn(
    BRAVE,
    [
      `--user-data-dir=${prof}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      parallel ? "--enable-features=ParallelDownloading" : "--disable-features=ParallelDownloading",
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  let browser;
  try {
    for (let i = 0; i < 40 && !browser; i++) {
      await sleep(500);
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null }).catch(() => null);
    }
    if (!browser) return { error: "could not connect to Brave" };
    const client = await browser.target().createCDPSession();
    await client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dl, eventsEnabled: true });
    let t0 = 0;
    let done = false;
    let failed = null;
    const samples = [];
    client.on("Browser.downloadWillBegin", () => (t0 = Date.now()));
    client.on("Browser.downloadProgress", (e) => {
      if (!t0) t0 = Date.now();
      samples.push({ t: Date.now(), bytes: e.receivedBytes });
      if (e.state === "completed") done = true;
      if (e.state === "canceled") failed = "canceled";
    });
    const page = (await browser.pages())[0] || (await browser.newPage());
    page.goto(url).catch(() => {}); // a download aborts the navigation; that is expected
    let conns = null;
    const started = Date.now();
    const limitMs = mode === "full" ? 20 * 60 * 1000 : (windowSec + 15) * 1000;
    while (!done && !failed && Date.now() - started < limitMs) {
      await sleep(250);
      if (conns === null && t0 && Date.now() - t0 > 12000) conns = await connectionCount(ips);
      if (mode === "window" && t0 && Date.now() - t0 >= windowSec * 1000) break;
    }
    if (conns === null) conns = await connectionCount(ips);
    return failed ? { error: failed } : { ...summarise(samples, t0, done), connections: conns };
  } finally {
    await run("taskkill", ["/T", "/F", "/PID", String(child.pid)]);
    await sleep(1500);
    for (const d of [prof, dl]) cleanup(d);
  }
}

const UNIT = { B: 1, KiB: 1024, MiB: MB, GiB: 1024 * MB };

async function runAria2(connections, ips) {
  const dl = path.join(WORK, `dl-${Date.now()}`);
  fs.mkdirSync(dl, { recursive: true });
  const args = [
    `-x${connections}`,
    `-s${connections}`,
    "-k1M",
    "--file-allocation=none",
    "--summary-interval=1",
    "--console-log-level=warn",
    "--auto-file-renaming=false",
    // aria2's built-in resolver (c-ares) hangs on some hosts on this machine.
    "--async-dns=false",
    "-d",
    dl,
    "-o",
    "file.bin",
    url,
  ];
  if (mode === "window") args.unshift(`--stop=${windowSec}`);
  const t0 = Date.now();
  const samples = [];
  const child = spawn(ARIA2, args, { windowsHide: true });
  child.stdout.on("data", (buf) => {
    // "[#2089b0 400MiB/1.0GiB(39%) CN:16 DL:11MiB ETA:55s]"
    const m = [...String(buf).matchAll(/\[#\w+ ([\d.]+)(B|KiB|MiB|GiB)\//g)].pop();
    if (m) samples.push({ t: Date.now(), bytes: Number(m[1]) * UNIT[m[2]] });
  });
  let conns = null;
  const timer = setTimeout(async () => (conns = await connectionCount(ips)), 12000);
  const code = await new Promise((res) => child.on("exit", res));
  clearTimeout(timer);
  try {
    if (mode === "full") {
      const file = path.join(dl, "file.bin");
      if (code !== 0 || !fs.existsSync(file)) return { error: `aria2 exit ${code}` };
      const bytes = fs.statSync(file).size;
      const sec = (Date.now() - t0) / 1000;
      return { bytes, sec: +sec.toFixed(1), mbPerSec: +(bytes / MB / sec).toFixed(2), connections: conns };
    }
    return { ...summarise(samples, t0, false), connections: conns };
  } finally {
    cleanup(dl);
  }
}

fs.mkdirSync(WORK, { recursive: true });
const ips = await serverIps();
console.log(`url ${url}\nmode ${mode}${mode === "window" ? ` (${WARMUP_SEC}-${windowSec} s)` : ""}, server ${ips.join(", ")}`);
for (const v of variants) {
  const r =
    v === "brave" ? await runBrave(false, ips)
    : v === "brave-parallel" ? await runBrave(true, ips)
    : v.startsWith("aria2-") ? await runAria2(Number(v.split("-")[1]), ips)
    : { error: "unknown variant" };
  const rec = { label: argv.label || "", variant: v, mode, url, at: new Date().toISOString(), ...r };
  console.log(JSON.stringify(rec));
  if (argv.out) fs.appendFileSync(argv.out, JSON.stringify(rec) + "\n");
  await sleep(3000);
}
