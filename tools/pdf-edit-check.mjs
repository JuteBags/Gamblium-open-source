// Gamblium PDF, Edit text: only the text changes. A page is made with unusual fonts mixed inside
// its sentences (different sizes, bold, italic, underline, struck through, colours, raised
// text), printed to a PDF by the browser itself, opened in Gamblium PDF and edited with real
// mouse and keyboard input: a click puts the caret at a letter, a double click takes a word,
// dragging and Shift select, typing replaces only the selection. After every edit the page is
// read again and everything that was not edited must be as before: each other letter's font,
// size, colour and place, every other line, and the page's picture outside the edited line.
//
// The fonts, the sentences and the edits are drawn from a seed, so a failure can be run again:
//   node tools/pdf-edit-check.mjs [shots dir] [--seed N] [--edits N] [--pdf file.pdf]
// (--pdf: edit a PDF of your own instead of the made one; nothing of it is kept.)
// Throwaway profile, this checkout's extension, the installed launcher.
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SEEN } from './pdf-check.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9381, SITE = 8781;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const opt = (name, d) => { const k = args.indexOf(`--${name}`); return k >= 0 ? args[k + 1] : d; };
const shots = args[0] && !args[0].startsWith('--') ? args[0] : null;
const SEED = Number(opt('seed', String(Date.now() % 100000)));
const EDITS = Number(opt('edits', '14'));
const OWN_PDF = opt('pdf', null);

// A small seeded generator (mulberry32): the same seed gives the same page and the same edits.
let seed = SEED >>> 0;
const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

const FONTS = ['Comic Sans MS', 'Impact', 'Georgia', 'Consolas', 'Gabriola', 'Segoe Script', 'Palatino Linotype', 'Trebuchet MS', 'Ink Free', 'Bahnschrift', 'Candara', 'Cambria', 'Constantia', 'Corbel', 'Courier New', 'Franklin Gothic Medium', 'Lucida Console', 'Segoe Print', 'Sitka Text', 'Verdana', 'Tahoma', 'Times New Roman', 'Arial', 'Calibri', 'MV Boli', 'Lucida Sans Unicode', 'Garamond', 'Book Antiqua', 'Century Gothic', 'Rockwell', 'Papyrus', 'Brush Script MT', 'Algerian', 'Jokerman', 'Chiller', 'Curlz MT', 'Harrington', 'Magneto', 'Old English Text MT', 'Ravie', 'Showcard Gothic', 'Snap ITC', 'Stencil', 'Vivaldi', 'Arial Black', 'Segoe UI', 'Microsoft Sans Serif', 'Sylfaen', 'Ebrima', 'Gadugi'];
const WORDS = 'quarterly report signature orchard velvet harbour copper lantern meadow thunder willow granite saffron ember quartz juniper marble falcon cinder maple orbit prism ribbon summit tundra umber vortex walnut yonder zephyr Sandhya Session invoice total amount due payment reference agreement between parties hereby'.split(' ');
const COLOURS = ['#111111', '#b3261e', '#0b57d0', '#146c2e', '#6b3fa0', '#8a4b00', '#00677d'];
const SIZES = [9, 11, 12, 14, 18, 24, 30];

/** The page to print: lines of several runs, each run its own font, size, weight, slant,
 *  decoration and colour; a wrapped paragraph; raised and lowered text. `fonts`: installed ones. */
function makeHtml(fonts) {
  const run = () => {
    const css = [`font-family:'${pick(fonts)}'`, `font-size:${pick(SIZES)}pt`, `color:${pick(COLOURS)}`];
    if (rnd() < 0.4) css.push('font-weight:bold');
    if (rnd() < 0.35) css.push('font-style:italic');
    const deco = rnd();
    if (deco < 0.25) css.push('text-decoration:underline');
    else if (deco < 0.32) css.push('text-decoration:line-through');
    if (rnd() < 0.12) css.push(`letter-spacing:${pick([1, 2, 3])}px`);
    const words = Array.from({ length: int(1, 3) }, () => pick(WORDS)).join(' ');
    return `<span style="${css.join(';')}">${words} </span>`;
  };
  const lines = Array.from({ length: 9 }, () => `<p class="one">${Array.from({ length: int(2, 4) }, run).join('')}</p>`);
  const pf = pick(fonts);
  const para = `<p class="para" style="font-family:'${pf}'">${Array.from({ length: 34 }, (_, k) => (k % 7 === 3 ? `<b>${pick(WORDS)}</b>` : k % 9 === 5 ? `<i>${pick(WORDS)}</i>` : k % 11 === 8 ? `<u>${pick(WORDS)}</u>` : pick(WORDS))).join(' ')}.</p>`;
  const sup = `<p class="one" style="font-family:'${pick(fonts)}';font-size:16pt">B.Tech (Hon) 6<sup>th</sup> semester, H<sub>2</sub>O and E = mc<sup>2</sup> <b>stay</b> raised</p>`;
  return `<!doctype html><meta charset="utf-8"><title>Edit text check, seed ${SEED}</title>
<style>@page { size: A4; margin: 14mm; } body { margin: 0; } p { margin: 0 0 9pt; } .one { white-space: nowrap; } .para { width: 150mm; font-size: 11.5pt; line-height: 1.35; }</style>
${lines.slice(0, 5).join('\n')}\n${sup}\n${para}\n${lines.slice(5).join('\n')}`;
}

