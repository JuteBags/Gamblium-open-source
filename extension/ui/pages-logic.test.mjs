import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtMb, fmtPct, fmtSize, fmtAgo, fmtDelay, clampInt, hostOf, countStates, statesLine, stateShares, tabPill, sortTabs,
  meterPct, weightOf, freeLevel, cpuLevel, kindRows, siteLabel, sessionFrom, reasonRows, cleanHost, parseHosts, hostListed, toggleHost, checkpointName, sessionSize, savedLine,
  restoredLine, exportFileName, downloadView, anyInProgress, ruleFromFields, rulesFromRows, proxyLocked, bridgeLine,
} from './pages-logic.js';

test('numbers read the way a person says them', () => {
  assert.equal(fmtMb(512.4), '512 MB');
  assert.equal(fmtMb(1536), '1.5 GB');
  assert.equal(fmtMb(null), '–');
  assert.equal(fmtPct(3.44), '3.4%');
  assert.equal(fmtPct(null), '–');
  assert.equal(fmtSize(999), '999 B');
  assert.equal(fmtSize(524288000), '524.3 MB');
  assert.equal(fmtSize(2.5e9), '2.50 GB');
  assert.equal(fmtDelay(600), '10 min');
  assert.equal(fmtDelay(90), '90 s');
  assert.equal(fmtDelay(7200), '2 h');
});

test('ages go from "just now" to a date', () => {
  const now = Date.UTC(2026, 10, 11, 12);
  assert.equal(fmtAgo(now - 5000, now), 'just now');
  assert.equal(fmtAgo(now - 5 * 60000, now), '5 min ago');
  assert.equal(fmtAgo(now - 3 * 3600000, now), '3 h ago');
  assert.equal(fmtAgo(now - 86400000, now), '1 day ago');
  assert.equal(fmtAgo(now - 30 * 86400000, now), '2026-10-12');
});

test('a typed number is kept inside its limits', () => {
  assert.equal(clampInt('5', 1, 1440, 10), 5);
  assert.equal(clampInt('0', 1, 1440, 10), 1);
  assert.equal(clampInt('99999', 1, 1440, 10), 1440);
  assert.equal(clampInt('', 1, 1440, 10), 10);
  assert.equal(clampInt('abc', 1, 1440, 10), 10);
});

test('tabs are counted by state, from rows or from browser tabs', () => {
  const c = countStates([{ state: 'awake' }, { discarded: true }, { frozen: true }, { frozen: true }]);
  assert.deepEqual(c, { total: 4, awake: 1, frozen: 2, asleep: 1 });
  assert.equal(statesLine(c), '4 tabs · 1 awake · 2 frozen · 1 asleep');
  assert.equal(statesLine({ total: 1, awake: 1, frozen: 0, asleep: 0 }), '1 tab · 1 awake');
  const s = stateShares({ total: 3, awake: 1, frozen: 1, asleep: 1 });
  assert.equal(s.awake + s.frozen + s.asleep, 100);
  assert.deepEqual(stateShares({ total: 0, awake: 0, frozen: 0, asleep: 0 }), { awake: 0, frozen: 0, asleep: 0 });
});

test('only a tab in use gets a coloured pill', () => {
  assert.deepEqual(tabPill({ state: 'awake', active: true }), { text: 'showing', cls: 'now' });
  assert.deepEqual(tabPill({ state: 'awake', audible: true }), { text: 'playing', cls: 'now' });
  assert.deepEqual(tabPill({ state: 'awake' }), { text: 'awake', cls: '' });
  assert.deepEqual(tabPill({ state: 'frozen', audible: true }), { text: 'frozen', cls: 'frozen' });
  assert.deepEqual(tabPill({ state: 'asleep' }), { text: 'asleep', cls: 'asleep' });
});

test('tabs sort by memory with unknown values last, either direction', () => {
  const rows = [
    { title: 'b', memoryMb: 100, cpuPct: 1, state: 'awake' },
    { title: 'a', memoryMb: null, cpuPct: null, state: 'asleep' },
    { title: 'c', memoryMb: 300, cpuPct: 0, state: 'frozen' },
  ];
  assert.deepEqual(sortTabs(rows).map((r) => r.title), ['c', 'b', 'a']);
  assert.deepEqual(sortTabs(rows, 'memory', false).map((r) => r.title), ['b', 'c', 'a']);
  assert.deepEqual(sortTabs(rows, 'cpu').map((r) => r.title), ['b', 'c', 'a']);
  assert.deepEqual(sortTabs(rows, 'title', false).map((r) => r.title), ['a', 'b', 'c']);
  assert.deepEqual(sortTabs(rows, 'state').map((r) => r.state), ['awake', 'frozen', 'asleep']);
});

test('the memory bar is a share of the largest tab', () => {
  assert.equal(meterPct(150, 300), 50);
  assert.equal(meterPct(1, 3000), 2);
  assert.equal(meterPct(null, 300), 0);
  assert.equal(meterPct(300, 0), 0);
});

test('process types get plain names and go largest first', () => {
  const rows = kindRows({ browser: { processes: 1, memoryMb: 120, cpuPct: 1.2 }, renderer: { processes: 9, memoryMb: 900, cpuPct: 2 }, odd: { processes: 1, memoryMb: 5, cpuPct: 0 } });
  assert.deepEqual(rows.map((r) => r.name), ['Pages', 'The browser itself', 'odd']);
  assert.equal(kindRows({ 'utility:NetworkService': { processes: 1, memoryMb: 30, cpuPct: 0 } })[0].name, 'Network');
  assert.equal(kindRows({ 'utility:VideoCaptureService': { processes: 1, memoryMb: 30, cpuPct: 0 } })[0].name, 'Video capture service');
  assert.deepEqual(reasonRows({ pinned: 1, visible: 2, odd: 1 }).map((r) => r.label), ['Showing in a window', 'odd', 'Pinned']);
});

