// Memory and CPU of a PDF in use: Chrome, Edge and Gamblium (built-in Gamblium PDF) open the same
// file in a fresh profile, as the only tab, and are measured as whole process trees
// (`gamblium stats`): open (first 15 s), read (scroll through every page, mouse wheel), idle
// (30 s after). On mains power, one browser at a time, order rotated between rounds.
// Usage: node tools/pdf-bench.mjs <file.pdf> [rounds] [gamblium Application folder]
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const pdf = process.argv[2];
const rounds = Number(process.argv[3] || 1);
const gamApp = process.argv[4] || join(process.env.LOCALAPPDATA, 'Gamblium', 'browser', 'Application');
const gamExe = process.env.GAMBLIUM_EXE || join(process.env.LOCALAPPDATA, 'Gamblium', 'app', 'gamblium.exe');
const PORT = 9411;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = pathToFileURL(pdf).href;

const BROWSERS = {
  chrome: { exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', name: 'chrome.exe' },
  edge: { exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', name: 'msedge.exe' },
  gamblium: { name: 'brave.exe' },
};

function stats(name, marker, seconds) {
  return new Promise((resolve) => {
    const p = spawn(gamExe, ['stats', '--exe', name, '--marker', marker, '--duration', String(seconds), '--interval', '1', '--json']);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
  });
}
const mb = (s) => Math.round(s?.total?.private_ws_mb ?? -1); // private working set, as Task Manager's Memory column
const commit = (s) => Math.round(s?.total?.commit_mb ?? -1);
const cpu = (s) => Math.round((s?.total?.cpu_pct ?? -1) * 10) / 10; // % of one core

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d.result ?? d.error); waiting.delete(d.id); } };
  // Never wait long: input sent into a PDF frame may never be answered.
  return { send: (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); setTimeout(() => r(null), 3000); }), fire: (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params })), close: () => ws.close() };
}

async function run(which) {
  const b = BROWSERS[which];
  const profile = mkdtempSync(join(tmpdir(), `gamblium-bench-${which}-`));
  // No component or background downloads in any of them: on a fresh profile they show up as
  // unzipper and network work in the idle figures (Nov 16 2026).
  const common = [`--window-size=1300,900`, '--window-position=40,40', '--disable-component-update', '--disable-background-networking'];
  try {
    if (which === 'gamblium') {
      spawnSync(gamExe, ['launch', ...(process.env.BENCH_COPY ? ['--official', '--brave', join(gamApp, 'brave.exe')] : []), '--user-data-dir', profile, '--debug-port', String(PORT), '--', ...common, url], { env: { ...process.env, ...(process.env.BENCH_HOME ? { GAMBLIUM_HOME: process.env.BENCH_HOME } : {}) } });
    } else {
      spawn(b.exe, [`--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', ...common, url], { detached: true, stdio: 'ignore' }).unref();
    }
    for (let i = 0; i < 60; i++) { await sleep(500); if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then((x) => x.ok, () => false)) break; }
    const open = await stats(b.name, profile, 15);
    // Read: wheel down through every page, over about 40 s.
    const tab = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).find((t) => t.type === 'page' && t.url.startsWith('file:'));
    const c = await cdp(tab.webSocketDebuggerUrl);
    await c.send('Page.bringToFront');
    // Only read once the PDF is really shown (a run that scrolled an empty viewer does not count).
    if (which === 'gamblium') {
      for (let i = 0; i < 40; i++) {
        const vf = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).find((t) => t.url.includes('/pdf/viewer.html'));
        if (vf) { const v = await cdp(vf.webSocketDebuggerUrl); const n = (await v.send('Runtime.evaluate', { expression: 'window.__gmbPdf?.pages ?? 0', returnByValue: true }))?.result?.value; v.close(); if (n > 0) break; }
        await sleep(500);
      }
    } else await sleep(2000);
    const reading = stats(b.name, profile, 40);
    let inner = null;
    if (which === 'gamblium') {
      const vf = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).find((t) => t.url.includes('/pdf/viewer.html'));
      if (vf) inner = await cdp(vf.webSocketDebuggerUrl);
    }
    const top = async () => (await inner?.send('Runtime.evaluate', { expression: `document.getElementById('stage').scrollTop`, returnByValue: true }))?.result?.value ?? 0;
    let byWheel = true;
    for (let k = 0; k < 200; k++) {
      if (byWheel) c.fire('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 650, y: 450, deltaX: 0, deltaY: 600 });
      else inner.fire('Runtime.evaluate', { expression: `document.getElementById('stage').scrollBy(0, 600)` });
      await sleep(185);
      if (k === 4 && inner && (await top()) < 100) byWheel = false;
    }
    inner?.close();
    const read = await reading;
    let lastPage = null;
    const vf = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).find((t) => t.url.includes('/pdf/viewer.html'));
    if (vf) { const v = await cdp(vf.webSocketDebuggerUrl); lastPage = (await v.send('Runtime.evaluate', { expression: `document.getElementById('pageNo').value + '/' + (window.__gmbPdf?.pages ?? '?')`, returnByValue: true }))?.result?.value; v.close(); }
    const idle = await stats(b.name, profile, 30);
    c.close();
    // A run that did not read (nearly) to the end does not count.
    const [at, of] = String(lastPage ?? '').split('/').map(Number);
    const valid = which !== 'gamblium' || (at > 0 && of > 0 && at >= of - 1);
    return { which, valid, byWheel, lastPage, openMB: mb(open), openCPU: cpu(open), readMB: mb(read), readCPU: cpu(read), idleMB: mb(idle), idleCommit: commit(idle), idleCPU: cpu(idle), procs: idle?.total?.procs, idleByKind: Object.fromEntries(Object.entries(idle?.by_kind || {}).map(([k, v]) => [k, `${Math.round(v.private_ws_mb)}MB ${v.cpu_pct.toFixed(1)}%`])), readByKind: Object.fromEntries(Object.entries(read?.by_kind || {}).map(([k, v]) => [k, `${Math.round(v.private_ws_mb)}MB ${v.cpu_pct.toFixed(1)}%`])) };
  } finally {
    // Only this test browser: through its own debugging connection (never by program name,
    // which would close the person's own Chrome or Edge too).
    if (which === 'gamblium') spawnSync(gamExe, ['close', '--user-data-dir', profile]);
    else {
      const v = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json(), () => null);
      if (v) { const c = await cdp(v.webSocketDebuggerUrl); c.send('Browser.close'); await sleep(1500); c.close(); }
    }
    await sleep(3000);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
  }
}

const order = (process.env.BENCH_ONLY || 'chrome,edge,gamblium').split(',');
const results = [];
for (let r = 0; r < rounds; r++) {
  const o = order.slice(r % 3).concat(order.slice(0, r % 3));
  for (const w of o) {
    const x = await run(w);
    console.log(JSON.stringify(x));
    results.push(x);
  }
}
