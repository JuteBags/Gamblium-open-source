// A pinned site on the new tab page, clicked in a NEW window while the same site is open in
// another window, must open in the new window and close nothing (owner, Nov 15 2026: it jumped to
// the old window and the new window closed). Also used by tools/gate.mjs.
// Usage: node tools/pin-check.mjs [port]   (starts and closes its own throwaway browser)
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = /^\d+$/.test(process.argv[2] || '') ? Number(process.argv[2]) : 9363;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cdp(url, method, params = {}) {
  const ws = new WebSocket(url);
  await new Promise((r) => (ws.onopen = r));
  const a = new Promise((r) => (ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d); }));
  ws.send(JSON.stringify({ id: 1, method, params }));
  const o = await a;
  ws.close();
  return o.result;
}
const ev = async (u, expression) => (await cdp(u, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
const list = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const browserWs = async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json())).webSocketDebuggerUrl;

export async function pinCheck(sameWindow = false) {
  const exe = join(process.env.LOCALAPPDATA, 'Gamblium', 'app', 'gamblium.exe');
  const profile = mkdtempSync(join(tmpdir(), 'gamblium-pin-'));
  const problems = [];
  try {
    spawnSync(exe, ['launch', '--user-data-dir', profile, '--debug-port', String(PORT), '--', '--window-size=1200,800'], { env: { ...process.env, GAMBLIUM_HOME: repo } });
    for (let i = 0; i < 60; i++) { await sleep(500); if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then((x) => x.ok, () => false)) break; }
    await sleep(3000);
    // Window A: the site is open there.
    await fetch(`http://127.0.0.1:${PORT}/json/new?https://example.com/`, { method: 'PUT' });
    await sleep(2500);
    // The pin, stored the way the new tab page stores it.
    const sw = (await list()).find((t) => t.type === 'service_worker' && t.url.includes('pbgbdlkcienglhbfadbjolphinilbpia'));
    if (!sw) return ['the background worker is not running'];
    await ev(sw.webSocketDebuggerUrl, `(async () => { const { newtab } = await chrome.storage.local.get({ newtab: {} }); await chrome.storage.local.set({ newtab: { ...(newtab || {}), pins: [{ title: 'Example', url: 'https://example.com/' }] } }); })()`);
    // Window B, or (sameWindow) a new tab beside the open site: the new tab page.
    const made = await cdp(await browserWs(), 'Target.createTarget', { url: 'chrome://newtab/', newWindow: !sameWindow });
    await sleep(4000);
    const before = await ev(sw.webSocketDebuggerUrl, `chrome.windows.getAll().then((w) => w.length)`);
    let b = (await list()).find((t) => t.id === made.targetId);
    if (!b) return ['the new window\'s tab is gone before any click'];
    const DOC = "([document, ...[...document.querySelectorAll('iframe')].map((f) => f.contentDocument)].find((d) => d && d.querySelector('a[data-pin]')))";
    const tile = await ev(b.webSocketDebuggerUrl, `(() => { const d = ${DOC}; const a = d && d.querySelector('a[data-pin]'); return a ? { open: a.closest('li').classList.contains('open'), title: a.title } : null; })()`);
    if (!tile) return ['no pinned tile on the new tab page'];
    if (!sameWindow && tile.open) problems.push(`the tile says "${tile.title}" although the site is open only in ANOTHER window`);
    // A real click.
    const at = await ev(b.webSocketDebuggerUrl, `(() => { const d = ${DOC}; const a = d.querySelector('a[data-pin]'); const r = a.getBoundingClientRect(); let x = r.x + r.width / 2, y = r.y + r.height / 2; const f = d.defaultView.frameElement; if (f) { const o = f.getBoundingClientRect(); x += o.x; y += o.y; } return { x, y }; })()`);
    await cdp(b.webSocketDebuggerUrl, 'Page.bringToFront');
    for (const type of ['mousePressed', 'mouseReleased']) await cdp(b.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await sleep(4000);
    const after = await ev(sw.webSocketDebuggerUrl, `chrome.windows.getAll().then((w) => w.length)`);
    b = (await list()).find((t) => t.id === made.targetId);
    if (!b) problems.push('the new window\'s tab was CLOSED by the click');
    else if (!b.url.startsWith('https://example.com')) problems.push(`the new window's tab shows ${b.url}, not the pinned site`);
    if (after < before) problems.push(`a window was closed (${before} -> ${after})`);
    return problems;
  } catch (e) {
    return [`the check itself failed: ${e.message}`];
  } finally {
    spawnSync(exe, ['close', '--user-data-dir', profile]);
    await sleep(2500);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let bad = 0;
  for (const same of [false, true]) {
    const p = await pinCheck(same);
    const where = same ? 'a new tab in the same window' : 'a new window';
    console.log(p.length ? `PIN CHECK FAILED (${where}):\n  ${p.join('\n  ')}` : `PIN CHECK PASSED (${where}): the pin opened there and nothing closed`);
    bad += p.length;
  }
  process.exit(bad ? 1 : 0);
}