test('a host name is found in whatever was typed', () => {
  assert.equal(cleanHost('https://Mail.Google.com/mail/u/0'), 'mail.google.com');
  assert.equal(cleanHost('localhost:3000'), 'localhost');
  assert.equal(cleanHost('*.example.org'), 'example.org');
  assert.equal(hostOf('https://www.example.com/x'), 'example.com');
  assert.deepEqual(parseHosts('mail.google.com\nhttps://github.com/x, mail.google.com\nnot a host!'), {
    hosts: ['mail.google.com', 'github.com'],
    bad: ['not', 'a', 'host!'],
  });
  assert.deepEqual(parseHosts('localhost').bad, ['localhost']);
  assert.deepEqual(parseHosts('localhost', { allowLocal: true }).hosts, ['localhost']);
});

test('a site is switched on and off in a list, parents included', () => {
  assert.equal(hostListed(['google.com'], 'mail.google.com'), true);
  assert.equal(hostListed(['mail.google.com'], 'google.com'), false);
  assert.deepEqual(toggleHost(['a.com'], 'b.com', true), ['a.com', 'b.com']);
  assert.deepEqual(toggleHost(['google.com'], 'mail.google.com', true), ['google.com']);
  assert.deepEqual(toggleHost(['a.com', 'google.com'], 'mail.google.com', false), ['a.com']);
});

test('a tab says where its page comes from', () => {
  assert.equal(siteLabel('https://www.github.com/x'), 'github.com');
  assert.equal(siteLabel('chrome-extension://abcdef/ui/settings.html'), 'Extension page');
  assert.equal(siteLabel('brave://settings'), 'Browser page');
  assert.equal(siteLabel('about:blank'), 'Browser page');
  assert.equal(siteLabel(''), '');
});

test('checkpoint texts', () => {
  assert.equal(sessionFrom({ profile: 'work' }), 'from work');
  assert.equal(sessionFrom({ profile: '462f90a7-1792-4282-9a15-406d380f72ca' }), '');
  assert.equal(sessionFrom({ profile: null }), '');
  assert.equal(checkpointName(new Date(2026, 10, 11, 9, 5)), '2026-11-11 09.05');
  assert.equal(sessionSize({ windows: 1, tabs: 31 }), '1 window, 31 tabs');
  assert.match(savedLine({ ok: true, name: 'work', tabs: 12, windows: 2, pagesCaptured: 3, skipped: 1 }).text, /Saved "work": 12 tabs in 2 windows\. .*3 pages\. 1 tab left out/);
  assert.equal(savedLine({ ok: false, error: 'Give the session a name.' }).cls, 'bad');
  assert.match(restoredLine({ ok: true, tabs: 5, windows: 1, settingsRestored: true }).text, /Reopened 5 tabs in 1 window\..*settings were put back/);
  assert.equal(exportFileName('work: a/b?'), 'gamblium-session-work ab.json');
  assert.equal(exportFileName(''), 'gamblium-session-checkpoint.json');
});

test('a download row says what is happening and what can be done', () => {
  const base = { id: 1, url: 'https://files.example.com/a/big%20file.iso', filename: 'C:\\Users\\me\\Downloads\\big file.iso' };
  const run = downloadView({ ...base, state: 'in_progress', paused: false, bytesReceived: 250e6, totalBytes: 500e6 });
  assert.equal(run.name, 'big file.iso');
  assert.equal(run.host, 'files.example.com');
  assert.equal(run.percent, 50);
  assert.equal(run.status, '250.0 MB of 500.0 MB');
  assert.deepEqual(run.actions, ['pause', 'cancel']);
  const paused = downloadView({ ...base, state: 'in_progress', paused: true, bytesReceived: 1e6, totalBytes: -1 });
  assert.equal(paused.percent, null);
  assert.deepEqual(paused.actions, ['resume', 'cancel']);
  const done = downloadView({ ...base, state: 'complete', exists: true, bytesReceived: 500e6, totalBytes: 500e6 });
  assert.equal(done.status, 'Done');
  assert.deepEqual(done.actions, ['show', 'erase']);
  assert.deepEqual(downloadView({ ...base, state: 'complete', exists: false }).actions, ['erase']);
  const failed = downloadView({ ...base, state: 'interrupted', error: 'NETWORK_FAILED', canResume: true });
  assert.equal(failed.cls, 'bad');
  assert.deepEqual(failed.actions, ['resume', 'erase']);
  assert.equal(downloadView({ ...base, state: 'interrupted', error: 'USER_CANCELED' }).cls, '');
  assert.equal(downloadView({ ...base, state: 'interrupted', error: 'SOMETHING_NEW' }).status, 'Failed: something new');
  assert.equal(downloadView({ id: 2, url: base.url, filename: '', state: 'in_progress', bytesReceived: 0, totalBytes: 0 }).name, 'big file.iso');
  assert.equal(anyInProgress([{ state: 'in_progress', paused: true }, { state: 'complete' }]), false);
  assert.equal(anyInProgress([{ state: 'in_progress', paused: false }]), true);
});

