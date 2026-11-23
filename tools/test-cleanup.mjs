// Leftovers of test runs, removed (owner, Nov 16 2026: a crashed gate left two test windows open,
// their folders and a test session behind). Run by the gate at its start, at its end and when it
// crashes or is stopped; also by hand: `node tools/test-cleanup.mjs`.
//
// Only what the test scripts make is touched:
//   - browsers whose --user-data-dir is a folder in TEMP named with a test prefix (below): stopped;
//   - those folders: deleted (with retries while Windows still holds files);
//   - named sessions whose note says "test": true: deleted through gamblium's own CLI.
// The owner's profile, their sessions and other sessions' work folders never match.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// Every prefix a test script passes to mkdtempSync (tools/*.mjs). Not 'gamblium-publish-'
// (publish-public's work tree) and nothing of the design session's.
export const TEST_PREFIXES = [
  'gamblium-gate-', 'gamblium-mgr-', 'gamblium-pdfbi-', 'gamblium-pdfbif-', 'gamblium-pdfchk-', 'gamblium-pdfedit-',
  'gamblium-pdffile-', 'gamblium-pdfsleep-', 'gamblium-pin-', 'gamblium-pip-', 'gamblium-private-', 'gamblium-pws-',
  'gamblium-restore-', 'gamblium-rst-', 'gamblium-stamp-', 'gamblium-stamphome-', 'gamblium-packchk-',
  'gamblium-handover-', 'gamblium-gputrace-', 'gamblium-winback-', 'gamblium-autohold-', 'gamblium-fontperm-', 'gamblium-pgdbg-',
];
const isTestFolder = (dir) => {
  const d = String(dir || '').replace(/[\\/]+$/, '');
  const tmp = tmpdir().replace(/[\\/]+$/, '').toLowerCase();
  const parent = d.slice(0, Math.max(d.lastIndexOf('\\'), d.lastIndexOf('/'))).toLowerCase();
  return parent === tmp && TEST_PREFIXES.some((p) => basename(d).toLowerCase().startsWith(p));
};

/** Browser processes (main ones) on a test folder: [{ pid, dir }]. */
function testBrowsers() {
  const ps = spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"name='brave.exe'\" | ? { $_.CommandLine -notmatch '--type=' } | % { \"$($_.ProcessId)`t$($_.CommandLine)\" }"],
  { encoding: 'utf8', windowsHide: true });
  const out = [];
  for (const line of (ps.stdout || '').split(/\r?\n/)) {
    const [pid, cmd = ''] = line.split('\t');
    const m = cmd.match(/--user-data-dir=(?:"([^"]+)"|(\S+))/);
    const dir = m && (m[1] || m[2]);
    if (pid && dir && isTestFolder(dir)) out.push({ pid: Number(pid), dir: dir.replace(/[\\/]+$/, '') });
  }
  return out;
}

/** Stops test browsers, deletes test folders and test sessions. Synchronous (safe in 'exit'). */
export function sweepTestLeftovers({ quiet = false } = {}) {
  const said = [];
  for (const b of testBrowsers()) {
    spawnSync('taskkill', ['/PID', String(b.pid), '/T', '/F'], { windowsHide: true });
    said.push(`stopped a test browser (${basename(b.dir)})`);
  }
  if (said.length) spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 2500'], { windowsHide: true });
  for (const e of readdirSync(tmpdir(), { withFileTypes: true })) {
    const full = join(tmpdir(), e.name);
    if (!e.isDirectory() || !isTestFolder(full)) continue;
    try {
      rmSync(full, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      said.push(`removed ${e.name}`);
    } catch (err) {
      said.push(`could not remove ${e.name} (${err.code})`);
    }
  }
  // Test sessions: notes with "test": true, deleted the way the CLI deletes any session.
  const local = process.env.LOCALAPPDATA;
  const sessions = local && join(local, 'Gamblium', 'sessions');
  const exe = local && join(local, 'Gamblium', 'app', 'gamblium.exe');
  if (sessions && existsSync(sessions) && existsSync(exe)) {
    for (const id of readdirSync(sessions)) {
      let note = null;
      try { note = JSON.parse(readFileSync(join(sessions, id, 'gamblium-session.json'), 'utf8')); } catch { continue; }
      if (note && note.test === true) {
        spawnSync(exe, ['cli', 'delete', id], { windowsHide: true, encoding: 'utf8' });
        said.push(`deleted test session ${note.name || id}`);
      }
    }
  }
  if (!quiet) for (const s of said) console.log(`  cleanup: ${s}`);
  return said;
}

/** At the start, at the end, and on a crash or Ctrl+C. */
export function cleanUpAlways() {
  sweepTestLeftovers();
  let done = false;
  const once = () => { if (!done) { done = true; try { sweepTestLeftovers(); } catch { /* best effort */ } } };
  process.on('exit', once);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => { once(); process.exit(130); });
  process.on('uncaughtException', (e) => { console.error(e); once(); process.exit(1); });
  process.on('unhandledRejection', (e) => { console.error(e); once(); process.exit(1); });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const said = sweepTestLeftovers({ quiet: true });
  console.log(said.length ? said.join('\n') : 'nothing left over from tests');
}
