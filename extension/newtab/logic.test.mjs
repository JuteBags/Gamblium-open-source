import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, siteLabel, pickSites, sameSites, statusLine } from './logic.js';

test('classify: addresses', () => {
  assert.deepEqual(classify('github.com'), { kind: 'url', url: 'https://github.com' });
  assert.deepEqual(classify('  www.example.fr/path?q=1 '), { kind: 'url', url: 'https://www.example.fr/path?q=1' });
  assert.deepEqual(classify('https://a.b/c'), { kind: 'url', url: 'https://a.b/c' });
  assert.deepEqual(classify('localhost:3000/x'), { kind: 'url', url: 'http://localhost:3000/x' });
  assert.deepEqual(classify('192.168.1.1'), { kind: 'url', url: 'http://192.168.1.1' });
  assert.deepEqual(classify('intranet.corp:8443'), { kind: 'url', url: 'https://intranet.corp:8443' });
  assert.deepEqual(classify('brave://settings'), { kind: 'url', url: 'chrome://settings' });
  assert.deepEqual(classify('about:blank'), { kind: 'url', url: 'about:blank' });
});

test('classify: searches', () => {
  assert.deepEqual(classify('how to sleep tabs'), { kind: 'search', text: 'how to sleep tabs' });
  assert.deepEqual(classify('node.js'), { kind: 'search', text: 'node.js' });
  assert.deepEqual(classify('rust'), { kind: 'search', text: 'rust' });
  assert.deepEqual(classify('a:b'), { kind: 'search', text: 'a:b' });
  assert.deepEqual(classify('-bad-.com'), { kind: 'search', text: '-bad-.com' });
  assert.deepEqual(classify('   '), { kind: 'empty' });
  assert.deepEqual(classify(undefined), { kind: 'empty' });
});

test('siteLabel prefers the title, falls back to the host', () => {
  assert.equal(siteLabel({ url: 'https://www.wikipedia.org/', title: ' Wikipedia ' }), 'Wikipedia');
  assert.equal(siteLabel({ url: 'https://www.wikipedia.org/x', title: '' }), 'wikipedia.org');
  assert.equal(siteLabel({ url: 'not a url', title: '' }), 'not a url');
});

test('pickSites keeps web pages only, in order, up to the limit', () => {
  const list = [{ url: 'chrome://settings', title: 'S' }, { url: 'https://a.com/', title: 'A' }, { url: 'http://b.com/' }, { url: 'https://c.com/', title: 'C' }];
  assert.deepEqual(pickSites(list, 2), [{ url: 'https://a.com/', title: 'A' }, { url: 'http://b.com/', title: '' }]);
  assert.deepEqual(pickSites(undefined), []);
  assert.ok(sameSites(pickSites(list), pickSites(list)));
  assert.ok(!sameSites(pickSites(list, 1), pickSites(list, 2)));
});

test('statusLine prints real zeros and leaves out what it does not know', () => {
  assert.equal(statusLine({ total: 23, reasons: { 'already asleep': 14 }, availableMb: 5222 }), '23 tabs · 14 asleep · 5.1 GB memory free');
  assert.equal(statusLine({ total: 1, reasons: {}, availableMb: null }), '1 tab · 0 asleep');
  assert.equal(statusLine(undefined), '');
  assert.equal(statusLine({ ok: false }), '');
});

import { fillSites, readPrefs, cleanPin, addPin, movePin, isPinned, greeting, ago, suggest, hostOf, MAX_PINS } from './logic.js';

test('cleanPin takes typed addresses and refuses the rest', () => {
  assert.deepEqual(cleanPin({ url: 'github.com', title: '' }), { url: 'https://github.com/', title: 'github.com' });
  assert.deepEqual(cleanPin({ url: 'https://www.example.org/a', title: ' Example ' }), { url: 'https://www.example.org/a', title: 'Example' });
  assert.equal(cleanPin({ url: 'two words' }), null);
  assert.equal(cleanPin({ url: 'chrome://settings' }), null);
  assert.equal(cleanPin({ url: 'file:///c:/x' }), null);
});

