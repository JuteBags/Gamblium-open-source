// Checks gamblium-dl against a local server that can be fast, slow per
// connection, strict about the number of connections, unable to send parts,
// or broken half-way.   node tools/dl-check.mjs [path to gamblium-dl.exe]
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exe = resolve(process.argv[2] || 'target/release/gamblium-dl.exe');
const SIZE = 48 * 1024 * 1024;
const body = randomBytes(SIZE);
const want = createHash('sha256').update(body).digest('hex');

// mode: { perConn: bytes/s or 0, maxConns: n or 0, ranges: bool, breakAfter: bytes or 0 }
let mode = {};
let open = 0, peak = 0, served = 0, refused = 0;
// Signed addresses (GitHub, Drive): /login/x needs the cookie s=secret and sends us to
// http://[::1]:PORT/signed/<token>/x; /expiring/x does the same without a login. A token
// is good for mode.ttl ms (default a minute); after that it answers 403.
let tokens = new Map(), issued = 0, leaked = 0, loginRefused = 0;
const server = createServer((req, res) => {
  const signIn = /^\/(login|expiring)\//.exec(req.url);
  if (signIn) {
    if (signIn[1] === 'login' && !/(^|; )s=secret(;|$)/.test(req.headers.cookie || '')) { loginRefused++; res.writeHead(403); return res.end(); }
    const token = randomBytes(6).toString('hex');
    tokens.set(token, Date.now() + (mode.ttl || 60000));
    issued++;
    res.writeHead(302, { Location: `http://[::1]:${other.address().port}/signed/${token}/${req.url.slice(signIn[0].length)}` });
    return res.end();
  }
  const signed = /^\/signed\/([0-9a-f]+)\//.exec(req.url);
  if (signed) {
    if (req.headers.cookie) leaked++;
    if (!(tokens.get(signed[1]) > Date.now())) { res.writeHead(403); return res.end(); }
  }
  if (req.url.startsWith('/named')) res.setHeader('Content-Disposition', 'attachment; filename="named file.bin"');
  if (mode.maxConns && open >= mode.maxConns) {
    refused++;
    res.writeHead(429, { 'Retry-After': '1' });
    return res.end();
  }
  let from = 0, to = SIZE - 1, status = 200;
  const m = mode.ranges !== false && /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    from = +m[1];
    to = m[2] ? Math.min(+m[2], SIZE - 1) : SIZE - 1;
    status = 206;
    res.setHeader('Content-Range', `bytes ${from}-${to}/${SIZE}`);
  }
  if (mode.ranges !== false) res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', '"dl-check"');
  res.writeHead(status, { 'Content-Length': to - from + 1 });
  open++;
  peak = Math.max(peak, open);
  let at = from, closed = false;
  const done = () => { if (!closed) { closed = true; open--; } };
  res.on('close', done);
  const step = () => {
    if (closed) return;
    if (mode.breakAfter && served > mode.breakAfter) return res.destroy();
    if (at > to) return res.end();
    const chunk = mode.perConn ? Math.max(1, Math.floor(mode.perConn / 20)) : 1024 * 1024;
    const end = Math.min(at + chunk, to + 1);
    served += end - at;
    const ok = res.write(body.subarray(at, end));
    at = end;
    if (mode.perConn) setTimeout(step, 50);
    else if (ok) setImmediate(step);
    else res.once('drain', step);
  };
  step();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
// The same files under a second host name ([::1]), for redirects to "another site".
const other = createServer((req, res) => server.emit('request', req, res));
await new Promise((r) => other.listen(0, '::1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const dir = mkdtempSync(join(tmpdir(), 'gdl-'));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const homes = new Set();
function run(urls, args = [], m = {}) {
  mode = m; open = 0; peak = 0; served = 0; refused = 0;
  const t = Date.now();
  // The server lives in this process, so the downloader must not block it: spawnSync would.
  return new Promise((done) => {
    import('node:child_process').then(({ spawn }) => {
      // Each run learns into its own folder (servers.json) unless a test shares one on purpose.
      const home = m.home || mkdtempSync(join(tmpdir(), 'gdl-home-'));
      homes.add(home);
      const p = spawn(exe, [...urls, '--dir', dir, '--json', ...args], { env: { ...process.env, LOCALAPPDATA: home, ...(m.env || {}) } });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('close', (code) => {
        const lines = out.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
        done({ code, lines, last: lines[lines.length - 1] || {}, secs: (Date.now() - t) / 1000, peak, refused });
      });
    });
  });
}

let r = await run([`${base}/fast.bin`]);
check('fast server: file arrives whole', r.code === 0 && sha(join(dir, 'fast.bin')) === want, `${r.secs.toFixed(1)} s, peak ${r.peak} connection(s)`);

const learnHome = mkdtempSync(join(tmpdir(), 'gdl-home-'));
r = await run([`${base}/slow.bin`], [], { perConn: 2 * 1024 * 1024, home: learnHome });
const single = SIZE / (2 * 1024 * 1024);
check('slow per connection: more connections are added', r.code === 0 && r.peak >= 4 && sha(join(dir, 'slow.bin')) === want, `peak ${r.peak}`);
check('slow per connection: at least twice as fast as one connection', r.secs < single / 2, `${r.secs.toFixed(1)} s against ${single.toFixed(0)} s on one`);

const learnt = JSON.parse(readFileSync(join(learnHome, 'Gamblium', 'downloads', 'servers.json'), 'utf8'))[0];
r = await run([`${base}/slow-again.bin`], [], { perConn: 2 * 1024 * 1024, home: learnHome });
const firstTick = r.lines.find((l) => l.event === 'progress');
check('the same server again: starts at the count found last time', r.code === 0 && learnt.connections >= 4 && firstTick && firstTick.connections >= learnt.connections / 2 && sha(join(dir, 'slow-again.bin')) === want, `learnt ${learnt.connections}, first second on ${firstTick && firstTick.connections}, ${r.secs.toFixed(1)} s`);

// Signed in, then sent to a signed address on another host: the cookie goes to the site only.
tokens = new Map(); issued = 0; leaked = 0; loginRefused = 0;
r = await run([`${base}/login/signed-in.bin`], [], { perConn: 8 * 1024 * 1024, env: { GAMBLIUM_DL_COOKIE: JSON.stringify({ '127.0.0.1': 's=secret' }) } });
check('signed in + redirect: whole, and the cookie never reaches the other host', r.code === 0 && sha(join(dir, 'signed-in.bin')) === want && leaked === 0 && loginRefused === 0 && issued >= 1, `${issued} signed address(es), ${leaked} request(s) with a cookie at the other host`);
// The signed address runs out half-way: a fresh one is fetched from the address asked.
tokens = new Map(); issued = 0; leaked = 0;
r = await run([`${base}/expiring/expiring.bin`], ['-x', '4'], { perConn: 2 * 1024 * 1024, ttl: 4000 });
if (process.env.GDL_TRACE) console.log(r.lines.filter((l) => l.event === 'progress').map((l) => l.connections + '@' + (l.speed / 1048576).toFixed(1)).join(' '), JSON.stringify(r.lines.filter((l) => l.event !== 'progress')));
check('signed address runs out mid-download: renewed, whole', r.code === 0 && sha(join(dir, 'expiring.bin')) === want && issued >= 2, `${issued} signed address(es), ${r.secs.toFixed(1)} s${r.code ? ' ' + JSON.stringify(r.last).slice(0, 200) : ''}`);

r = await run([`${base}/strict.bin`], [], { perConn: 4 * 1024 * 1024, maxConns: 3 });
check('server that refuses a 4th connection: still whole', r.code === 0 && sha(join(dir, 'strict.bin')) === want, `refused ${r.refused} request(s), ${r.secs.toFixed(1)} s`);
check('server that refuses: the count was cut back', r.refused > 0 && r.refused < 40, `${r.refused} refusals`);

r = await run([`${base}/plain.bin`], [], { ranges: false });
check('server without parts: one stream, whole', r.code === 0 && r.peak === 1 && sha(join(dir, 'plain.bin')) === want);

r = await run([`${base}/named/x`]);
check('the server\'s file name is used', r.code === 0 && existsSync(join(dir, 'named file.bin')));

r = await run([`${base}/resume.bin`], ['--give-up-after', '4'], { breakAfter: 20 * 1024 * 1024 });
const partLeft = existsSync(join(dir, 'resume.bin.part')) && existsSync(join(dir, 'resume.bin.part.state'));
check('broken half-way: stops with an error and keeps what it has', r.code === 1 && partLeft, r.last.error ? r.last.error.slice(0, 90) : '');
r = await run([`${base}/resume.bin`]);
const resumed = r.lines.find((l) => l.event === 'resume');
check('run again: continues instead of starting over', r.code === 0 && resumed && resumed.have > 8 * 1024 * 1024 && sha(join(dir, 'resume.bin')) === want, resumed ? `${(resumed.have / 1048576).toFixed(0)} MB kept` : '');
check('no leftovers after finishing', !readdirSync(dir).some((f) => f.endsWith('.part') || f.endsWith('.state')));

r = await run([`http://127.0.0.1:9/dead.bin`, `${base}/mirror.bin`], ['--out', 'mirror.bin']);
check('two sources, one dead: the other delivers', r.code === 0 && sha(join(dir, 'mirror.bin')) === want);

r = await run([`${base}/a.bin`, `${base}/b.bin`], ['--out', 'both.bin'], { perConn: 2 * 1024 * 1024 });
check('two live sources are used together', r.code === 0 && r.peak >= 2 && sha(join(dir, 'both.bin')) === want, `peak ${r.peak}`);

r = await run(['ftp://example.org/file.bin']);
check('an address that is neither web, magnet nor torrent is refused', r.code === 2);

server.close();
other.close();
rmSync(dir, { recursive: true, force: true });
for (const h of homes) rmSync(h, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