/** The names inside a TrueType file (family, style, PostScript name), read from its start:
 *  what the browser tells a page about an installed font. null for collections and others. */
function fontNames(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(12 + 16 * 64);
    readSync(fd, head, 0, head.length, 0);
    if (head.readUInt32BE(0) !== 0x00010000) return null;
    let name = null, glyf = false;
    for (let i = 0; i < Math.min(64, head.readUInt16BE(4)); i++) {
      const tag = head.toString('latin1', 12 + 16 * i, 16 + 16 * i);
      if (tag === 'name') name = [head.readUInt32BE(20 + 16 * i), head.readUInt32BE(24 + 16 * i)];
      if (tag === 'glyf') glyf = true;
    }
    if (!name || !glyf || name[1] > 400000) return null;
    const t = Buffer.alloc(name[1]);
    readSync(fd, t, 0, t.length, name[0]);
    const out = {}, strings = t.readUInt16BE(4);
    for (let i = 0; i < t.readUInt16BE(2); i++) {
      const r = 6 + 12 * i, platform = t.readUInt16BE(r), lang = t.readUInt16BE(r + 4), id = t.readUInt16BE(r + 6);
      if (platform !== 3 || lang !== 0x409 || ![1, 2, 6].includes(id)) continue;
      const raw = t.subarray(strings + t.readUInt16BE(r + 10), strings + t.readUInt16BE(r + 10) + t.readUInt16BE(r + 8));
      out[id] = Buffer.from(raw).swap16().toString('utf16le');
    }
    return out[6] ? { family: out[1] || '', style: out[2] || '', postscriptName: out[6] } : null;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const waiting = new Map(); const events = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d.result ?? d.error); waiting.delete(d.id); } else if (d.method) events.push(d); };
  return { events, send: (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); }), close: () => ws.close() };
}
const ev = async (c, expression) => { const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r?.result?.value; };

const KEYS = { Backspace: 8, Delete: 46, Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35 };
async function key(c, name, { shift = false, ctrl = false } = {}) {
  const base = { key: name, code: name, windowsVirtualKeyCode: KEYS[name], nativeVirtualKeyCode: KEYS[name], modifiers: (shift ? 8 : 0) | (ctrl ? 2 : 0) };
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
async function click(c, x, y, { count = 1, shift = false } = {}) {
  const base = { x, y, button: 'left', modifiers: shift ? 8 : 0 };
  for (let n = 1; n <= count; n++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, clickCount: n });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, clickCount: n });
  }
}
async function drag(c, x0, y, x1) {
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y, button: 'left', clickCount: 1 });
  for (let s = 1; s <= 6; s++) await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * s) / 6, y, button: 'left', buttons: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y, button: 'left', clickCount: 1 });
}

