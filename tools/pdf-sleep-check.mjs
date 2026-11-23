// Gamblium PDF and tab sleep: a site's PDF is changed (watermark), its tab is put to sleep (the
// browser discards it, as the extension does when memory is short) and opened again; the change
// must come back from the draft (IndexedDB, keyed by the PDF's address), and Download must end it.
// Run on a fresh test profile with this checkout's extension. Usage: node tools/pdf-sleep-check.mjs
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { samplePdf, SEEN } from './pdf-check.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9381, SITE = 8781;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d.result ?? d.error); waiting.delete(d.id); } };
  return { send: (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); }), close: () => ws.close() };
}
const ev = async (c, expression) => (await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
const list = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());

async function viewerOf(test) {
  for (let i = 0; i < 40; i++) {
    const t = (await list()).find((x) => x.url.includes('/pdf/viewer.html') && test(x));
    if (t) {
      const c = await connect(t.webSocketDebuggerUrl);
      if ((await ev(c, 'window.__gmbPdf?.pages ?? 0')) > 0) return c;
      c.close();
    }
    await sleep(500);
  }
  return null;
}

export async function pdfSleepCheck() {
  const problems = [];
  const pdf = samplePdf();
  const server = http.createServer((q, r) => {
    if (q.url.startsWith('/report.pdf')) { r.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length }); return r.end(pdf); }
    r.writeHead(404); r.end();
  }).listen(SITE, '127.0.0.1');
  const exe = join(process.env.LOCALAPPDATA, 'Gamblium', 'app', 'gamblium.exe');
  const profile = mkdtempSync(join(tmpdir(), 'gamblium-pdfsleep-'));
  const addr = `http://127.0.0.1:${SITE}/report.pdf`;
  try {
    spawnSync(exe, ['launch', '--user-data-dir', profile, '--debug-port', String(PORT), '--', '--window-size=1300,900', ...SEEN], { env: { ...process.env, GAMBLIUM_HOME: repo } });
    for (let i = 0; i < 60; i++) { await sleep(500); if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then((x) => x.ok, () => false)) break; }
    await sleep(3000);
    await fetch(`http://127.0.0.1:${PORT}/json/new?${addr}`, { method: 'PUT' });
    let v = await viewerOf(() => true);
    if (!v) return ['the PDF did not open in Gamblium PDF'];
    // A change, through the Watermark dialog.
    await ev(v, `(async () => { document.querySelector('[data-act=watermark]').click(); document.getElementById('wmText').value = 'ASLEEP'; document.getElementById('wmDlg').close('ok'); await new Promise((r) => setTimeout(r, 2500)); })()`);
    const changed = await ev(v, '({ edited: window.__gmbPdf.edited, size: window.__gmbPdf.bytes.length })');
    if (!changed?.edited) { problems.push('the watermark did not change the file'); return problems; }
    v.close();
    // Put the tab to sleep from the extension's own worker, as the extension does itself.
    const sw = (await list()).find((t) => t.type === 'service_worker' && t.url.includes('/background.js'));
    if (!sw) return [...problems, "the extension's worker was not found"];
    const w = await connect(sw.webSocketDebuggerUrl);
    const blank = await ev(w, `chrome.tabs.create({ url: 'about:blank', active: true }).then((t) => t.id)`);
    await sleep(800);
    const slept = await ev(w, `(async () => { const [t] = await chrome.tabs.query({ url: '${addr}' }); if (!t) return { error: 'tab not found' }; const d = await chrome.tabs.discard(t.id); return { id: d?.id ?? null, discarded: d?.discarded ?? null }; })()`);
    if (!slept?.discarded) problems.push(`the PDF tab could not be put to sleep (${JSON.stringify(slept)})`);
    await sleep(1000);
    // Opened again: the browser loads the PDF anew and the viewer brings the change back.
    await ev(w, `chrome.tabs.update(${slept?.id ?? -1}, { active: true }).then(() => true)`);
    v = await viewerOf(() => true);
    if (!v) problems.push('the PDF did not open again after sleep');
    else {
      await sleep(2500);
      const back = await ev(v, `({ edited: window.__gmbPdf.edited, size: window.__gmbPdf.bytes.length, said: document.getElementById('toast').textContent, undo: !document.getElementById('undo').disabled })`);
      if (!back?.edited || back.size !== changed.size) problems.push(`the change did not come back after sleep (${JSON.stringify(back)}, before ${changed.size} bytes)`);
      if (!back?.undo) problems.push('after sleep, Undo is not offered (the original should be one Undo away)');
      // Download ends the draft: opened again, the PDF is the site's own.
      // No file is really saved (and no save dialog shows): downloads are refused for this test.
      const ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json());
      const br = await connect(ver.webSocketDebuggerUrl);
      await br.send('Browser.setDownloadBehavior', { behavior: 'deny' });
      br.close();
      await ev(v, `document.getElementById('download').click(); true`);
      await sleep(1500);
      const left = await ev(v, `(async () => { const db = await new Promise((r, j) => { const q = indexedDB.open('gamblium-pdf'); q.onsuccess = () => r(q.result); q.onerror = j; }); const n = await new Promise((r) => { const q = db.transaction('drafts').objectStore('drafts').count(); q.onsuccess = () => r(q.result); q.onerror = () => r(-1); }); db.close(); return n; })()`);
      if (left !== 0) problems.push(`Download did not end the draft (${left} kept)`);
      v.close();
    }
    if (blank) await ev(w, `chrome.tabs.remove(${blank}).then(() => true, () => false)`);
    w.close();
  } finally {
    spawnSync(exe, ['close', '--user-data-dir', profile]);
    server.close();
    await sleep(3000);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const p = await pdfSleepCheck();
  console.log(p.length ? p.join('\n') : 'PASS: a changed PDF put to sleep comes back with its change; Download ends the draft');
  process.exit(p.length ? 1 : 0);
}
