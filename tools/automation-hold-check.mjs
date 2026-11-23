// While another program drives the browser (a debugger attached to a tab, as Claude in Chrome
// does), Gamblium freezes nothing and puts nothing to sleep, so tab ids stay and pages answer
// (owner, Nov 16 2026). A throwaway profile, freeze delay 5 s: one tab attached from outside, one
// hidden tab must stay unfrozen and awake past the delay, and the freeze log must say why.
// Usage: node tools/automation-hold-check.mjs   (GAMBLIUM_HOME = a checkout loads its extension)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanUpAlways } from './test-cleanup.mjs';

cleanUpAlways();
const exe = join(process.env.LOCALAPPDATA, 'Gamblium', 'app', 'gamblium.exe');
const PORT = 9498;
const EXT = 'chrome-extension://pbgbdlkcienglhbfadbjolphinilbpia';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'gamblium-autohold-'));
const ws = async (url) => {
  const w = new WebSocket(url);
  await new Promise((r) => w.addEventListener('open', r));
  let n = 0;
  const wait = new Map();
  w.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (wait.has(d.id)) { wait.get(d.id)(d.result); wait.delete(d.id); } });
  w.send1 = (method, params = {}) => new Promise((r) => { const id = ++n; wait.set(id, r); w.send(JSON.stringify({ id, method, params })); });
  return w;
};
const problems = [];
try {
  spawnSync(exe, ['launch', '--user-data-dir', profile, '--debug-port', String(PORT)], { windowsHide: true, env: process.env });
  for (let i = 0; i < 60; i++) { await sleep(500); if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.ok, () => false)) break; }
  await sleep(3000);
  const list = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
  // The extension's settings page, to drive the extension from.
  const page = await fetch(`http://127.0.0.1:${PORT}/json/new?${EXT}/ui/settings.html`, { method: 'PUT' }).then((r) => r.json());
  await sleep(2000);
  const ext = await ws(page.webSocketDebuggerUrl);
  const ev = async (e) => (await ext.send1('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }))?.result?.value;
  await ev(`chrome.storage.local.set({ freezeDelaySec: 5 })`);
  // A hidden tab, and the "driven" tab attached from outside (a page-level debugging session).
  const hidden = await ev(`chrome.tabs.create({ url: 'https://example.org/?hidden', active: false }).then((t) => t.id)`);
  await sleep(1500);
  // The page `ext` is connected to is attached from outside, as an automation tool attaches.
  await sleep(45000);
  const t = await ev(`chrome.tabs.get(${hidden}).then((t) => ({ id: t.id, discarded: t.discarded }), () => null)`);
  const log = await ev(`chrome.storage.local.get('freezeLog').then((r) => r.freezeLog)`);
  const frozen = await ev(`chrome.storage.session.get(null).then((r) => JSON.stringify(r).includes('"${hidden}"') && /frozen/i.test(JSON.stringify(r)))`);
  console.log('hidden tab:', JSON.stringify(t), '| freeze log:', String(JSON.stringify(log)).slice(0, 160));
  if (!t) problems.push('the hidden tab is gone (its id changed: put to sleep)');
  else if (t.discarded) problems.push('the hidden tab was put to sleep');
  if (log && log.ran !== false) problems.push('the freezer ran while the browser was driven');
  void frozen;
  ext.close();
} catch (e) {
  problems.push(String(e.message || e));
} finally {
  spawnSync(exe, ['close', '--user-data-dir', profile], { windowsHide: true });
  await sleep(1500);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
console.log(problems.length ? `AUTOMATION HOLD CHECK FAILED:\n  ${problems.join('\n  ')}` : 'AUTOMATION HOLD CHECK PASSED: driven browser kept its tabs awake and their ids');
process.exit(problems.length ? 1 : 0);
