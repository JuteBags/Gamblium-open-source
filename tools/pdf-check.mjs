// Gamblium PDF: a PDF served by a site opens in our viewer, its pages are drawn, and the tools
// change the file (watermark, delete, merge, highlight, rotate, undo). Throwaway profile, this
// checkout's extension. Also run by tools/gate.mjs. Usage: node tools/pdf-check.mjs [shots dir]
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9379, SITE = 8779;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A test window under the person's own windows must still count as shown: Windows marks a covered
// window hidden, and a hidden viewer lets its pixels go (Sign then placed nothing; Nov 16 2026).
// Test windows only, never a person's browser.
export const SEEN = ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'];

// A small two-page PDF written by hand.
export function samplePdf(mixed = false) {
  const esc = (t) => t.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = (n) => [
    '0.11 0.33 0.62 rg 0 772 612 20 re f',
    `0 g BT /F2 26 Tf 56 720 Td (${esc(n === 1 ? 'Quarterly Report' : 'Terms and signature')}) Tj ET`,
    ...Array.from({ length: 12 }, (_, i) => `0.15 g BT /F1 11 Tf 56 ${680 - i * 18} Td (${esc(`Line ${i + 1} of page ${n}: text for testing the viewer.`)}) Tj ET`),
    n === 1 && mixed ? '0.15 g BT /F1 11 Tf 56 250 Td (Signed by ) Tj /F2 11 Tf (Asha Rao) Tj /F1 11 Tf ( for the board.) Tj ET' : '',
    n === 1 ? '0.2 0.6 0.35 rg 56 300 60 120 re f 0.85 0.55 0.15 rg 136 300 60 160 re f 0.11 0.33 0.62 rg 216 300 60 200 re f' : '0 G 120 376 m 320 376 l S',
  ].join('\n');
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const cat = add(''), pages = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const kids = [1, 2].map((n) => { const c = content(n); const s = add(`<< /Length ${Buffer.byteLength(c)} >>\nstream\n${c}\nendstream`); return add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${s} 0 R >>`); });
  objs[cat - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  objs[pages - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count 2 >>`;
  let out = '%PDF-1.7\n';
  const offs = objs.map((o, i) => { const at = Buffer.byteLength(out); out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const x = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out);
}

// One page with a picture (2 x 2 pixels, drawn 200 x 100 points at 100, 500).
function picturePdf() {
  const pix = Buffer.from([255, 0, 0, 0, 160, 0, 0, 0, 255, 240, 200, 0]);
  const content = 'q 200 0 0 100 100 500 cm /Im1 Do Q';
  let out = Buffer.from('%PDF-1.7\n');
  const offs = [];
  const push = (b) => { out = Buffer.concat([out, Buffer.isBuffer(b) ? b : Buffer.from(b)]); };
  const plain = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>'];
  plain.forEach((o, i) => { offs.push(out.length); push(`${i + 1} 0 obj\n${o}\nendobj\n`); });
  offs.push(out.length);
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pix.length} >>\nstream\n`);
  push(pix);
  push('\nendstream\nendobj\n');
  offs.push(out.length);
  push(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  const x = out.length;
  push(`xref\n0 6\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`);
  return out;
}

// One page with a form: a text field "name" and a check box "agree" (with its two appearances).
function formPdf() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R 5 0 R] >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Annots [4 0 R 5 0 R] /Resources << /Font << /F1 9 0 R >> >> >>',
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [150 680 400 700] /P 3 0 R >>',
    '<< /Type /Annot /Subtype /Widget /FT /Btn /T (agree) /Rect [150 640 164 654] /AS /Off /AP << /N << /Off 7 0 R /Yes 8 0 R >> >> /P 3 0 R >>',
  ];
  const content = 'BT /F1 14 Tf 72 684 Td (Your name) Tj 0 -40 Td (I agree) Tj ET';
  let out = '%PDF-1.7\n';
  const offs = [];
  const add = (body) => { offs.push(Buffer.byteLength(out)); out += `${offs.length} 0 obj\n${body}\nendobj\n`; };
  objs.forEach(add);
  add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  add('<< /Type /XObject /Subtype /Form /BBox [0 0 14 14] /Length 0 >>\nstream\n\nendstream');
  const tick = '0 g 3 3 8 8 re f';
  add(`<< /Type /XObject /Subtype /Form /BBox [0 0 14 14] /Length ${tick.length} >>\nstream\n${tick}\nendstream`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const x = Buffer.byteLength(out);
  out += `xref\n0 ${offs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${offs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out);
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const waiting = new Map(); const events = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d.result ?? d.error); waiting.delete(d.id); } else if (d.method) events.push(d); };
  return { events, send: (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); }), close: () => ws.close() };
}
const ev = async (c, expression) => (await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.value;

export async function pdfCheck(shots = null) {
  const problems = [];
  const pdf = samplePdf(true); // with a line of three runs (regular, bold, regular) for Edit text
  const server = http.createServer((q, r) => {
    if (q.url.startsWith('/report.pdf')) { r.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length }); return r.end(pdf); }
    // A real locked file (RC4 128-bit, reader password "open sesame"), as banks send statements.
    if (q.url.startsWith('/locked.pdf')) { const b = readFileSync(join(repo, 'tools', 'fixtures', 'locked-rc4.pdf')); r.writeHead(200, { 'content-type': 'application/pdf', 'content-length': b.length }); return r.end(b); }
    if (q.url.startsWith('/form.pdf')) { const b = formPdf(); r.writeHead(200, { 'content-type': 'application/pdf', 'content-length': b.length }); return r.end(b); }
    if (q.url.startsWith('/picture.pdf')) { const b = picturePdf(); r.writeHead(200, { 'content-type': 'application/pdf', 'content-length': b.length }); return r.end(b); }
    if (q.url.startsWith('/attach.pdf')) { r.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="a.pdf"' }); return r.end(pdf); }
    r.writeHead(404); r.end();
  }).listen(SITE, '127.0.0.1');
  const exe = join(process.env.LOCALAPPDATA, 'Gamblium', 'app', 'gamblium.exe');
  const profile = mkdtempSync(join(tmpdir(), 'gamblium-pdfchk-'));
  try {
    spawnSync(exe, ['launch', '--user-data-dir', profile, '--debug-port', String(PORT), '--', '--window-size=1400,950', ...SEEN], { env: { ...process.env, GAMBLIUM_HOME: repo, GAMBLIUM_PDF_BY_EXTENSION: '1' } });
    for (let i = 0; i < 60; i++) { await sleep(500); if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then((x) => x.ok, () => false)) break; }
    await sleep(3000);
    const t = await fetch(`http://127.0.0.1:${PORT}/json/new?http://127.0.0.1:${SITE}/report.pdf`, { method: 'PUT' }).then((r) => r.json());
    let viewerTab = null;
    for (let i = 0; i < 30 && !viewerTab; i++) { await sleep(500); viewerTab = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).find((x) => x.id === t.id && x.url.includes('/pdf/viewer.html')); }
    if (!viewerTab) return ['a PDF from a website did not open in Gamblium PDF'];
    const c = await connect(viewerTab.webSocketDebuggerUrl);
    await c.send('Runtime.enable');
    await c.send('Page.bringToFront');
    await sleep(4000);
    const errors = () => c.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails?.exception?.description?.split('\n')[0]);
    const state = () => ev(c, `({ pages: window.__gmbPdf?.pages ?? -1, edited: window.__gmbPdf?.edited, drawn: [...document.querySelectorAll('.page canvas.pix')].filter((x) => x.width > 50).length, ink: (() => { const x = document.querySelector('.page canvas.pix'); if (!x || !x.width) return 0; const t = document.createElement('canvas'); t.width = x.width; t.height = x.height; const g = t.getContext('2d'); g.drawImage(x, 0, 0); const d = g.getImageData(0, 0, x.width, x.height).data; let n = 0; for (let k = 0; k < d.length; k += 4 * 97) if (d[k] < 200) n++; return n; })(), title: document.title })`);
    let s = await state();
    if (s.pages !== 2) problems.push(`the viewer shows ${s.pages} pages, not 2`);
    if (s.drawn < 1) problems.push('no page was drawn');
    // Every tool of the rail fits on screen (no scrolling to reach one).
    const railFits = await ev(c, `(() => { const r = document.querySelector('.rail'); return r.scrollHeight <= r.clientHeight + 1; })()`);
    if (!railFits) problems.push('the tool rail overflows: some tools are off screen');
    if (s.ink < 20) problems.push('the drawn page is blank');
    // What is on screen, not only in the page: the welcome screen is gone and page 1 is the
    // element at the middle of the stage.
    const onTop = await ev(c, `(() => { const st = document.getElementById('stage').getBoundingClientRect(); const e = document.elementFromPoint(st.x + st.width / 2, st.y + 200); return { start: getComputedStyle(document.getElementById('start')).display, hit: e?.closest('.page') ? 'page' : (e?.className || e?.tagName) }; })()`);
    if (onTop.start !== 'none') problems.push('the welcome screen is still shown over the PDF');
    if (onTop.hit !== 'page') problems.push(`the middle of the screen shows "${onTop.hit}", not the page`);
    if (shots) { const p = await c.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, 'pdf-1-open.png'), Buffer.from(p.data, 'base64')); }
    // Text: words found, selectable, searchable.
    const words0 = await ev(c, `window.__gmbPdf.words(0).map((w) => w[0]).join(' ')`);
    if (!/Quarterly Report/.test(words0 || '')) problems.push(`the engine did not find the page's words (${String(words0).slice(0, 60)})`);
    const selected = await ev(c, `(() => { const spans = [...document.querySelectorAll('.page .textlayer span')]; if (spans.length < 2) return 'no text layer'; const r = document.createRange(); r.setStart(spans[0].firstChild, 0); r.setEnd(spans[1].firstChild, spans[1].textContent.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); const t = s.toString(); s.removeAllRanges(); return t; })()`);
    if (!/Quarterly Report/.test(selected || '')) problems.push(`selecting the title gives "${selected}"`);
    await ev(c, `(() => { const f = document.getElementById('find'); f.value = 'testing the viewer'; f.dispatchEvent(new Event('input')); })()`);
    await sleep(1200);
    const found = await ev(c, `({ n: window.__gmbPdf.hits, label: document.getElementById('findCount').textContent, boxes: document.querySelectorAll('.hit').length })`);
    if (found.n !== 24) problems.push(`search for "testing the viewer" found ${found.n}, not 24 (${found.label})`);
    if (!found.boxes) problems.push('search found matches but marks none on the page');
    await ev(c, `(() => { const f = document.getElementById('find'); f.value = ''; f.dispatchEvent(new Event('input')); })()`);
    await sleep(500);
    // Edit text, with a real mouse and keyboard: a click puts the caret at a letter, a double
    // click takes a word, typing changes only that; the other letters keep their place and font.
    await ev(c, `document.querySelector('[data-tool=edit]').click()`);
    await sleep(800);
    {
      const model = () => ev(c, `window.__gmbPdf.lines(0)`);
      const text = (L) => L.chars.map((x) => x[0]).join('');
      const fonts = (li) => ev(c, `(async () => { const eng = await import('./engine/gamblium_pdf.js'); return eng.line_fonts(window.__gmbPdf.bytes, 0, ${li}); })()`);
      // Where character k of line li is on screen (a fifth into the letter), after scrolling to it.
      const spot = async (li, k) => {
        const at = () => ev(c, `(() => { const e = document.querySelector('.page .eline[data-l="${li}"]'); if (!e) return null; e.scrollIntoView({ block: 'center' }); const L = window.__gmbPdf.lines(0).lines[${li}], z = window.__gmbPdf.zoom, p = e.closest('.page').getBoundingClientRect(), r = e.getBoundingClientRect(); const x0 = L.chars[${k}][1], x1 = ${k} + 1 < L.chars.length ? L.chars[${k} + 1][1] : L.x1; return { x: p.left + (x0 + (x1 - x0) * 0.2) * z, y: r.top + r.height / 2 }; })()`);
        await at(); await sleep(250);
        return at();
      };
      const mouse = async (p, count = 1) => { for (let n = 1; n <= count; n++) for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: n }); };
      const press = async (key, code) => { for (const type of ['rawKeyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code }); };
      const caret = () => ev(c, `(() => { const s = getSelection(), e = document.activeElement?.closest?.('.eline'); if (!e || !s.rangeCount) return null; const r = s.getRangeAt(0), n = (node, off) => { const a = document.createRange(); a.setStart(e, 0); a.setEnd(node, off); return a.toString().length; }; return { line: Number(e.dataset.l), a: n(r.startContainer, r.startOffset), b: n(r.endContainer, r.endOffset), text: s.toString() }; })()`);
      const kept = async (v0) => { for (let n = 0; n < 40; n++) { await sleep(150); const v = await ev(c, `({ v: window.__gmbPdf.version, layer: document.querySelector('.page .editlayer')?.dataset.v })`); if (v.v !== v0 && v.layer === String(v.v)) return true; } return false; };
      const before = await model();
      const title = before.lines.findIndex((L) => text(L) === 'Quarterly Report');
      const body = before.lines.findIndex((L) => text(L).startsWith('Line 1 of page 1'));
      const mixed = before.lines.findIndex((L) => text(L) === 'Signed by Asha Rao for the board.');
      if (title < 0 || body < 0 || mixed < 0) problems.push(`Edit text does not see the page's lines (${before.lines.map(text).join(' | ').slice(0, 160)})`);
      else {
        // 1. A double click on "Report" takes that word only; "Summary" typed over it stays bold.
        let v0 = await ev(c, `window.__gmbPdf.version`);
        await mouse(await spot(title, 12), 2);
        const word = await caret();
        if (!word || word.text.trim() !== 'Report') problems.push(`a double click on "Report" selected "${word?.text}" (a click must not take the whole line)`);
        await c.send('Input.insertText', { text: 'Summary' });
        await sleep(200);
        if (shots) { const p = await c.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, 'pdf-0-editing.png'), Buffer.from(p.data, 'base64')); }
        await press('Enter', 13);
        if (!(await kept(v0))) problems.push(`Enter did not keep the edited title (${await ev(c, `document.getElementById('toast').textContent`)})`);
        let after = await model();
        if (text(after.lines[title]) !== 'Quarterly Summary') problems.push(`the title reads "${text(after.lines[title])}", not "Quarterly Summary"`);
        const tf = await fonts(title);
        if (!tf || !tf.split('|').every((f) => f.startsWith('F2:Helvetica-Bold:bold:26.00'))) problems.push(`the edited bold title is not all in its own bold font (${tf.split('|').filter((f, n, all) => all.indexOf(f) === n).join(', ')})`);
        const moved = before.lines[title].chars.slice(0, 10).some((x, n) => Math.abs(x[1] - after.lines[title].chars[n][1]) > 0.02);
        if (moved || Math.abs(before.lines[title].base - after.lines[title].base) > 0.02) problems.push('the letters of the title that were not edited moved');
        if (JSON.stringify(before.lines[body]) !== JSON.stringify(after.lines[body])) problems.push('a line that was not edited changed');
        const keptFont = await ev(c, `(async () => { const eng = await import('./engine/gamblium_pdf.js'); return eng.font_for_text(window.__gmbPdf.bytes, 0, 'Quarterly Summary'); })()`);
        if (keptFont !== 'Helvetica-Bold') problems.push(`the edited bold title became ${keptFont}, not Helvetica-Bold`);
        // 2. A click puts the caret at that letter: after "Line 1", "23" typed there. The letters
        //    before keep their place, the letters after move by one amount, the font stays.
        v0 = await ev(c, `window.__gmbPdf.version`);
        await mouse(await spot(body, 6));
        const at = await caret();
        if (!at || at.line !== body || at.a !== 6 || at.b !== 6) problems.push(`a click on the 7th character put the caret at ${JSON.stringify(at)}, not at 6`);
        await c.send('Input.insertText', { text: '23' });
        await press('Enter', 13);
        await kept(v0);
        const b2 = after; after = await model();
        const was = b2.lines[body], now = after.lines[body];
        if (!text(now).startsWith('Line 123 of page 1')) problems.push(`after typing 23 at the caret the line reads "${text(now).slice(0, 30)}"`);
        else {
          if (was.chars.slice(0, 6).some((x, n) => Math.abs(x[1] - now.chars[n][1]) > 0.02)) problems.push('typing at a caret moved the letters before it');
          const shifts = was.chars.slice(6).map((x, n) => now.chars[n + 8][1] - x[1]);
          if (shifts.some((d) => Math.abs(d - shifts[0]) > 0.03) || Math.abs(shifts[0] - 2 * 11 * 0.556) > 0.05) problems.push(`the letters after the caret did not move by the width of what was typed (${shifts[0]?.toFixed(2)} pt)`);
          const bf = await fonts(body);
          if (!bf.split('|').every((f) => f.startsWith('F1:Helvetica:regular:11.00'))) problems.push(`the edited line is not all in its own font (${bf.slice(0, 80)})`);
        }
        // 3. Inside a line of three runs (regular, bold, regular): the bold name is changed, the
        //    runs around it keep their font, their letters and the order.
        v0 = await ev(c, `window.__gmbPdf.version`);
        await mouse(await spot(mixed, 16), 2); // "Rao"
        const name = await caret();
        if (!name || name.text.trim() !== 'Rao') problems.push(`a double click on "Rao" selected "${name?.text}"`);
        await c.send('Input.insertText', { text: 'Mehta' });
        await press('Enter', 13);
        await kept(v0);
        after = await model();
        if (text(after.lines[mixed]) !== 'Signed by Asha Mehta for the board.') problems.push(`the mixed line reads "${text(after.lines[mixed])}"`);
        else {
          const mf = (await fonts(mixed)).split('|').map((f) => f.split(':')[1]);
          const want = [...Array(10).fill('Helvetica'), ...Array(10).fill('Helvetica-Bold'), ...Array(15).fill('Helvetica')];
          if (JSON.stringify(mf) !== JSON.stringify(want)) problems.push(`an edit inside the bold name changed the fonts of the line (${mf.join(',')})`);
          if (before.lines[mixed].chars.slice(0, 15).some((x, n) => Math.abs(x[1] - after.lines[mixed].chars[n][1]) > 0.02)) problems.push('the letters before the edited name moved');
        }
        // 4. Esc drops what was typed.
        v0 = await ev(c, `window.__gmbPdf.version`);
        await mouse(await spot(body, 2));
        await c.send('Input.insertText', { text: 'zzz' });
        await press('Escape', 27);
        await sleep(500);
        const esc = await ev(c, `({ v: window.__gmbPdf.version, dirty: document.querySelectorAll('.eline.dirty').length, tool: document.body.dataset.tool })`);
        if (esc.v !== v0 || esc.dirty || esc.tool !== 'edit') problems.push(`Esc did not just drop the typing (${JSON.stringify(esc)})`);
        if (shots) { const p = await c.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, 'pdf-0-edited.png'), Buffer.from(p.data, 'base64')); }
        // Each kept edit is one step back.
        for (let n = 0; n < 2; n++) { await ev(c, `document.getElementById('undo').click()`); await sleep(1200); }
      }
    }
    await ev(c, `document.getElementById('undo').click()`);
    await sleep(1500);
    await ev(c, `document.querySelector('[data-tool=view]').click()`);
    // Tools, through the same functions the buttons call.
    const run = (code) => ev(c, `(async () => { try { ${code}; await new Promise((r) => setTimeout(r, 1500)); return 'ok'; } catch (e) { return String(e); } })()`);
    // Watermark through its dialog.
    await run(`document.querySelector('[data-act=watermark]').click(); document.getElementById('wmText').value = 'CONFIDENTIAL'; document.getElementById('wmDlg').close('ok')`);
    s = await state();
    if (!s.edited) problems.push(`Watermark did not change the file (${await ev(c, `document.visibilityState + ' / dialogs open: ' + [...document.querySelectorAll('dialog[open]')].map((d) => d.id).join(',') + ' / toast: ' + document.getElementById('toast').textContent`)}; errors: ${errors().join(' | ') || 'none'})`);
    if (shots) { await sleep(1000); const p = await c.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, 'pdf-2-watermark.png'), Buffer.from(p.data, 'base64')); }
    // Highlight: a drag on page 1.
    await run(`document.querySelector('[data-tool=highlight]').click()`);
    const box = await ev(c, `(() => { const r = document.querySelector('.page').getBoundingClientRect(); return { x: r.x + 60, y: r.y + 120 }; })()`);
    const before = await ev(c, 'window.__gmbPdf.bytes.length');
    await ev(c, `window.__keepPage = document.querySelectorAll('.page')[1]; window.__keepThumb = document.querySelectorAll('.thumb canvas')[1]; true`);
    for (const [type, dx] of [['mousePressed', 0], ['mouseMoved', 200], ['mouseReleased', 200]]) await c.send('Input.dispatchMouseEvent', { type, x: box.x + dx, y: box.y + (dx ? 30 : 0), button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    await sleep(2000);
    if ((await ev(c, 'window.__gmbPdf.bytes.length')) === before) problems.push('a Highlight drag did not change the file');
    // Smooth: the pages stay (no white flash); page 2 and its thumbnail were not drawn again.
    const kept = await ev(c, `({ page: document.querySelectorAll('.page')[1] === window.__keepPage, thumb: document.querySelectorAll('.thumb canvas')[1] === window.__keepThumb })`);
    if (!kept.page || !kept.thumb) problems.push(`a highlight on page 1 rebuilt the whole document (${JSON.stringify(kept)})`);
    // Organize: delete page 2, then undo.
    await run(`document.querySelector('[data-tool=organize]').click()`);
    await sleep(1500);
    if (shots) { const p = await c.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, 'pdf-3-organize.png'), Buffer.from(p.data, 'base64')); }
    const gridShown = await ev(c, `getComputedStyle(document.getElementById('grid')).display !== 'none' && getComputedStyle(document.getElementById('pages')).display === 'none' && document.querySelectorAll('.cell').length`);
    if (gridShown !== 2) problems.push(`Organize does not show the two pages as a grid (${gridShown})`);
    await run(`[...document.querySelectorAll('.cell')][1].querySelector('[title="Delete page"]').click()`);
    s = await state();
    if (s.pages !== 1) problems.push(`after deleting a page there are ${s.pages} pages`);
    await run(`document.getElementById('undo').click()`);
    s = await state();
    if (s.pages !== 2) problems.push(`Undo did not bring the page back (${s.pages} pages)`);
    // Merge: the same file again, through the engine call the Merge button makes.
    await run(`const b = window.__gmbPdf.bytes; const eng = await import('./engine/gamblium_pdf.js'); document.getElementById('undo'); window.__merged = eng.merge(b, b).length`);
    const merged = await ev(c, 'window.__merged || 0');
    if (!merged) problems.push('Merge did not make a file');
    await run(`document.querySelector('[data-tool=view]').click()`);
    const errs = errors();
    if (errs.length) problems.push(`page errors: ${errs.slice(0, 3).join(' | ')}`);
    // Arrange: a picture moves, grows and goes.
    {
      const pt = await fetch(`http://127.0.0.1:${PORT}/json/new?http://127.0.0.1:${SITE}/picture.pdf`, { method: 'PUT' }).then((r) => r.json());
      let vt = null;
      for (let i = 0; i < 30 && !vt; i++) { await sleep(500); vt = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).find((x) => x.id === pt.id && x.url.includes('/pdf/viewer.html')); }
      if (!vt) problems.push('the picture PDF did not open in the viewer');
      else {
        const p = await connect(vt.webSocketDebuggerUrl);
        await p.send('Page.bringToFront');
        await sleep(4000);
        const objsNow = () => ev(p, `(async () => { const eng = await import('./engine/gamblium_pdf.js'); return Array.from(eng.page_objects(window.__gmbPdf.bytes, 0)); })()`);
        const boxNow = () => ev(p, `(() => { const b = document.querySelector('.obj'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
        const drag = async (fx, fy, dx, dy) => {
          await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fx, y: fy, button: 'left', buttons: 1, clickCount: 1 });
          for (let k = 1; k <= 5; k++) await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fx + (dx * k) / 5, y: fy + (dy * k) / 5, button: 'left', buttons: 1 });
          await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fx + dx, y: fy + dy, button: 'left', buttons: 0, clickCount: 1 });
          await sleep(2500);
        };
        const start = await objsNow();
        await ev(p, `document.querySelector('[data-tool=arrange]').click()`);
        await sleep(800);
        const box = await boxNow();
        if (!box || start.length !== 6) problems.push(`Arrange shows no outline for the picture (engine found ${start.length / 6})`);
        else {
          await drag(box.x + box.w / 2, box.y + box.h / 2, 60, 40);
          const moved = await objsNow();
          const z = await ev(p, `parseFloat(document.getElementById('zoomLabel').textContent) / 100`);
          const dxPt = moved[2] - start[2], dyPt = moved[3] - start[3];
          if (Math.abs(dxPt - 60 / z) > 3 || Math.abs(dyPt + 40 / z) > 3) problems.push(`a dragged picture moved ${dxPt.toFixed(1)}, ${dyPt.toFixed(1)} points, not ${(60 / z).toFixed(1)}, ${(-40 / z).toFixed(1)}`);
          // Select it (a click), then pull its bottom-right corner outwards.
          const b2 = await boxNow();
          await drag(b2.x + b2.w / 2, b2.y + b2.h / 2, 0, 0);
          const b3 = await boxNow();
          await drag(b3.x + b3.w - 1, b3.y + b3.h - 1, 80, 0);
          const grown = await objsNow();
          if (!(grown[4] - grown[2] > moved[4] - moved[2] + 20)) problems.push(`resizing from a corner did not make the picture bigger (${(moved[4] - moved[2]).toFixed(0)} -> ${(grown[4] - grown[2]).toFixed(0)} points wide)`);
          if (shots) { const s2 = await p.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, 'pdf-4-arrange.png'), Buffer.from(s2.data, 'base64')); }
          const b4 = await boxNow();
          await drag(b4.x + b4.w / 2, b4.y + b4.h / 2, 0, 0);
          await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
          await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
          await sleep(2500);
          if ((await objsNow()).length) problems.push('Delete did not remove the picture');
        }
        p.close();
      }
    }
    // Fill form and Compress.
    {
      const ft = await fetch(`http://127.0.0.1:${PORT}/json/new?http://127.0.0.1:${SITE}/form.pdf`, { method: 'PUT' }).then((r) => r.json());
      let vt = null;
      for (let i = 0; i < 30 && !vt; i++) { await sleep(500); vt = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).find((x) => x.id === ft.id && x.url.includes('/pdf/viewer.html')); }
      if (!vt) problems.push('the form PDF did not open in the viewer');
      else {
        const f = await connect(vt.webSocketDebuggerUrl);
        await f.send('Page.bringToFront');
        await sleep(4000);
        await ev(f, `document.querySelector('[data-tool=form]').click()`);
        await sleep(800);
        const inputs = await ev(f, `[...document.querySelectorAll('.formlayer [data-field]')].map((i) => i.dataset.field + ':' + i.type)`);
        if (!inputs || inputs.length !== 2) problems.push(`Fill form shows ${inputs?.length ?? 0} inputs, not 2 (${inputs})`);
        else {
          await ev(f, `(() => { const t = document.querySelector('.formlayer [data-field=name]'); t.value = 'Asha Verma'; t.dispatchEvent(new Event('change')); })()`);
          await sleep(2000);
          await ev(f, `(() => { const c = document.querySelector('.formlayer [data-field=agree]'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);
          await sleep(2000);
          const filled = await ev(f, `(async () => { const eng = await import('./engine/gamblium_pdf.js'); return JSON.parse(eng.form_fields(window.__gmbPdf.bytes)).map((x) => x.name + '=' + x.value).join(' '); })()`);
          if (!/name=Asha Verma/.test(filled) || !/agree=Yes/.test(filled)) problems.push(`Fill form did not put the values in the file (${filled})`);
          const shown = await ev(f, `window.__gmbPdf.words(0).map((w) => w[0]).join(' ')`);
          if (!/Asha Verma/.test(shown)) problems.push('the filled name does not show on the page');
          if (shots) { const s3 = await f.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, 'pdf-5-form.png'), Buffer.from(s3.data, 'base64')); }
          const before = await ev(f, 'window.__gmbPdf.bytes.length');
          await ev(f, `document.querySelector('[data-act=compress]').click()`);
          await sleep(2500);
          const afterLen = await ev(f, 'window.__gmbPdf.bytes.length');
          if (!(afterLen <= before)) problems.push(`Compress made the file bigger (${before} -> ${afterLen})`);
          const stillFilled = await ev(f, `(async () => { const eng = await import('./engine/gamblium_pdf.js'); return JSON.parse(eng.form_fields(window.__gmbPdf.bytes)).map((x) => x.name + '=' + x.value).join(' '); })()`);
          if (!/name=Asha Verma/.test(stillFilled)) problems.push('Compress lost the filled form');
        }
        f.close();
      }
    }
    // Sign: one click places one signature, which is then selected in Arrange; another click
    // adds nothing; Delete takes it away (owner, Nov 16 2026: signatures stacked, could not be
    // selected or deleted).
    {
      const count = () => ev(c, `(async () => { const eng = await import('./engine/gamblium_pdf.js'); return eng.page_objects(window.__gmbPdf.bytes, 0).length / 6; })()`);
      // This tab may have been hidden (and frozen) while the form tab was in front.
      await c.send('Page.bringToFront');
      await sleep(1500);
      const n0 = await count();
      await ev(c, `document.querySelector('[data-tool=sign]').click()`);
      await sleep(600);
      await ev(c, `(() => { document.querySelector('#signMode [data-m=type]').click(); const n = document.getElementById('signName'); n.value = 'Asha Verma'; n.dispatchEvent(new Event('input')); })()`);
      await sleep(1200);
      await ev(c, `document.getElementById('signOk').click()`);
      await sleep(600);
      await sleep(600);
      const spot = await ev(c, `(() => { const r = document.querySelector('.page').getBoundingClientRect(); return { x: r.x + r.width * 0.6, y: r.y + r.height * 0.5 }; })()`);
      const click = async (p) => { for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }); };
      await click(spot);
      await sleep(2500);
      const after = await ev(c, `({ tool: document.body.dataset.tool, sel: document.querySelectorAll('.page .obj.sel').length })`);
      const n1 = await count();
      if (n1 !== n0 + 1) problems.push(`Sign: one click placed ${n1 - n0} signatures (${await ev(c, `document.visibilityState + ' / dialogs open: ' + [...document.querySelectorAll('dialog[open]')].map((d) => d.id).join(',') + ' / toast: ' + document.getElementById('toast').textContent`)}; errors: ${errors().join(' | ') || 'none'})`);
      if (after.tool !== 'arrange' || after.sel !== 1) problems.push(`Sign: the new signature is not selected to move or delete (${JSON.stringify(after)})`);
      await click({ x: spot.x + 120, y: spot.y + 80 });
      await sleep(1500);
      if ((await count()) !== n1) problems.push('Sign: a second click stacked another signature');
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
      await sleep(2000);
      if ((await count()) !== n0) problems.push('Sign: Delete did not remove the selected signature');
      await ev(c, `document.querySelector('[data-tool=view]').click()`);
    }
    // Redact: a real drag over line 3 of page 1. The line's words leave the file (the content
    // stream held them as plain text before), the box is black, the other lines stay searchable.
    {
      await ev(c, `document.querySelector('[data-tool=redact]').click()`);
      await sleep(800);
      const line = await ev(c, `(() => { const w = window.__gmbPdf.words(0); const k = w.findIndex((x, n) => x[0] === 'Line' && w[n + 1]?.[0] === '3'); if (k < 0) return null; const row = w.filter((x) => Math.abs(x[6] - w[k][6]) < 1); const r = document.querySelector('.page').getBoundingClientRect(); const z = r.width / window.__gmbPdf.pageWidth(0); return { x0: r.x + (Math.min(...row.map((x) => x[1])) - 2) * z, y0: r.y + (Math.min(...row.map((x) => x[2])) - 1) * z, x1: r.x + (Math.max(...row.map((x) => x[3])) + 2) * z, y1: r.y + (Math.max(...row.map((x) => x[4])) + 1) * z }; })()`);
      if (!line) problems.push('Redact: line 3 of page 1 was not found to redact');
      else {
        const plainBefore = await ev(c, `new TextDecoder('latin1').decode(window.__gmbPdf.bytes).includes('Line 3 of page 1')`);
        for (const [type, x, y] of [['mousePressed', line.x0, line.y0], ['mouseMoved', line.x1, line.y1], ['mouseReleased', line.x1, line.y1]]) await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
        await sleep(3000);
        const after = await ev(c, `(async () => { const eng = await import('./engine/gamblium_pdf.js'); const b = window.__gmbPdf.bytes; const v = new eng.Viewer(b); const words = JSON.parse(v.words(0)).map((x) => x[0]).join(' '); const raw = new TextDecoder('latin1').decode(b); return { words, inFile: raw.includes('Line 3 of page 1'), page2: JSON.parse(v.words(1)).map((x) => x[0]).join(' ').includes('Line 3 of page 2'), pages: v.page_count() }; })()`);
        if (!plainBefore) problems.push('Redact: the test file did not hold the line as plain text to begin with');
        if (/Line 3 of page 1/.test(after.words) || after.inFile) problems.push(`Redact left the words in the file (${after.words.slice(0, 80)})`);
        if (!/Line 4 of page 1/.test(after.words)) problems.push(`Redact lost the other words of the page: ${after.words.slice(0, 120)}`);
        if (!after.page2 || after.pages !== 2) problems.push('Redact changed another page');
        if (shots) { const p = await c.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, 'pdf-7-redact.png'), Buffer.from(p.data, 'base64')); }
      }
    }
    // A locked PDF: the password is asked, a wrong one is refused, the right one opens it;
    // Protect saves an AES-256 locked copy that only its password opens.
    {
      const lt = await fetch(`http://127.0.0.1:${PORT}/json/new?http://127.0.0.1:${SITE}/locked.pdf`, { method: 'PUT' }).then((r) => r.json());
      let vt = null;
      for (let i = 0; i < 30 && !vt; i++) { await sleep(500); vt = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).find((x) => x.id === lt.id && x.url.includes('/pdf/viewer.html')); }
      if (!vt) problems.push('the locked PDF did not open in the viewer');
      else {
        const f = await connect(vt.webSocketDebuggerUrl);
        await f.send('Page.bringToFront');
        await sleep(3000);
        const asked = await ev(f, `document.getElementById('pwDlg').open`);
        if (!asked) problems.push('a locked PDF did not ask for its password');
        else {
          const typePw = async (pw) => {
            await ev(f, `(() => { const i = document.getElementById('pdfPw'); i.value = ''; i.focus(); })()`);
            await f.send('Input.insertText', { text: pw });
            await ev(f, `document.querySelector('#pwDlg button[value=ok]').click()`);
            await sleep(1200);
          };
          await typePw('wrong one');
          const refused = await ev(f, `({ open: document.getElementById('pwDlg').open, bad: !document.getElementById('pwBad').hidden, pages: window.__gmbPdf.pages })`);
          if (!refused.open || !refused.bad || refused.pages) problems.push(`a wrong password was not refused (${JSON.stringify(refused)})`);
          await typePw('open sesame');
          const opened = await ev(f, `({ open: document.getElementById('pwDlg').open, pages: window.__gmbPdf.pages, words: window.__gmbPdf.words(0).map((w) => w[0]).join(' ') })`);
          if (opened.open || opened.pages !== 1 || !/Secret salary/.test(opened.words)) problems.push(`the right password did not open the locked PDF (${JSON.stringify(opened)})`);
          if (shots) { const s4 = await f.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, 'pdf-6-unlocked.png'), Buffer.from(s4.data, 'base64')); }
          // Protect: a locked copy.
          await ev(f, `document.querySelector('[data-act=protect]').click()`);
          await sleep(500);
          await ev(f, `(() => { document.getElementById('lockPw').value = 'tiger lily'; document.getElementById('lockPw2').value = 'tiger lilx'; document.getElementById('lockOk').click(); })()`);
          await sleep(500);
          const mismatch = await ev(f, `({ open: document.getElementById('lockDlg').open, bad: document.getElementById('lockBad').textContent })`);
          if (!mismatch.open || !/not the same/.test(mismatch.bad)) problems.push(`Protect accepted two different passwords (${JSON.stringify(mismatch)})`);
          await ev(f, `(() => { document.getElementById('lockPw2').value = 'tiger lily'; document.getElementById('lockOk').click(); })()`);
          await sleep(1500);
          const lock = await ev(f, `(async () => { const eng = await import('./engine/gamblium_pdf.js'); const b = window.__gmbPdf.lastSaved; if (!b) return { saved: false }; const text = new TextDecoder('latin1').decode(b); let wrong = false; try { eng.unlock(b, 'tiger'); } catch { wrong = true; } let right = ''; try { right = new eng.Viewer(eng.unlock(b, 'tiger lily')).words(0); } catch (e) { right = 'ERR ' + e; } return { saved: true, closed: !document.getElementById('lockDlg').open, aes: text.includes('/AESV3'), plain: text.includes('Secret salary'), asks: eng.needs_password(b), wrong, right: right.slice(0, 80) }; })()`);
          if (!lock.saved) problems.push('Protect saved nothing');
          else {
            if (!lock.closed) problems.push('the Protect dialog stayed open after saving');
            if (!lock.aes) problems.push('the locked copy is not AES-256');
            if (lock.plain) problems.push('the locked copy still has readable text');
            if (!lock.asks) problems.push('the locked copy opens without a password');
            if (!lock.wrong) problems.push('the locked copy opened with a wrong password');
            if (!/Secret/.test(lock.right)) problems.push(`the locked copy does not open with its password (${lock.right})`);
          }
        }
        f.close();
      }
    }
    // A PDF file on this computer (Explorer's "Open with Gamblium", or a file dropped on a
    // window): its file:// address goes to the viewer, which reads it through the helper.
    // The helper is the installed one, so before an install that knows "pdf-read" this step
    // only says so.
    {
      const dir = mkdtempSync(join(tmpdir(), 'gamblium-pdffile-'));
      const local = join(dir, 'My report #2.pdf');
      writeFileSync(local, pdf);
      const url = pathToFileURL(local).href;
      const ft = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((r) => r.json());
      let vt = null;
      for (let i = 0; i < 30 && !vt; i++) { await sleep(500); vt = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).find((x) => x.id === ft.id && x.url.includes('/pdf/viewer.html')); }
      if (!vt) problems.push(`a PDF file on this computer did not open in Gamblium PDF (${url})`);
      else {
        const f = await connect(vt.webSocketDebuggerUrl);
        await sleep(3000);
        const got = await ev(f, `({ pages: window.__gmbPdf.pages, name: document.getElementById('docName').textContent, toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent })`);
        if (/unknown request type 'pdf-read'/.test(got.toast)) console.log('  (file:// PDF: the installed helper does not read files yet; run this check again after install)');
        else if (got.pages !== 2 || got.name !== 'My report #2.pdf') problems.push(`a PDF file on this computer: ${JSON.stringify(got)}`);
        // Not every file: the helper refuses anything that is not a .pdf.
        const refused = await ev(f, `chrome.runtime.sendMessage({ type: 'native', request: { type: 'pdf-read', url: ${JSON.stringify(pathToFileURL(join(dir, 'x.txt')).href)}, offset: 0 } }).then((r) => r.error || 'read')`);
        if (!/only PDF files|unknown request/.test(refused)) problems.push(`the helper read a file that is not a PDF (${refused})`);
        f.close();
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
    // An attachment stays a download: the tab is not taken over.
    const a = await fetch(`http://127.0.0.1:${PORT}/json/new?http://127.0.0.1:${SITE}/attach.pdf`, { method: 'PUT' }).then((r) => r.json());
    await sleep(3000);
    const at = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).find((x) => x.id === a.id);
    if (at && at.url.includes('/pdf/viewer.html')) problems.push('a PDF sent as an attachment (a download) was opened in the viewer');
    c.close();
    return problems;
  } catch (e) {
    return [`the check itself failed: ${e.message}`];
  } finally {
    spawnSync(exe, ['close', '--user-data-dir', profile]);
    await sleep(2500);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    server.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const shots = process.argv[2] || null;
  if (shots) mkdirSync(shots, { recursive: true });
  const p = await pdfCheck(shots);
  console.log(p.length ? `PDF CHECK FAILED:\n  ${p.join('\n  ')}` : 'PDF CHECK PASSED');
  process.exit(p.length ? 1 : 0);
}
