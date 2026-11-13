// After the first start of a new profile the Gamblium extension must be
// allowed in private windows, with nobody clicking anything.
//   node tools/private-check.mjs [gamblium.exe]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exe = resolve(process.argv[2] || 'target/release/gamblium.exe');
const ID = 'pbgbdlkcienglhbfadbjolphinilbpia';
const PORT = 9411;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = mkdtempSync(join(tmpdir(), 'gamblium-private-'));
const profile = join(work, 'profile');
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };

async function evalIn(url, expression) {
  const made = await fetch(`http://127.0.0.1:${PORT}/json/new?${url}`, { method: 'PUT' }).then((r) => r.json());
  await sleep(2500);
  const ws = new WebSocket(made.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const answer = new Promise((r) => (ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d); }));
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const out = await answer;
  ws.close();
  return out.result?.result?.value;
}

try {
  let r = spawnSync(exe, ['launch', '--user-data-dir', profile, '--debug-port', String(PORT)], { encoding: 'utf8' });
  check('first start says it switched private windows on', /private windows: the Gamblium extension is now allowed/.test(r.stdout), (r.stdout.match(/private windows:.*/) || [''])[0].slice(0, 160));
  check('the profile remembers it', existsSync(join(profile, 'gamblium-private-access')));
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await sleep(500); up = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((x) => x.ok, () => false); }
  const info = await evalIn('chrome://extensions/', `new Promise((d) => chrome.developerPrivate.getExtensionInfo('${ID}', (i) => d(JSON.stringify({ on: i && i.incognitoAccess && i.incognitoAccess.isActive, name: i && i.name }))))`);
  check('the browser itself reports private access as on', JSON.parse(info || '{}').on === true, info);
  spawnSync(exe, ['close', '--user-data-dir', profile], { encoding: 'utf8' });
  await sleep(2000);
  r = spawnSync(exe, ['launch', '--user-data-dir', profile, '--debug-port', String(PORT)], { encoding: 'utf8' });
  check('the second start does not do it again', !/private windows:/.test(r.stdout));
} catch (e) {
  check('the run finished', false, String(e?.stack ?? e).slice(0, 300));
} finally {
  spawnSync(exe, ['close', '--user-data-dir', profile], { encoding: 'utf8' });
  await sleep(1500);
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
