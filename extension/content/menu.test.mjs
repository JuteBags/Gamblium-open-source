import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The menu is a classic script; its pure part hands itself over when this object is there.
globalThis.__gambliumMenuTest = {};
new Function(fs.readFileSync(new URL('./menu.js', import.meta.url), 'utf8'))();
const { menuFor, isTorrentLink, cleanLink, destination, highlightLink } = globalThis.__gambliumMenuTest;
// "awake-tab", "shot" and "inspect" are on every web page menu; the first test looks at them.
const ids = (items) => items.flatMap((i) => (i.strip ? i.strip.map((s) => s.id) : i.id && !['awake-tab', 'shot', 'inspect'].includes(i.id) ? [i.id] : []));
const subs = (items) => Object.fromEntries(items.filter((i) => i.sub).map((i) => [i.label, ids(i.sub)]));
const flat = (items) => items.filter((i) => i.id);
const heads = (items) => items.filter((i) => i.head).map((i) => [i.head, i.detail]);

test('a plain right-click: the strip, Keep this tab awake, Screenshot, the three sub-menus, Inspect at the foot', () => {
  const m = menuFor({ page: 'https://a.example/' });
  assert.deepEqual(ids(m), ['back', 'forward', 'reload', 'bookmark']);
  // Keep this tab awake: one click, then Screenshot (one entry; its overlay picks the mode), then the sub-menus.
  assert.equal(m.findIndex((i) => i.id === 'awake-tab'), m.findIndex((i) => i.id === 'shot') - 1);
  assert.equal(m.findIndex((i) => i.id === 'shot'), m.findIndex((i) => i.sub) - 1);
  assert.equal(m.find((i) => i.id === 'awake-tab').check, false);
  assert.equal(menuFor({ page: 'https://a.example/', state: { awakeTab: true } }).find((i) => i.id === 'awake-tab').check, true);
  assert.deepEqual(Object.keys(subs(m)), ['This tab', 'Tools', 'More']);
  assert.deepEqual(heads(m), []);
  // Inspect is last, after a line; nothing on the first level is repeated in a sub-menu.
  assert.equal(m.at(-1).id, 'inspect');
  assert.ok(m.at(-2).sep);
  const deep = m.filter((i) => i.sub).flatMap((i) => i.sub.map((x) => x.id)).filter(Boolean);
  assert.ok(!deep.includes('awake-tab') && !deep.includes('inspect'));
  // Focus is one step down, first in This tab.
  const tab = m.find((i) => i.label === 'This tab').sub;
  assert.equal(tab[0].id, 'focus');
  assert.equal(tab[0].label, 'Focus on this tab');
  assert.equal(menuFor({ page: 'https://a.example/', state: { focused: true } }).find((i) => i.label === 'This tab').sub[0].label, 'Leave focus');
});

test('the everyday entries are on the first level, under a line saying what was clicked', () => {
  const link = menuFor({ link: 'https://www.b.example/x/y?id=7' });
  assert.deepEqual(ids(link).slice(4), ['link-tab', 'link-window', 'link-private', 'link-tor', 'link-copy']);
  assert.deepEqual(heads(link), [['Link', 'b.example/x/y?id=7']]);
  assert.deepEqual(ids(menuFor({ link: 'mailto:someone@example.com' })).slice(4), ['link-copy']);
  assert.deepEqual(ids(menuFor({ link: 'magnet:?xt=urn:btih:abc' })).slice(4), ['link-torrent', 'link-copy']);
  assert.deepEqual(ids(menuFor({ link: 'https://b.example/files/big.iso' })).slice(4), ['link-tab', 'link-window', 'link-private', 'link-tor', 'link-download', 'link-copy']);
  const pic = menuFor({ image: 'https://b.example/p.png', imageSize: '120 × 90' });
  assert.deepEqual(ids(pic).slice(4), ['image-tab', 'image-save', 'image-copy', 'image-address']);
  assert.deepEqual(heads(pic), [['Picture', '120 × 90']]);
  const sel = menuFor({ text: 'hello   world', page: 'https://a.example/' });
  assert.deepEqual(ids(sel).slice(4), ['copy', 'search', 'translate', 'highlight']);
  assert.deepEqual(heads(sel), [['Selection', '"hello world"']]);
  // Cut and Copy stay in their places, greyed, with nothing selected.
  assert.deepEqual(ids(menuFor({ editable: true })).slice(4), ['undo', 'cut', 'copy', 'paste', 'select-all']);
  assert.deepEqual(flat(menuFor({ editable: true })).filter((x) => x.disabled).map((x) => x.id), ['cut', 'copy']);
  assert.deepEqual(ids(menuFor({ editable: true, text: 'abc' })).slice(4), ['undo', 'cut', 'copy', 'paste', 'select-all']);
  // a picture that is a link: both groups, the link first
  assert.deepEqual(heads(menuFor({ link: 'https://b.example/', image: 'https://b.example/p.png' })).map((h) => h[0]), ['Link', 'Picture']);
  // every entry of the first level has a picture of its own, so the eye finds it
  for (const i of [...link, ...pic, ...sel]) if (i.id || i.sub) assert.ok(i.icon || i.check !== undefined, i.label); // a check entry draws its box
});

