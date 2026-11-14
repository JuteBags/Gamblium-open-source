// Links on darkened websites (owner, Nov 14 2026: "the colour doesn't match... make it cyan or
// something for the links, since pinkish for all doesn't look good").
//
// Forced dark (WebContentsForceDark) darkens a light-only page by turning each colour's
// lightness over in CIELAB: L becomes 110 - L, the colour's a and b stay. Google's link blue
// #1a0dab carries a lot of red in its a, so it comes out a pink lavender, and every light site's
// links with it. Chromium 157 no longer lets the method be chosen, so the extension gives such
// links a colour of its own: the one that comes out as the colour picked once the page is
// darkened (beforeDarkening), set as a user style the page cannot override.

/** Colour choices for links, as they look on a darkened page. "site" leaves links alone. */
export const LINK_SETS = [
  // Colours darkening can really give (a light cyan cannot be had more vivid: the dark colour
  // it comes from holds little colour), so what the swatch shows is what pages show.
  { id: 'cyan', name: 'Cyan', link: '#8acad8', visited: '#9eb7d6' },
  { id: 'blue', name: 'Blue', link: '#8ab4f8', visited: '#b5a8e8' },
  { id: 'green', name: 'Green', link: '#8bd4a5', visited: '#a9c9a0' },
  { id: 'amber', name: 'Amber', link: '#e9c684', visited: '#d6b88c' },
  { id: 'site', name: "The site's own", link: null, visited: null },
];
export const LINK_DEFAULT = 'cyan';

const hex = (n) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');

export function parseHex(text) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(text ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const toHex = ([r, g, b]) => `#${hex(r)}${hex(g)}${hex(b)}`;

// sRGB (D65) <-> CIELAB, as the browser's dark mode filter does it.
const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const WHITE = [0.95047, 1, 1.08883];
const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const fi = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));

export function rgbToLab([r, g, b]) {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / WHITE[0];
  const y = (0.2126729 * R + 0.7151522 * G + 0.072175 * B) / WHITE[1];
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / WHITE[2];
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function labToLinear([L, a, bb]) {
  const fy = (L + 16) / 116;
  const [x, y, z] = [fi(fy + a / 500) * WHITE[0], fi(fy) * WHITE[1], fi(fy - bb / 200) * WHITE[2]];
  return [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
}
export function labToRgb(lab) {
  return labToLinear(lab).map((c) => gam(Math.min(1, Math.max(0, c))));
}
const inGamut = (lab) => labToLinear(lab).every((c) => c >= -0.001 && c <= 1.001);
/** The same lightness and hue with as much colour as sRGB can hold (clipping would turn the hue). */
function fit([L, a, b]) {
  if (inGamut([L, a, b])) return [L, a, b];
  let lo = 0, hi = 1;
  for (let i = 0; i < 20; i++) {
    const k = (lo + hi) / 2;
    if (inGamut([L, a * k, b * k])) lo = k; else hi = k;
  }
  return [L, a * lo, b * lo];
}

/** What forced dark shows for a text colour: lightness turned over (110 - L, at most 100). */
export function darkened(colour) {
  const rgb = parseHex(colour);
  if (!rgb) return null;
  const [L, a, b] = rgbToLab(rgb);
  return toHex(labToRgb([Math.min(110 - L, 100), a, b]));
}

/** The colour to give a link so that, darkened, it shows `wanted`. */
export function beforeDarkening(wanted) {
  const rgb = parseHex(wanted);
  if (!rgb) return null;
  const [L, a, b] = rgbToLab(rgb);
  return toHex(labToRgb(fit([Math.max(0, 110 - L), a, b])));
}

/** What a picked colour will really look like on a darkened page. */
export const shownAs = (wanted) => darkened(beforeDarkening(wanted));

/** The chosen colours ({ set, link, visited } as stored) -> the two shown colours, or null to leave links alone. */
export function linkColours(choice) {
  const c = choice && typeof choice === 'object' ? choice : { set: LINK_DEFAULT };
  if (c.set === 'site') return null;
  const set = LINK_SETS.find((s) => s.id === c.set) || LINK_SETS.find((s) => s.id === LINK_DEFAULT);
  const link = parseHex(c.link) ? c.link : set.link;
  const visited = parseHex(c.visited) ? c.visited : set.visited;
  return link && visited ? { link, visited } : null;
}

/** The user style for marked links (content/darklinks.js marks them). */
export function linkCss(shown) {
  if (!shown) return '';
  const link = beforeDarkening(shown.link);
  const visited = beforeDarkening(shown.visited);
  return `[data-gamblium-link]{color:${link}!important}` +
    `a:visited[data-gamblium-link],a:visited [data-gamblium-link]{color:${visited}!important}`;
}
