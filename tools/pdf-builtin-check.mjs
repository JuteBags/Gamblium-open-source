// Gamblium PDF built into the browser: a rebranded copy whose own PDF viewer page starts Gamblium
// PDF (tools/rebrand/pdf_loader.js, written by extra.py step 7). A website's PDF and a PDF file
// open in it while the address bar keeps the PDF's own address; the extension does not redirect.
// Usage: node tools/pdf-builtin-check.mjs <Application folder of a patched copy>
// (the installed copy when no folder is given). Throwaway profile, this checkout's extension.
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { SEEN } from './pdf-check.mjs';
import { tmpdir } from 'node:os';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9381, SITE = 8781;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INSTALLED = join(process.env.LOCALAPPDATA, 'Gamblium', 'browser', 'Application');
const exe = process.env.GAMBLIUM_EXE || join(process.env.LOCALAPPDATA, 'Gamblium', 'app', 'gamblium.exe');

// The two-page sample of pdf-check, written by hand.
function samplePdf() {
  const content = (n) => `0 g BT /F1 24 Tf 72 700 Td (Built in page ${n}) Tj ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>'];
  for (const n of [1, 2]) {
    const page = objs.length + 1;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${page + 1} 0 R >>`);
    objs.push(`<< /Length ${content(n).length} >>\nstream\n${content(n)}\nendstream`);
  }
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.7\n';
  const offs = [];
  objs.forEach((o, k) => { offs.push(Buffer.byteLength(out)); out += `${k + 1} 0 obj\n${o}\nendobj\n`; });
  const x = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out);
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d.result ?? d.error); waiting.delete(d.id); } };
  return { send: (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); }), close: () => ws.close() };
}
const ev = async (c, expression) => (await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());

export async function builtinCheck(app = INSTALLED) {
  const problems = [];
  const ver = readdirSync(app).map((n) => join(app, n)).find((p) => existsSync(join(p, 'resources.pak')));
  if (!ver || !existsSync(join(ver, 'gamblium-pdf-builtin'))) return [`${app} has no built-in Gamblium PDF (run gamblium rebrand)`];
  const pdf = samplePdf();
  const server = http.createServer((q, r) => {
    if (q.url.startsWith('/report.pdf')) { r.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length }); return r.end(pdf); }
    r.writeHead(404); r.end();
  }).listen(SITE, '127.0.0.1');
  const profile = mkdtempSync(join(tmpdir(), 'gamblium-pdfbi-'));
  const files = mkdtempSync(join(tmpdir(), 'gamblium-pdfbif-'));
  try {
    const out = spawnSync(exe, ['launch', '--official', '--brave', join(app, 'brave.exe'), '--user-data-dir', profile, '--debug-port', String(PORT), '--', '--window-size=1300,900', ...SEEN], { env: { ...process.env, GAMBLIUM_HOME: repo }, encoding: 'utf8' });
    if (!/builtin|PDF/i.test(readFileSync(join(profile, 'gamblium-launch.json'), 'utf8'))) problems.push('the launcher did not note the built-in viewer');
    for (let i = 0; i < 60; i++) { await sleep(500); if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then((x) => x.ok, () => false)) break; }
    await sleep(4000);
    const local = join(files, 'Local report.pdf');
    writeFileSync(local, pdf);
    for (const [what, url] of [['a website PDF', `http://127.0.0.1:${SITE}/report.pdf`], ['a PDF file', pathToFileURL(local).href]]) {
      const t = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((r) => r.json());
      let frame = null;
      for (let i = 0; i < 30 && !frame; i++) { await sleep(500); frame = (await targets()).find((x) => x.url.includes('/pdf/viewer.html?embed=1') && x.url.includes(encodeURIComponent(url))); }
      const tab = (await targets()).find((x) => x.id === t.id);
      if (!tab || tab.url !== url) problems.push(`${what}: the address bar shows ${tab?.url}, not the PDF's own address`);
      if (!frame) { problems.push(`${what}: Gamblium PDF did not open inside the browser's PDF page`); continue; }
      const c = await connect(frame.webSocketDebuggerUrl);
      await sleep(2500);
      const s = await ev(c, `({ pages: window.__gmbPdf?.pages, words: window.__gmbPdf ? window.__gmbPdf.words(0).map((w) => w[0]).join(' ') : '', name: document.getElementById('docName').textContent })`);
      if (s?.pages !== 2 || !/Built in page 1/.test(s?.words || '')) problems.push(`${what}: the viewer shows ${JSON.stringify(s)}`);
      c.close();
    }
    // Switched off (Settings: Gamblium PDF off): the browser's own viewer shows the PDF.
    const sw = (await targets()).find((x) => x.type === 'service_worker' && x.url.includes('pbgbdlkcienglhbfadbjolphinilbpia'));
    if (sw) {
      const w = await connect(sw.webSocketDebuggerUrl);
      await ev(w, `chrome.storage.local.set({ pdfViewerOff: true })`);
      w.close();
      const url = `http://127.0.0.1:${SITE}/report.pdf?off`;
      const t = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((r) => r.json());
      await sleep(7000);
      const host = (await targets()).find((x) => x.url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai') && x.parentId === t.id) || (await targets()).filter((x) => x.url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai')).pop();
      const tab = (await targets()).find((x) => x.id === t.id);
      if (!host) problems.push("switched off: the browser's own PDF page did not open");
      else {
        const h = await connect(host.webSocketDebuggerUrl);
        const st = await ev(h, `({ ours: !!document.getElementById('gamblium-pdf'), brave: !!window.viewer && !!document.querySelector('pdf-viewer')?.shadowRoot })`);
        if (st?.ours || !st?.brave) problems.push(`switched off: the browser's own viewer did not take over (${JSON.stringify(st)})`);
        h.close();
      }
      if (tab?.url !== url) problems.push(`switched off: the address became ${tab?.url}`);
    }
  } finally {
    spawnSync(exe, ['close', '--user-data-dir', profile]);
    server.close();
    await sleep(2500);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    rmSync(files, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const p = await builtinCheck(process.argv[2] || INSTALLED).catch((e) => [`the check itself failed: ${e.message}`]);
  console.log(p.length ? `PDF BUILT-IN CHECK FAILED:\n  ${p.join('\n  ')}` : 'PDF BUILT-IN CHECK PASSED');
  process.exit(p.length ? 1 : 0);
}