test('a link that carries tracking is offered clean; the full one is one step down', () => {
  const m = menuFor({ link: 'https://shop.example/item?id=7&utm_source=mail&fbclid=abc' });
  assert.deepEqual(ids(m).slice(4), ['link-tab', 'link-window', 'link-private', 'link-tor', 'link-copy-clean']);
  assert.ok(subs(m).More.includes('link-copy'));
  assert.deepEqual(heads(m), [['Link', 'shop.example/item?id=7']]);
  assert.equal(cleanLink('https://shop.example/item?id=7&utm_source=mail&fbclid=abc'), 'https://shop.example/item?id=7');
  assert.equal(cleanLink('https://shop.example/?utm_medium=x'), 'https://shop.example/');
  assert.equal(cleanLink('https://shop.example/a?ref=front&page=2'), 'https://shop.example/a?ref=front&page=2'); // "ref" may mean something to the site
  assert.equal(cleanLink('mailto:a@example.com?utm_source=x'), 'mailto:a@example.com?utm_source=x');
  assert.equal(cleanLink('not an address'), 'not an address');
  assert.ok(destination('https://www.example.com/' + 'a'.repeat(80)).length <= 44);
});

test('the rest is one step down, and follows the tab', () => {
  const plain = subs(menuFor({ page: 'https://a.example/' }));
  assert.deepEqual(plain.More, ['page-copy', 'page-markdown', 'page-print', 'page-save', 'page-source', 'open-settings']);
  assert.deepEqual(plain['This tab'], ['focus', 'tab-duplicate', 'tab-pin', 'tab-mute', 'sleep-others']);
  const m = menuFor({ image: 'https://b.example/p.png', state: { pinned: true, muted: true, awakeTab: true, awakeSite: false, host: 'a.example', bookmarked: true, tools: [{ id: 'audit', title: 'Audit this page' }] } });
  const tab = m.find((i) => i.label === 'This tab').sub;
  assert.deepEqual(tab.filter((i) => i.id).map((i) => [i.label, i.check]), [['Focus on this tab', undefined], ['Duplicate', undefined], ['Unpin', undefined], ['Unmute', undefined], ['Always keep a.example awake', false], ['Put the other tabs to sleep', undefined]]);
  assert.ok(!subs(m).More.includes('image-address') && ids(m).includes('image-address')); // on the first level now
  assert.deepEqual(subs(m).Tools, ['tool:audit', 'open-dashboard']);
  assert.equal(m[0].strip[3].on, true);
  assert.equal(m[0].strip[3].label, 'Remove the bookmark');
});

test('a link to selected text, and torrent links', () => {
  assert.equal(highlightLink('https://a.example/page#old', '  some  well-chosen words '), 'https://a.example/page#:~:text=some%20well%2Dchosen%20words');
  assert.deepEqual(['magnet:?xt=1', 'https://x.example/a.torrent', 'https://x.example/a.torrent?k=1', 'https://x.example/torrent', 'https://x.example/?f=a.torrent'].map(isTorrentLink), [true, true, true, false, false]);
});

