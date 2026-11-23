// The gate before anything is installed to the owner's Gamblium (owner, Nov 15 2026: "I cannot
// check everything manually"). Unit tests check pieces; this checks the real thing:
//   1. every unit test (extension, pages, new tab, Rust),
//   2. a throwaway Gamblium with THIS checkout's extension: the background worker must start and
//      answer, and every page of ours must load with no uncaught error and no console error,
//   3. pages that must show data actually show it (Tabs and memory lists tabs, Sessions answers).
// Exit 0 only if all pass. Usage: node tools/gate.mjs [--skip-unit]
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { cleanUpAlways } from './test-cleanup.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = 'chrome-extension://pbgbdlkcienglhbfadbjolphinilbpia';
const PORT = 9361;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const fail = (what, why) => { failures.push(`${what}: ${why}`); console.log(`  FAIL ${what}: ${why}`); };
const pass = (what) => console.log(`  ok   ${what}`);

// Test leftovers (browsers, folders, test sessions) removed now, at the end and on any crash.
cleanUpAlways();

// ---- 0. the programs are built from this checkout (a stale exe once ran old code in a check)
console.log('build');
{
  const b = spawnSync('cargo', ['build', '--release'], { encoding: 'utf8', cwd: repo });
  if (b.status !== 0) {
    fail('build', (b.stderr || '').split('\n').filter((l) => /^error/.test(l)).slice(0, 3).join('; ') || 'cargo build failed');
    console.log('\nGATE FAILED: the programs do not build. Do not install.');
    process.exit(1);
  }
  pass('programs built from this checkout');
}

// ---- 1. unit tests
if (!process.argv.includes('--skip-unit')) {
  console.log('unit tests');
  // Every .test.mjs under extension/ and tools/ (content/ and pdf/ were left out; review 2, 4.3).
  const tests = [];
  const walk = (d) => { for (const e of readdirSync(join(repo, d), { withFileTypes: true })) { if (e.isDirectory()) { if (!['node_modules', 'engine'].includes(e.name)) walk(join(d, e.name)); } else if (e.name.endsWith('.test.mjs')) tests.push(join(repo, d, e.name)); } };
  walk('extension');
  walk('tools');
  const node = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...tests], { encoding: 'utf8', cwd: repo });
  const m = /ℹ fail (\d+)/.exec(node.stdout);
  if (!m || m[1] !== '0') fail('extension unit tests', (node.stdout.match(/not ok .*/g) || ['no summary']).join('; '));
  else pass(`extension unit tests (${/ℹ pass (\d+)/.exec(node.stdout)?.[1]} passed)`);
  const cargo = spawnSync('cargo', ['test', '--release', '-q', '--workspace'], { encoding: 'utf8', cwd: repo });
  const pdf = spawnSync('cargo', ['test', '--release', '-q'], { encoding: 'utf8', cwd: join(repo, 'crates', 'gamblium-pdf') });
  if (pdf.status !== 0) fail('PDF engine tests', (pdf.stdout + pdf.stderr).split('\n').filter((l) => /FAILED|panicked|error/.test(l)).slice(0, 5).join('; '));
  if (cargo.status !== 0) fail('Rust tests', (cargo.stdout + cargo.stderr).split('\n').filter((l) => /FAILED|panicked|error/.test(l)).slice(0, 5).join('; '));
  else pass('Rust tests');
}

