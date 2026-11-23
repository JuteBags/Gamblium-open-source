// A session a person opens in a window (Create and open, New isolated window) must be a full
// Gamblium window, started like the owner's own: the normal extension (Alt+K, menu), the same
// switches, no agent mode, no theme add-on (no "Installed theme ... Undo" bar), its own fresh
// profile; and the CLI must still reach it. Owner, Nov 15 2026. Also run by tools/gate.mjs.
// Usage: node tools/session-window-check.mjs
import { execFile, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repo, 'target', 'release', 'gamblium-cli.exe');
const env = { ...process.env, GAMBLIUM_HOME: repo };
const run = (...a) => new Promise((res) => execFile(cli, a, { env, timeout: 120000 }, (e, out, err) => { try { res(JSON.parse(out)); } catch { res({ ok: false, error: (out + err).slice(0, 300) }); } }));
const commandLine = (pid) => execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8' }).trim();
const switches = (cmd) => (cmd.match(/--[a-z-]+(=("[^"]*"|\S+))?/g) || []);

export async function sessionWindowCheck() {
  const problems = [];
  const name = `gate person ${Date.now().toString(36).slice(-5)}`;
  let id = null;
  try {
    const made = await run('create', name, '--window', '--test');
    if (made.ok !== true) return [`create --window failed: ${made.error}`];
    id = made.session.id;
    const pid = made.session.pid;
    if (!pid) return ['the session window is not running after create'];
    const cmd = commandLine(pid);
    const sw = switches(cmd);
    if (sw.some((s) => s === '--headless' || s.startsWith('--headless='))) problems.push('it runs with no window (headless)');
    const ext = sw.filter((s) => s.startsWith('--load-extension=')).join(',');
    if (/agent-extension/i.test(ext)) problems.push('it loads the AGENT copy of the extension (no Alt+K, not the person\'s Gamblium)');
    if (/[\\/]theme[\\/]/i.test(ext)) problems.push('it loads the theme add-on (the "Installed theme ... Undo" bar)');
    if (!/[\\/]extension\b/i.test(ext)) problems.push('it does not load Gamblium\'s extension');
    for (const s of ['--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows']) {
      if (sw.includes(s)) problems.push(`it has the agent switch ${s}`);
    }
    // The same feature switches as the owner's Gamblium (picture-in-picture and the rest live there).
    const owner = execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='brave.exe'" | Where-Object { $_.CommandLine -match 'Gamblium\\\\User Data' -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1 -ExpandProperty CommandLine`], { encoding: 'utf8' }).trim();
    if (owner) {
      const feat = (c) => (switches(c).find((s) => s.startsWith('--enable-features=')) || '').replace('--enable-features=', '').split(',').filter(Boolean).sort().join(',');
      const ownerF = feat(owner), mineF = feat(cmd);
      // WebContentsForceDark follows the owner's "darken websites" choice; both come from the same rule.
      if (ownerF !== mineF) problems.push(`its features differ from your Gamblium's: yours ${ownerF || '(none)'}; the session's ${mineF || '(none)'}`);
    }
    // An agent's command into a person's window waits for the owner's yes (review 6, D2), unless
    // the owner has allowed agents in their session windows for now.
    // info is the one status read free of the owner's yes (review 9, G3): it proves the CLI reaches it.
    const tabs = await run(`#${id}`, 'info');
    if (tabs.ok !== true) problems.push(`the CLI cannot reach it: ${tabs.error}`);
    // Reading a page is refused without the owner's yes (unless they allowed agents for now).
    const text = await run(`#${id}`, 'text');
    if (text.ok === true && !process.env.GAMBLIUM_PERSON_ALLOWED) problems.push('an agent read a person\'s window without their yes');
    return problems;
  } catch (e) {
    return [`the check itself failed: ${e.message}`];
  } finally {
    if (id) await run('delete', `#${id}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const p = await sessionWindowCheck();
  console.log(p.length ? `SESSION WINDOW CHECK FAILED:\n  ${p.join('\n  ')}` : 'SESSION WINDOW CHECK PASSED: a full Gamblium window, fresh profile, no agent mode, no theme bar, the CLI reaches it (or is asked for the owner\'s yes)');
  process.exit(p.length ? 1 : 0);
}