test('a link can be opened in a named session, one step down, only when there are sessions', () => {
  const none = menuFor({ link: 'https://b.example/' });
  assert.equal(none.some((i) => i.label === 'Open in a session'), false);
  const m = menuFor({ link: 'https://b.example/', state: { sessions: [{ name: 'work', state: 'window' }, { name: 'bank', state: 'stopped' }, { name: 'lab', state: 'hidden' }] } });
  const s = m.find((i) => i.label === 'Open in a session');
  assert.deepEqual(s.sub.map((i) => [i.id, i.label, i.keys]), [['session:work', 'work', ''], ['session:bank', 'bank', 'stopped'], ['session:lab', 'lab', 'no window']]);
  assert.equal(m.indexOf(s), m.findIndex((i) => i.id === 'link-tor') + 1);
  // not for a link that is no web address
  assert.equal(menuFor({ link: 'mailto:a@example.com', state: { sessions: [{ name: 'work', state: 'window' }] } }).some((i) => i.label === 'Open in a session'), false);
});

test('our own pages: no bookmark, print, focus or tools; the page adds its own entries', () => {
  const plain = menuFor({ ours: 'newtab', page: 'chrome-extension://x/newtab/index.html' });
  assert.deepEqual(ids(plain), ['back', 'forward', 'reload', 'open-settings']);
  assert.equal(plain.find((i) => i.id === 'focus'), undefined);
  assert.deepEqual(Object.keys(subs(plain)), ['This tab']);
  assert.equal(menuFor({ ours: 'settings' }).find((i) => i.id === 'open-settings'), undefined); // already there

  // A quick-access tile: the link's entries, with the tile's own two in the same group.
  const tile = menuFor({ ours: 'newtab', link: 'https://www.c.example/', extra: { items: [{ id: 'page:0', label: 'Edit' }, { id: 'page:1', label: 'Remove from quick access' }] }, pageItems: [{ id: 'page:2', label: 'Customise this page' }], state: { sessions: [{ name: 'work', state: 'hidden' }] } });
  assert.deepEqual(heads(tile), [['Link', 'c.example']]);
  assert.deepEqual(ids(tile), ['back', 'forward', 'reload', 'link-tab', 'link-window', 'link-private', 'link-tor', 'link-copy', 'page:0', 'page:1', 'page:2', 'open-settings']);
  assert.deepEqual(subs(tile)['Open in a session'], ['session:work']);

  // A link to another of our pages opens in a tab, nothing else; text fields keep their entries.
  assert.deepEqual(ids(menuFor({ ours: 'settings', link: 'chrome-extension://x/ui/shortcuts.html', ownLink: true, linkText: 'Shortcuts' })).slice(3, 4), ['link-tab']);
  assert.deepEqual(ids(menuFor({ ours: 'newtab', link: 'javascript:void 0' })), ['back', 'forward', 'reload', 'open-settings']);
  // On our own pages the entry is live: it answers with a card that says why there is no picture.
  const shot = menuFor({ ours: 'newtab' }).find((i) => i.id === 'shot');
  assert.ok(shot && !shot.disabled);
  assert.deepEqual(ids(menuFor({ ours: 'newtab', editable: true })).slice(3, 8), ['undo', 'cut', 'copy', 'paste', 'select-all']);
});

test('back and forward are greyed when there is nowhere to go; links offer Save as and their text', async () => {
  const strip = (m) => m[0].strip;
  assert.deepEqual(strip(menuFor({ canBack: false, canForward: true })).filter((x) => x.disabled).map((x) => x.id), ['back']);
  assert.deepEqual(strip(menuFor({})).filter((x) => x.disabled).map((x) => x.id), []); // not known: both stay usable
  const more = subs(menuFor({ link: 'https://b.example/x', linkText: 'Read more' })).More;
  assert.ok(more.includes('link-text') && more.includes('link-save'));
  assert.ok(!subs(menuFor({ link: 'mailto:a@b.example' })).More.includes('link-save'));
});

test('Inspect is on the first level, last, in every profile', () => {
  for (const state of [{}, { pentest: true }]) {
    const m = menuFor({ page: 'https://a.example/', state });
    assert.equal(m.at(-1).id, 'inspect');
    assert.ok(!subs(m).More.includes('inspect'));
  }
});
