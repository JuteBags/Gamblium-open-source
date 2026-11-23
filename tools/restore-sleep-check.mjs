// Restored tabs stay asleep (owner, Nov 16 2026): a throwaway profile with 6 pages from a local
// server that counts page loads is closed and started again; only the tab in front may load, the
// others come back asleep (discarded, keeping their titles) and load when opened.
// Usage: node tools/restore-sleep-check.mjs   (also run by tools/gate.mjs)
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = join(process.env.LOCALAPPDATA, 'Gamblium', 'app', 'gamblium.exe');
const PORT = 9481;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function restoreSleepCheck() {
  const loads = [];
  const server = createServer((req, res) => {
    if (req.url.startsWith('/page')) loads.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Page ${req.url}</title><p>${req.url}`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const site = `http://127.0.0.1:${server.address().port}`;
  const profile = mkdtempSync(join(tmpdir(), 'gamblium-restore-'));
  const env = { ...process.env, GAMBLIUM_HOME: repo };
  const up = async () => { for (let i = 0; i < 60; i++) { await sleep(500); if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then((x) => x.ok, () => false)) return true; } return false; };
  try {
    // Session restore on: the browser brings its tabs back at the next start.
    mkdirSync(join(profile, 'Default'), { recursive: true });
    writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ session: { restore_on_startup: 1 } }));
    spawnSync(exe, ['launch', '--user-data-dir', profile, '--debug-port', String(PORT)], { env });
    if (!(await up())) return ['the test browser did not start'];
    await sleep(2000);
    for (let i = 1; i <= 6; i++) await fetch(`http://127.0.0.1:${PORT}/json/new?${site}/page${i}`, { method: 'PUT' });
    await sleep(6000);
    spawnSync(exe, ['close', '--user-data-dir', profile]);
    await sleep(4000);
    loads.length = 0;
    spawnSync(exe, ['launch', '--user-data-dir', profile, '--debug-port', String(PORT)], { env });
    if (!(await up())) return ['the test browser did not start again'];
    await sleep(40000);
    // The worker's own view of the tabs (never attached to a tab: that would load it).
    const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
    const sw = targets.find((t) => t.type === 'service_worker' && /pbgbdlkcienglhbfadbjolphinilbpia/.test(t.url));
    let tabs = null;
    if (sw) {
      const ws = new WebSocket(sw.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener('open', r));
      tabs = await new Promise((r) => {
        ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d.result?.result?.value); });
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `chrome.tabs.query({}).then((t) => t.filter((x) => /\\/page\\d/.test(x.url || x.pendingUrl || '')).map((x) => ({ url: x.url, title: x.title, discarded: x.discarded, active: x.active })))`, awaitPromise: true, returnByValue: true } }));
      });
      ws.close();
    }
    const problems = [];
    const pages = new Set(loads);
    if (!tabs || tabs.length < 6) problems.push(`the 6 pages did not come back (${tabs ? tabs.length : 'no answer from the worker'})`);
    if (pages.size > 1) problems.push(`${pages.size} of the 6 restored pages loaded (${[...pages].join(', ')}); only the one in front should`);
    const awake = (tabs || []).filter((t) => !t.active && !t.discarded);
    if (awake.length) problems.push(`${awake.length} hidden restored tabs are awake`);
    if ((tabs || []).some((t) => t.discarded && !/Page/.test(t.title || ''))) problems.push('an asleep tab lost its title');
    return problems;
  } catch (e) {
    return [`the check itself failed: ${e.message}`];
  } finally {
    spawnSync(exe, ['close', '--user-data-dir', profile]);
    await sleep(1500);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    server.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const p = await restoreSleepCheck();
  console.log(p.length ? `RESTORE SLEEP CHECK FAILED:\n  ${p.join('\n  ')}` : 'RESTORE SLEEP CHECK PASSED: after a restart only the tab in front loaded; the others came back asleep with their titles');
  process.exit(p.length ? 1 : 0);
}
