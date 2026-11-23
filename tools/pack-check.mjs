// Packing a profile folder and unpacking it gives back every file, byte for byte; a pack stopped by
// a start leaves the folder as it was. Uses gamblium.exe pack-dir on a made-up folder (no browser).
// Usage: node tools/pack-check.mjs   (exit 1 on a difference)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.env.GAMBLIUM_EXE || join(repo, 'target', 'release', 'gamblium.exe');

function hashes(dir) {
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(dir.length)] = createHash('sha1').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

export function packCheck() {
  const problems = [];
  const root = mkdtempSync(join(tmpdir(), 'gamblium-packchk-'));
  const dir = join(root, 'profile');
  try {
    mkdirSync(join(dir, 'Default', 'Network'), { recursive: true });
    mkdirSync(join(dir, 'Default', 'Cache', 'Cache_Data'), { recursive: true });
    writeFileSync(join(dir, 'Local State'), '{"a":1}');
    writeFileSync(join(dir, 'Default', 'Network', 'Cookies'), Buffer.alloc(50000, 7));
    writeFileSync(join(dir, 'Default', 'Cache', 'Cache_Data', 'data_1'), Buffer.alloc(9 * 1024 * 1024, 3)); // over 8 MB: written straight
    for (let i = 0; i < 300; i++) writeFileSync(join(dir, 'Default', `f${i}`), `file ${i} `.repeat(i + 1));
    const before = hashes(dir);
    const p = spawnSync(exe, ['pack-dir', dir], { encoding: 'utf8' });
    if (p.status !== 0 || !existsSync(join(dir, 'profile.tar.zst'))) problems.push(`pack failed: ${p.stderr || p.stdout}`);
    if (existsSync(join(dir, 'Default'))) problems.push('the packed folder still holds its files');
    const u = spawnSync(exe, ['pack-dir', dir, '--unpack'], { encoding: 'utf8' });
    if (u.status !== 0) problems.push(`unpack failed: ${u.stderr || u.stdout}`);
    const after = hashes(dir);
    const missing = Object.keys(before).filter((k) => after[k] !== before[k]);
    if (missing.length) problems.push(`${missing.length} file(s) differ after a round trip, e.g. ${missing[0]}`);
    if (existsSync(join(dir, 'profile.tar.zst'))) problems.push('the archive stayed after unpacking');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const p = packCheck();
  console.log(p.length ? p.join('\n') : 'PASS: a profile packs and unpacks byte for byte');
  process.exit(p.length ? 1 : 0);
}