test('a folder rule is checked before it is stored', () => {
  assert.deepEqual(ruleFromFields({ folder: ' Video ', extensions: '.MP4, mkv mp4', hosts: '' }), {
    ok: true,
    rule: { folder: 'Video', extensions: ['mp4', 'mkv'], hosts: [] },
  });
  assert.deepEqual(ruleFromFields({ folder: 'Work', extensions: '', hosts: 'https://github.com/x' }).rule.hosts, ['github.com']);
  assert.equal(ruleFromFields({ folder: '..', extensions: 'pdf', hosts: '' }).ok, false);
  assert.equal(ruleFromFields({ folder: 'A', extensions: '', hosts: '' }).ok, false);
  assert.equal(ruleFromFields({ folder: 'A', extensions: 'p/df', hosts: '' }).ok, false);
  assert.equal(ruleFromFields({ folder: 'A', extensions: 'pdf', hosts: 'bad host!' }).ok, false);
  const all = rulesFromRows([{ folder: 'Docs', extensions: 'pdf', hosts: '' }, { folder: '', extensions: '', hosts: '' }]);
  assert.equal(all.rules.length, 1);
  assert.equal(rulesFromRows([{ folder: 'Docs', extensions: '', hosts: '' }]).ok, false);
});

test('proxy lock and agent control lines', () => {
  assert.equal(proxyLocked({ ok: true, controlledBy: 'controlled_by_this_extension' }), null);
  assert.match(proxyLocked({ ok: true, controlledBy: 'controlled_by_other_extensions' }), /Another extension/);
  assert.match(proxyLocked({ ok: true, controlledBy: 'not_controllable' }), /policy/);
  assert.equal(bridgeLine({ ok: true, wanted: false }).text, ''); // the unticked box says it
  assert.equal(bridgeLine({ ok: true, wanted: true, connected: true }).cls, 'warn');
  assert.match(bridgeLine({ ok: true, wanted: true, connected: false, error: 'host not found' }).text, /not connected \(host not found\)/);
  assert.equal(bridgeLine(null).cls, 'bad');
});

test('tab filter: every word, any order, one state', async () => {
  const { filterTabs } = await import('./pages-logic.js');
  const rows = [
    { tabId: 1, title: 'Inbox', url: 'https://mail.example.com/', state: 'awake' },
    { tabId: 2, title: 'Docs: plan', url: 'https://docs.example.com/plan', state: 'asleep' },
    { tabId: 3, title: 'Plan B', url: 'https://example.org/', state: 'frozen' },
  ];
  assert.deepEqual(filterTabs(rows, { query: 'plan' }).map((r) => r.tabId), [2, 3]);
  assert.deepEqual(filterTabs(rows, { query: 'EXAMPLE plan docs' }).map((r) => r.tabId), [2]);
  assert.deepEqual(filterTabs(rows, { state: 'frozen' }).map((r) => r.tabId), [3]);
  assert.deepEqual(filterTabs(rows, { query: 'plan', state: 'awake' }), []);
  assert.equal(filterTabs(rows).length, 3);
});

test('memory map: largest first, tabs without a figure still get a block', async () => {
  const { mapBlocks } = await import('./pages-logic.js');
  const blocks = mapBlocks([
    { tabId: 1, memoryMb: 100 }, { tabId: 2, memoryMb: 700 }, { tabId: 3, memoryMb: null }, { tabId: 4, memoryMb: 200 },
  ]);
  assert.deepEqual(blocks.map((b) => b.row.tabId), [2, 4, 1, 3]);
  assert.deepEqual(blocks.map((b) => b.wide), [true, true, true, false]);
  assert.ok(blocks[3].grow > 0 && blocks[3].grow < blocks[2].grow);
  assert.deepEqual(mapBlocks([{ tabId: 9, memoryMb: null }]).map((b) => [b.grow, b.wide]), [[1, false]]);
});

test('tabs gather under their window, order kept', async () => {
  const { groupByWindow } = await import('./pages-logic.js');
  const g = groupByWindow([{ tabId: 1, windowId: 7 }, { tabId: 2, windowId: 3 }, { tabId: 3, windowId: 7 }]);
  assert.deepEqual(g.map((x) => [x.windowId, x.rows.map((r) => r.tabId)]), [[3, [2]], [7, [1, 3]]]);
});

import { lookOf } from './pages-logic.js';
test('lookOf: a background colour is a dark or a light look', () => {
  assert.equal(lookOf('#030304'), 'dark');
  assert.equal(lookOf('#EEF0F3'), 'light');
  assert.equal(lookOf('#7a1f2b'), 'dark');
  assert.equal(lookOf('nonsense'), 'dark');
});

import { markdownLink, secureChip, shotName } from './pages-logic.js';
test('site panel helpers: Markdown link, secure chip, screenshot name', () => {
  assert.equal(markdownLink(' Diamond  [cut] ', 'https://en.wikipedia.org/wiki/Diamond_(gemstone)'), '[Diamond \\[cut\\]](https://en.wikipedia.org/wiki/Diamond_%28gemstone%29)');
  assert.equal(markdownLink('', 'https://a.com/'), '[https://a.com/](https://a.com/)');
  assert.equal(secureChip('https://a.com/').text, 'Secure');
  assert.equal(secureChip('http://a.com/').cls, 'warn');
  assert.equal(secureChip('http://127.0.0.1:8096/').text, 'Local');
  assert.equal(secureChip('chrome://settings').text, '');
  assert.equal(shotName('a.com:8080', new Date(2026, 10, 12, 4, 5, 9)), 'screenshot a.com_8080 2026-11-12 04.05.09.png');
});