test('readPrefs fills in defaults and drops what is wrong', () => {
  const p = readPrefs({ pins: [{ url: 'a.com' }, { url: 'https://a.com/' }, { url: 'nope nope' }], widgets: { notes: true, clock: 'yes' }, backdrop: 'lava', name: '  Asha  ' });
  assert.equal(p.pins.length, 1);
  assert.equal(p.widgets.notes, true);
  assert.equal(p.widgets.clock, true);
  // Recent sessions first; saved tab sets and Most visited off (owner, Nov 16 2026).
  assert.equal(p.widgets.browsers, true);
  assert.equal(p.widgets.sessions, false);
  assert.equal(p.widgets.top, false);
  // Once moved over, a person's own choice stays.
  const mine = readPrefs({ sessionDeck: true, widgets: { top: true, browsers: false } });
  assert.equal(mine.widgets.top, true);
  assert.equal(mine.widgets.browsers, false);
  assert.equal(mine.sessionDeck, true);
  assert.equal(p.backdrop, 'moon');
  assert.equal(p.name, 'Asha');
  assert.deepEqual(readPrefs(null).pins, []);
});

test('pins: add once, stop at the limit, move', () => {
  const a = { url: 'https://a.com/', title: 'A' };
  const b = { url: 'https://b.com/', title: 'B' };
  const c = { url: 'https://c.com/', title: 'C' };
  let pins = addPin(addPin([], a), b);
  assert.equal(addPin(pins, { url: 'https://A.com', title: 'again' }), pins);
  assert.ok(isPinned(pins, 'https://b.com'));
  pins = addPin(pins, c);
  assert.deepEqual(movePin(pins, 2, 0).map((p) => p.title), ['C', 'A', 'B']);
  assert.equal(movePin(pins, 0, 9), pins);
  const full = Array.from({ length: MAX_PINS }, (_, i) => ({ url: `https://s${i}.com/`, title: '' }));
  assert.equal(addPin(full, a), full);
});

test('fillSites tops up from history, one per site, most visited first', () => {
  const got = fillSites([{ url: 'https://a.com/', title: 'A' }], [
    { url: 'https://b.com/x', title: 'B x', visitCount: 2 },
    { url: 'https://b.com/y', title: 'B y', visitCount: 9 },
    { url: 'https://a.com/z', title: 'A z', visitCount: 50 },
    { url: 'chrome://history', title: 'History', visitCount: 99 },
    { url: 'https://c.com/', title: 'C', visitCount: 1 },
  ], 3);
  assert.deepEqual(got.map((s) => s.url), ['https://a.com/', 'https://b.com/y', 'https://c.com/']);
});

import { openTabFor } from './logic.js';
test('openTabFor: a front-page pin matches the site, a deeper pin only that page', () => {
  const tabs = [{ id: 1, url: 'https://github.com/JuteBags' }, { id: 2, url: 'https://en.wikipedia.org/wiki/Diamond#History' }, { id: 3, url: 'chrome://settings' }];
  assert.equal(openTabFor({ url: 'https://github.com/' }, tabs).id, 1);
  assert.equal(openTabFor({ url: 'https://en.wikipedia.org/wiki/Diamond' }, tabs).id, 2);
  assert.equal(openTabFor({ url: 'https://en.wikipedia.org/wiki/Ruby' }, tabs), null);
  assert.equal(openTabFor({ url: 'https://example.com/' }, tabs), null);
  assert.equal(openTabFor({ url: 'nonsense' }, tabs), null);
});

test('greeting and ago', () => {
  assert.equal(greeting(9), 'Good morning');
  assert.equal(greeting(14, 'Asha'), 'Good afternoon, Asha');
  assert.equal(greeting(22), 'Good evening');
  assert.equal(greeting(2), 'Still up');
  assert.equal(ago(0, 20_000), 'just now');
  assert.equal(ago(0, 12 * 60_000), '12 min ago');
  assert.equal(ago(0, 3 * 3_600_000), '3 h ago');
  assert.equal(ago(0, 48 * 3_600_000), '2 days ago');
  assert.equal(hostOf('https://www.x.org/a'), 'x.org');
});

test('suggest: every word must match, open tabs first, each address once', () => {
  const sources = {
    tabs: [{ id: 7, windowId: 1, url: 'https://github.com/JuteBags', title: 'JuteBags' }, { id: 8, windowId: 1, url: 'chrome://settings', title: 'git settings' }],
    pins: [{ url: 'https://github.com/', title: 'GitHub' }],
    bookmarks: [{ url: 'https://git-scm.com/docs', title: 'Git docs' }, { title: 'A folder called git' }],
    history: [{ url: 'https://github.com/', title: 'GitHub', visitCount: 50, typedCount: 9 }, { url: 'https://example.com/', title: 'Example' }],
  };
  const got = suggest('git', sources);
  assert.deepEqual(got.map((g) => g.url), ['https://github.com/', 'https://github.com/JuteBags', 'https://git-scm.com/docs']);
  assert.equal(got[0].kind, 'pin'); // visited often, and named after the pin, not the history entry
  assert.equal(got[1].kind, 'tab');
  assert.equal(got[1].tabId, 7);
  assert.deepEqual(suggest('git docs', sources).map((g) => g.title), ['Git docs']);
  assert.deepEqual(suggest('   ', sources), []);
  const twice = [{ url: 'https://w.org/wiki/Token', title: 'Chip' }, { url: 'https://w.org/wiki/Chip', title: 'Chip' }];
  assert.equal(suggest('chip', { history: twice }).length, 1);
  assert.equal(suggest('g', { history: Array.from({ length: 20 }, (_, i) => ({ url: `https://g${i}.com/`, title: 'g' })) }).length, 6);
});

