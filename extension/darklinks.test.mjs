import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LINK_SETS, beforeDarkening, darkened, linkColours, linkCss, parseHex, shownAs } from './darklinks.js';

test("the page stylesheet's own colours are the default choice, before darkening", () => {
  const css = readFileSync(new URL('./content/darklinks.css', import.meta.url), 'utf8');
  const d = linkColours(null);
  assert.match(css, new RegExp(`--gamblium-link, ${beforeDarkening(d.link)}\\)`));
  assert.match(css, new RegExp(`--gamblium-visited, ${beforeDarkening(d.visited)}\\)`));
});

const dist = (a, b) => Math.max(...parseHex(a).map((v, i) => Math.abs(v - parseHex(b)[i])));

test("darkening turns Google's link blue pink, as seen on the owner's screen (#fac3ff)", () => {
  assert.ok(dist(darkened('#1a0dab'), '#fac3ff') <= 8, darkened('#1a0dab'));
});

test('every colour set comes out as the colour its swatch shows', () => {
  for (const s of LINK_SETS.filter((x) => x.link)) {
    assert.ok(dist(shownAs(s.link), s.link) <= 6, `${s.id} link ${s.link} -> ${shownAs(s.link)}`);
    assert.ok(dist(shownAs(s.visited), s.visited) <= 6, `${s.id} visited ${s.visited} -> ${shownAs(s.visited)}`);
  }
});

test('the colour given to links is dark, so the browser does turn it over', () => {
  const [r, g, b] = parseHex(beforeDarkening('#8acad8'));
  assert.ok((299 * r + 587 * g + 114 * b) / 1000 < 128);
});

test('a colour darkening cannot give exactly keeps its hue (less vivid, not another colour)', () => {
  const got = parseHex(shownAs('#00e5ff')); // a vivid cyan
  assert.ok(got[2] > got[0] + 40 && got[1] > got[0] + 40, String(got)); // still cyan, not grey or pink
});

test('choices: cyan by default, the site\'s own leaves links alone, own colours win', () => {
  assert.deepEqual(linkColours(null), { link: '#8acad8', visited: '#9eb7d6' });
  assert.equal(linkColours({ set: 'site' }), null);
  assert.deepEqual(linkColours({ set: 'own', link: '#ff8800', visited: '#aa7744' }), { link: '#ff8800', visited: '#aa7744' });
  assert.deepEqual(linkColours({ set: 'own', link: 'nonsense' }).link, '#8acad8');
  assert.equal(linkCss(null), '');
  assert.match(linkCss(linkColours(null)), /\[data-gamblium-link\]\{color:#[0-9a-f]{6}!important\}/);
  assert.match(linkCss(linkColours(null)), /a:visited\[data-gamblium-link\]/);
});