// ---- 2. a real browser with this checkout's extension
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } else if (d.method) events.push(d);
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  return { send, events, close: () => ws.close() };
}
const evaluate = async (c, expression) => (await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

const exe = join(process.env.LOCALAPPDATA, 'Gamblium', 'app', 'gamblium.exe');
const profile = mkdtempSync(join(tmpdir(), 'gamblium-gate-'));
const env = { ...process.env, GAMBLIUM_HOME: repo };
console.log('real browser (throwaway profile, this checkout\'s extension)');
try {
  spawnSync(exe, ['launch', '--user-data-dir', profile, '--debug-port', String(PORT), '--', '--window-size=1280,860'], { env });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(500); up = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((x) => x.ok, () => false); }
  if (!up) throw new Error('the browser did not start');
  await sleep(3000);
  for (const u of ['https://example.com/', 'https://example.org/']) await fetch(`http://127.0.0.1:${PORT}/json/new?${u}`, { method: 'PUT' });
  await sleep(2000);
  const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
  const sw = targets.find((t) => t.type === 'service_worker' && t.url.startsWith(EXT));
  if (!sw) fail('background worker', 'not running');
  else pass('background worker running');

  const pages = ['popup.html', ...readdirSync(join(repo, 'extension', 'ui')).filter((f) => f.endsWith('.html')).map((f) => `ui/${f}`), 'newtab/index.html'];
  for (const page of pages) {
    const t = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
    const c = await connect(t.webSocketDebuggerUrl);
    await c.send('Runtime.enable');
    await c.send('Log.enable');
    await c.send('Page.enable');
    await c.send('Page.navigate', { url: `${EXT}/${page}` });
    await sleep(3500);
    // Not judged on a page still loading: its body must have something in it (review 2, 4.4).
    const filled = await evaluate(c, `(document.body?.innerText || '').trim().length`).catch(() => 0);
    if (!filled) { await sleep(3000); }
    // Still nothing in it (in the page or its frame): that is a failure, not a pass (review 9, G14).
    const stillEmpty = !(await evaluate(c, `[document, ...[...document.querySelectorAll('iframe')].map((f) => f.contentDocument)].some((d) => d && d.body && d.body.innerText.trim().length > 0)`).catch(() => false));
    // Errors thrown a little later (helper answers, timers) are seen too.
    await sleep(1500);
    const errors = c.events
      .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && !/favicon|net::ERR_/.test(e.params.entry.text || '')))
      .map((e) => e.params.exceptionDetails?.exception?.description?.split('\n')[0] || e.params.exceptionDetails?.text || e.params.args?.map((a) => a.value ?? a.description).join(' ') || e.params.entry?.text);
    // The download card's own page shows only when given a download (?id=): empty alone by design.
    if (stillEmpty && page !== 'ui/dl-card.html') fail(page, 'the page stayed empty');
    else if (errors.length) fail(page, errors.slice(0, 3).join(' | '));
    else pass(`${page} loads with no error`);
    // Pages that must show data.
    if (page === 'ui/dashboard.html') {
      await sleep(3000);
      const DOC = "([...document.querySelectorAll('iframe')].map((f) => f.contentDocument).find((d) => d && d.getElementById('rows')) || document)";
      const rows = await evaluate(c, `${DOC}.querySelectorAll('#rows > *').length`);
      const mem = await evaluate(c, `${DOC}.getElementById('fMem')?.textContent || ''`);
      if (!rows) fail('Tabs and memory', `lists no tabs; page says: ${JSON.stringify((await evaluate(c, `document.querySelector('main')?.innerText || ''`)).replace(/\s+/g, ' ').slice(0, 300))}; later events: ${c.events.filter((e) => /exception|console/.test(e.method)).map((e) => e.params.exceptionDetails?.exception?.description?.split('\n')[0] || (e.params.args || []).map((a) => a.value ?? a.description).join(' ')).slice(0, 3).join(' | ')}`);
      else if (!/\d/.test(mem)) fail('Tabs and memory', `no memory figure (${JSON.stringify(mem)})`);
      else pass(`Tabs and memory lists ${rows} tabs, uses ${mem}`);
    }
    if (page === 'ui/sessions.html') {
      // An error said on the page fails, and so does a page that shows nothing: its Active and
      // Inactive sections are drawn once the lists are read (review 2, 4.4).
      // Given up to 10 s more: the lists wait on the helper, slower when memory is short.
      let said = 'the lists are not shown';
      for (let i = 0; i < 20 && said === 'the lists are not shown'; i++) {
        // The page is drawn inside a frame of the page shell: its own document is the one read.
        said = await evaluate(c, `(() => { const d = [document, ...[...document.querySelectorAll('iframe')].map((f) => f.contentDocument)].find((x) => x && x.getElementById('activeRows')) || document; const t = d.body ? d.body.innerText : ''; const panel = d.getElementById('named'); return t.includes('could not be read') ? 'error shown' : (panel && !panel.hidden) ? 'ok' : 'the lists are not shown'; })()`);
        if (said === 'the lists are not shown') await sleep(500);
      }
      if (said !== 'ok') fail('Sessions', said); else pass('Sessions reads its lists');
    }
    if (page === 'popup.html') {
      // Rows with words in them, not empty shells (review 2, 4.4).
      const rows = await evaluate(c, `[...document.querySelectorAll('.mrow')].filter((r) => r.innerText.trim().length > 1).length`);
      if (!rows) fail('menu', 'no rows with text'); else pass(`menu has ${rows} rows`);
    }
    c.close();
    await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
  }
} catch (e) {
  fail('browser run', e.message);
} finally {
  spawnSync(exe, ['close', '--user-data-dir', profile]);
  await sleep(2500);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}