// Helpers that run in the viewer page.
const IN_PAGE = `
{ const real = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) return; return real.call(this); }; }
window.__t = {
  // What line li reads as in a file (the one saved by Download, say).
  reads: async (b, li) => { const eng = await import('./engine/gamblium_pdf.js'); return JSON.parse(eng.text_lines(b, 0)).lines[li].chars.map((c) => c[0]).join(''); },
  // How long the engine takes on this file, in the page (ms): reading a page's lines, asking
  // which letters are missing, one edit.
  timing: async (li) => { const eng = await import('./engine/gamblium_pdf.js'); const b = window.__gmbPdf.bytes, sp = Uint32Array.of(li, 1, 2, 0); const t0 = performance.now(); eng.text_lines(b, 0); const t1 = performance.now(); eng.missing_glyphs(b, 0, sp, 'Qz7'); const t2 = performance.now(); eng.edit_text(b, 0, sp, 'Qz7'); const t3 = performance.now(); return [Math.round(t1 - t0), Math.round(t2 - t1), Math.round(t3 - t2), b.length]; },
  // A letter the font of line li cannot write by itself (it must come from elsewhere).
  lacking: async (li) => { const eng = await import('./engine/gamblium_pdf.js'); for (const ch of ['Q', 'Z', 'X', 'J', '7', '4', 'q', 'z']) if (eng.missing_glyphs(window.__gmbPdf.bytes, 0, Uint32Array.of(li, 1, 1, 0), ch) !== '[]') return ch; return null; },
  model: () => window.__gmbPdf.lines(0),
  // Where on screen character k of line li starts (and its line's middle), after scrolling to it.
  spot: (li, k, frac) => {
    const line = document.querySelector('.page[data-i="0"] .eline[data-l="' + li + '"]');
    if (!line) return null;
    line.scrollIntoView({ block: 'center' });
    const L = window.__gmbPdf.lines(0).lines[li], z = window.__gmbPdf.zoom;
    const page = line.closest('.page').getBoundingClientRect(), r = line.getBoundingClientRect();
    const x0 = k < L.chars.length ? L.chars[k][1] : L.x1, x1 = k + 1 < L.chars.length ? L.chars[k + 1][1] : L.x1;
    return { x: page.left + (x0 + (x1 - x0) * frac) * z, y: r.top + r.height / 2 };
  },
  // The selection inside the focused line, counted in characters of its text.
  sel: () => {
    const s = getSelection(), line = document.activeElement?.closest?.('.eline');
    if (!line || !s.rangeCount) return null;
    const r = s.getRangeAt(0), count = (node, off) => { const a = document.createRange(); a.setStart(line, 0); a.setEnd(node, off); return Array.from(a.toString()).length; };
    return { line: Number(line.dataset.l), a: count(r.startContainer, r.startOffset), b: count(r.endContainer, r.endOffset), text: s.toString() };
  },
  state: () => ({ version: window.__gmbPdf.version, edited: window.__gmbPdf.edited, dirty: document.querySelectorAll('.eline.dirty').length, layer: document.querySelector('.page[data-i="0"] .editlayer')?.dataset.v, toast: document.getElementById('toast').textContent, size: window.__gmbPdf.bytes.length }),
  // The page's picture, kept to compare with a later one.
  pix: async () => { const eng = await import('./engine/gamblium_pdf.js'); const v = new eng.Viewer(window.__gmbPdf.bytes.slice()); const px = v.render(0, 1.5); v.free?.(); return px; },
  keep: async () => { window.__t.before = await window.__t.pix(); return true; },
  // Rows of the picture that differ from the kept one, outside the band [y0, y1] (points).
  changedOutside: async (y0, y1) => {
    const a = window.__t.before, b = await window.__t.pix();
    const dv = new DataView(a.buffer, a.byteOffset, 8), w = dv.getUint32(0, true), h = dv.getUint32(4, true);
    if (a.length !== b.length) return { size: true };
    const rows = [];
    for (let y = 0; y < h; y++) {
      if (y >= y0 * 1.5 && y <= y1 * 1.5) continue;
      const o = 8 + y * w * 4;
      for (let x = 0; x < w * 4; x++) if (Math.abs(a[o + x] - b[o + x]) > 2) { rows.push(y); break; }
    }
    return { rows: rows.length, first: rows[0], last: rows[rows.length - 1] };
  },
  // How much of the strip just under a stretch of a line is inked (an underline is a full strip).
  inked: async (x0, x1, y0, y1) => {
    const a = await window.__t.pix();
    const dv = new DataView(a.buffer, a.byteOffset, 8), w = dv.getUint32(0, true);
    let best = 0;
    for (let y = Math.floor(y0 * 1.5); y <= Math.ceil(y1 * 1.5); y++) {
      let n = 0, all = 0;
      for (let x = Math.ceil(x0 * 1.5) + 1; x < Math.floor(x1 * 1.5) - 1; x++) { const o = 8 + (y * w + x) * 4; all++; if (a[o] + a[o + 1] + a[o + 2] < 600) n++; }
      best = Math.max(best, all ? n / all : 0);
    }
    return best;
  },
};
true`;

const tally = {}; // new letters by where their glyph came from
let lentFaces = new Set(); // faces the viewer was given from this computer
const styleKey = (m, s) => (s === -1 ? 'gap' : JSON.stringify(m.styles[s]));
const textOf = (L) => L.chars.map((c) => c[0]).join('');

/** Compares the page before and after one edit of line `li` (characters a..b replaced by
 *  `typed`): returns what is wrong, and notes. */
