// The restart an update triggers (the extension asks its helper to `restart`; the helper starts
// `gamblium relaunch`, which closes the browser and starts it again) must bring the browser back
// on the same profile. Owner, Nov 15 2026: after an install Gamblium closed and did not reopen.
// Throwaway profile. Also run by tools/gate.mjs. Usage: node tools/restart-check.mjs
import { spawnSync, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9403;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browsersOn = (base) => execFileSync('powershell', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "Name='brave.exe'" | Where-Object { $_.CommandLine -like '*${base}*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { $_.ProcessId }) -join ','`], { encoding: 'utf8' }).trim().split(',').filter(Boolean).map(Number);

export async function restartCheck() {
  const problems = [];
  const exe = join(process.env.LOCALAPPDATA, 'Gamblium', 'app', 'gamblium.exe');
  const profile = mkdtempSync(join(tmpdir(), 'gamblium-rst-'));
  const base = profile.split(/[\\/]/).pop();
  try {
    spawnSync(exe, ['launch', '--user-data-dir', profile, '--debug-port', String(PORT), '--', '--window-size=1000,700'], { env: { ...process.env, GAMBLIUM_HOME: repo } });
    for (let i = 0; i < 60; i++) { await sleep(500); if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then((x) => x.ok, () => false)) break; }
    await sleep(3000);
    for (const u of ['https://example.com/', 'https://example.org/']) await fetch(`http://127.0.0.1:${PORT}/json/new?${u}`, { method: 'PUT' });
    await sleep(2000);
    const before = browsersOn(base);
    if (before.length !== 1) return [`expected one browser on the test profile, found ${before.length}`];
    const sw = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).find((t) => t.type === 'service_worker' && t.url.includes('pbgbdlkcienglhbfadbjolphinilbpia'));
    if (!sw) return ['the extension is not running'];
    const ws = new WebSocket(sw.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `chrome.runtime.sendNativeMessage('com.gamblium.host', { type: 'restart' }).then((r) => JSON.stringify(r), (e) => String(e))`, awaitPromise: true, returnByValue: true } }));
    const said = await new Promise((r) => (ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d.result?.result?.value); }));
    ws.close();
    if (!/restarting/.test(String(said))) problems.push(`the helper did not start a restart: ${said}`);
    // Gone, then back with a new process, within a minute.
    let gone = false, back = [];
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      const now = browsersOn(base);
      if (!now.includes(before[0])) gone = true;
      if (gone && now.length) { back = now; break; }
    }
    if (!gone) problems.push('the browser was never closed by the restart');
    else if (!back.length) problems.push('the browser closed and did NOT come back within 60 s');
    else if (back.length > 1) problems.push(`${back.length} browsers came back on one profile`);
    return problems;
  } catch (e) {
    return [`the check itself failed: ${e.message}`];
  } finally {
    spawnSync(exe, ['close', '--user-data-dir', profile]);
    await sleep(3000);
    for (const pid of browsersOn(base)) { try { process.kill(pid); } catch {} }
    await sleep(2000);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const p = await restartCheck();
  console.log(p.length ? `RESTART CHECK FAILED:\n  ${p.join('\n  ')}` : 'RESTART CHECK PASSED: closed and back on the same profile');
  process.exit(p.length ? 1 : 0);
}