import { whenRange, groupByDay, fileKind, filterDownloads, WHENS, FILE_KINDS } from './pages-logic.js';
test('library: when, days, file kinds', () => {
  const now = new Date(2026, 10, 12, 15, 30).getTime();
  const at = (d, h) => new Date(2026, 10, d, h, 0).getTime();
  assert.deepEqual(whenRange('today', now), [at(12, 0), now]);
  assert.deepEqual(whenRange('yesterday', now), [at(11, 0), at(12, 0) - 1]);
  assert.equal(whenRange('week', now)[0], at(6, 0));
  assert.equal(whenRange('month', now)[0], new Date(2026, 9, 14).getTime());
  assert.deepEqual(whenRange('all', now), [0, now]);
  assert.equal(WHENS.length, 5);
  const groups = groupByDay([{ t: at(12, 9) }, { t: at(12, 1) }, { t: at(11, 23) }, { t: at(3, 8) }], (x) => x.t, now);
  assert.deepEqual(groups.map((g) => [g.label.split(' ')[0], g.items.length]), [['Today', 2], ['Yesterday', 1], [groups[2].label.split(' ')[0], 1]]);
  assert.match(groups[2].label, /2026/);
  assert.equal(fileKind('C:\\Users\\a\\Report.PDF'), 'document');
  assert.equal(fileKind('song.flac'), 'audio');
  assert.equal(fileKind('setup.exe'), 'program');
  assert.equal(fileKind('noext'), 'other');
  assert.equal(FILE_KINDS[0].id, 'all');
  const list = [
    { filename: 'C:\\d\\report.pdf', url: 'https://a.com/report.pdf', startTime: new Date(at(12, 9)).toISOString() },
    { filename: 'C:\\d\\film.mkv', url: 'https://b.com/film.mkv', startTime: new Date(at(11, 9)).toISOString() },
    { filename: 'C:\\d\\old.zip', url: 'https://c.com/old.zip', startTime: new Date(2026, 5, 1).toISOString() },
  ];
  assert.equal(filterDownloads(list, {}, now).length, 3);
  assert.deepEqual(filterDownloads(list, { kind: 'video' }, now).map((d) => d.url), ['https://b.com/film.mkv']);
  assert.equal(filterDownloads(list, { when: 'today' }, now).length, 1);
  assert.equal(filterDownloads(list, { when: 'week' }, now).length, 2);
  assert.equal(filterDownloads(list, { query: 'c.com' }, now).length, 1);
  assert.equal(filterDownloads(list, { kind: 'audio' }, now).length, 0);
});

import { COLOUR_SETS, tune, setColours, findMatches, splitTheme } from './pages-logic.js';
test('settings: colour sets, strength, find, theme names', () => {
  assert.equal(tune('#E8A04C', 100), '#e8a04c');
  assert.equal(tune('#808080', 40), '#808080');
  const grey = tune('#E8A04C', 0);
  assert.equal(grey.slice(1, 3), grey.slice(3, 5));
  assert.equal(grey.slice(3, 5), grey.slice(5, 7));
  assert.deepEqual(setColours('ember', 'dark'), { accent: '#e8a04c', bg: '#120c06' });
  assert.deepEqual(setColours('ink', 'light'), { accent: '#111111', bg: '#ffffff' });
  assert.equal(setColours('nope', 'dark'), null);
  assert.equal(new Set(COLOUR_SETS.map((s) => s.id)).size, 8);
  for (const s of COLOUR_SETS) for (const look of ['dark', 'light']) assert.equal(lookOf(s[look].bg), look, `${s.id} ${look}`);
  assert.ok(findMatches('Put hidden tabs to sleep after', 'SLEEP tabs'));
  assert.ok(!findMatches('Proxy', 'sleep'));
  assert.ok(findMatches('anything', '  '));
  assert.deepEqual(splitTheme('felt-light'), ['felt', 'light']);
  assert.deepEqual(splitTheme('moon-auto'), ['moon', 'auto']);
  assert.deepEqual(splitTheme(null), ['moon', 'dark']);
});