function compare(before, after, li, a, b, typed) {
  const wrong = [], notes = [];
  const kb = before.lines[li], want = Array.from(textOf(kb));
  // Counted in characters of the line's text; items of the model can hold several characters.
  const items = []; kb.chars.forEach((c, k) => { for (let n = Array.from(c[0]).length; n > 0; n--) items.push(k); });
  const expected = [...want.slice(0, a), ...Array.from(typed), ...want.slice(b)].join('');
  // The edited line is found again by its place: lines keep their order unless one empties.
  if (after.lines.length !== before.lines.length) { wrong.push(`the page has ${after.lines.length} lines, had ${before.lines.length}`); return { wrong, notes }; }
  const ka = after.lines[li];
  if (textOf(ka) !== expected) wrong.push(`line ${li} reads "${textOf(ka)}", expected "${expected}"`);
  for (let k = 0; k < before.lines.length; k++) {
    if (k === li) continue;
    const x = before.lines[k], y = after.lines[k];
    const same = textOf(x) === textOf(y) && x.chars.every((c, n) => y.chars[n] && Math.abs(c[1] - y.chars[n][1]) < 0.02 && styleKey(before, c[2]) === styleKey(after, y.chars[n][2])) && Math.abs(x.base - y.base) < 0.02;
    if (!same) wrong.push(`line ${k} ("${textOf(x).slice(0, 30)}") changed though it was not edited`);
  }
  if (wrong.length) return { wrong, notes };
  // Letters before the edit: same place, same look. After it: same look, moved by one amount.
  const ia = items[a] ?? kb.chars.length, ib = b < items.length ? items[b] : kb.chars.length;
  for (let k = 0; k < ia; k++) {
    const x = kb.chars[k], y = ka.chars[k];
    if (Math.abs(x[1] - y[1]) > 0.02) wrong.push(`"${x[0]}" before the edit moved by ${(y[1] - x[1]).toFixed(2)} pt`);
    if (styleKey(before, x[2]) !== styleKey(after, y[2])) wrong.push(`"${x[0]}" before the edit changed its look: ${styleKey(before, x[2])} -> ${styleKey(after, y[2])}`);
  }
  const tail = kb.chars.length - ib, off = ka.chars.length - tail;
  let delta = null;
  for (let n = 0; n < tail; n++) {
    const x = kb.chars[ib + n], y = ka.chars[off + n];
    if (!y) { wrong.push('letters after the edit are missing'); break; }
    if (styleKey(before, x[2]) !== styleKey(after, y[2])) wrong.push(`"${x[0]}" after the edit changed its look: ${styleKey(before, x[2])} -> ${styleKey(after, y[2])}`);
    const d = y[1] - x[1];
    if (delta === null) delta = d;
    else if (Math.abs(d - delta) > 0.03) wrong.push(`letters after the edit moved unevenly (${delta.toFixed(2)} and ${d.toFixed(2)} pt)`);
  }
  // The new letters look like what they replaced (or the letter before the caret).
  const model = (ia < ib ? kb.chars.slice(ia, ib).find((c) => c[2] !== -1) : null) || [...kb.chars.slice(0, ia)].reverse().find((c) => c[2] !== -1) || kb.chars.slice(ib).find((c) => c[2] !== -1);
  const ms = model ? before.styles[model[2]] : null;
  for (let k = ia; k < off; k++) {
    const y = ka.chars[k];
    if (y[2] === -1 || !ms) continue;
    const s = after.styles[y[2]];
    for (const f of ['bold', 'italic', 'size', 'color', 'generic']) if (s[f] !== ms[f]) wrong.push(`new "${y[0]}" has ${f} ${s[f]}, the text it joined has ${ms[f]}`);
    // Where the new letter came from: the run's own font, the same face elsewhere in the file
    // or on this computer (the same PostScript name), or a standard look-alike.
    const how = s.font === ms.font ? 'own' : s.ps && s.ps === ms.ps ? 'same face' : 'look-alike';
    tally[how] = (tally[how] || 0) + 1;
    if (how === 'look-alike' && lentFaces.has(ms.ps) && y[0].trim()) wrong.push(`new "${y[0]}" is written in ${s.font} though this computer's ${ms.ps} was at hand`);
    else if (how === 'look-alike') notes.push(`"${y[0]}" not in ${ms.font}: written in ${s.font}`);
  }
  if (Math.abs(ka.base - kb.base) > 0.02) wrong.push(`the edited line's baseline moved by ${(ka.base - kb.base).toFixed(2)} pt`);
  if (Math.abs(ka.x0 - kb.x0) > 0.02 && ia > 0) wrong.push(`the edited line's start moved by ${(ka.x0 - kb.x0).toFixed(2)} pt`);
  return { wrong, notes, delta };
}