// ---- 3. behaviour the owner hit (each a check of its own, in its own throwaway browser)
console.log('behaviour checks');
{
  const { sessionWindowCheck } = await import('./session-window-check.mjs');
  const p = await sessionWindowCheck();
  if (p.length) fail('session window', p.join('; '));
  else pass('session window: full Gamblium window, fresh, no agent mode, no theme bar, CLI reaches it');
}
{
  // Parts of this go through the INSTALLED helper (the browser's native host): run it again after install.
  const { managerCheck } = await import('./manager-check.mjs');
  const p = (await managerCheck()).filter((x) => !(process.argv.includes('--pre-install') && /marked unnamed/.test(x)));
  if (p.length) fail('Session manager', p.join('; '));
  else pass('Session manager: Active / Inactive, Go to session, filters, menu label, one click = one session');
}
{
  const { pdfCheck } = await import('./pdf-check.mjs');
  const p = await pdfCheck();
  if (p.length) fail('Gamblium PDF', p.join('; '));
  else pass('Gamblium PDF: a PDF from a site opens in it, pages drawn and on screen, watermark, highlight, organize, delete, undo, merge; attachments stay downloads');
}
{
  // Built into the installed rebranded copy (gamblium rebrand, extra.py step 7), when it is.
  const { builtinCheck } = await import('./pdf-builtin-check.mjs');
  const p = await builtinCheck();
  if (p.length === 1 && /has no built-in Gamblium PDF/.test(p[0])) console.log(`  (${p[0]})`);
  else if (p.length) fail('Gamblium PDF built in', p.join('; '));
  else pass("Gamblium PDF built in: a site's PDF and a file open in it with their own address; switched off, the browser's viewer");
}
{
  const { packCheck } = await import('./pack-check.mjs');
  const p = packCheck();
  if (p.length) fail('Packing', p.join('; '));
  else pass('Packing: a profile packs and unpacks byte for byte (a file over 8 MB included)');
}
{
  const { pdfSleepCheck } = await import('./pdf-sleep-check.mjs');
  const p = await pdfSleepCheck();
  if (p.length) fail('Gamblium PDF and sleep', p.join('; '));
  else pass('Gamblium PDF and sleep: a changed PDF put to sleep comes back with its change, Undo shows the original, Download ends the draft');
}
{
  const { pwSuggestCheck } = await import('./pwsuggest-check.mjs');
  const r = await pwSuggestCheck();
  if (r.problems.length) fail('Suggest a strong password', r.problems.join('; '));
  else pass('Suggest a strong password: right-click on a password field fills both fields, card shows it and covers nothing');
}
{
  const { restartCheck } = await import('./restart-check.mjs');
  const p = await restartCheck();
  if (p.length) fail('restart after an update', p.join('; '));
  else pass('restart after an update: the browser closes and comes back on the same profile');
}
{
  const { pipCheck } = await import('./pip-check.mjs');
  const p = await pipCheck();
  if (p.length) fail('pop-out video window', p.join('; '));
  else pass('pop-out video window: plays there, captions in proportion, Background keeps the sound, close pauses');
}
{
  const { restoreSleepCheck } = await import('./restore-sleep-check.mjs');
  const p = await restoreSleepCheck();
  if (p.length) fail('restored tabs asleep', p.join('; '));
  else pass('restored tabs asleep: after a restart only the tab in front loads');
}
{
  const { codestampCheck } = await import('./codestamp-check.mjs');
  const p = await codestampCheck();
  if (p.length) fail('new extension code before the window', p.join('; '));
  else pass('new extension code before the window: taken in a hidden start, no restart, pages back');
}
const { pinCheck } = await import('./pin-check.mjs');
for (const same of [false, true]) {
  const where = same ? 'pinned site, new tab beside the open one' : 'pinned site, new window';
  const p = await pinCheck(same);
  if (p.length) fail(where, p.join('; '));
  else pass(`${where}: opens there, nothing closed`);
}

console.log(failures.length ? `\nGATE FAILED: ${failures.length} problem(s). Do not install.` : '\nGATE PASSED');
process.exit(failures.length ? 1 : 0);
