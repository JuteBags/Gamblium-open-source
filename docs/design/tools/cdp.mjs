// Shared helpers for the design checks. Rules every script here follows:
//   1. A run always closes its browser, pass or fail (withBrave does it in finally).
//   2. Never start on a folder that already has a Brave running.
//   3. One window at a time, and a fresh throwaway folder per run. Fresh folders
//      live under the OS temp directory and are deleted after the run.
//   4. Never bring a test window to the front or send it keystrokes.
// The owner's real profile is never touched: startBrave refuses any folder that
// is not under the temp directory.
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The one build everybody tests on (backend, Nov 12 2026): the installed programs in
// %LOCALAPPDATA%\Gambliumpp and the rebranded browser the launcher starts. A test
// never starts brave.exe itself and never passes --official; `gamblium launch` picks
// the browser, writes the First Run file and the presets, and loads the extension
// from GAMBLIUM_HOME, which is this worktree, so the branch under test is what runs.
export const GAMBLIUM = process.env.GAMBLIUM_EXE ?? path.join(process.env.LOCALAPPDATA ?? '', 'Gamblium', 'app', 'gamblium.exe');
export const HOME = process.env.GAMBLIUM_HOME ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
if (!fs.existsSync(GAMBLIUM)) throw new Error(`Gamblium is not installed at ${GAMBLIUM}. The backend session runs \`gamblium install\`.`);
const here = path.dirname(fileURLToPath(import.meta.url));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ps = (command) => execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' }).trim();
const isTemp = (dir) => path.resolve(dir).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase() + path.sep);