export async function pdfEditCheck() {
  const problems = [], notes = [];
  let pdf = OWN_PDF ? readFileSync(OWN_PDF) : null, html = '';
  const server = http.createServer((q, r) => {
    if (q.url.startsWith('/fonts.html')) { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return r.end(html); }
    if (q.url.startsWith('/probe.html')) { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return r.end('<!doctype html><title>probe</title>'); }
    if (q.url.startsWith('/fonts.pdf') && pdf) { r.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length }); return r.end(pdf); }
    r.writeHead(404); r.end();
  }).listen(SITE, '127.0.0.1');
  const exe = join(process.env.LOCALAPPDATA, 'Gamblium', 'app', 'gamblium.exe');
  const profile = mkdtempSync(join(tmpdir(), 'gamblium-pdfedit-'));
  const open = async (url, match) => {
    // Twice: the first PDF of a new profile sometimes opens before the extension is up.
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await fetch(`http://127.0.0.1:${PORT}/json/new?${url}`, { method: 'PUT' }).then((r) => r.json());
      for (let i = 0; i < 30; i++) { await sleep(400); const x = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).find((y) => y.id === t.id && y.url.includes(match)); if (x) return connect(x.webSocketDebuggerUrl); }
      await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
    }
    return null;
  };
  try {
    spawnSync(exe, ['launch', '--user-data-dir', profile, '--debug-port', String(PORT), '--', '--window-size=1500,1000', ...SEEN], { env: { ...process.env, GAMBLIUM_HOME: repo, GAMBLIUM_PDF_BY_EXTENSION: '1' } });
    for (let i = 0; i < 60; i++) { await sleep(500); if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then((x) => x.ok, () => false)) break; }
    await sleep(3000);
    if (!pdf) {
      // Which of the fonts this computer has (a font it lacks is as wide as the fallback).
      const probe = await open(`http://127.0.0.1:${SITE}/probe.html`, 'probe.html');
      if (!probe) return { problems: ['the test page did not open'], notes };
      const have = await ev(probe, `(() => { const g = document.createElement('canvas').getContext('2d'); const w = (f) => { g.font = '40px ' + f; return g.measureText('mmmmmmmmmlli WQ@ 0123').width; }; const a = w('monospace'), b = w('serif'); return ${JSON.stringify(FONTS)}.filter((f) => { const x = w("'" + f + "', monospace"), y = w("'" + f + "', serif"); return x !== a || y !== b; }); })()`);
      probe.close();
      // Eight of them, unusual ones first in the draw.
      const fonts = []; const pool = [...have];
      while (fonts.length < 8 && pool.length) fonts.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
      notes.push(`seed ${SEED}; fonts: ${fonts.join(', ')}`);
      html = makeHtml(fonts);
      const pg = await open(`http://127.0.0.1:${SITE}/fonts.html`, 'fonts.html');
      await pg.send('Page.enable');
      await sleep(1200);
      const out = await pg.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
      pg.close();
      if (!out?.data) return { problems: [`the browser did not print the test page to a PDF (${JSON.stringify(out).slice(0, 120)})`], notes };
      pdf = Buffer.from(out.data, 'base64');
      if (shots) { writeFileSync(join(shots, 'edit-fonts.pdf'), pdf); writeFileSync(join(shots, 'edit-fonts.html'), html); }
    }
    const c = await open(`http://127.0.0.1:${SITE}/fonts.pdf`, '/pdf/viewer.html');
    if (!c) return { problems: ['the PDF did not open in Gamblium PDF'], notes };
    await c.send('Runtime.enable');
    await c.send('Page.bringToFront');
    await sleep(3500);
    const errors = () => c.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails?.exception?.description?.split('\n')[0]);
    const shot = async (name) => { if (shots) { const p = await c.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, name), Buffer.from(p.data, 'base64')); } };
    await ev(c, IN_PAGE);
    await ev(c, `document.querySelector('[data-tool=edit]').click()`);
    await sleep(1200);
    const first = await ev(c, `window.__t.model()`);
    const usable = first.lines.map((L, li) => ({ L, li, text: textOf(L) })).filter((x) => x.text.trim().length >= 6);
    if (usable.length < 4) return { problems: [`only ${usable.length} editable lines were found on the page (${first.lines.length} lines in all)`], notes };
    const faces = new Set(first.styles.map((s) => `${s.ps || s.family || s.font}${s.bold ? ' bold' : ''}${s.italic ? ' italic' : ''} ${s.size}`));
    await sleep(800);
    // (The browser's own question about fonts cannot be answered by a script: the check hands the fonts over itself, below.)
    // The fonts of this computer that the page's text is written in, handed to the viewer as
    // the browser would after a person allowed it.
    if (!args.includes('--no-local-fonts')) {
      const wanted = new Set(first.styles.map((x) => x.ps).filter(Boolean));
      const dirs = [join(process.env.WINDIR || 'C:/Windows', 'Fonts'), join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts')];
      const lend = [];
      for (const dir of dirs) {
        let files = [];
        try { files = readdirSync(dir).filter((f) => /\.ttf$/i.test(f)); } catch {}
        for (const f of files) {
          const n = fontNames(join(dir, f));
          if (n && wanted.has(n.postscriptName) && !lend.some((x) => x.postscriptName === n.postscriptName)) lend.push({ ...n, base64: readFileSync(join(dir, f)).toString('base64') });
        }
      }
      for (const f of lend) await ev(c, `(window.__lend ||= []).push(${JSON.stringify(f)}) && true`);
      const lent = lend.length ? await ev(c, `window.__gmbPdf.lendFonts(window.__lend)`) : 0;
      lentFaces = new Set(lend.map((x) => x.postscriptName));
      notes.push(`${lent} of this computer's fonts handed to the viewer: ${lend.map((x) => x.postscriptName).join(', ')}`);
    }
    notes.push(`${usable.length} lines, ${first.styles.length} looks: ${[...faces].slice(0, 14).join(' | ')}`);
    await shot('edit-0-page.png');
    const original = await ev(c, `window.__gmbPdf.bytes.length`);

    const wait = async (v0) => { for (let n = 0; n < 60; n++) { await sleep(150); const s = await ev(c, `window.__t.state()`); if (s.version !== v0 && s.layer === String(s.version)) return s; } return ev(c, `window.__t.state()`); };
    const TYPED = ['yy', '7', 'Quartz', 'Zoë', ' and more', 'X', '42', 'né', 'W', 'kind '];
    const kinds = ['caret', 'word', 'drag', 'shift', 'delete', 'backspace', 'end', 'start'];
    /** One edit through the editor. Returns what went wrong. */
    const one = async (n, kind, li, typed) => {
      const tag = `edit ${n} (${kind}, line ${li})`;
      const before = await ev(c, `window.__t.model()`);
      const L = before.lines[li], len = L.chars.length;
      const real = L.chars.map((ch, k) => (ch[2] !== -1 && ch[0].trim() ? k : -1)).filter((k) => k >= 0);
      const k = real[Math.min(real.length - 1, int(1, Math.max(1, real.length - 2)))];
      await ev(c, `window.__t.keep()`);
      const v0 = (await ev(c, `window.__t.state()`)).version;
      const at = async (kk, frac) => ev(c, `window.__t.spot(${li}, ${kk}, ${frac})`);
      let p = await at(k, 0.2);
      if (!p) return [`${tag}: the line has no editor`];
      await sleep(250);
      p = await at(k, 0.2);
      if (kind === 'word') await click(c, p.x, p.y, { count: 2 });
      else if (kind === 'drag') { const k2 = Math.min(len - 1, k + int(2, 7)); const q = await at(k2, 0.2); await drag(c, p.x, p.y, q.x); }
      else {
        await click(c, p.x, p.y);
        const s0 = await ev(c, `window.__t.sel()`);
        // A click puts the caret at that letter (items of several characters count as one).
        const chars = Array.from(L.chars.slice(0, k).map((x) => x[0]).join('')).length;
        if (!s0) return [`${tag}: a click did not put a caret in the line`];
        if (s0.line !== li || s0.a !== s0.b || Math.abs(s0.a - chars) > 0) return [`${tag}: a click on character ${chars} put the caret at ${s0.a}${s0.a !== s0.b ? ` and selected to ${s0.b}` : ''} of line ${s0.line}`];
        if (kind === 'shift') { const k2 = Math.min(len - 1, k + int(2, 9)); const q = await at(k2, 0.2); await click(c, q.x, q.y, { shift: true }); }
        if (kind === 'delete') for (let d = int(1, 3); d > 0; d--) await key(c, 'ArrowRight', { shift: true });
        if (kind === 'backspace') for (let d = int(1, 3); d > 0; d--) await key(c, 'ArrowLeft', { shift: true });
        if (kind === 'end') await key(c, 'End');
        if (kind === 'start') await key(c, 'Home');
      }
      const sel = await ev(c, `window.__t.sel()`);
      if (await ev(c, `!!document.querySelector('.editline')`)) return [`${tag}: the click opened the box for a whole line instead of putting a caret in the text`];
      if (!sel || sel.line !== li) return [`${tag}: no selection in the line (${JSON.stringify(sel)})`];
      const whole = Array.from(textOf(L)).length;
      if (kind === 'word' && (sel.a === sel.b || (sel.a === 0 && sel.b === whole && /\s/.test(textOf(L).trim())))) return [`${tag}: a double click selected ${sel.a === sel.b ? 'nothing' : 'the whole line'}, not a word`];
      if (kind === 'word' && /\s/.test(sel.text.trim())) return [`${tag}: a double click selected "${sel.text}", more than a word`];
      if (kind === 'end' && sel.a !== whole) return [`${tag}: End put the caret at ${sel.a} of ${whole}`];
      if (kind === 'start' && sel.a !== 0) return [`${tag}: Home put the caret at ${sel.a}`];
      if (kind === 'delete') { await key(c, 'Delete'); typed = ''; }
      else if (kind === 'backspace') { await key(c, 'Backspace'); typed = ''; }
      else await c.send('Input.insertText', { text: typed });
      await sleep(200);
      if (n < 3) await shot(`edit-${n}-typing.png`);
      const mid = await ev(c, `window.__t.state()`);
      if (!mid.dirty) return [`${tag}: after typing the line is not marked as changed`];
      await key(c, 'Enter');
      const s = await wait(v0);
      if (s.version === v0) return [`${tag}: Enter did not change the file (toast: ${s.toast}; errors: ${errors().join(' | ') || 'none'})`];
      const after = await ev(c, `window.__t.model()`);
      const r = compare(before, after, li, sel.a, sel.b, typed);
      const out = r.wrong.map((w) => `${tag}, "${sel.text || ''}" -> "${typed}": ${w}`);
      r.notes.forEach((x) => notes.push(`${tag}: ${x}`));
      // The picture of the page outside the edited line is the same.
      const px = await ev(c, `window.__t.changedOutside(${L.y0 - L.size * 0.35}, ${L.y1 + L.size * 0.35})`);
      if (px.size || px.rows) out.push(`${tag}: the page's picture changed outside the edited line (${px.rows} rows, ${px.first}..${px.last})`);
      if (n < 3) await shot(`edit-${n}-done.png`);
      // Undo brings the file back to the byte.
      await ev(c, `document.getElementById('undo').click()`);
      const u = await wait(s.version);
      const back = await ev(c, `window.__t.model()`);
      if (JSON.stringify(back) !== JSON.stringify(before)) out.push(`${tag}: Undo did not bring the page back`);
      if (u.size !== original) out.push(`${tag}: after Undo the file is ${u.size} bytes, was ${original}`);
      // Redo makes the edit again, Undo takes it back again.
      if (n % 4 === 0) {
        await ev(c, `document.getElementById('redo').click()`);
        const r2 = await wait(u.version);
        if (JSON.stringify(await ev(c, `window.__t.model()`)) !== JSON.stringify(after)) out.push(`${tag}: Redo did not make the edit again`);
        await ev(c, `document.getElementById('undo').click()`);
        const u2 = await wait(r2.version);
        if (u2.size !== original) out.push(`${tag}: Undo after Redo did not bring the file back`);
      }
      return out;
    };
    let done = 0;
    for (let n = 0; n < EDITS; n++) {
      const kind = kinds[n % kinds.length], line = pick(usable);
      const res = await one(n, kind, line.li, pick(TYPED));
      problems.push(...res);
      done++;
      if (problems.length > 12) break;
    }
    notes.push(`${done} edits made; new letters: ${tally.own || 0} in the run's own font, ${tally['same face'] || 0} in the same face (from elsewhere in the file or from this computer), ${tally['look-alike'] || 0} in a standard look-alike`);

    {
      const [lines, missing, edit, size] = await ev(c, `window.__t.timing(${usable[0].li})`);
      notes.push(`engine in the page, ${(size / 1024).toFixed(0)} KB file: lines of a page ${lines} ms, missing letters ${missing} ms, one edit ${edit} ms`);
      if (lines > 1500 || edit > 2500) problems.push(`the engine is slow on this file (lines ${lines} ms, edit ${edit} ms)`);
    }
    // Leaving the line without Enter keeps the change too. A click on Download right after
    // typing saves the typed text, also when a letter had to be fetched from another font; a
    // click on the empty page keeps it as well.
    for (const how of ['download', 'download with a letter from another font', 'click on the page']) {
      const line = usable[how === 'click on the page' ? 2 : 1];
      const lack = how.includes('letter') ? await ev(c, `window.__t.lacking(${line.li})`) : null;
      if (how.includes('letter') && !lack) { notes.push(`"${how}": the line's own font has every letter tried`); continue; }
      const typed = lack || line.text.trim()[0];
      const v0 = (await ev(c, `window.__t.state()`)).version;
      let p = await ev(c, `window.__t.spot(${line.li}, 1, 0.2)`); await sleep(200); p = await ev(c, `window.__t.spot(${line.li}, 1, 0.2)`);
      await click(c, p.x, p.y);
      const s0 = await ev(c, `window.__t.sel()`);
      await c.send('Input.insertText', { text: typed });
      const tx = Array.from(line.text), want = [...tx.slice(0, s0?.a ?? 1), ...Array.from(typed), ...tx.slice(s0?.a ?? 1)].join('');
      if (how === 'click on the page') {
        const q = await ev(c, `(() => { const r = document.querySelector('.page[data-i="0"]').getBoundingClientRect(), st = document.getElementById('stage').getBoundingClientRect(); return { x: Math.min(r.right - 12, st.right - 30), y: Math.min(st.bottom - 30, Math.max(st.top + 80, r.top + 12)) }; })()`);
        await click(c, q.x, q.y);
        const s = await wait(v0);
        if (s.version === v0) problems.push('clicking on the page after typing did not keep the change');
        else if (textOf((await ev(c, `window.__t.model()`)).lines[line.li]) !== want) problems.push(`after a click on the page the line reads "${textOf((await ev(c, `window.__t.model()`)).lines[line.li])}", expected "${want}"`);
      } else {
        const d = await ev(c, `(() => { const r = document.getElementById('download').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        await click(c, d.x, d.y);
        await wait(v0);
        await sleep(400);
        const saved = await ev(c, `window.__gmbPdf.lastSaved ? window.__t.reads(window.__gmbPdf.lastSaved, ${line.li}) : null`);
        if (saved !== want) problems.push(`${how}: the saved file reads "${saved}", not "${want}" (the typed text was not in what Download saved)`);
      }
      const now = (await ev(c, `window.__t.state()`)).version;
      if (now !== v0) { await ev(c, `document.getElementById('undo').click()`); await wait(now); }
    }
    // Esc drops what was typed: nothing changes.
    {
      const line = usable[0];
      const v0 = (await ev(c, `window.__t.state()`)).version;
      const p = await ev(c, `window.__t.spot(${line.li}, 2, 0.2)`);
      await sleep(200);
      const p2 = await ev(c, `window.__t.spot(${line.li}, 2, 0.2)`);
      await click(c, (p2 || p).x, (p2 || p).y);
      await c.send('Input.insertText', { text: 'dropped' });
      await key(c, 'Escape');
      await sleep(600);
      const s = await ev(c, `({ ...window.__t.state(), tool: document.body.dataset.tool, text: document.querySelector('.eline[data-l="${line.li}"]')?.textContent })`);
      if (s.version !== v0 || s.dirty) problems.push(`Esc did not drop the typing (version ${v0} -> ${s.version}, ${s.dirty} lines still changed)`);
      if (s.tool !== 'edit') problems.push(`Esc in a line left the Edit text tool (${s.tool})`);
      if (s.text !== line.text) problems.push(`after Esc the line shows "${s.text}", not "${line.text}"`);
    }
    // Two lines changed, then Enter: one step, both in the file; arrow down moves between lines.
    {
      const [x, y] = [usable[1], usable[2]];
      const before = await ev(c, `window.__t.model()`);
      const v0 = (await ev(c, `window.__t.state()`)).version;
      let p = await ev(c, `window.__t.spot(${x.li}, 1, 0.2)`); await sleep(200); p = await ev(c, `window.__t.spot(${x.li}, 1, 0.2)`);
      await click(c, p.x, p.y);
      await c.send('Input.insertText', { text: 'A' });
      await key(c, 'ArrowDown');
      const s1 = await ev(c, `window.__t.sel()`);
      if (!s1 || s1.line === x.li) problems.push(`Arrow down stayed in line ${x.li} (${JSON.stringify(s1)})`);
      let q = await ev(c, `window.__t.spot(${y.li}, 3, 0.2)`); await sleep(200); q = await ev(c, `window.__t.spot(${y.li}, 3, 0.2)`);
      await click(c, q.x, q.y);
      await c.send('Input.insertText', { text: 'B' });
      const mid = await ev(c, `window.__t.state()`);
      if (mid.version !== v0) problems.push('moving to another line of the page already changed the file (it should wait for Enter)');
      if (mid.dirty !== 2) problems.push(`${mid.dirty} lines are marked changed, not 2`);
      await key(c, 'Enter');
      const s = await wait(v0);
      const after = await ev(c, `window.__t.model()`);
      const tx = Array.from(x.text), ty = Array.from(y.text);
      const cx = Array.from(before.lines[x.li].chars.slice(0, 1).map((ch) => ch[0]).join('')).length, cy = Array.from(before.lines[y.li].chars.slice(0, 3).map((ch) => ch[0]).join('')).length;
      const wantX = [...tx.slice(0, cx), 'A', ...tx.slice(cx)].join(''), wantY = [...ty.slice(0, cy), 'B', ...ty.slice(cy)].join('');
      if (textOf(after.lines[x.li]) !== wantX || textOf(after.lines[y.li]) !== wantY) problems.push(`two lines edited in one go read "${textOf(after.lines[x.li])}" and "${textOf(after.lines[y.li])}", expected "${wantX}" and "${wantY}"`);
      await ev(c, `document.getElementById('undo').click()`);
      const u = await wait(s.version);
      if (u.size !== original) problems.push('one Undo did not take back both lines');
    }
    // Underlines follow the text: under an underlined run that grew, the line is still whole.
    if (!OWN_PDF) {
      const under = await ev(c, `(async () => {
        const m = window.__t.model(), out = [];
        for (let li = 0; li < m.lines.length && out.length < 3; li++) {
          const L = m.lines[li]; let k = 0;
          while (k < L.chars.length) {
            let e = k; while (e + 1 < L.chars.length && (L.chars[e + 1][2] === L.chars[k][2] || L.chars[e + 1][2] === -1)) e++;
            const x0 = L.chars[k][1], x1 = e + 1 < L.chars.length ? L.chars[e + 1][1] : L.x1;
            if (L.chars[k][2] !== -1 && e - k >= 5 && x1 - x0 > 30 && x1 < window.__gmbPdf.pageWidth(0) - 110) { const ink = await window.__t.inked(x0 + 2, x1 - 6, L.base + L.size * 0.03, L.base + L.size * 0.22); if (ink > 0.97) { out.push({ li, k, e, x0, x1, base: L.base, size: L.size }); break; } }
            k = e + 1;
          }
        }
        return out;
      })()`);
      notes.push(`${under.length} underlined runs found`);
      for (const u of under.slice(0, 2)) {
        const v0 = (await ev(c, `window.__t.state()`)).version;
        const kk = u.k + 3;
        let p = await ev(c, `window.__t.spot(${u.li}, ${kk}, 0.2)`); await sleep(200); p = await ev(c, `window.__t.spot(${u.li}, ${kk}, 0.2)`);
        await click(c, p.x, p.y);
        await c.send('Input.insertText', { text: 'WWWW' });
        await key(c, 'Enter');
        const s = await wait(v0);
        const res = await ev(c, `(async () => { const L = window.__t.model().lines[${u.li}]; const x1 = ${u.e} + 5 < L.chars.length ? L.chars[${u.e} + 5][1] : L.x1; return { x1, ink: await window.__t.inked(${u.x0} + 2, x1 - 6, L.base + L.size * 0.03, L.base + L.size * 0.22) }; })()`);
        if (res.x1 - u.x1 < 5) problems.push(`underline check: the run did not grow (${u.x1} -> ${res.x1})`);
        else if (res.ink < 0.97) problems.push(`the underline under line ${u.li} did not follow the longer text (only ${(res.ink * 100).toFixed(0)}% of the run is underlined)`);
        await shot(`edit-underline-${u.li}.png`);
        await ev(c, `document.getElementById('undo').click()`);
        await wait(s.version);
      }
    }
    const errs = errors();
    if (errs.length) problems.push(`errors in the viewer: ${[...new Set(errs)].slice(0, 4).join(' | ')}`);
    c.close();
  } finally {
    spawnSync(exe, ['close', '--user-data-dir', profile]);
    await sleep(800);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
    server.close();
  }
  return { problems, notes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (shots) mkdirSync(shots, { recursive: true });
  const { problems, notes } = await pdfEditCheck();
  for (const n of notes) console.log(`  note: ${n}`);
  console.log(problems.length ? `PDF EDIT CHECK FAILED (seed ${SEED}):\n  ${problems.join('\n  ')}` : `PDF EDIT CHECK PASSED (seed ${SEED})`);
  process.exit(problems.length ? 1 : 0);
}