import { chordOf, findClash, sameKeys, filterCommands, groupCommands, USUAL_KEYS } from './pages-logic.js';
test('shortcuts: a key press becomes a chord; clashes are found', () => {
  const press = (o) => ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o });
  assert.equal(chordOf(press({ key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+K');
  assert.equal(chordOf(press({ key: 'Control', code: 'ControlLeft', ctrlKey: true })), null);
  assert.equal(chordOf(press({ key: 'k', code: 'KeyK' })), null); // a bare letter would fire while typing
  assert.equal(chordOf(press({ key: 'K', code: 'KeyK', shiftKey: true })), null);
  assert.equal(chordOf(press({ key: 'F6', code: 'F6' })), 'F6');
  assert.equal(chordOf(press({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true })), 'Alt+Left');
  assert.equal(chordOf(press({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+1');
  assert.equal(chordOf(press({ key: ' ', code: 'Space', ctrlKey: true })), 'Ctrl+Space');
  const commands = USUAL_KEYS.map((c) => ({ ...c, keys: [...c.defaults] }));
  assert.equal(findClash(commands, 'ctrl+t', 'x').name, 'New tab');
  assert.equal(findClash(commands, 'Ctrl+T', commands[0].id), null);
  assert.equal(findClash(commands, 'Ctrl+Alt+Q', 'x'), null);
  assert.ok(sameKeys(['Ctrl+T', 'F5'], ['f5', 'ctrl+t']));
  assert.ok(!sameKeys(['Ctrl+T'], []));
  assert.deepEqual(filterCommands(commands, 'tab shift').map((c) => c.name), ['Reopen closed tab', 'Previous tab', 'Search tabs']);
  assert.deepEqual(groupCommands(commands).map((g) => g.name), ['Tabs', 'Windows', 'Page', 'Go to']);
  assert.equal(new Set(commands.map((c) => c.id)).size, commands.length);
});

import { fmtSpeed, fmtSpan, dlFold, dlView, dlActive } from './pages-logic.js';
test('own downloader: events fold into a job, and the row says what matters', () => {
  assert.equal(fmtSpeed(9_400_000), '9.4 MB/s');
  assert.equal(fmtSpeed(420_000), '420 kB/s');
  assert.equal(fmtSpeed(0), '0 kB/s');
  assert.equal(fmtSpan(51), '51 s');
  assert.equal(fmtSpan(200), '3 min');
  assert.equal(fmtSpan(4320), '1 h 12 min');
  const lines = [
    { event: 'source-failed', error: 'refused' },
    { event: 'start', path: 'C:\\d\\ubuntu.iso', size: 500_000_000, split: true, sources: 3 },
    { event: 'resume', have: 100_000_000 },
    { event: 'progress', done: 212_000_000, total: 500_000_000, speed: 9_400_000, connections: 8 },
  ];
  let job = lines.reduce(dlFold, { id: 1 });
  let v = dlView(job);
  assert.equal(v.name, 'ubuntu.iso');
  assert.equal(v.word, 'Downloading');
  assert.equal(v.percent, 42);
  assert.deepEqual(v.line, ['212.0 MB of 500.0 MB', '42%', '9.4 MB/s', '31 s left']);
  assert.deepEqual(v.facts, ['8 connections', '2 of 3 sources', 'picked up at 100.0 MB']);
  assert.deepEqual(v.actions, ['pause', 'cancel']);
  assert.ok(dlActive([job]));
  assert.deepEqual(dlView({ ...job, state: 'paused' }).actions, ['resume', 'cancel']);
  job = dlFold(job, { event: 'done', path: 'C:\\d\\ubuntu.iso', bytes: 500_000_000, seconds: 58, speed: 8_600_000, connections: 8 });
  v = dlView(job);
  assert.deepEqual([v.word, v.percent, v.line, v.actions], ['Done', 100, ['500.0 MB', 'in 58 s', '8.6 MB/s on average'], ['open', 'show', 'remove']]);
  assert.ok(!dlActive([job]));
  const failed = dlView(dlFold(dlFold({}, lines[1]), { event: 'error', error: 'no byte arrived for 60 s' }));
  assert.deepEqual([failed.word, failed.cls, failed.actions], ['Stopped', 'bad', ['retry', 'remove']]);
  const one = dlView(dlFold({}, { event: 'progress', done: 5_000_000, total: 0, speed: 1_000_000, connections: 1 }));
  assert.equal(one.percent, null);
  assert.deepEqual(one.line, ['5.0 MB', '1.0 MB/s']);
  const torrent = dlFold(dlFold({ kind: 'torrent' }, { event: 'start', path: 'film.mkv', size: 2e9, sources: 1 }), { event: 'progress', done: 5e8, total: 2e9, speed: 4e6, peers: 34, seeds: 12, up: 300_000 });
  assert.deepEqual(dlView(torrent).facts, ['Torrent', '34 peers', '12 seeds', 'up 300 kB/s']);
  const seeding = dlView(dlFold(dlFold(torrent, { event: 'done', path: 'film.mkv', bytes: 2e9, seconds: 500, speed: 4e6 }), { event: 'seeding', uploaded: 7e8, ratio: 0.35, peers: 9, up: 120_000 }));
  assert.deepEqual([seeding.word, seeding.line, seeding.actions[0]], ['Seeding', ['700.0 MB given back', 'ratio 0.35', 'up 120 kB/s'], 'stop']);
});

import { maskAddr, peerRows, fileRows, dlDetail } from './pages-logic.js';

test('a peer address is shown without its last part', () => {
  assert.equal(maskAddr('203.0.113.57:51413'), '203.0.113.···');
  assert.equal(maskAddr('203.0.113.57'), '203.0.113.···');
  assert.equal(maskAddr('[2001:db8:85a3::8a2e:370:7334]:6881'), '2001:db8:···');
  assert.equal(maskAddr('something else'), '···');
  assert.equal(maskAddr(undefined), '');
});

test('peers come busiest first with a share for the dot', () => {
  const rows = peerRows([
    { addr: '198.51.100.7:6881', client: 'qBittorrent 5.0', state: 'live', down: 100, up: 0 },
    { addr: '203.0.113.9:51413', client: null, state: 'live', down: 400, up: 50 },
    { addr: '192.0.2.44:1', client: 'Transmission', state: 'queued', down: 0, up: 0 },
    { addr: '192.0.2.45:1', client: '', state: 'live', down: 0, up: 300 },
  ]);
  assert.deepEqual(rows.map((r) => r.masked), ['203.0.113.···', '192.0.2.···', '198.51.100.···', '192.0.2.···']);
  assert.deepEqual(rows.map((r) => r.kind), ['gives', 'takes', 'gives', 'quiet']);
  assert.deepEqual(rows.map((r) => r.share), [1, 0, 0.25, 0]);
  assert.equal(rows[0].client, 'Unknown program');
  assert.equal(rows[3].word, 'Waiting');
  assert.deepEqual(peerRows(undefined), []);
});

test('files say how far each one is', () => {
  assert.deepEqual(fileRows([{ name: 'a.iso', size: 200, done: 50 }, { name: 'readme.txt', size: 0, done: 0 }, { name: 'b', size: 10, done: 99 }]), [
    { name: 'a.iso', size: 200, done: 50, percent: 25 },
    { name: 'readme.txt', size: 0, done: 0, percent: 0 },
    { name: 'b', size: 10, done: 10, percent: 100 },
  ]);
});

test('an opened torrent shows figures, peers and files; a normal download where it comes from', () => {
  const t = dlDetail({ kind: 'torrent', state: 'downloading', peers: 41, speed: 8_700_000, up: 620_000, uploaded: 120_000_000, ratio: 0.08, path: 'C:\\d\\x.iso',
    peerList: [{ addr: '203.0.113.9:1', client: 'x', state: 'live', down: 5, up: 1 }, { addr: '203.0.113.8:1', state: 'live', down: 0, up: 0 }], files: [{ name: 'x.iso', size: 10, done: 5 }] });
  assert.deepEqual(t.figures, [['Peers', '41'], ['Giving to us', '1'], ['Coming in', '8.7 MB/s'], ['Going out', '620 kB/s'], ['Given back', '120.0 MB'], ['Ratio', '0.08']]);
  assert.equal(t.peers.length, 2);
  assert.equal(t.files[0].percent, 50);
  const seeding = dlDetail({ kind: 'torrent', state: 'seeding', peers: 6, up: 0, uploaded: 0 });
  assert.deepEqual(seeding.figures.map((f) => f[0]), ['Peers', 'Going out', 'Given back']);
  const h = dlDetail({ kind: 'http', state: 'downloading', url: 'https://releases.example.org/a.iso', connections: 8, sources: 3, failed: 1, resumed: 1_200_000_000, path: 'C:\\d\\a.iso' });
  assert.deepEqual(h.figures, [['From', 'releases.example.org'], ['Connections', '8'], ['Sources', '2 of 3 answering'], ['Picked up at', '1.20 GB']]);
  assert.equal(h.torrent, false);
});

import { nowShape, stripOf, sessionWhen, filterSessions, sessionFacts, sessionTabs } from './pages-logic.js';

test('the open tabs take the shape of a saved session, the window in front first', () => {
  const tabs = [
    { windowId: 1, index: 1, url: 'https://b.example/', groupId: 7 },
    { windowId: 1, index: 0, url: 'https://a.example/', pinned: true, groupId: -1 },
    { windowId: 2, index: 0, url: 'chrome://newtab/' },
    { windowId: 2, index: 1, url: '', pendingUrl: 'https://c.example/', discarded: true },
  ];
  const r = nowShape(tabs, [{ id: 7, color: 'blue' }], 2);
  assert.deepEqual([r.windows, r.tabs, r.skipped], [2, 3, 1]);
  assert.deepEqual(r.shape.map((w) => w.id), [2, 1]);
  assert.deepEqual(r.shape[1].icons, [
    { url: 'https://a.example/', pinned: true, color: null, asleep: false },
    { url: 'https://b.example/', pinned: false, color: 'blue', asleep: false },
  ]);
  assert.equal(r.shape[0].icons[0].asleep, true);
  assert.deepEqual(nowShape([]), { shape: [], windows: 0, tabs: 0, skipped: 0 });
});

test('a window is cut to what fits a row and says how many more', () => {
  const win = { tabs: 40, icons: Array.from({ length: 28 }, (_, i) => ({ url: `https://a.example/${i}` })) };
  assert.equal(stripOf(win, 18).icons.length, 18);
  assert.equal(stripOf(win, 18).more, 22);
  assert.deepEqual(stripOf({ tabs: 2, icons: [{ url: 'a' }, { url: 'b' }] }), { icons: [{ url: 'a' }, { url: 'b' }], more: 0 });
});

test('when a session was saved, in the words a person uses', () => {
  const now = new Date(2026, 10, 12, 16, 0).getTime();
  assert.equal(sessionWhen(new Date(2026, 10, 12, 14, 5).getTime(), now), 'Today 14:05');
  assert.equal(sessionWhen(new Date(2026, 10, 11, 18, 40).getTime(), now), 'Yesterday 18:40');
  assert.equal(sessionWhen(new Date(2026, 10, 9, 9, 12).getTime(), now), 'Mon 09:12');
  assert.equal(sessionWhen(new Date(2026, 10, 3, 9, 12).getTime(), now), '3 Nov');
  assert.equal(sessionWhen(new Date(2025, 10, 3, 9, 12).getTime(), now), '3 Nov 2025');
});

test('sessions are found by name, site or a tab address', () => {
  const list = [
    { name: 'Morning work', hosts: ['github.com'], shape: [{ tabs: 1, icons: [{ url: 'https://github.com/JuteBags' }] }] },
    { name: 'Trip', hosts: ['maps.example'], shape: [{ tabs: 1, icons: [{ url: 'https://hotels.example/goa' }] }] },
  ];
  assert.deepEqual(filterSessions(list, 'work git').map((s) => s.name), ['Morning work']);
  assert.deepEqual(filterSessions(list, 'GOA').map((s) => s.name), ['Trip']);
  assert.equal(filterSessions(list, '').length, 2);
  assert.equal(filterSessions(list, 'nothing').length, 0);
});

test('a session says what was kept with it and lists its tabs by window', () => {
  assert.deepEqual(sessionFacts({ profile: 'Work', pagesCaptured: 3, hasSettings: true }), ['from Work', 'scroll and form text for 3 pages', 'settings']);
  assert.deepEqual(sessionFacts({ profile: null, pagesCaptured: 0, hasSettings: false }), []);
  const wins = sessionTabs({ windows: [{ groups: [{ title: 'Docs', color: 'green' }], tabs: [
    { url: 'https://docs.example/a', title: ' Guide ', pinned: true, group: 0, page: { scroll: 1 } },
    { url: 'https://www.example.org/', title: '', group: null },
  ] }] });
  assert.equal(wins[0].title, 'Window 1');
  assert.deepEqual(wins[0].tabs[0], { url: 'https://docs.example/a', title: 'Guide', host: 'docs.example', pinned: true, color: 'green', group: 'Docs', kept: true });
  assert.equal(wins[0].tabs[1].title, wins[0].tabs[1].host);
  assert.deepEqual(sessionTabs(null), []);
});

import { namedNameError, proxyAddress, namedView, namedActionLabel } from './pages-logic.js';

test('a named session needs a plain name that is free', () => {
  assert.equal(namedNameError('work-2'), '');
  assert.match(namedNameError(''), /Give the session a name/);
  assert.match(namedNameError('my work'), /letters, digits/);
  assert.match(namedNameError('x'.repeat(41)), /at most 40/);
  assert.match(namedNameError('Open'), /command word/);
  assert.match(namedNameError('Work', ['work']), /already a session/);
});

test('a proxy address is kind://host:port, or none', () => {
  assert.deepEqual(proxyAddress(''), { ok: true, value: 'none' });
  assert.deepEqual(proxyAddress('None'), { ok: true, value: 'none' });
  assert.deepEqual(proxyAddress(' SOCKS5://127.0.0.1:9050 '), { ok: true, value: 'socks5://127.0.0.1:9050' });
  assert.deepEqual(proxyAddress('http://proxy.example:8080/'), { ok: true, value: 'http://proxy.example:8080' });
  assert.match(proxyAddress('127.0.0.1:8080').error, /kind:\/\/host:port|http, https/);
  assert.match(proxyAddress('ftp://a.example:21').error, /http, https, socks4 or socks5/);
  assert.match(proxyAddress('http://me:secret@a.example:8080').error, /name or password/);
  assert.match(proxyAddress('socks5://a.example').error, /needs a port/);
  assert.match(proxyAddress('http://a.example:8080/path').error, /nothing after the port/);
});

test('a named session card says its state, what it applies and what can be done', () => {
  const v = namedView({ name: 'research', state: 'hidden', by: 'cli', applies: { proxy: 'socks5://127.0.0.1:9050', always: true, extensions: ['a', 'b', 'c'] } });
  assert.deepEqual([v.word, v.cls, v.actions], ['Working unseen', 'warn', ['open', 'close']]);
  assert.deepEqual(v.facts, ['Proxy socks5://127.0.0.1:9050', '3 extensions', 'made from the command line']);
  assert.deepEqual(v.extensions, ['a', 'b', 'c']);
  const stopped = namedView({ name: 'bank', state: 'stopped', applies: { proxy: null } });
  assert.deepEqual([stopped.word, stopped.actions, stopped.facts], ['Stopped', ['open', 'hide', 'delete'], ['No proxy']]);
  assert.deepEqual(namedView({ name: 'x', state: 'window', by: 'page', applies: { extensions: [] } }).facts, ['No proxy', 'No extensions of its own']);
  assert.equal(namedView({ name: 'x', state: 'something new' }).state, 'stopped');
  assert.equal(namedActionLabel('hide', 'window'), 'Hide the window');
  assert.equal(namedActionLabel('hide', 'stopped'), 'Start unseen');
  assert.equal(namedActionLabel('open', 'hidden'), 'Open in a window');
  assert.equal(namedActionLabel('close', 'window'), 'Stop');
});

test('sessions can be found by name, and deleting one says it takes the logins', async () => {
  const { filterNamed, namedDeleteQuestion } = await import('./pages-logic.js');
  const list = [{ name: 'tt-card-1' }, { name: 'research' }, { name: 'tt-cf-2' }];
  assert.deepEqual(filterNamed(list, 'TT card').map((s) => s.name), ['tt-card-1']);
  assert.deepEqual(filterNamed(list, '  '), list);
  assert.deepEqual(filterNamed(list, 'tt').length, 2);
  assert.equal(namedDeleteQuestion(['bank']), 'Delete bank and its logins?');
  assert.equal(namedDeleteQuestion(['a', 'b', 'c']), 'Delete 3 sessions and their logins?');
});

test('the permission prompt names each choice and says what is in force', async () => {
  const { permitLabel, permitStatus } = await import('./pages-logic.js');
  assert.deepEqual([0, 30, 60, 120, 360, -1].map(permitLabel), ['Not now', 'Allow for 30 minutes', 'Allow for 1 hour', 'Allow for 2 hours', 'Allow for 6 hours', 'Always allow, never ask']);
  assert.equal(permitStatus({ allowed: false }, 0), 'Agents may not change settings. They ask each time.');
  assert.equal(permitStatus({ allowed: true, neverAsk: true }, 0), 'Agents may change settings; you are not asked.');
  assert.equal(permitStatus({ allowed: true, until: 1800 }, 0), 'Agents may change settings for another 30 min.');
  assert.equal(permitStatus({ allowed: true, until: 7500 }, 0), 'Agents may change settings for another 2 h 5 min.');
});

test('the permission prompt knows what is asked, by whom, and what is in force', async () => {
  const { permitShort, permitParts } = await import('./pages-logic.js');
  assert.deepEqual([0, 30, 60, 120, 360, -1].map(permitShort), ['Not now', '30 min', '1 hour', '2 hours', '6 hours', 'Always']);
  const now = new Date(2026, 10, 12, 18, 0).getTime();
  const asking = permitParts({ allowed: false, choices: [0, 30, 60, 120, 360, -1], asks: [{ command: 'proxy-set mode=fixed', profile: "the session 'work'", at: now / 1000 - 120 }] }, now);
  assert.deepEqual([asking.state, asking.choice, asking.times], ['asking', 0, [30, 60, 120, 360]]);
  assert.deepEqual(asking.asks, [{ command: 'proxy-set mode=fixed', who: "the session 'work'", when: '2 min ago' }]);
  const timed = permitParts({ allowed: true, until: new Date(2026, 10, 12, 18, 40).getTime() / 1000, asks: [] }, now);
  assert.deepEqual([timed.state, timed.choice, timed.until], ['allowed', null, '18:40']);
  assert.deepEqual([permitParts({ allowed: true, neverAsk: true }, now).state, permitParts({ allowed: true, neverAsk: true }, now).choice], ['always', -1]);
  assert.equal(permitParts({ allowed: false, asks: [] }, now).state, 'closed');
  assert.equal(permitParts({ asks: [{ command: 'x' }] }, now).asks[0].who, 'an agent');
});

test('zoom goes one of the browser\'s steps at a time and stops at the ends', async () => {
  const { zoomStep, zoomLabel } = await import('./pages-logic.js');
  assert.deepEqual([zoomStep(1, 1), zoomStep(1, -1), zoomStep(1.1, -1)], [1.1, 0.9, 1]);
  assert.deepEqual([zoomStep(0.95, 1), zoomStep(0.95, -1)], [1, 0.9]); // between two steps
  assert.deepEqual([zoomStep(5, 1), zoomStep(0.25, -1), zoomStep(undefined, 1)], [5, 0.25, 1.1]);
  assert.deepEqual([zoomLabel(1), zoomLabel(0.67), zoomLabel(1.1000000238), zoomLabel(null)], ['100%', '67%', '110%', '100%']);
});

test('keys show in the Windows order with symbols for plus and minus', async () => {
  const { keyParts } = await import('./pages-logic.js');
  assert.deepEqual(keyParts('Shift+Alt+F'), ['Alt', 'Shift', 'F']);
  assert.deepEqual(keyParts('Ctrl+Plus'), ['Ctrl', '+']);
  assert.deepEqual(keyParts('Ctrl+-'), ['Ctrl', '−']);
  assert.deepEqual(keyParts('Ctrl+Shift+Alt+K'), ['Ctrl', 'Alt', 'Shift', 'K']);
  assert.deepEqual(keyParts(''), []);
});

test('weight, free memory and processor levels pick the tint', () => {
  assert.equal(weightOf(null), '');
  assert.equal(weightOf(149), 'light');
  assert.equal(weightOf(150), 'mid');
  assert.equal(weightOf(399), 'mid');
  assert.equal(weightOf(400), 'heavy');
  assert.equal(freeLevel(undefined), '');
  assert.equal(freeLevel(1000), 'bad');
  assert.equal(freeLevel(1500), 'warn');
  assert.equal(freeLevel(2048), 'ok');
  assert.equal(freeLevel(3900), 'ok');
  assert.equal(cpuLevel(null), '');
  assert.equal(cpuLevel(5.3), 'ok');
  assert.equal(cpuLevel(20), 'warn');
  assert.equal(cpuLevel(75), 'bad');
});

test('a browser download gets the tint of its state', () => {
  const base = { id: 1, filename: 'C:/d/a.zip', url: 'https://x.org/a.zip', bytesReceived: 1e6, totalBytes: 2e6 };
  assert.equal(downloadView({ ...base, state: 'in_progress' }).tone, 'run');
  assert.equal(downloadView({ ...base, state: 'in_progress', paused: true }).tone, 'paused');
  assert.equal(downloadView({ ...base, state: 'complete', exists: true }).tone, 'done');
  assert.equal(downloadView({ ...base, state: 'complete', exists: false }).tone, 'moved');
  assert.equal(downloadView({ ...base, state: 'interrupted', error: 'NETWORK_FAILED' }).tone, 'bad');
  assert.equal(downloadView({ ...base, state: 'interrupted', error: 'USER_CANCELED' }).tone, '');
});

test('every interrupted download says why in words, never a raw code', () => {
  const base = { id: 1, filename: 'C:/d/a.zip', url: 'https://x.org/a.zip', bytesReceived: 1e6, totalBytes: 5e6, state: 'interrupted' };
  for (const error of ['SERVER_CONTENT_LENGTH_MISMATCH', 'SERVER_CERT_PROBLEM', 'FILE_TOO_SHORT', 'CRASH', 'SERVER_FAILED']) {
    const v = downloadView({ ...base, error });
    assert.ok(!/_/.test(v.status) && !/mismatch/i.test(v.status), `${error}: ${v.status}`);
  }
});
