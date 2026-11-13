// A big download started in the browser must end up with gamblium-dl, a small
// one must stay with Brave. Uses the installed Gamblium (helper and extension),
// a fresh profile, its own download folder and a local server.
//   node tools/handover-check.mjs
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const app = join(process.env.LOCALAPPDATA, 'Gamblium', 'app', 'gamblium.exe');
const stateDir = join(process.env.LOCALAPPDATA, 'Gamblium', 'downloads');
const PORT = 9399;
const BIG = 96 * 1024 * 1024, SMALL = 2 * 1024 * 1024;
const body = randomBytes(BIG);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let peak = 0, open = 0;
let loginSeen = 0, loginRefused = 0;
const server = createServer((req, res) => {
  // /login sets a cookie; /private.bin is only served with it.
  if (req.url.startsWith('/login')) {
    res.writeHead(200, { 'Set-Cookie': 'session=let-me-in; Path=/', 'Content-Type': 'text/html' });
    return res.end('<a id="go" href="/private.bin">file</a>');
  }
  if (req.url.startsWith('/private')) {
    if (!/session=let-me-in/.test(req.headers.cookie || '')) {
      loginRefused++;
      res.writeHead(403);
      return res.end('sign in first');
    }
    loginSeen++;
  }
  const size = req.url.startsWith('/small') ? SMALL : BIG;
  let from = 0, to = size - 1, status = 200;
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    from = +m[1];
    to = m[2] ? Math.min(+m[2], size - 1) : size - 1;
    status = 206;
    res.setHeader('Content-Range', `bytes ${from}-${to}/${size}`);
  }
  res.writeHead(status, { 'Content-Length': to - from + 1, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${req.url.slice(1)}"` });
  open++;
  peak = Math.max(peak, open);
  let at = from, closed = false;
  res.on('close', () => { if (!closed) { closed = true; open--; } });
  // 4 MB/s per connection: one connection needs 24 s for the big file.
  const step = () => {
    if (closed) return;
    if (at > to) return res.end();
    const end = Math.min(at + (req.url.includes('slow') ? 20 : 200) * 1024, to + 1);
    res.write(body.subarray(at, end));
    at = end;
    setTimeout(step, 50);
  };
  step();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const work = mkdtempSync(join(tmpdir(), 'gamblium-handover-'));
const profile = join(work, 'profile'), saveTo = join(work, 'saved');
const preset = join(work, 'preset.json');
writeFileSync(preset, JSON.stringify({ name: 'handover-check', preferences: { 'download.default_directory': saveTo, 'download.prompt_for_download': false } }));

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };
const ours = () => (existsSync(stateDir) ? readdirSync(stateDir) : [])
  .filter((f) => f.endsWith('.args.json'))
  .map((f) => ({ id: f.slice(0, 16), asked: JSON.parse(readFileSync(join(stateDir, f), 'utf8')) }))
  .filter((d) => String(d.asked.url || '').startsWith(base))
  .map((d) => ({ ...d, state: (() => { try { return JSON.parse(readFileSync(join(stateDir, d.id + '.json'), 'utf8')); } catch { return {}; } })() }));
// Runs an expression in the extension's worker and returns its value.
async function inWorker(expression) {
  const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
  const sw = targets.find((x) => x.type === 'service_worker' && x.url.includes('pbgbdlkcienglhbfadbjolphinilbpia'));
  const ws = new WebSocket(sw.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const answer = new Promise((r) => (ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d); }));
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true } }));
  const out = (await answer).result?.result?.value;
  ws.close();
  return out;
}
const helper = (request) => inWorker(`chrome.runtime.sendNativeMessage('com.gamblium.host', ${JSON.stringify(request)}).then((r) => JSON.stringify(r))`).then((t) => JSON.parse(t || '{}'));
const openTab = (url) => fetch(`http://127.0.0.1:${PORT}/json/new?${url}`, { method: 'PUT' }).then((r) => r.ok, () => false);

