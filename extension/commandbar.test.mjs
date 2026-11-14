import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggest, asAddress, fit } from './commandbar.js';

const tabs = [
  { id: 1, windowId: 9, title: 'Pull requests · JuteBags/Gamblium', url: 'https://github.com/JuteBags/Gamblium/pulls' },
  { id: 2, windowId: 9, title: 'Inbox (3) - Gmail', url: 'https://mail.google.com/mail/u/0/' },
];

test('actions, tabs, an address or a search', () => {
  assert.equal(suggest('sleep', tabs)[0].id, 'sleep-others');
  assert.equal(suggest('downl', tabs)[0].title, 'Downloads');
  const gm = suggest('gmail', tabs);
  assert.equal(gm[0].kind, 'tab');
  assert.equal(gm[0].tabId, 2);
  assert.equal(gm.at(-1).kind, 'search');
  assert.equal(suggest('github.com/rust-lang', tabs)[0].url, 'https://github.com/rust-lang');
  assert.equal(suggest('pip', tabs).filter((l) => l.kind === 'action').length, 2);
  const s = suggest('how tall is everest', tabs);
  assert.deepEqual([s.length, s[0].kind, s[0].query], [1, 'search', 'how tall is everest']);
  assert.ok(suggest('', tabs).every((l) => l.kind === 'action'));
  assert.ok(suggest('', tabs).length <= 9);
});

test('what counts as an address', () => {
  assert.equal(asAddress('example.org'), 'https://example.org');
  assert.equal(asAddress('localhost:3000/x'), 'http://localhost:3000/x');
  assert.equal(asAddress('chrome://gpu'), 'chrome://gpu');
  assert.equal(asAddress('two words'), null);
  assert.equal(asAddress('v1.2'), null);
  assert.equal(asAddress('file.txt'), 'https://file.txt'); // a dotted name: taken as a site
  assert.equal(fit('dl', 'Downloads files'), 0);
  assert.ok(fit('down', 'Downloads') > fit('load', 'Downloads'));
});
