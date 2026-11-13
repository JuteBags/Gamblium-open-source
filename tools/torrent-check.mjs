// Checks gamblium-dl's torrent mode against a real, legal torrent (a Debian
// install image): it must find peers, download, stop, and continue from
// where it stopped. With --full it runs to the end and checks the SHA-256.
//   node tools/torrent-check.mjs [gamblium-dl.exe] [--magnet] [--full]
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const exe = resolve(args.find((a) => !a.startsWith('--')) || 'target/release/gamblium-dl.exe');
const full = args.includes('--full');
// debian-13.7.0-s390x-netinst.iso, 421 MiB (under the 500 MB limit for test files).
const TORRENT = 'https://cdimage.debian.org/debian-cd/current/s390x/bt-cd/debian-13.7.0-s390x-netinst.iso.torrent';
const SUMS = 'https://cdimage.debian.org/debian-cd/current/s390x/iso-cd/SHA256SUMS';
const NAME = 'debian-13.7.0-s390x-netinst.iso';
const source = args.includes('--magnet') ? process.env.GAMBLIUM_TEST_MAGNET : TORRENT;
if (!source) { console.log('set GAMBLIUM_TEST_MAGNET to a magnet link'); process.exit(2); }

const dir = mkdtempSync(join(tmpdir(), 'gdl-torrent-'));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };
const MB = 1048576;

// Runs until `stopWhen(events)` says so (then kills it) or it exits by itself.
function run(stopWhen, capMs) {
  return new Promise((done) => {
    // Peers only: Debian's torrent also names a web address, which would be
    // fetched first over plain HTTP (checked separately, see the tester's notes).
    const p = spawn(exe, [source, '--dir', dir, '--json', '--no-web-seed']);
    const events = [];
    let buf = '', err = '';
    const t0 = Date.now();
    const finish = (code) => { clearTimeout(timer); done({ code, events, err, secs: (Date.now() - t0) / 1000 }); };
    const timer = setTimeout(() => p.kill(), capMs);
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        try { events.push(JSON.parse(buf.slice(0, i))); } catch { /* not a JSON line */ }
        buf = buf.slice(i + 1);
      }
      if (stopWhen && stopWhen(events)) p.kill();
    });
    p.stderr.on('data', (d) => (err += d));
    p.on('close', finish);
  });
}
const last = (evs, type) => [...evs].reverse().find((e) => e.event === type);
const sha256 = (file) => new Promise((ok, bad) => {
  const h = createHash('sha256');
  createReadStream(file).on('data', (d) => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', bad);
});

try {
  // 1. Start, find peers, fetch at least 24 MB, then be stopped.
  let r = await run((evs) => (last(evs, 'progress')?.done ?? 0) >= 24 * MB, 240000);
  const start = last(r.events, 'start'), prog = last(r.events, 'progress');
  check('the torrent is read and the file is named', start?.kind === 'torrent' && String(start?.path).endsWith(NAME) && start?.size > 400 * MB, start ? `${(start.size / MB).toFixed(0)} MiB` : r.err.slice(-200));
  check('peers are found and data arrives', (prog?.done ?? 0) >= 24 * MB && prog?.peers > 0, prog ? `${(prog.done / MB).toFixed(0)} MiB in ${r.secs.toFixed(0)} s, ${prog.peers} peers, ${(Math.max(...r.events.filter((e) => e.event === 'progress').map((e) => e.speed)) / MB).toFixed(1)} MiB/s at best` : '');
  const got = prog?.done ?? 0;

  // 2. Run again: what is on disk is checked and kept.
  r = await run(full ? null : (evs) => (last(evs, 'progress')?.done ?? 0) >= got + 8 * MB, full ? 580000 : 240000);
  const firstAgain = r.events.find((e) => e.event === 'progress');
  check('run again: it continues instead of starting over', (firstAgain?.done ?? 0) >= got * 0.8, firstAgain ? `${(firstAgain.done / MB).toFixed(0)} MiB already there (stopped at ${(got / MB).toFixed(0)})` : r.err.slice(-200));

  if (full) {
    const done = last(r.events, 'done');
    check('it finishes', r.code === 0 && !!done, done ? `${(done.bytes / MB).toFixed(0)} MiB, ${(done.speed / MB).toFixed(2)} MiB/s, up to ${done.connections} peers` : `exit ${r.code} ${r.err.slice(-200)}`);
    const sums = await fetch(SUMS).then((x) => x.text());
    const want = sums.split('\n').find((l) => l.includes(NAME))?.split(/\s+/)[0];
    const have = done ? await sha256(join(dir, NAME)) : null;
    check('the file matches Debian\'s SHA-256', !!want && have === want, have ? have.slice(0, 16) : '');
  }
  console.log('      in the folder:', readdirSync(dir).map((f) => `${f} (${(statSync(join(dir, f)).size / MB).toFixed(0)} MiB)`).join(', '));
} catch (e) {
  check('the run finished', false, String(e?.stack ?? e).slice(0, 300));
} finally {
  await new Promise((r) => setTimeout(r, 1500));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
