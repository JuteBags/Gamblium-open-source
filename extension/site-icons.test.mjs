import test from 'node:test';
import assert from 'node:assert/strict';
import { SITE_ICONS, siteIcon, hostMatches, monogram } from './site-icons.js';
import { STARTERS } from './newtab/logic.js';

test('every site offered on first run has a mark', () => {
  for (const s of STARTERS) assert.ok(siteIcon(s.url), s.title);
});

test('a mark is one path on a 24 unit canvas and nothing else', () => {
  for (const s of SITE_ICONS) {
    assert.match(s.path, /^[MmZzLlHhVvCcSsQqTtAa0-9eE.,\s-]+$/, s.id);
    assert.ok(s.colour === null || /^#[0-9A-F]{6}$/.test(s.colour), s.id);
  }
  assert.equal(new Set(SITE_ICONS.map((s) => s.id)).size, SITE_ICONS.length);
});

test('a site is matched by its host and subdomains, not by a look-alike', () => {
  assert.equal(siteIcon('https://github.com/JuteBags')?.id, 'github');
  assert.equal(siteIcon('https://en.wikipedia.org/wiki/Moon')?.id, 'wikipedia');
  assert.equal(siteIcon('https://www.youtube.com/watch?v=1')?.id, 'youtube');
  assert.equal(siteIcon('https://twitter.com/home')?.id, 'x');
  assert.equal(siteIcon('https://mail.google.com/mail/u/0/')?.id, 'gmail');
  assert.equal(siteIcon('https://www.google.com/')?.id, 'google'); // the search engines, for the welcome page
  assert.equal(siteIcon('https://search.brave.com/search?q=x')?.id, 'bravesearch');
  assert.equal(siteIcon('https://brave.com/'), null);
  assert.equal(siteIcon('https://notx.com/'), null);
  assert.equal(siteIcon('https://github.com.evil.example/'), null);
  assert.equal(siteIcon('not an address'), null);
  assert.equal(siteIcon(undefined), null);
});

test('amazon is matched under any country ending, and nothing that only starts like it', () => {
  for (const h of ['amazon.com', 'www.amazon.in', 'amazon.co.uk', 'smile.amazon.de']) assert.ok(hostMatches(h.replace(/^www\./, ''), 'amazon.*'), h);
  for (const h of ['amazonaws.com', 'amazon.evil.example', 'myamazon.com', '']) assert.equal(hostMatches(h, 'amazon.*'), false, h);
});

test('a site with no icon gets its first letter or digit', () => {
  assert.equal(monogram('intranet', 'https://10.0.0.2/'), 'I');
  assert.equal(monogram('', 'https://example.com/'), 'E');
  assert.equal(monogram('  (9gag)', ''), '9');
  assert.equal(monogram('', ''), '?');
});

test('an icon that would vanish on the surface is caught, a coloured one is not', async () => {
  const { fadesInto, luminance } = await import('./site-icons.js');
  const fill = (r, g, b, a = 255, n = 64) => Uint8ClampedArray.from({ length: n * 4 }, (_, i) => [r, g, b, a][i % 4]);
  const light = luminance(0xEE, 0xF0, 0xF3);
  const dark = luminance(0x03, 0x03, 0x04);
  assert.equal(fadesInto(fill(255, 255, 255), light), true); // GitHub's white mark on the light page
  assert.equal(fadesInto(fill(255, 255, 255), dark), false);
  assert.equal(fadesInto(fill(10, 10, 10), dark), true); // a black mark on the dark page
  assert.equal(fadesInto(fill(255, 0, 0), light), false);
  assert.equal(fadesInto(fill(255, 255, 255, 0), light), false); // nothing opaque: nothing to judge
});