try {
  const launched = spawnSync(app, ['launch', '--user-data-dir', profile, '--debug-port', String(PORT), '--preset-file', preset], { encoding: 'utf8' });
  check('the browser started', launched.status === 0, launched.status === 0 ? '' : (launched.stderr || launched.stdout).slice(-200));
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await sleep(500); up = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.ok, () => false); }
  await sleep(4000); // the extension's worker and the helper settle

  await openTab(`${base}/small.bin`);
  await openTab(`${base}/big.bin`);
  const t = Date.now();
  let done = null;
  while (Date.now() - t < 60000) {
    await sleep(1000);
    done = ours().find((d) => d.state.state === 'done');
    if (done && existsSync(join(saveTo, 'small.bin')) && existsSync(join(saveTo, 'big.bin'))) break;
  }
  const secs = (Date.now() - t) / 1000;
  const list = ours();
  check('the big download was handed to gamblium-dl', list.length === 1 && !!done, JSON.stringify(list.map((d) => ({ state: d.state.state, error: d.state.error, connections: d.state.connections }))));
  check('it arrived whole', existsSync(join(saveTo, 'big.bin')) && sha(readFileSync(join(saveTo, 'big.bin'))) === sha(body), `${secs.toFixed(0)} s`);
  check('it used more than one connection', peak > 1 && done && done.state.connections > 1, `peak ${peak}`);
  check('faster than one connection could be', secs < 20, `${secs.toFixed(0)} s against 24 s`);
  // Behind a login: the page sets a cookie, then the file is asked for.
  await openTab(`${base}/login`);
  await sleep(1500);
  const before = ours().length;
  await openTab(`${base}/private.bin`);
  const t2 = Date.now();
  let priv = null;
  while (Date.now() - t2 < 60000 && !priv) {
    await sleep(1000);
    priv = ours().find((d) => String(d.asked.url).includes('/private.bin') && d.state.state === 'done');
  }
  check('a download behind a login goes through our downloader with the cookie', !!priv && priv.state.connections > 1 && loginRefused === 0, `${ours().length - before} hand-over(s), ${loginSeen} request(s) with the cookie, ${loginRefused} refused, ${((Date.now() - t2) / 1000).toFixed(0)} s`);
  check('and arrives whole', existsSync(join(saveTo, 'private.bin')) && sha(readFileSync(join(saveTo, 'private.bin'))) === sha(body));
  check('the cookie is in none of the download\'s own files', !readFileSync(join(stateDir, (priv?.id ?? 'x') + '.args.json'), 'utf8').includes('let-me-in') && !readFileSync(join(stateDir, (priv?.id ?? 'x') + '.json'), 'utf8').includes('let-me-in'));
  check('the stored login is deleted the moment the download is whole', !existsSync(join(stateDir, (priv?.id ?? 'x') + '.cookie')));

  // Pause a logged-in download half-way, look at what is on disk, continue it.
  await openTab(`${base}/private-slow.bin`);
  let slow = null;
  for (let i = 0; i < 40 && !(slow && slow.state.done > 6 * 1024 * 1024); i++) {
    await sleep(1000);
    slow = ours().find((d) => String(d.asked.url).includes('/private-slow.bin'));
  }
  const cookieFile = join(stateDir, (slow?.id ?? 'x') + '.cookie');
  const paused = await helper({ type: 'dl-action', id: slow?.id, action: 'pause' });
  await sleep(1500);
  const sealed = existsSync(cookieFile) ? readFileSync(cookieFile) : Buffer.alloc(0);
  check('paused: the login is stored, sealed', paused.ok !== false && sealed.length > 40 && !sealed.includes('let-me-in') && !sealed.includes('session='), `${sealed.length} bytes`);
  const row = (await helper({ type: 'dl-list' })).jobs?.find((j) => j.id === slow?.id);
  check('paused: the list says it can be continued, and until when', row?.state === 'paused' && row?.canResume === true && row?.loginUntil > Date.now() / 1000, row ? `${row.state}, login valid for ${Math.round((row.loginUntil - Date.now() / 1000) / 3600)} h` : '');
  const wasAt = ours().find((d) => d.id === slow?.id)?.state.done ?? 0;
  const resumed = await helper({ type: 'dl-action', id: slow?.id, action: 'resume' });
  let fin = null;
  for (let i = 0; i < 90 && !fin; i++) {
    await sleep(1000);
    fin = ours().find((d) => d.id === slow?.id && d.state.state === 'done');
  }
  check('continued with the stored login and finished whole', resumed.ok !== false && !!fin && loginRefused === 0 && sha(readFileSync(join(saveTo, 'private-slow.bin'))) === sha(body), `stopped at ${(wasAt / 1048576).toFixed(0)} MiB, ${loginRefused} refused`);
  check('finished: the stored login is gone', !existsSync(cookieFile));
  // A sealed login moved onto another download must not open.
  const other = await helper({ type: 'dl-action', id: 'ffffffffffffffff', action: 'resume' });
  check('an unknown download cannot be continued', other.ok === false);
  check('the small download stayed with Brave and arrived', existsSync(join(saveTo, 'small.bin')) && sha(readFileSync(join(saveTo, 'small.bin'))) === sha(body.subarray(0, SMALL)));
  // What the extension noted about the hand-over (read from its worker).
  try {
    const notes = JSON.parse((await inWorker('chrome.storage.local.get({handovers: []}).then((s) => JSON.stringify(s.handovers))')) || '[]');
    check("Brave's own copy was cancelled", notes.length === 3 && notes.every((n) => n.cancel === 'ok' && n.after?.state === 'interrupted'), notes.map((n) => n.cancel + '/' + n.after?.state).join(', '));
  } catch (e) {
    console.log('      (could not read the hand-over note: ' + e + ')');
  }
  // Brave clears its cancelled copy a little after the cancel.
  for (let i = 0; i < 10 && readdirSync(saveTo).some((f) => f.endsWith('.crdownload')); i++) await sleep(1000);
  check('no half-finished files are left', !readdirSync(saveTo).some((f) => /\.(part|state|crdownload)$/.test(f)), readdirSync(saveTo).join(', '));
} catch (e) {
  check('the run finished', false, String(e && e.stack ? e.stack : e).slice(0, 400));
} finally {
  spawnSync(app, ['close', '--user-data-dir', profile], { encoding: 'utf8' });
  for (const d of ours()) for (const f of [d.id + '.args.json', d.id + '.json']) rmSync(join(stateDir, f), { force: true });
  await sleep(1500);
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