/** Process ids of Brave browser processes (not their children) started on this folder. */
export function bravePidsOn(profile) {
  const needle = path.resolve(profile).replace(/'/g, "''");
  const out = ps(
    `Get-CimInstance Win32_Process -Filter "Name='brave.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { $_.ProcessId }`,
  );
  return out ? out.split(/\s+/).map(Number) : [];
}

const setDotted = (root, key, value) => {
  const parts = key.split('.');
  let node = root;
  for (const p of parts.slice(0, -1)) {
    if (typeof node[p] !== 'object' || node[p] === null || Array.isArray(node[p])) node[p] = {};
    node = node[p];
  }
  node[parts.at(-1)] = value;
};

/** A new, empty folder under the temp directory. The launcher fills it. */
export function freshProfile(tag = 'run') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gamblium-design-${tag}-`));
}

/**
 * Starts Gamblium on a throwaway folder through the installed launcher.
 * `presets` are file paths as before: a theme-<name>.json becomes --theme <name>;
 * debloat and new-profile are the launcher's own; anything else is laid over
 * with --preset-file. Switches that only made the unbranded browser load our
 * extension are dropped: the launcher loads it from HOME.
 */
export function startBrave({ profile, port, presets = [], args = [] }) {
  if (!isTemp(profile)) throw new Error(`throwaway profiles only: ${profile} is not under ${os.tmpdir()}`);
  if (bravePidsOn(profile).length) throw new Error(`a browser is already running on ${profile}`);
  const opts = ['launch', '--user-data-dir', profile, '--debug-port', String(port)];
  for (const file of presets) {
    const name = path.basename(file, '.json');
    if (name.startsWith('theme-')) opts.push('--theme', name.slice(6));
    else if (name !== 'debloat' && name !== 'new-profile') opts.push('--preset-file', file);
  }
  const extra = args.filter((a) => !a.startsWith('--load-extension=') && a !== '--disable-features=DisableLoadExtensionCommandLineSwitch');
  // CalculateNativeWinOcclusion off only so a covered window still paints for the screenshot.
  opts.push('--', '--window-size=1360,860', '--window-position=80,60', '--disable-features=CalculateNativeWinOcclusion', ...extra);
  const said = execFileSync(GAMBLIUM, opts, { env: { ...process.env, GAMBLIUM_HOME: HOME }, encoding: 'utf8', timeout: 60000 });
  // The launcher falls back to the unbranded browser when the copy is stale. A test must not run on that.
  if (!/rebranded copy/i.test(said)) {
    try {
      execFileSync(GAMBLIUM, ['close', '--user-data-dir', profile], { stdio: 'ignore', timeout: 20000 });
    } catch {}
    throw new Error(`The launcher did not start the rebranded browser. Tell the backend session. It said:
${said.slice(0, 600)}`);
  }
  for (let i = 0; i < 20; i++) {
    const pids = bravePidsOn(profile);
    if (pids.length) return pids[0];
    execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 400']);
  }
  throw new Error('the browser did not start');
}

export async function connect(port, tries = 60) {
  let info;
  for (let i = 0; i < tries; i++) {
    try {
      info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!info) throw new Error('no debugging port');
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    });
  return {
    info,
    send,
    async open(url) {
      const { targetId } = await send('Target.createTarget', { url });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      return { targetId, sessionId };
    },
    async evalIn(sessionId, expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    },
    /** Runs a function inside the page and returns its JSON-serialisable result. */
    async call(sessionId, fn, ...args) {
      return this.evalIn(sessionId, `(${fn})(${args.map((a) => JSON.stringify(a)).join(',')})`);
    },
    async pages() {
      return (await send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page');
    },
    async pageShot(sessionId, file) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
    },
    async closeBrowser() {
      try {
        await send('Browser.close');
      } catch {}
      try {
        ws.close();
      } catch {}
    },
    ws,
  };
}

export async function waitExit(pid, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(300);
  }
  return false;
}

/** Closes the test browser for certain: ask it, then the launcher's close, then stop the process. */
export async function closeBrave(b, pid, profile) {
  if (b) await b.closeBrowser();
  if (pid && (await waitExit(pid, 8000))) return 'closed';
  if (fs.existsSync(GAMBLIUM)) {
    try {
      execFileSync(GAMBLIUM, ['close', '--user-data-dir', profile], { stdio: 'ignore', timeout: 20000 });
    } catch {}
    if (!bravePidsOn(profile).length) return 'closed by gamblium close';
  }
  for (const p of bravePidsOn(profile)) {
    try {
      process.kill(p);
    } catch {}
  }
  await sleep(1000);
  return bravePidsOn(profile).length ? 'STILL RUNNING' : 'stopped';
}

/**
 * Starts Gamblium (the rebranded build) on a fresh folder, runs `fn`, and always closes and removes it.
 *   await withBrave({ presets, args, tag }, async ({ b, pid, profile }) => { ... })
 */
export async function withBrave({ presets = [], args = [], tag = 'run', keep = false }, fn) {
  const profile = freshProfile(tag);
  const port = 9400 + Math.floor(Math.random() * 400);
  let b;
  let pid;
  try {
    pid = startBrave({ profile, port, presets, args });
    b = await connect(port);
    return await fn({ b, pid, profile });
  } finally {
    const how = await closeBrave(b, pid, profile);
    console.log('browser', how);
    if (how === 'STILL RUNNING') process.exitCode = 1;
    else if (!keep) {
      for (let i = 0; i < 5; i++) {
        try {
          fs.rmSync(profile, { recursive: true, force: true });
          break;
        } catch {
          await sleep(700); // Brave's helpers can hold files for a moment after exit
        }
      }
    } else console.log('kept', profile);
  }
}

/** Photograph of the real window (toolbar included), even when it is covered. */
export function winshot(pid, out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'winshot.ps1'), '-ProcessId', String(pid), '-Out', out],
    { encoding: 'utf8' },
  ).trim();
}

/** Drives Brave's own interface through UI Automation; never takes focus. */
export function uia(pid, action, text = '') {
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'uia-act.ps1'), '-ProcessId', String(pid), '-Action', action, '-Text', text],
      { encoding: 'utf8', timeout: 40000 },
    ).trim();
  } catch (e) {
    return 'uia failed: ' + ((e.stdout || '') + (e.stderr || e.message)).trim().slice(0, 200);
  }
}

/** Splits `a b c -- x y` into [['a','b','c'], ['x','y']]. */
export function splitArgs(argv) {
  const cut = argv.indexOf('--');
  return cut < 0 ? [argv, []] : [argv.slice(0, cut), argv.slice(cut + 1)];
}
