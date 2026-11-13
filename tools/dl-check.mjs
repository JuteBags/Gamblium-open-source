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
const server = createServer((req, res) => {
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
const base = `http://127.0.0.1:${server.address().port}`;

const dir = mkdtempSync(join(tmpdir(), 'gdl-'));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
function run(urls, args = [], m = {}) {
  mode = m; open = 0; peak = 0; served = 0; refused = 0;
  const t = Date.now();
  // The server lives in this process, so the downloader must not block it: spawnSync would.
  return new Promise((done) => {
    import('node:child_process').then(({ spawn }) => {
      const p = spawn(exe, [...urls, '--dir', dir, '--json', ...args]);
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

r = await run([`${base}/slow.bin`], [], { perConn: 2 * 1024 * 1024 });
const single = SIZE / (2 * 1024 * 1024);
check('slow per connection: more connections are added', r.code === 0 && r.peak >= 4 && sha(join(dir, 'slow.bin')) === want, `peak ${r.peak}`);
check('slow per connection: at least twice as fast as one connection', r.secs < single / 2, `${r.secs.toFixed(1)} s against ${single.toFixed(0)} s on one`);

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
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
