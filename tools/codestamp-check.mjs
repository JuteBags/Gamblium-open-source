// New extension code is taken before the window opens (crates/gamblium/src/codestamp.rs): a
// throwaway profile runs a copy of the extension (stamp A) with a page open, is closed, the copy's
// stamp becomes B (as an install does), and the next start must run code B from the first page
// without the browser restarting itself, with the page back.
// Usage: node tools/codestamp-check.mjs
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = join(process.env.LOCALAPPDATA, 'Gamblium', 'app', 'gamblium.exe');
const PORT = 9485;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = async () => { for (let i = 0; i < 80; i++) { await sleep(500); if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then((x) => x.ok, () => false)) return true; } return false; };

export async function codestampCheck() {
  const home = mkdtempSync(join(tmpdir(), 'gamblium-stamphome-'));
  const profile = mkdtempSync(join(tmpdir(), 'gamblium-stamp-'));
  const problems = [];
  try {
    for (const d of ['extension', 'presets', 'theme', 'branding']) if (existsSync(join(repo, d))) cpSync(join(repo, d), join(home, d), { recursive: true });
    const stampFile = join(home, 'extension', 'code-stamp.js');
    writeFileSync(stampFile, 'export const CODE_STAMP = "stamp-A";\n');
    mkdirSync(join(profile, 'Default'), { recursive: true });
    writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ session: { restore_on_startup: 1 } }));
    const env = { ...process.env, GAMBLIUM_HOME: home };
    spawnSync(exe, ['launch', '--user-data-dir', profile, '--debug-port', String(PORT)], { env });
    if (!(await up())) return ['the test browser did not start'];
    await sleep(3000);
    await fetch(`http://127.0.0.1:${PORT}/json/new?https://example.com/`, { method: 'PUT' });
    await sleep(8000);
    const runA = existsSync(join(profile, 'gamblium-code-stamp')) ? readFileSync(join(profile, 'gamblium-code-stamp'), 'utf8').trim() : '';
    if (runA !== 'stamp-A') problems.push(`the extension did not note the code it runs (${JSON.stringify(runA)})`);
    spawnSync(exe, ['close', '--user-data-dir', profile]);
    await sleep(4000);
    writeFileSync(stampFile, 'export const CODE_STAMP = "stamp-B";\n');
    const logBefore = existsSync(join(process.env.LOCALAPPDATA, 'Gamblium', 'relaunch.log')) ? readFileSync(join(process.env.LOCALAPPDATA, 'Gamblium', 'relaunch.log'), 'utf8').length : 0;
    const r = spawnSync(exe, ['launch', '--user-data-dir', profile, '--debug-port', String(PORT)], { env, encoding: 'utf8' });
    const said = (r.stdout || '').split('\n').find((l) => /new extension code/.test(l)) || '';
    if (!/prepared in a hidden start \((reloaded|already new)/.test(said)) problems.push(`no hidden start for the new code (${said.trim() || 'nothing said'})`);
    if (!(await up())) return [...problems, 'the browser did not start after the hidden start'];
    await sleep(10000);
    const runB = existsSync(join(profile, 'gamblium-code-stamp')) ? readFileSync(join(profile, 'gamblium-code-stamp'), 'utf8').trim() : '';
    if (runB !== 'stamp-B') problems.push(`the window does not run the new code (${JSON.stringify(runB)})`);
    const log = existsSync(join(process.env.LOCALAPPDATA, 'Gamblium', 'relaunch.log')) ? readFileSync(join(process.env.LOCALAPPDATA, 'Gamblium', 'relaunch.log'), 'utf8').slice(logBefore) : '';
    if (log.includes(profile)) problems.push('the browser restarted itself anyway');
    const pages = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((x) => x.json()).catch(() => []);
    if (!pages.some((p) => /example\.com/.test(p.url))) problems.push('the saved page did not come back');
    return problems;
  } catch (e) {
    return [...problems, `the check itself failed: ${e.message}`];
  } finally {
    spawnSync(exe, ['close', '--user-data-dir', profile]);
    await sleep(2000);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const p = await codestampCheck();
  console.log(p.length ? `CODE STAMP CHECK FAILED:\n  ${p.join('\n  ')}` : 'CODE STAMP CHECK PASSED: new extension code was taken in a hidden start; the window ran it from the start, did not restart, and its page came back');
  process.exit(p.length ? 1 : 0);
}
