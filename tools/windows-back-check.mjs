// Every window comes back after Gamblium closes a browser (owner, Nov 16 2026: Personal's 17-tab
// window was lost at a restart: windows closed one by one, all but the last went to Recently
// closed). A throwaway profile gets 2 windows (3 tabs and 1 tab); `gamblium close` stops it; it is
// started again and must show 2 windows with all 4 pages.
// Usage: node tools/windows-back-check.mjs [path to gamblium.exe]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanUpAlways } from './test-cleanup.mjs';

cleanUpAlways();
const exe = process.argv[2] || join(process.env.LOCALAPPDATA, 'Gamblium', 'app', 'gamblium.exe');
const PORT = 9497;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'gamblium-winback-'));
mkdirSync(join(profile, 'Default'), { recursive: true });
// Continue where you left off, as a used profile is.
writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ session: { restore_on_startup: 1 } }));
const start = async () => {
  spawnSync(exe, ['launch', '--user-data-dir', profile, '--debug-port', String(PORT)], { windowsHide: true });
  for (let i = 0; i < 60; i++) { await sleep(500); if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.ok, () => false)) return; }
  throw new Error('the browser did not start');
};
const pages = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).filter((t) => t.type === 'page' && /example\.(com|org)|127\.0\.0\.1/.test(t.url));
const send = async (method, params = {}) => {
  const v = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json());
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const out = await new Promise((r) => { ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d.result); }); ws.send(JSON.stringify({ id: 1, method, params })); });
  ws.close();
  return out;
};
const problems = [];
try {
  await start();
  await sleep(2000);
  // Window 1: three pages. Window 2: one page.
  for (const u of ['https://example.com/?a', 'https://example.com/?b', 'https://example.com/?c']) await send('Target.createTarget', { url: u });
  await send('Target.createTarget', { url: 'https://example.org/?w2', newWindow: true });
  await sleep(6000);
  const before = await pages();
  const winsOf = async (list) => new Set(await Promise.all(list.map(async (p) => (await send('Browser.getWindowForTarget', { targetId: p.id }))?.windowId))).size;
  const wBefore = await winsOf(before);
  spawnSync(exe, ['close', '--user-data-dir', profile], { windowsHide: true });
  await sleep(2000);
  await start();
  await sleep(6000);
  const after = await pages();
  const wAfter = await winsOf(after);
  console.log(`before: ${before.length} pages in ${wBefore} windows; after: ${after.length} pages in ${wAfter} windows`);
  if (after.length < before.length) problems.push(`pages lost: ${before.length} -> ${after.length}`);
  if (wAfter < wBefore) problems.push(`windows lost: ${wBefore} -> ${wAfter}`);
} catch (e) {
  problems.push(String(e.message || e));
} finally {
  spawnSync(exe, ['close', '--user-data-dir', profile], { windowsHide: true });
  await sleep(1500);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
console.log(problems.length ? `WINDOWS BACK CHECK FAILED:\n  ${problems.join('\n  ')}` : 'WINDOWS BACK CHECK PASSED: every window and page came back');
process.exit(problems.length ? 1 : 0);
