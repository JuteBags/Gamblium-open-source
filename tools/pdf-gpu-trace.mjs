// What the graphics process holds after a long PDF was read in Gamblium PDF: opens the PDF in a
// fresh test window, wheels through it, waits, then takes a memory-infra dump through the browser's
// debugging socket and prints the biggest graphics-process allocators (Nov 16 2026: 231 MB there
// after reading 60 pages, Chrome 68-87 MB).
// Usage: node tools/pdf-gpu-trace.mjs <file.pdf> [settle seconds]
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const pdf = process.argv[2];
const settle = Number(process.argv[3] || 15);
const PORT = 9417;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = process.env.GAMBLIUM_EXE || join(process.env.LOCALAPPDATA, 'Gamblium', 'app', 'gamblium.exe');

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const waiting = new Map(); const events = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d.result ?? d.error); waiting.delete(d.id); } else if (d.method) events.push(d); };
  return { events, send: (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); }), fire: (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params })), close: () => ws.close() };
}
const list = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());

const profile = mkdtempSync(join(tmpdir(), 'gamblium-gputrace-'));
try {
  spawnSync(exe, ['launch', '--user-data-dir', profile, '--debug-port', String(PORT), '--', '--window-size=1300,900', '--disable-component-update', '--disable-background-networking', pathToFileURL(pdf).href], { env: { ...process.env, ...(process.env.BENCH_HOME ? { GAMBLIUM_HOME: process.env.BENCH_HOME } : {}) } });
  for (let i = 0; i < 60; i++) { await sleep(500); if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then((x) => x.ok, () => false)) break; }
  let pages = 0;
  for (let i = 0; i < 40 && !pages; i++) {
    await sleep(500);
    const vf = (await list()).find((t) => t.url.includes('/pdf/viewer.html'));
    if (vf) { const v = await cdp(vf.webSocketDebuggerUrl); pages = (await v.send('Runtime.evaluate', { expression: 'window.__gmbPdf?.pages ?? 0', returnByValue: true }))?.result?.value || 0; v.close(); }
  }
  const tab = (await list()).find((t) => t.type === 'page' && t.url.startsWith('file:'));
  const c = await cdp(tab.webSocketDebuggerUrl);
  await c.send('Page.bringToFront');
  await sleep(1500);
  for (let k = 0; k < 200; k++) { c.fire('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 650, y: 450, deltaX: 0, deltaY: 600 }); await sleep(185); }
  const vf = (await list()).find((t) => t.url.includes('/pdf/viewer.html'));
  const v = await cdp(vf.webSocketDebuggerUrl);
  const at = (await v.send('Runtime.evaluate', { expression: `document.getElementById('pageNo').value + '/' + window.__gmbPdf.pages + ' canvases drawn: ' + [...document.querySelectorAll('.page canvas.pix')].filter((x) => x.width).length + ', text layers: ' + document.querySelectorAll('.textlayer').length`, returnByValue: true }))?.result?.value;
  console.log('read to', at);
  // At 25% many small pages show at once: every page on screen must be drawn (canvases are lent
  // by a pixel budget; a page near the screen is never left blank).
  if (process.env.LOW_ZOOM) {
    await v.send('Runtime.evaluate', { expression: `for (let k = 0; k < 12; k++) document.getElementById('zoomOut').click()` });
    await sleep(1500);
    for (const y of [0.5, 0.2, 0.8]) {
      await v.send('Runtime.evaluate', { expression: `document.getElementById('stage').scrollTop = document.getElementById('stage').scrollHeight * ${y}` });
      await sleep(2500);
      const r = (await v.send('Runtime.evaluate', { expression: `(() => { const st = document.getElementById('stage').getBoundingClientRect(); const on = [...document.querySelectorAll('.page')].filter((p) => { const b = p.getBoundingClientRect(); return b.bottom > st.top && b.top < st.bottom; }); return { zoom: document.getElementById('zoomLabel').textContent, onScreen: on.length, blank: on.filter((p) => !(p.querySelector('canvas.pix')?.width > 0)).map((p) => p.dataset.i) }; })()`, returnByValue: true }))?.result?.value;
      console.log('low zoom at', y, JSON.stringify(r));
    }
  }
  v.close();
  // Hidden for a while (another tab in front): the PDF tab lets its pixels go.
  if (process.env.HIDE) {
    const vf1 = (await list()).find((t) => t.url.includes('/pdf/viewer.html'));
    const v1 = await cdp(vf1.webSocketDebuggerUrl);
    await v1.send('Runtime.evaluate', { expression: `window.__vis = []; document.addEventListener('visibilitychange', () => { window.__vis.push(document.visibilityState + '@' + Math.round(performance.now())); if (document.hidden) for (const d of [1000, 5000, 12000, 20000]) setTimeout(() => window.__vis.push('t' + d + '@' + Math.round(performance.now())), d); }); true` });
    v1.close();
    await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
    console.log('hidden for 25 s');
    await sleep(25000);
    const vf2 = (await list()).find((t) => t.url.includes('/pdf/viewer.html'));
    if (vf2) { const v2 = await cdp(vf2.webSocketDebuggerUrl); console.log('after hiding', JSON.stringify((await v2.send('Runtime.evaluate', { expression: `({ vis: window.__vis, now: Math.round(performance.now()), hidden: document.hidden, pix: [...document.querySelectorAll('canvas.pix')].map((c) => c.width), thumbs: [...document.querySelectorAll('.thumb canvas')].filter((c) => c.width).length, inks: [...document.querySelectorAll('canvas.ink')].filter((c) => c.width).length })`, returnByValue: true }))?.result?.value)); v2.close(); }
  }
  await sleep(settle * 1000);
  // A memory dump of every process.
  const ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json());
  const b = await cdp(ver.webSocketDebuggerUrl);
  await b.send('Tracing.start', { traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], memoryDumpConfig: { triggers: [] } }, transferMode: 'ReportEvents' });
  await sleep(500);
  const dump = await b.send('Tracing.requestMemoryDump', { deterministic: true, levelOfDetail: 'detailed' });
  await b.send('Tracing.end');
  for (let i = 0; i < 40 && !b.events.some((e) => e.method === 'Tracing.tracingComplete'); i++) await sleep(250);
  console.log('dump', JSON.stringify(dump));
  const evs = b.events.filter((e) => e.method === 'Tracing.dataCollected').flatMap((e) => e.params.value);
  const names = {};
  for (const e of evs) if (e.ph === 'M' && e.name === 'process_labels' || e.name === 'process_name') names[e.pid] = e.args?.name || e.args?.labels;
  for (const e of evs.filter((x) => x.ph === 'v')) {
    const alloc = e.args?.dumps?.allocators || {};
    const size = (a) => parseInt(a?.attrs?.size?.value || '0', 16);
    const top = Object.entries(alloc).filter(([k]) => !k.includes('/') || k.split('/').length <= 3).map(([k, a]) => [k, size(a)]).filter(([, s]) => s > 2 << 20).sort((x, y) => y[1] - x[1]).slice(0, 18);
    if (!top.length) continue;
    console.log(`\npid ${e.pid} ${names[e.pid] || ''}`);
    for (const [k, s] of top) console.log(`  ${(s / 1048576).toFixed(1).padStart(7)} MB  ${k}`);
  }
  b.close();
  c.close();
} finally {
  spawnSync(exe, ['close', '--user-data-dir', profile]);
  await sleep(3000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
}
