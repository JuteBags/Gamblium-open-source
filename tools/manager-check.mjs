// The Session manager as the owner described it (Nov 15 2026): Active sessions (this Gamblium
// first, then every open session with "Go to session"), Inactive sessions (stopped ones and saved
// tab sets that are not open), a filter All / Named / Unnamed / Saved tab sets, no "Named
// sessions" or "Tabs put away" boxes; the menu says "Session manager"; one click on "New
// isolated window" makes exactly one session, marked unnamed. Also run by tools/gate.mjs.
import { spawnSync, execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9365;
const EXT = 'chrome-extension://pbgbdlkcienglhbfadbjolphinilbpia';
const env = { ...process.env, GAMBLIUM_HOME: repo };
const cliExe = join(repo, 'target', 'release', 'gamblium-cli.exe');
const cli = (...a) => new Promise((res) => execFile(cliExe, a, { env, timeout: 120000 }, (e, out, err) => { try { res(JSON.parse(out)); } catch { res({ ok: false, error: (out + err).slice(0, 300) }); } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cdp(url, method, params = {}) {
  const ws = new WebSocket(url);
  await new Promise((r) => (ws.onopen = r));
  const a = new Promise((r) => (ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d); }));
  ws.send(JSON.stringify({ id: 1, method, params }));
  const o = await a;
  ws.close();
  return o.result;
}
const ev = async (u, expression) => (await cdp(u, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
const DOC = "([document, ...[...document.querySelectorAll('iframe')].map((f) => f.contentDocument)].find((d) => d && d.getElementById('activeRows')) || document)";

export async function managerCheck() {
  const problems = [];
  const exe = join(process.env.LOCALAPPDATA, 'Gamblium', 'app', 'gamblium.exe');
  const profile = mkdtempSync(join(tmpdir(), 'gamblium-mgr-'));
  const name = `gate manager ${Date.now().toString(36).slice(-5)}`;
  const made = [];
  const startedAt = Date.now();
  try {
    const s = await cli('create', name, '--window', '--test');
    if (s.ok !== true) return [`could not make a session window: ${s.error}`];
    made.push(s.session.id);
    // A page in it, so it has a tab to show.
    // open-url, as a person opens an address: an agent's command into a person's window waits
    // for the owner's yes (review 6, D2).
    const opened = await cli('open-url', `#${s.session.id}`, 'https://example.com/');
    if (opened.ok === false) problems.push(`open-url failed: ${opened.error}`);
    await sleep(4000);
    spawnSync(exe, ['launch', '--user-data-dir', profile, '--debug-port', String(PORT), '--', '--window-size=1280,900'], { env });
    for (let i = 0; i < 60; i++) { await sleep(500); if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then((x) => x.ok, () => false)) break; }
    await sleep(3000);
    const page = await fetch(`http://127.0.0.1:${PORT}/json/new?${EXT}/ui/sessions.html?tests`, { method: 'PUT' }).then((r) => r.json());
    await sleep(5000);
    const look = () => ev(page.webSocketDebuggerUrl, `(() => { const d = ${DOC}; const t = d.body.innerText;
      const rowsOf = (id) => [...d.querySelectorAll('#' + id + ' > li')].map((li) => ({ name: li.querySelector('h3')?.textContent || '', buttons: [...li.querySelectorAll('button')].map((b) => b.textContent.trim()) }));
      const own = d.getElementById('ownCard'), head = d.getElementById('activeHead');
      const grey = [...d.querySelectorAll('.tabicon img')].filter((i) => /grayscale/.test(getComputedStyle(i).filter)).length;
      const icons = (id) => [...d.querySelectorAll('#' + id + ' > li')].map((li) => ({ name: li.querySelector('h3')?.textContent || '', icons: li.querySelectorAll('.tabicon img').length }));
      return { ownFirst: !!(own && head && (own.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING)), activeCount: d.getElementById('activeCount')?.textContent || '', grey, activeIcons: icons('activeRows'), title: d.querySelector('h1')?.textContent, hasNamedBox: /Named sessions/.test(t), hasPutAway: /Tabs put away/.test(t), hasActive: /Active sessions/.test(t), hasInactive: /Inactive sessions/.test(t), own: !d.getElementById('ownCard').hidden, active: rowsOf('activeRows'), inactive: rowsOf('namedRows'), filters: [...d.querySelectorAll('#sfilter button')].map((b) => b.textContent) };
    })()`);
    let v = await look();
    if (v.title !== 'Session manager') problems.push(`the page is called "${v.title}", not "Session manager"`);
    if (v.hasNamedBox) problems.push('it still shows a "Named sessions" box');
    if (v.hasPutAway) problems.push('it still says "Tabs put away"');
    if (!v.hasActive || !v.hasInactive) problems.push('Active / Inactive sections missing');
    if (!v.own) problems.push('"This Gamblium" is not shown under Active');
    if (v.filters.join(',') !== 'All,Named,Unnamed,Saved tab sets') problems.push(`filters are ${v.filters.join(', ')}`);
    if (!v.ownFirst) problems.push('"This Gamblium" is not its own section above Active sessions');
    if (v.grey) problems.push(`${v.grey} tab icons are drawn grey`);
    const withIcons = v.activeIcons.find((r) => r.name === name);
    if (!withIcons || withIcons.icons === 0) problems.push('the open session shows none of its tabs');
    if (v.activeCount !== String(v.active.length) && !(v.active.length === 0 && v.activeCount === '')) problems.push(`Active sessions says ${v.activeCount} for ${v.active.length} open sessions (This Gamblium must not count)`);
    const act = v.active.find((r) => r.name === name);
    if (!act) problems.push('the open session is not under Active sessions');
    else if (!act.buttons.includes('Go to session')) problems.push(`the open session has no "Go to session" (buttons: ${act.buttons.join(', ')})`);
    if (v.inactive.some((r) => r.name === name)) problems.push('the open session is ALSO listed under Inactive');
    // Go to session works from the CLI path the button uses.
    const f = await cli('focus', `#${s.session.id}`);
    if (f.ok !== true) problems.push(`Go to session failed: ${f.error}`);
    // Stopped: it moves to Inactive.
    await cli('close', `#${s.session.id}`);
    await ev(page.webSocketDebuggerUrl, `location.reload()`);
    await sleep(5000);
    v = await look();
    if (v.active.some((r) => r.name === name)) problems.push('a stopped session is still under Active');
    if (!v.inactive.some((r) => r.name === name)) problems.push('a stopped session is not under Inactive');
    // A private window is an anonymous session: none of its tabs in This Gamblium, one line under Active.
    const madePrivate = await ev(page.webSocketDebuggerUrl, `chrome.windows.create({ incognito: true, url: 'https://example.org/?private-check' }).then(() => true, (e) => String(e))`);
    if (madePrivate !== true) problems.push(`could not open a private window for the check: ${madePrivate}`);
    else {
      await sleep(3000);
      await ev(page.webSocketDebuggerUrl, `location.reload()`);
      await sleep(5000);
      // innerText and a real width: the words must be on screen, not only in the page.
      const pv = await ev(page.webSocketDebuggerUrl, `(() => { const d = ${DOC}; return { own: d.getElementById('ownCard').innerText, anon: [...d.querySelectorAll('#activeRows h3')].filter((h) => h.getBoundingClientRect().width > 40).map((h) => h.innerText) }; })()`);
      if (/2 windows/.test(pv.own)) problems.push('the private window is counted in This Gamblium');
      if (!pv.anon.includes('Anonymous session')) problems.push('Active sessions does not show "Anonymous session" for the private window');
      const listed = await cli('list');
      if (JSON.stringify(listed).includes('private-check')) problems.push('gamblium-cli list shows a private tab');
    }
    // The Named filter hides "This Gamblium" and saved tab sets.
    await ev(page.webSocketDebuggerUrl, `(() => { const d = ${DOC}; d.querySelector('#sfilter [data-filter=named]').click(); })()`);
    await sleep(500);
    v = await look();
    if (v.own) problems.push('the Named filter still shows "This Gamblium"');
    // The menu.
    const menu = await fetch(`http://127.0.0.1:${PORT}/json/new?${EXT}/popup.html`, { method: 'PUT' }).then((r) => r.json());
    await sleep(2500);
    await ev(menu.webSocketDebuggerUrl, `[...document.querySelectorAll('.mrow.more')].find((b) => b.textContent.includes('Sessions'))?.click()`);
    await sleep(1500);
    // On a website the Gamblium button opens on Menu, not This site (owner, Nov 15 2026).
    await fetch(`http://127.0.0.1:${PORT}/json/new?https://example.com/`, { method: 'PUT' });
    await sleep(2500);
    await ev(menu.webSocketDebuggerUrl, `chrome.tabs.query({ url: 'https://example.com/*' }).then(([t]) => { location.search = '?tab=' + t.id; })`);
    await sleep(2500);
    const startView = await ev(menu.webSocketDebuggerUrl, `(() => { const v = document.getElementById('viewMenu'); return v && !v.hidden && !document.getElementById('site').hidden ? 'menu' : (v && !v.hidden ? 'menu-without-site' : 'other'); })()`);
    if (startView !== 'menu') problems.push('the Gamblium button does not open on Menu');
    await ev(menu.webSocketDebuggerUrl, `[...document.querySelectorAll('.mrow.more')].find((b) => b.textContent.includes('Sessions'))?.click()`);
    await sleep(1500);
    const labels = await ev(menu.webSocketDebuggerUrl, `(() => { const g = (k) => [...document.querySelectorAll('.mrow')].find((b) => b.dataset.go === k)?.querySelector('span')?.textContent; return [g('window'), g('isolated'), g('forked')]; })()`);
    if (labels.join('|') !== 'New window|New session window|Forked session window') problems.push(`menu says ${labels.join(' / ')}`);
    // The flyout asks the helper first (sessions and which browser this is): up to 6 s.
    let first = '';
    for (let i = 0; i < 12 && !first; i++) {
      first = await ev(menu.webSocketDebuggerUrl, `[...document.querySelectorAll('.mrow')].map((b) => b.textContent.trim()).find((t) => /Session manager|All sessions/.test(t)) || ''`);
      if (!first) await sleep(500);
    }
    if (first !== 'Session manager') problems.push(`the Sessions flyout says "${first}"`);
    if ((await cli('list')).sessions.some((x) => String(x.name).startsWith('.'))) problems.push('a folder that is not a session (.components) is listed as a session');
    // One click on New isolated window makes exactly one session, marked unnamed (twice clicked fast).
    const before = (await cli('list')).sessions.map((x) => x.id);
    await ev(menu.webSocketDebuggerUrl, `location.reload()`);
    await sleep(2000);
    await ev(menu.webSocketDebuggerUrl, `(() => { const b = [...document.querySelectorAll('.mrow')].find((x) => x.dataset.go === 'isolated'); b.click(); b.click(); })()`);
    let fresh = [];
    for (let i = 0; i < 40 && fresh.length === 0; i++) { await sleep(1000); fresh = (await cli('list')).sessions.filter((x) => !before.includes(x.id)); }
    await sleep(6000);
    fresh = (await cli('list')).sessions.filter((x) => !before.includes(x.id));
    // Only what this run made: new, and created after the check began. Anything else is the owner's.
    // Made during this run: a creation time after the start, or (made by an older helper that
    // does not record one) a menu-made name whose time is after the start.
    const nameTime = (n) => { const m = /^Window \d+ \w+ (\d\d)\.(\d\d)\.(\d\d)$/.exec(n || ''); if (!m) return 0; const d = new Date(); d.setHours(+m[1], +m[2], +m[3], 0); return d.getTime(); };
    const ours = (x) => x.createdAt >= startedAt || (x.named === false && nameTime(x.name) >= startedAt - 1000);
    const strangers = fresh.filter((x) => !ours(x));
    if (strangers.length) problems.push(`sessions that are not this check's look new: ${strangers.map((x) => x.name).join(', ')} (left alone)`);
    fresh = fresh.filter(ours);
    made.push(...fresh.map((x) => x.id));
    if (fresh.length !== 1) problems.push(`a double click on "New isolated window" made ${fresh.length} sessions`);
    else if (fresh[0].named !== false) problems.push('the isolated window\'s session is not marked unnamed');
    return problems;
  } catch (e) {
    return [`the check itself failed: ${e.message}`];
  } finally {
    spawnSync(exe, ['close', '--user-data-dir', profile]);
    for (const id of made) await cli('delete', `#${id}`);
    await sleep(2500);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const p = await managerCheck();
  console.log(p.length ? `MANAGER CHECK FAILED:\n  ${p.join('\n  ')}` : 'MANAGER CHECK PASSED');
  process.exit(p.length ? 1 : 0);
}