import { cleanTodos, monthGrid, zoneName, timeOptions, heaviest, recentPages, WIDGETS } from './logic.js';

test('new settings: clock, to-dos and zones are cleaned', () => {
  const p = readPrefs({ clock: '24', todos: [{ text: ' call ', done: true }, { text: '' }, 'x'], zones: ['Asia/Kolkata', 'Asia/Kolkata', 'not a zone!', 7] });
  assert.equal(p.clock, '24');
  assert.deepEqual(p.todos, [{ text: 'call', done: true }]);
  assert.deepEqual(p.zones, ['Asia/Kolkata']);
  assert.equal(readPrefs({ clock: 'noon' }).clock, 'auto');
  // To do and Notes are among the default cards (owner, Nov 16 2026).
  assert.equal(readPrefs({}).widgets.todo, true);
  assert.equal(new Set(WIDGETS.map((w) => w.id)).size, WIDGETS.length);
  assert.equal(cleanTodos(Array.from({ length: 99 }, () => ({ text: 'a' }))).length, 40);
});

test('monthGrid lays out a month from Monday or Sunday', () => {
  const nov = monthGrid(2026, 10, 1); // November 2026 starts on a Sunday
  assert.deepEqual(nov[0], [0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(nov.at(-1), [30, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(monthGrid(2026, 10, 0)[0], [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(monthGrid(2027, 1, 1).flat().filter(Boolean).length, 28);
});

test('zone names and clock options', () => {
  assert.equal(zoneName('America/Argentina/Buenos_Aires'), 'Buenos Aires');
  assert.deepEqual(timeOptions('auto'), { hour: 'numeric', minute: '2-digit' });
  assert.equal(timeOptions('12').hour12, true);
  assert.equal(timeOptions('24', 'Asia/Tokyo').hourCycle, 'h23');
  const midnight = new Date(2026, 0, 1, 0, 5);
  assert.equal(new Intl.DateTimeFormat('en-US', timeOptions('24')).format(midnight), '00:05');
  assert.match(new Intl.DateTimeFormat('en-GB', timeOptions('12')).format(midnight), /12:05/);
});

test('heaviest tabs and recent pages', () => {
  const tabs = [{ tabId: 1, url: 'https://a.com', memoryMb: 120 }, { tabId: 2, url: 'https://b.com', memoryMb: 480 }, { tabId: 3, url: 'https://c.com', memoryMb: null }, { tabId: 4, url: 'chrome://x', memoryMb: 900 }];
  assert.deepEqual(heaviest(tabs).map((t) => t.tabId), [2, 1]);
  const pages = recentPages([
    { url: 'https://a.com/1', title: 'One', lastVisitTime: 5 },
    { url: 'https://a.com/2', title: 'One', lastVisitTime: 9 },
    { url: 'https://b.com/', title: '', lastVisitTime: 7 },
    { url: 'chrome://history', title: 'History', lastVisitTime: 99 },
  ]);
  assert.deepEqual(pages, [{ url: 'https://a.com/2', title: 'One', at: 9 }, { url: 'https://b.com/', title: 'b.com', at: 7 }]);
});

import { ENGINES, searchUrl, STARTERS, togglePin } from './logic.js';

test('search engines: a chosen one gives an address, none gives the browser default', () => {
  assert.equal(searchUrl('duckduckgo', ' cut diamond '), 'https://duckduckgo.com/?q=cut%20diamond');
  assert.equal(searchUrl('', 'x'), null);
  assert.equal(searchUrl('altavista', 'x'), null);
  assert.equal(readPrefs({ search: 'bing' }).search, 'bing');
  assert.equal(readPrefs({ search: 'altavista' }).search, '');
  assert.equal(ENGINES.length, 4);
});

test('starter sites become pins and come off again', () => {
  assert.equal(STARTERS.length, 9);
  for (const s of STARTERS) assert.ok(cleanPin(s), s.title);
  const mine = [{ url: 'https://example.org/', title: 'Mine' }];
  const on = togglePin(mine, STARTERS[2], true);
  assert.deepEqual(on.map((p) => p.title), ['Mine', 'GitHub']);
  assert.equal(togglePin(on, STARTERS[2], true), on);
  assert.deepEqual(togglePin(on, STARTERS[2], false), mine);
});

test('the card layout: every card once, sizes in range, rubbish dropped', async () => {
  const { readLayout, CARDS, cardSize, readPrefs } = await import('./logic.js');
  // A new page: Recently closed, Right now, Recent sessions, Notes (two wide), To do, then the rest.
  const plain = readLayout(null);
  assert.deepEqual(plain.order.slice(0, 5), ['closed', 'status', 'browsers', 'notes', 'todo']);
  assert.equal(plain.order.length, CARDS.length);
  assert.deepEqual(plain.size, { notes: { w: 2, h: 1 } });
  assert.equal(plain.pack, true);
  assert.equal(readLayout({ pack: false }).pack, false);
  assert.equal(readLayout({ pack: 0 }).pack, true); // only a plain "off" switches it off
  const l = readLayout({ order: ['notes', 'nope', 'top', 'notes', 'clock'], size: { top: { w: 9, h: 2 }, notes: { w: 1, h: 1 }, status: { w: 'x', h: 0 }, nope: { w: 2, h: 2 } } });
  assert.deepEqual(l.order.slice(0, 2), ['notes', 'top']);
  assert.equal(l.order.length, CARDS.length);
  assert.equal(new Set(l.order).size, CARDS.length);
  assert.deepEqual(l.size, { top: { w: 3, h: 2 } });
  assert.deepEqual(cardSize(l, 'top'), { w: 3, h: 2 });
  assert.deepEqual(cardSize(l, 'notes'), { w: 1, h: 1 });
  assert.deepEqual(readPrefs({}).layout, plain);
  assert.deepEqual(readPrefs({ layout: { order: ['status'] } }).layout.order[0], 'status');
});

test('moving a card: before another, to the end, and one step among the shown cards', async () => {
  const { readLayout, moveCard, nudgeCard } = await import('./logic.js');
  const l = readLayout({ order: ['top', 'closed', 'status', 'notes'] });
  assert.deepEqual(moveCard(l, 'status', 'top').order.slice(0, 4), ['status', 'top', 'closed', 'notes']);
  assert.equal(moveCard(l, 'top', null).order.at(-1), 'top');
  assert.equal(moveCard(l, 'top', 'top'), l);
  assert.equal(moveCard(l, 'nope', 'top'), l);
  assert.equal(moveCard(l, 'top', 'nope'), l);
  const shown = ['top', 'status', 'notes']; // "closed" is switched off: a step jumps over it
  assert.deepEqual(nudgeCard(l, 'top', 1, shown).order.slice(0, 4), ['closed', 'status', 'top', 'notes']);
  assert.deepEqual(nudgeCard(l, 'notes', -1, shown).order.slice(0, 4), ['top', 'closed', 'notes', 'status']);
  assert.equal(nudgeCard(l, 'top', -1, shown), l);
  assert.equal(nudgeCard(l, 'notes', 1, shown).order.indexOf('notes') > l.order.indexOf('status'), true);
});

test('resizing a card: kept in range, 1 x 1 is forgotten, the corner snaps to columns and rows', async () => {
  const { readLayout, sizeCard, snapSize, rowsFor } = await import('./logic.js');
  assert.equal(sizeCard(readLayout({ pack: false }), 'top', 2, 2).pack, false);
  let l = sizeCard(readLayout({}), 'top', 2, 2);
  assert.deepEqual(l.size, { top: { w: 2, h: 2 } });
  l = sizeCard(l, 'top', 7, 0);
  assert.deepEqual(l.size, { top: { w: 3, h: 1 } });
  assert.deepEqual(sizeCard(l, 'top', 1, 1).size, {});
  assert.equal(sizeCard(l, 'nope', 2, 2), l);
  const grid = { col: 362, row: 236, gap: 16, cols: 3 };
  assert.deepEqual(snapSize(362, 236, grid), { w: 1, h: 1 });
  assert.deepEqual(snapSize(600, 400, grid), { w: 2, h: 2 });
  assert.deepEqual(snapSize(2000, 2000, grid), { w: 3, h: 2 });
  assert.deepEqual(snapSize(-50, -50, grid), { w: 1, h: 1 });
  assert.deepEqual(snapSize(2000, 100, { ...grid, cols: 2 }), { w: 2, h: 1 });
  assert.deepEqual([rowsFor(1), rowsFor(2)], [5, 11]);
});
