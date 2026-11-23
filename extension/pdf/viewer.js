// Gamblium PDF (proof of concept, owner Nov 15 2026): the page Gamblium opens for every PDF.
// Rendering and every edit run in Gamblium's own Rust engine (crates/gamblium-pdf, compiled to
// WebAssembly): nothing is uploaded. Each edit makes a new file in memory; Undo / Redo walk them.
import init, * as eng from './engine/gamblium_pdf.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, kids = []) => { const e = Object.assign(document.createElement(tag), props); e.append(...[].concat(kids)); return e; };
const params = new URLSearchParams(location.search);

// Built in (rebranded copy, tools/rebrand/pdf_loader.js): the browser's own PDF page frames this
// viewer, the address bar keeps the PDF's own address. "Ready" goes out at once, before the
// engine loads (the page waits only a few seconds before showing the browser's own viewer); the
// PDF that comes back waits here until the engine is up.
const BROWSER_PDF = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai';
const embedded = params.get('embed') === '1' && window.parent !== window;
const embedPdf = embedded ? new Promise((resolve) => {
  addEventListener('message', (e) => {
    if (e.origin !== BROWSER_PDF || e.source !== window.parent) return;
    if (e.data?.type === 'gamblium-pdf-url' || e.data?.type === 'gamblium-pdf-error') resolve(e.data);
  });
  chrome.storage.local.get({ pdfViewerOff: false }).then(({ pdfViewerOff }) => window.parent.postMessage({ type: 'gamblium-pdf-ready', off: pdfViewerOff }, BROWSER_PDF));
}) : null;

let bytes = null;        // the PDF as it is now
let sizes = [];          // each page's shown size, to tell an edit that keeps the layout
let viewer = null;       // the engine's view of it
let boxes = [];          // per page [x0, y0, x1, y1, rotate]
let name = 'document.pdf';
let zoom = 1;            // CSS pixels per point
let fitWidth = true;
let tool = 'view';
let version = 0;         // bumps on every change; renders of older versions are dropped
const undo = [];
const redo = [];
let edited = false;
let inkColour = [0.12, 0.33, 0.85];
let signature = null;    // { rgba, w, h } once drawn

function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = bad ? 'toast bad' : 'toast';
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, bad ? 5000 : 2600);
}

// ---------------------------------------------------------------- loading

async function openBytes(b, fileName, changed = null) {
  try {
    if (eng.needs_password(b)) {
      const open = await askPassword(b);
      if (!open) { if (!bytes) $('start').hidden = false; return; }
      b = open;
    } else {
      // Locked by its author against changes or printing: said once when it opens, since an edit
      // saves it without that lock (review 2, 2.5: it was dropped without a word).
      if (fileName && eng.owner_locked && eng.owner_locked(b)) toast('Its author locked this PDF against changes. Any edit you save here is saved without that lock.');
      b = eng.unlock(b, ''); // a lock against changes only: lifted, the file is unchanged otherwise
    }
    const v = new eng.Viewer(b);
    if (v.page_count() === 0) throw new Error('this PDF has no pages');
    const oldSizes = sizes;
    viewer?.free?.();
    viewer = v;
    bytes = b;
    if (fileName) name = fileName;
    boxes = chunk(eng.page_boxes(b), 5);
    sizes = Array.from({ length: v.page_count() }, (_, i) => Array.from(v.page_size(i)).join(','));
    version++;
    wordCache.clear();
    $('start').hidden = true;
    $('docName').textContent = name;
    document.title = `${name} · Gamblium`;
    // An edit that keeps every page's size: the pages stay, only what changed is drawn again,
    // in place (no white flash, no waiting on a long PDF). Anything else is laid out anew.
    const same = !fileName && oldSizes.length === sizes.length && oldSizes.every((x, k) => x === sizes[k]) && $('pages').children.length === sizes.length;
    if (same) refresh(changed);
    else layout();
    if (tool === 'organize') drawGrid();
  } catch (e) {
    toast(`Could not open it: ${e.message || e}`, true);
    if (!bytes) $('start').hidden = false;
  }
}
function askPassword(b) {
  return new Promise((resolve) => {
    const dlg = $('pwDlg');
    $('pwBad').hidden = true;
    $('pdfPw').value = '';
    const done = () => {
      dlg.removeEventListener('close', done);
      if (dlg.returnValue !== 'ok') return resolve(null);
      try { resolve(eng.unlock(b, $('pdfPw').value)); } catch { $('pwBad').hidden = false; dlg.returnValue = ''; dlg.showModal(); dlg.addEventListener('close', done); }
    };
    dlg.addEventListener('close', done);
    dlg.showModal();
    $('pdfPw').focus();
  });
}
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => Array.from(a.slice(i * n, i * n + n)));

/** An edit: the engine makes a new file from the current one. `pages`: the pages it changes
 *  (null: maybe all), so only those are drawn again. */
async function edit(fn, done, pages = null) {
  if (!bytes) return;
  try {
    const next = fn(bytes);
    undo.push({ b: bytes, pages });
    capUndo();
    redo.length = 0;
    edited = true;
    await openBytes(next, undefined, pages);
    sync();
    saveDraftSoon();
    if (done) toast(done);
  } catch (e) {
    toast(String(e.message || e), true);
  }
}
// Earlier versions kept for Undo: at most this many bytes in all, the oldest dropped first (a big
// PDF edited many times held a full copy per edit).
const UNDO_MAX_BYTES = 256 * 1024 * 1024;
function capUndo() {
  let total = undo.reduce((n, e) => n + (e.b?.length || 0), 0);
  while (undo.length > 1 && total > UNDO_MAX_BYTES) total -= undo.shift().b?.length || 0;
}
function sync() {
  $('undo').disabled = undo.length === 0;
  $('redo').disabled = redo.length === 0;
  $('dirty').hidden = !edited;
}

// ---------------------------------------------------------------- drafts: edits survive sleep
// Every change is kept as a draft under the PDF's address (in this extension's own storage), so a
// tab put to sleep, a crash or a closed tab does not lose it: the PDF opens with the draft, and
// Undo goes back to the original. Downloading ends the draft; drafts older than 30 days go.

let sourceKey = null; // the PDF's address (site, file); null when it came from the file picker
const DRAFT_DAYS = 30;
function draftDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('gamblium-pdf', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('drafts');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function draftDo(mode, fn) {
  const db = await draftDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', mode);
      const req = fn(tx.objectStore('drafts'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
let draftTimer = null;
function saveDraftSoon() {
  if (!sourceKey) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const key = sourceKey;
    (edited ? draftDo('readwrite', (st) => st.put({ bytes, name, at: Date.now() }, key)) : draftDo('readwrite', (st) => st.delete(key))).catch(() => {
      if (!edited) return;
      toast('Your changes could not be kept as a draft: Download to keep them. This tab stays awake meanwhile.', true);
      chrome.tabs.getCurrent().then((t) => t && chrome.tabs.update(t.id, { autoDiscardable: false })).catch(() => {});
    });
  }, 600);
}
async function restoreDraft() {
  if (!sourceKey) return;
  try {
    const all = await draftDo('readonly', (st) => st.getAllKeys());
    for (const k of all || []) {
      const d = await draftDo('readonly', (st) => st.get(k));
      if (d && Date.now() - d.at > DRAFT_DAYS * 864e5) await draftDo('readwrite', (st) => st.delete(k));
    }
    const d = await draftDo('readonly', (st) => st.get(sourceKey));
    if (!d?.bytes || !bytes) return;
    undo.push({ b: bytes, pages: null });
    edited = true;
    await openBytes(new Uint8Array(d.bytes));
    sync();
    toast(`Your changes from ${new Date(d.at).toLocaleString()} are back. Undo shows the original.`);
  } catch {}
}
// A PDF picked from the file picker cannot be loaded again: its tab is never put to sleep.
async function keepAwakeIfNoSource() {
  if (sourceKey) return;
  try { const t = await chrome.tabs.getCurrent(); if (t) await chrome.tabs.update(t.id, { autoDiscardable: false }); } catch {}
}

// Hidden for a while: the drawn pages and thumbnails let go of their pixels (several MB a page);
// shown again, what is on screen is drawn at once.
// It must happen before the tab is frozen (timers stop then: a 20 s timer never fired, because
// the freezer counts from when the tab was last used): at 10 s, or as the freeze comes.
let hiddenTimer = null;
function letPixelsGo() {
  clearTimeout(hiddenTimer);
  dropCanvases();
  for (const t of $('thumbs').querySelectorAll('canvas')) { t.width = t.height = 0; t.dataset.v = ''; }
  closePool();
}
document.addEventListener('freeze', () => { if (document.hidden) letPixelsGo(); });
document.addEventListener('visibilitychange', () => {
  clearTimeout(hiddenTimer);
  if (document.hidden) {
    hiddenTimer = setTimeout(letPixelsGo, 10000);
  } else if (viewer) {
    const st = $('stage').getBoundingClientRect();
    for (const page of $('pages').children) { const r = page.getBoundingClientRect(); if (page.dataset.painted === '' && r.bottom > st.top - 600 && r.top < st.bottom + 600) paint(page); }
    for (const t of $('thumbs').children) if (thumbNear(t)) drawThumb(t.querySelector('canvas'), Number(t.dataset.i));
  }
});

// ---------------------------------------------------------------- pages

let io = null;
let far = null;
function layout() {
  const pages = $('pages');
  const n = viewer.page_count();
  const avail = $('stage').clientWidth - 48;
  if (fitWidth) {
    const widest = Math.max(...Array.from({ length: n }, (_, i) => viewer.page_size(i)[0]));
    zoom = Math.min(2.5, Math.max(0.25, Math.min(avail, 980) / widest));
  }
  $('zoomLabel').textContent = `${Math.round(zoom * 100)}%`;
  $('pageOf').textContent = `/ ${n}`;
  io?.disconnect();
  near.clear();
  io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { near.add(e.target); paintSoon(e.target); } else near.delete(e.target);
  }), { root: $('stage'), rootMargin: '400px 0px' });
  // Pages far from the screen give their pixels back (a drawn page is several MB; a long PDF
  // read to the end kept them all): drawn again when they come near.
  far?.disconnect();
  far = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) return;
    if (e.target.querySelector('canvas.pix')) { giveCanvasBack(e.target); e.target.dataset.painted = ''; }
    // Its text layer too: thousands of positioned words per page held most of the graphics memory.
    e.target.querySelector('.textlayer')?.remove();
  }), { root: $('stage'), rootMargin: '900px 0px' });
  const list = [];
  for (let i = 0; i < n; i++) {
    const [w, h] = viewer.page_size(i);
    const page = el('div', { className: 'page' }, [el('canvas', { className: 'ink' })]);
    page.style.width = `${w * zoom}px`;
    page.style.height = `${h * zoom}px`;
    page.dataset.i = String(i);
    wirePage(page, i);
    io.observe(page);
    far.observe(page);
    list.push(page);
  }
  for (const c of pages.querySelectorAll('canvas.pix')) { c.remove(); if (freeCanvases.length < CANVASES) freeCanvases.push(c); else c.width = c.height = 0; }
  pages.replaceChildren(...list);
  drawThumbs();
}

/** After an edit: unchanged pages keep their pixels; changed ones near the screen are drawn
 *  again in place, the others when they are scrolled to; only their thumbnails change. */
function refresh(changed) {
  const set = changed ? new Set(changed) : null;
  const st = $('stage').getBoundingClientRect();
  for (const page of $('pages').children) {
    const i = Number(page.dataset.i);
    if (set && !set.has(i)) { page.dataset.painted = `${version}:${zoom}`; continue; }
    page.dataset.painted = '';
    const r = page.getBoundingClientRect();
    if (r.bottom > st.top - 600 && r.top < st.bottom + 600) paint(page);
  }
  [...$('thumbs').children].forEach((t, i) => {
    const c = t.querySelector('canvas');
    if (set && !set.has(i)) { c.dataset.v = String(version); return; }
    c.dataset.v = '';
    if (thumbNear(t)) drawThumb(c, i);
  });
}

// Pages that came near the screen while scrolling: drawn once the scrolling stops (a long PDF
// read to the end drew every page that flew past; the engine's work is the CPU cost).
const wanted = new Set();
let settleTimer = null;
function paintSoon(page) {
  wanted.add(page);
  clearTimeout(settleTimer);
  settleTimer = setTimeout(flushPaint, 120);
}
function flushPaint() {
  const st = $('stage').getBoundingClientRect();
  for (const page of wanted) {
    const r = page.getBoundingClientRect();
    if (page.isConnected && r.bottom > st.top - 400 && r.top < st.bottom + 400) paint(page);
  }
  wanted.clear();
}
$('stage').addEventListener('scroll', () => { if (wanted.size) { clearTimeout(settleTimer); settleTimer = setTimeout(flushPaint, 120); } }, { passive: true });

// ---------------------------------------------------------------- drawing workers
// Pages are drawn by a small pool of workers (pdf/render-worker.js), each with its own engine:
// two pages at once on two cores, and the page itself stays light. After a quiet spell the pool
// is closed and the engine's memory goes with it (WebAssembly memory only grows); the next page
// to draw starts it again in a few tens of milliseconds.
const POOL_SIZE = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1));
const POOL_IDLE_MS = 60000;
let pool = [];          // { w, version, busy, loaded }
let jobs = [];          // waiting: { page, scale, version, resolve }
let jobId = 0;
let poolIdle = null;
function poolWorker() {
  const w = new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' });
  const slot = { w, version: -1, busy: false, wait: new Map() };
  w.onmessage = (e) => { const f = slot.wait.get(e.data.id); if (f) { slot.wait.delete(e.data.id); f(e.data); } };
  w.onerror = () => { slot.dead = true; dropCalls(slot); pump(); };
  return slot;
}
function dropCalls(slot) {
  for (const f of slot.wait.values()) f({ error: 'worker gone' });
  slot.wait.clear();
}
const call = (slot, msg, transfer = []) => new Promise((resolve) => { const id = ++jobId; slot.wait.set(id, resolve); slot.w.postMessage({ ...msg, id }, transfer); });
function closePool() {
  for (const p of pool) { p.w.terminate(); dropCalls(p); }
  pool = [];
  for (const j of jobs.splice(0)) j.resolve(null);
}
/** Pixels of page i at `scale`, drawn by a worker; null if the PDF changed meanwhile. */
function renderPage(i, scale, withWords = false) {
  clearTimeout(poolIdle);
  return new Promise((resolve) => { jobs.push({ page: i, scale, version, words: withWords, resolve }); pump(); });
}
async function pump() {
  pool = pool.filter((p) => !p.dead);
  while (pool.length < POOL_SIZE && jobs.length > pool.filter((p) => !p.busy).length) pool.push(poolWorker());
  for (const slot of pool) {
    if (slot.busy || !jobs.length) continue;
    const job = jobs.shift();
    if (job.version !== version) { job.resolve(null); continue; }
    slot.busy = true;
    (async () => {
      try {
        if (slot.version !== version) {
          const v = version;
          await call(slot, { op: 'load', bytes: bytes.slice(), version: v });
          slot.version = v;
        }
        if (slot.dead) throw new Error('worker gone');
        const r = await call(slot, { op: 'render', page: job.page, scale: job.scale, version: job.version, words: job.words });
        if (r.words && job.version === version) { try { wordCache.set(`${version}:${job.page}`, JSON.parse(r.words)); } catch {} }
        job.resolve(r.px || null);
      } catch { job.resolve(null); }
      slot.busy = false;
      if (slot.dead) slot.version = -1;
      if (jobs.length) pump();
      else if (pool.every((p) => !p.busy)) { clearTimeout(poolIdle); poolIdle = setTimeout(closePool, POOL_IDLE_MS); }
    })();
  }
}

const PAGE_PIXEL_CAP = 8_000_000;
function paint(page) {
  const i = Number(page.dataset.i);
  const want = `${version}:${zoom}`;
  if (page.dataset.painted === want) return;
  page.dataset.painted = want;
  // At most about 8 million pixels a page (32 MB): an A4 page at 400% on a 2x screen would be
  // 124 MB; above the cap the page is drawn a little softer instead.
  const [pw, ph] = viewer.page_size(i);
  const scale = Math.min(zoom * Math.min(2, devicePixelRatio || 1), Math.sqrt(PAGE_PIXEL_CAP / Math.max(1, pw * ph)));
  const v = version;
  renderPage(i, scale, !wordCache.has(`${version}:${i}`)).then((px) => {
    // The PDF or the zoom changed meanwhile, or the page went far away: the result is not used.
    if (!px) { if (page.dataset.painted === want) page.dataset.painted = ''; return; }
    if (v !== version || page.dataset.painted !== want || !page.isConnected) return;
    const dv = new DataView(px.buffer, px.byteOffset, 8);
    putPixels(canvasFor(page, dv.getUint32(0, true), dv.getUint32(4, true)), px);
    textLayer(page, i);
    editLayer(page, i);
    if (tool === 'arrange') objectLayer(page, i);
    if (tool === 'form') formLayer(page, i);
  });
}

// ---------------------------------------------------------------- text: select, search, edit

const wordCache = new Map(); // `${version}:${page}` -> words
function wordsOf(i) {
  const k = `${version}:${i}`;
  if (!wordCache.has(k)) { try { wordCache.set(k, JSON.parse(viewer.words(i))); } catch { wordCache.set(k, []); } }
  return wordCache.get(k);
}
const measure = document.createElement('canvas').getContext('2d');
function textLayer(page, i) {
  page.querySelector('.textlayer')?.remove();
  const layer = el('div', { className: 'textlayer' });
  const words = wordsOf(i);
  words.forEach((w, k) => {
    const [t, x0, y0, x1, y1, size, base] = w;
    const next = words[k + 1];
    const sameLine = next && Math.abs(next[6] - base) < size * 0.35;
    const span = el('span', { textContent: sameLine ? `${t} ` : `${t}\n` });
    const fs = size * zoom;
    measure.font = `${fs}px Arial, Helvetica, sans-serif`;
    const natural = measure.measureText(t).width || 1;
    span.style.left = `${x0 * zoom}px`;
    span.style.top = `${(base - size * 0.8) * zoom}px`;
    span.style.fontSize = `${fs}px`;
    span.style.transform = `scaleX(${((x1 - x0) * zoom) / natural})`;
    span.dataset.k = String(k);
    layer.append(span);
  });
  layer.addEventListener('click', (e) => {
    if (tool !== 'edit' || !e.target.dataset.k) return;
    // A word that lies in a line with an editor of its own (its box may poke out past the
    // line's): the caret goes into that line. The box for a whole line is only for text the
    // engine cannot change in place.
    const w = words[Number(e.target.dataset.k)], cx = (w[1] + w[3]) / 2;
    const li = linesOf(i).lines.findIndex((L) => cx >= L.x0 - 1 && cx <= L.x1 + 1 && Math.abs(w[6] - L.base) < L.size * 0.5);
    const line = li < 0 ? null : page.querySelector(`.eline[data-l="${li}"]`);
    if (!line) return editLine(page, i, Number(e.target.dataset.k));
    const r = line.getBoundingClientRect();
    const at = document.caretRangeFromPoint?.(Math.min(r.right - 1, Math.max(r.left + 1, e.clientX)), r.top + r.height / 2);
    line.focus();
    if (at && line.contains(at.startContainer)) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(at); }
  });
  page.append(layer);
  drawHits(page, i);
}

// ---------------------------------------------------------------- Fill form: the PDF's own fields

let fieldsCache = { v: -1, list: [] };
function fields() {
  if (fieldsCache.v !== version) { try { fieldsCache = { v: version, list: JSON.parse(eng.form_fields(bytes)) }; } catch { fieldsCache = { v: version, list: [] }; } }
  return fieldsCache.list;
}
function formLayer(page, i) {
  page.querySelector('.formlayer')?.remove();
  if (tool !== 'form') return;
  const layer = el('div', { className: 'formlayer' });
  for (const f of fields().filter((x) => x.page === i)) {
    const a = fromPdf(i, f.rect[0], f.rect[1]), b = fromPdf(i, f.rect[2], f.rect[3]);
    const box = { left: `${Math.min(a.x, b.x)}px`, top: `${Math.min(a.y, b.y)}px`, width: `${Math.abs(b.x - a.x)}px`, height: `${Math.abs(b.y - a.y)}px` };
    let input;
    if (f.kind === 'check') {
      input = el('input', { type: 'checkbox', checked: f.value && f.value !== 'Off', title: f.name });
      input.addEventListener('change', () => edit((bb) => eng.fill_field(bb, f.name, input.checked ? 'on' : 'off'), null, [i]));
    } else if (f.kind === 'choice' && f.options.length) {
      input = el('select', { title: f.name }, f.options.map((o) => el('option', { value: o, textContent: o, selected: o === f.value })));
      input.addEventListener('change', () => edit((bb) => eng.fill_field(bb, f.name, input.value), null, [i]));
    } else {
      input = el('input', { type: 'text', value: f.value, title: f.name, placeholder: f.name });
      input.style.fontSize = `${Math.max(9, Math.min(14, (Math.abs(b.y - a.y) / zoom) * 0.62)) * zoom}px`;
      input.addEventListener('change', () => edit((bb) => eng.fill_field(bb, f.name, input.value), null, [i]));
    }
    Object.assign(input.style, box);
    input.dataset.field = f.name;
    layer.append(input);
  }
  page.append(layer);
}

// ---------------------------------------------------------------- Arrange: pictures on the page

/** PDF points to a position on the page as shown (CSS px), the inverse of toPdf. */
function fromPdf(i, x, y) {
  const [x0, y0, x1, y1, rot] = boxes[i];
  let u, v;
  if (rot === 90) { v = x - x0; u = y - y0; } else if (rot === 180) { u = x1 - x; v = y - y0; } else if (rot === 270) { v = x1 - x; u = y1 - y; } else { u = x - x0; v = y1 - y; }
  return { x: u * zoom, y: v * zoom };
}
let selected = null; // { page, op }
function objectLayer(page, i) {
  page.querySelector('.objlayer')?.remove();
  if (tool !== 'arrange') return;
  const layer = el('div', { className: 'objlayer' });
  let objs = [];
  try { objs = chunk(eng.page_objects(bytes, i), 6); } catch { objs = []; }
  for (const [op, , ox0, oy0, ox1, oy1] of objs) {
    const a = fromPdf(i, ox0, oy0), b = fromPdf(i, ox1, oy1);
    const r = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    const box = el('div', { className: 'obj', title: 'A picture: drag to move, corners to resize' });
    const place = (q) => Object.assign(box.style, { left: `${q.x}px`, top: `${q.y}px`, width: `${q.w}px`, height: `${q.h}px` });
    place(r);
    for (const c of ['nw', 'ne', 'sw', 'se']) box.append(el('span', { className: `h ${c}` }));
    const bar = el('div', { className: 'objbar' }, [
      Object.assign(el('button', { type: 'button', textContent: 'Fit to page width' }), { onclick: (e) => { e.stopPropagation(); const W = page.clientWidth - 40 * zoom; commit({ x: 20 * zoom, y: r.y, w: W, h: (W * r.h) / r.w }); } }),
      Object.assign(el('button', { type: 'button', textContent: 'Delete' }), { onclick: (e) => { e.stopPropagation(); remove(); } }),
    ]);
    box.append(bar);
    if (selected && selected.page === i && selected.op === op) box.classList.add('sel');
    const commit = (q) => {
      const [x, y, w, h] = rectToPdf(i, { x: q.x, y: q.y }, { x: q.x + q.w, y: q.y + q.h });
      edit((bb) => eng.place_object(bb, i, op, x, y, x + w, y + h, false), null, [i]);
      selected = null;
    };
    const remove = () => { selected = null; edit((bb) => eng.place_object(bb, i, op, 0, 0, 0, 0, true), 'Picture removed', [i]); };
    box.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.objbar')) return;
      e.preventDefault();
      e.stopPropagation();
      layer.querySelectorAll('.obj.sel').forEach((x) => x.classList.remove('sel'));
      box.classList.add('sel');
      selected = { page: i, op };
      const handle = e.target.classList.contains('h') ? [...e.target.classList].find((c) => c.length === 2) : null;
      const sx = e.clientX, sy = e.clientY;
      let q = { ...r };
      let moved = false;
      box.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        if (!handle) q = { ...r, x: r.x + dx, y: r.y + dy };
        else {
          let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
          if (handle.includes('w')) x0 += dx; else x1 += dx;
          if (handle.includes('n')) y0 += dy; else y1 += dy;
          if (!ev.shiftKey) { // keep the picture's proportions
            const k = Math.max((x1 - x0) / r.w, 0.05);
            const h = r.h * k;
            if (handle.includes('n')) y0 = y1 - h; else y1 = y0 + h;
          }
          q = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.max(4, Math.abs(x1 - x0)), h: Math.max(4, Math.abs(y1 - y0)) };
        }
        place(q);
      };
      const up = () => {
        box.removeEventListener('pointermove', move);
        box.removeEventListener('pointerup', up);
        if (moved) commit(q);
      };
      box.addEventListener('pointermove', move);
      box.addEventListener('pointerup', up);
    });
    layer.append(box);
  }
  page.append(layer);
}
addEventListener('keydown', (e) => {
  if (tool !== 'arrange' || !selected || e.target.matches('input, textarea')) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    const s = selected;
    selected = null;
    const objs = chunk(eng.page_objects(bytes, s.page), 6);
    if (objs.some((o) => o[0] === s.op)) edit((bb) => eng.place_object(bb, s.page, s.op, 0, 0, 0, 0, true), 'Picture removed', [s.page]);
  }
});

// Search: every page's words, a match may run over several words of a line.
let hits = []; // { page, box: [x0, y0, x1, y1] }
let hitAt = -1;
function runSearch(q) {
  hits = [];
  hitAt = -1;
  const needle = q.trim().toLowerCase();
  if (needle && viewer) {
    for (let i = 0; i < viewer.page_count(); i++) {
      const words = wordsOf(i);
      // The page's text with each character's word, so a match maps back to boxes.
      let text = '';
      const owner = [];
      words.forEach((w, k) => { for (const _ of w[0]) owner.push(k); text += w[0]; owner.push(-1); text += ' '; });
      const hay = text.toLowerCase();
      for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
        const ks = [...new Set(owner.slice(at, at + needle.length).filter((k) => k >= 0))];
        const ws = ks.map((k) => words[k]);
        hits.push({ page: i, box: [Math.min(...ws.map((w) => w[1])), Math.min(...ws.map((w) => w[2])), Math.max(...ws.map((w) => w[3])), Math.max(...ws.map((w) => w[4]))] });
      }
    }
  }
  if (hits.length) hitAt = 0;
  $('findCount').textContent = needle ? (hits.length ? `1 of ${hits.length}` : 'none') : '';
  for (const p of $('pages').children) drawHits(p, Number(p.dataset.i));
  showHit();
}
function drawHits(page, i) {
  page.querySelectorAll('.hit').forEach((h) => h.remove());
  hits.forEach((h, n) => {
    if (h.page !== i) return;
    const d = el('div', { className: n === hitAt ? 'hit now' : 'hit' });
    const [x0, y0, x1, y1] = h.box;
    Object.assign(d.style, { left: `${x0 * zoom - 1}px`, top: `${y0 * zoom - 1}px`, width: `${(x1 - x0) * zoom + 2}px`, height: `${(y1 - y0) * zoom + 2}px` });
    page.append(d);
  });
}
function showHit() {
  if (hitAt < 0) return;
  const h = hits[hitAt];
  $('findCount').textContent = `${hitAt + 1} of ${hits.length}`;
  for (const p of $('pages').children) drawHits(p, Number(p.dataset.i));
  const page = $('pages').children[h.page];
  if (page) $('stage').scrollTo({ top: page.offsetTop + h.box[1] * zoom - $('stage').clientHeight / 3, behavior: 'smooth' });
}
let findTimer = null;
$('find').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(() => runSearch($('find').value), 180); });
$('find').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !hits.length) return;
  hitAt = (hitAt + (e.shiftKey ? hits.length - 1 : 1)) % hits.length;
  showHit();
});

// ---------------------------------------------------------------- Edit text, in place
// Every line of the page is a small text editor lying exactly over its own words: a click puts
// the caret at that letter, a double click takes the word, dragging selects, the arrow keys,
// Home / End and Shift work as in any editor. Only what was typed or removed changes in the
// file: the engine rewrites those characters inside the page's own text (same font, size,
// colour, spacing, baseline) and moves what follows on the line by the change in width.
// Enter (or clicking elsewhere) keeps the change as one step for Undo; Esc drops it.
// The words stay invisible (the page's own picture shows them) until a line is changed; a
// changed line shows its text in the matching font over the paper's colour.

const lineCache = new Map(); // `${version}:${page}` -> { styles, lines }
function linesOf(i) {
  const k = `${version}:${i}`;
  if (!lineCache.has(k)) {
    for (const old of lineCache.keys()) if (!old.startsWith(`${version}:`)) lineCache.delete(old);
    let m = { styles: [], lines: [] };
    try { m = JSON.parse(eng.text_lines(bytes, i)); } catch {}
    lineCache.set(k, m);
  }
  return lineCache.get(k);
}
const GENERIC = { sans: 'Arial, Helvetica, sans-serif', serif: '"Times New Roman", Times, serif', mono: '"Courier New", Courier, monospace' };
// The very face the PDF was written in, when this computer has it: found by its PostScript name
// ("Arial-BoldMT", "ComicSansMS"), which a font family alone cannot say. Then the family, then a
// font of the same kind.
const faces = new Set();
const safeName = (n) => typeof n === 'string' && n.length < 80 && /^[\p{L}\p{N} ._-]+$/u.test(n);
function cssFont(st) {
  const weight = st.bold ? '700' : '400', style = st.italic ? 'italic' : 'normal';
  let first = '';
  if (safeName(st.ps)) {
    const id = `gmb-${st.ps}-${weight}-${style}`;
    if (!faces.has(id)) {
      faces.add(id);
      let sheet = $('gmbFaces');
      if (!sheet) { sheet = el('style', { id: 'gmbFaces' }); document.head.append(sheet); }
      sheet.append(`@font-face { font-family: "${id}"; src: local("${st.ps}"); font-weight: ${weight}; font-style: ${style}; }\n`);
    }
    first = `"${id}", `;
  }
  const fam = safeName(st.family) ? `"${st.family}", ` : '';
  return { family: first + fam + (GENERIC[st.generic] || GENERIC.sans), weight, style };
}
const cps = (t) => Array.from(t); // whole characters, as the engine counts them

function editLayer(page, i) {
  const had = page.querySelector('.editlayer');
  if (tool !== 'edit') { had?.remove(); return; }
  // Typing not kept yet (a zoom or a redraw came first): it is kept now, and the page drawn
  // again builds this layer anew.
  if (had && had.dataset.v === String(version) && had.querySelector('.eline.dirty')) { commitEdits(page, i); return; }
  had?.remove();
  const model = linesOf(i);
  const layer = el('div', { className: 'editlayer' });
  layer.dataset.v = String(version);
  const blocks = new Map();
  model.lines.forEach((L, li) => {
    const text = L.chars.map((c) => c[0]).join('');
    if (!text.trim()) return;
    // Runs of one look. A gap that reads as a space belongs to the run before it.
    const runs = [];
    for (const [t, x, s] of L.chars) {
      const last = runs[runs.length - 1];
      if (last && (s === -1 || s === last.s)) last.text += t;
      else runs.push({ s: s === -1 ? (last ? last.s : (L.chars.find((c) => c[2] !== -1) || [0, 0, 0])[2]) : s, text: t, x });
    }
    // The line's own font is that of its biggest letters: it sets where the baseline falls.
    const main = model.styles[runs.reduce((a, r) => (model.styles[r.s].size > model.styles[a.s].size ? r : a), runs[0]).s];
    const mf = cssFont(main), mfs = main.size * zoom;
    measure.font = `${mf.style} ${mf.weight} ${mfs}px ${mf.family}`;
    const mm = measure.measureText('Hg');
    const asc = mm.fontBoundingBoxAscent ?? mfs * 0.9, desc = mm.fontBoundingBoxDescent ?? mfs * 0.22;
    const lh = Math.max(Math.ceil(mfs * 1.2), Math.ceil(asc + desc));
    const line = el('div', { className: 'eline', spellcheck: false });
    line.contentEditable = 'plaintext-only';
    if (line.contentEditable !== 'plaintext-only') line.contentEditable = 'true';
    line.dataset.l = String(li);
    line.dataset.b = String(L.block);
    line.dataset.orig = text;
    Object.assign(line.style, {
      left: `${L.x0 * zoom}px`, top: `${L.base * zoom - ((lh - (asc + desc)) / 2 + asc)}px`, height: `${lh}px`, lineHeight: `${lh}px`, minWidth: `${(L.x1 - L.x0) * zoom}px`,
      fontFamily: mf.family, fontWeight: mf.weight, fontStyle: mf.style, fontSize: `${mfs}px`,
    });
    line.style.setProperty('--c', main.color);
    runs.forEach((r, n) => {
      const st = model.styles[r.s], f = cssFont(st), fs = st.size * zoom;
      const span = el('span', { textContent: r.text });
      span.dataset.s = String(r.s);
      // Letters are spread so that the run is as wide as in the PDF: the caret then stands
      // where the page shows the letter, also when the screen's font is a little different.
      measure.font = `${f.style} ${f.weight} ${fs}px ${f.family}`;
      const natural = measure.measureText(r.text).width;
      const wide = ((n + 1 < runs.length ? runs[n + 1].x : L.x1) - r.x) * zoom;
      const count = cps(r.text).length;
      const ls = Math.max(-0.25 * fs, Math.min(0.25 * fs, (wide - natural) / Math.max(1, count)));
      Object.assign(span.style, { fontFamily: f.family, fontWeight: f.weight, fontStyle: f.style, fontSize: `${fs}px`, letterSpacing: `${ls}px` });
      if (st.rise) { span.style.position = 'relative'; span.style.top = `${-st.rise * zoom}px`; }
      span.style.setProperty('--c', st.color);
      line.append(span);
    });
    layer.append(line);
    const b = blocks.get(L.block) || [Infinity, Infinity, -Infinity, -Infinity];
    blocks.set(L.block, [Math.min(b[0], L.x0), Math.min(b[1], L.y0), Math.max(b[2], L.x1), Math.max(b[3], L.y1)]);
  });
  for (const [id, b] of blocks) {
    const box = el('div', { className: 'eblock' });
    box.dataset.b = String(id);
    Object.assign(box.style, { left: `${b[0] * zoom - 4}px`, top: `${b[1] * zoom - 2}px`, width: `${(b[2] - b[0]) * zoom + 8}px`, height: `${(b[3] - b[1]) * zoom + 4}px` });
    layer.prepend(box);
  }
  const blockOf = (line) => layer.querySelector(`.eblock[data-b="${line.dataset.b}"]`);
  layer.addEventListener('pointerover', (e) => { const l = e.target.closest?.('.eline'); layer.querySelectorAll('.eblock.hover').forEach((x) => x.classList.remove('hover')); if (l) blockOf(l)?.classList.add('hover'); });
  layer.addEventListener('pointerleave', () => layer.querySelectorAll('.eblock.hover').forEach((x) => x.classList.remove('hover')));
  layer.addEventListener('focusin', (e) => {
    const l = e.target.closest?.('.eline');
    if (!l) return;
    layer.querySelectorAll('.eblock.on').forEach((x) => x.classList.remove('on'));
    blockOf(l)?.classList.add('on');
    if (!l.style.getPropertyValue('--paper')) l.style.setProperty('--paper', paperColour(page, l));
  });
  layer.addEventListener('focusout', (e) => {
    layer.querySelectorAll('.eblock.on').forEach((x) => x.classList.remove('on'));
    // Leaving for another line of this page keeps typing going: several lines, one step.
    if (e.relatedTarget?.closest?.('.editlayer') === layer) return;
    commitEdits(page, i);
  });
  layer.addEventListener('input', (e) => {
    const l = e.target.closest?.('.eline');
    if (l) l.classList.toggle('dirty', lineText(l) !== l.dataset.orig);
  });
  layer.addEventListener('beforeinput', (e) => {
    // One line stays one line.
    if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') { e.preventDefault(); commitEdits(page, i); }
  });
  layer.addEventListener('paste', (e) => {
    e.preventDefault();
    const t = (e.clipboardData?.getData('text/plain') || '').replace(/\s*[\r\n]+\s*/g, ' ');
    if (t) document.execCommand('insertText', false, t);
  });
  layer.addEventListener('drop', (e) => e.preventDefault());
  // A double click takes the word, not the space after it (Windows adds that space, and typing
  // over the word would then glue the new word to the next one).
  layer.addEventListener('dblclick', () => {
    const sel = getSelection(), t = sel.toString();
    if (!t.trim()) return;
    for (let k = t.length - t.trimEnd().length; k > 0; k--) sel.modify('extend', 'backward', 'character');
  });
  layer.addEventListener('keydown', (e) => {
    const l = e.target.closest?.('.eline');
    if (!l) return;
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitEdits(page, i); getSelection().removeAllRanges(); l.blur(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && ['s', 'p', 'f'].includes(e.key.toLowerCase())) {
      // Save, print, find: what was typed is kept first.
      e.preventDefault(); e.stopPropagation();
      const k = e.key.toLowerCase();
      commitEdits(page, i);
      getSelection().removeAllRanges();
      l.blur();
      if (k === 's') $('download').click();
      else if (k === 'p') $('print').click();
      else { $('find').focus(); $('find').select(); }
      return;
    }
    if (e.key === 'Escape') {
      // Drops what was typed on this page and leaves the line; the tool stays.
      e.preventDefault(); e.stopPropagation();
      layer.dataset.v = 'dropped';
      getSelection().removeAllRanges();
      l.blur();
      editLayer(page, i);
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // To the line above or below, at the same place across the page.
      const sel = getSelection();
      const cr = sel.rangeCount ? sel.getRangeAt(0).getClientRects()[0] || sel.getRangeAt(0).getBoundingClientRect() : null;
      const here = l.getBoundingClientRect();
      const x = cr && cr.width + cr.height > 0 ? cr.left : here.left;
      const down = e.key === 'ArrowDown';
      let best = null;
      for (const o of layer.querySelectorAll('.eline')) {
        if (o === l) continue;
        const r = o.getBoundingClientRect();
        const dy = down ? r.top - here.top : here.top - r.top;
        if (dy < here.height * 0.4) continue;
        const dxo = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
        const cost = dy + dxo * 3;
        if (!best || cost < best.cost) best = { o, r, cost };
      }
      if (!best) return;
      e.preventDefault();
      const px = Math.min(best.r.right - 1, Math.max(best.r.left + 1, x));
      const at = document.caretRangeFromPoint?.(px, best.r.top + best.r.height / 2);
      best.o.focus();
      if (at && best.o.contains(at.startContainer)) {
        if (e.shiftKey && sel.rangeCount && l === best.o) sel.extend(at.startContainer, at.startOffset);
        else { sel.removeAllRanges(); sel.addRange(at); }
      }
    }
  });
  page.append(layer);
}

/** The colour of the paper beside a line, read from the page's picture: a changed line covers
 *  its old letters with it. */
function paperColour(page, line) {
  try {
    const c = page.querySelector('canvas.pix');
    const k = c.width / page.clientWidth;
    const x = Math.max(0, Math.round((line.offsetLeft - 3) * k)), y = Math.max(0, Math.round((line.offsetTop + line.offsetHeight / 2) * k));
    const d = c.getContext('2d').getImageData(Math.min(c.width - 1, x), Math.min(c.height - 1, y), 1, 1).data;
    return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
  } catch { return '#fff'; }
}
const lineText = (line) => line.textContent.replace(/\u00a0/g, ' ').replace(/[\r\n]/g, '');

/** What changed in a line, as the fewest replaced ranges of its characters: letters that stayed
 *  are matched to the letters they were, so they keep their place in the file and their font.
 *  Returns [{ a, b, side, text }], a and b counted in the line's characters. */
function lineChanges(L, line, styles) {
  // The line as it is now: each character with the look of the span it sits in.
  const now = [];
  const walk = (node, s) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) for (const ch of c.data) { if (ch !== '\n' && ch !== '\r') now.push([ch === '\u00a0' ? ' ' : ch, s]); }
      else if (c.nodeType === 1) walk(c, c.dataset?.s ?? s);
    }
  };
  walk(line, null);
  // The line as it was: each character with the item of the line it belongs to.
  const was = [];
  L.chars.forEach((c, k) => { for (const ch of c[0]) was.push([ch, k]); });
  let pre = 0;
  while (pre < was.length && pre < now.length && was[pre][0] === now[pre][0]) pre++;
  let suf = 0;
  while (suf < was.length - pre && suf < now.length - pre && was[was.length - 1 - suf][0] === now[now.length - 1 - suf][0]) suf++;
  // Longest common run of letters in between (kept short: a line is a few hundred letters).
  const n = was.length - pre - suf, m = now.length - pre - suf;
  const match = new Int32Array(was.length).fill(-1); // old character -> new character
  for (let k = 0; k < pre; k++) match[k] = k;
  for (let k = 0; k < suf; k++) match[was.length - 1 - k] = now.length - 1 - k;
  if (n > 0 && m > 0 && n * m <= 400000) {
    const w = m + 1, t = new Uint16Array((n + 1) * w);
    for (let a = n - 1; a >= 0; a--) for (let b = m - 1; b >= 0; b--) t[a * w + b] = was[pre + a][0] === now[pre + b][0] ? t[(a + 1) * w + b + 1] + 1 : Math.max(t[(a + 1) * w + b], t[a * w + b + 1]);
    let a = 0, b = 0;
    while (a < n && b < m) {
      if (was[pre + a][0] === now[pre + b][0]) { match[pre + a] = pre + b; a++; b++; }
      else if (t[(a + 1) * w + b] >= t[a * w + b + 1]) a++;
      else b++;
    }
  }
  // An item of the line stays only if all of its characters stayed, side by side.
  const first = new Map(), len = new Map();
  was.forEach(([, k], at) => { if (!first.has(k)) first.set(k, at); len.set(k, (len.get(k) || 0) + 1); });
  const keptAt = (k) => {
    const at = first.get(k);
    if (at === undefined || match[at] < 0) return -1;
    for (let j = 1; j < len.get(k); j++) if (match[at + j] !== match[at] + j) return -1;
    return match[at];
  };
  const styleOf = (k) => { for (let j = k; j >= 0 && j < L.chars.length; j--) if (L.chars[j][2] !== -1) return String(L.chars[j][2]); return null; };
  const styleAfter = (k) => { for (let j = k; j < L.chars.length; j++) if (L.chars[j][2] !== -1) return String(L.chars[j][2]); return null; };
  const out = [];
  let from = 0, upto = 0; // first item not yet accounted for; new characters accounted for
  for (let k = 0; k <= L.chars.length; k++) {
    const at = k < L.chars.length ? keptAt(k) : now.length;
    if (k < L.chars.length && (at < 0 || at < upto)) continue;
    if (from < k || upto < at) {
      const text = now.slice(upto, at).map((c) => c[0]).join('');
      // Typed between two letters of different looks: the editor showed it in one of them.
      let side = 0;
      if (from === k && text) {
        const shown = now[upto][1], before = from > 0 ? styleOf(from - 1) : null, after = styleAfter(k);
        if (shown !== null && shown === after && shown !== before) side = 1;
      }
      out.push({ a: from, b: k, side, text });
    }
    if (k < L.chars.length) { from = k + 1; upto = at + len.get(k); }
  }
  void styles;
  return out;
}

// Letters a PDF's own fonts lack (a PDF carries only the letters it used): when this computer
// has that very font, its glyphs for those letters go into the file, so typed text is in the
// same typeface as the line. The browser asks once whether Gamblium PDF may read the fonts
// installed here; nothing leaves the computer. Without it (or without the font) such letters
// are written in the standard font of the same kind, weight and slant.
// The question is put when Edit text is chosen (a click, as the browser requires), never while
// a change is being kept: keeping a change does not wait for an answer.
const localFiles = new Map(); // PostScript name -> Uint8Array, or null when it cannot be had
let localList = null;         // the installed fonts, once the person said yes
let localAsked = false;
async function askLocalFonts() {
  if (localList || typeof window.queryLocalFonts !== 'function') return;
  try {
    const state = (await navigator.permissions.query({ name: 'local-fonts' })).state;
    if (state === 'denied' || (state === 'prompt' && localAsked)) return;
    localAsked = true;
    localList = await window.queryLocalFonts();
  } catch {}
}
const within = (promise, ms, otherwise) => Promise.race([promise, new Promise((r) => setTimeout(() => r(otherwise), ms))]);
async function localFontsFor(need) {
  if (!need.length || typeof window.queryLocalFonts !== 'function') return [];
  if (!localList) {
    // Allowed on an earlier day: the list comes at once. Not answered yet: no waiting.
    const state = await within(navigator.permissions.query({ name: 'local-fonts' }).then((x) => x.state, () => 'denied'), 500, 'denied');
    if (state !== 'granted') return [];
    localList = await within(window.queryLocalFonts().catch(() => null), 3000, null);
    if (!localList) return [];
  }
  const out = [];
  for (const n of need) {
    const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const f = localList.find((x) => n.ps && x.postscriptName === n.ps)
      || localList.find((x) => n.family && norm(x.family) === norm(n.family) && /bold|black|heavy|demi/i.test(x.style) === n.bold && /italic|oblique/i.test(x.style) === n.italic);
    if (!f) continue;
    if (!localFiles.has(f.postscriptName)) {
      localFiles.set(f.postscriptName, await within(f.blob().then((x) => x.arrayBuffer()).then((x) => new Uint8Array(x), () => null), 3000, null));
    }
    const data = localFiles.get(f.postscriptName);
    if (data && data.length < 24 * 1024 * 1024) out.push(data);
  }
  return out;
}

// Keeping a change may take a moment (a font is fetched): Download, Print, Undo and Redo wait
// for it, so a click on Download right after typing saves the typed text.
let pendingEdit = Promise.resolve();
function commitEdits(page, i) {
  const p = commitNow(page, i);
  pendingEdit = pendingEdit.then(() => p).catch(() => {});
  return p;
}
async function commitNow(page, i) {
  const layer = page.querySelector('.editlayer');
  if (!layer || layer.dataset.v !== String(version)) return;
  const model = linesOf(i);
  const spans = [], texts = [];
  for (const line of layer.querySelectorAll('.eline.dirty')) {
    const li = Number(line.dataset.l);
    for (const c of lineChanges(model.lines[li], line, model.styles)) { spans.push(li, c.a, c.b, c.side); texts.push(c.text); }
  }
  if (!spans.length) return;
  layer.dataset.v = 'kept'; // once
  const v = version, where = Uint32Array.from(spans), what = texts.join('\n');
  let fonts = [];
  try {
    const need = JSON.parse(eng.missing_glyphs(bytes, i, where, what));
    if (need.length) fonts = await localFontsFor(need);
  } catch {}
  if (v !== version) return; // the file changed meanwhile (Undo): the typing went with it
  await edit((b0) => {
    try {
      if (!fonts.length) return eng.edit_text(b0, i, where, what);
      const all = new Uint8Array(fonts.reduce((n, f) => n + f.length, 0));
      let at = 0;
      for (const f of fonts) { all.set(f, at); at += f.length; }
      return eng.edit_text_fonts(b0, i, where, what, all, Uint32Array.from(fonts.map((f) => f.length)));
    } catch (e) { layer.remove(); setTimeout(() => editLayer(page, i)); throw e; }
  }, 'Text changed. Download to keep it.', [i]);
}

// Text the engine cannot reach in place (inside a drawn group, in a font with no reading of its
// codes): the clicked word's line becomes a text box; Enter covers the old line and writes the
// new one in its place, in the standard font of the same look, as one step for Undo.
function editLine(page, i, k) {
  page.querySelector('.editline')?.remove();
  const words = wordsOf(i);
  const base = words[k][6], size = words[k][5];
  let a = k, b = k;
  while (a > 0 && Math.abs(words[a - 1][6] - base) < size * 0.35 && words[a][1] - words[a - 1][3] < size * 1.5) a--;
  while (b < words.length - 1 && Math.abs(words[b + 1][6] - base) < size * 0.35 && words[b + 1][1] - words[b][3] < size * 1.5) b++;
  const line = words.slice(a, b + 1);
  const old = line.map((w) => w[0]).join(' ');
  const box = [Math.min(...line.map((w) => w[1])), Math.min(...line.map((w) => w[2])), Math.max(...line.map((w) => w[3])), Math.max(...line.map((w) => w[4]))];
  const input = el('input', { className: 'editline', value: old });
  Object.assign(input.style, { left: `${box[0] * zoom - 3}px`, top: `${box[1] * zoom - 2}px`, width: `${Math.max(160, (box[2] - box[0]) * zoom + 60)}px`, height: `${(box[3] - box[1]) * zoom + 4}px`, fontSize: `${size * zoom * 0.95}px` });
  page.append(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const text = input.value;
    input.remove();
    if (!keep || text === old) return;
    const [x, y, w, h] = rectToPdf(i, { x: (box[0] - 1) * zoom, y: (box[1] - 1) * zoom }, { x: (box[2] + 1) * zoom, y: (box[3] + 1) * zoom });
    const [bx, by] = toPdf(i, box[0] * zoom, base * zoom);
    edit((b0) => {
      const covered = eng.add_box(b0, i, x, y, w, h, 1, 1, 1, 1);
      // The same style: bold stays bold, a serif a serif. Found where the line sits on the page
      // (Word's PDFs keep text as glyph numbers, so matching the words alone fails).
      let font = eng.font_at(b0, i, bx, by);
      if (font === 'Helvetica') font = eng.font_for_text(b0, i, old);
      return text.trim() ? eng.add_text_font(covered, i, bx, by, size, 0.08, 0.08, 0.08, text, font) : covered;
    }, 'Text changed. Download to keep it.', [i]);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
}

// ---------------------------------------------------------------- page canvases, lent
// A few canvases are lent to the pages near the screen and taken back from pages far away. One
// canvas per page kept every page ever drawn in the graphics process, even resized to nothing
// (memory trace, Nov 16 2026: 500 MB of canvas textures after reading 60 pages, and as pictures
// instead of canvases the browser's image caches held as much). Lent canvases bound it: at most
// CANVASES pages' worth of pixels, however long the PDF.
// The budget is pixels, not a count: about four screens' worth, so a few big pages at a high
// zoom or many small ones at 25% (all near the screen) are drawn alike.
const CANVASES = 2; // canvases kept for reuse once their page went far
const near = new Set(); // pages in the drawing zone
const budgetPx = () => 4 * $('stage').clientWidth * $('stage').clientHeight * Math.min(2, devicePixelRatio || 1) ** 2;
let freeCanvases = [];
function canvasFor(page, w, h) {
  let c = page.querySelector('canvas.pix');
  if (c) return c;
  c = freeCanvases.pop();
  if (!c) {
    let lent = 0;
    for (const x of $('pages').querySelectorAll('canvas.pix')) lent += x.width * x.height;
    if (lent + w * h > budgetPx()) {
      // Over budget: take the canvas of the page farthest from this one that is not near the screen.
      const at = Number(page.dataset.i);
      let best = null;
      for (const p of $('pages').children) {
        if (p === page || near.has(p) || !p.querySelector('canvas.pix')) continue;
        if (!best || Math.abs(Number(p.dataset.i) - at) > Math.abs(Number(best.dataset.i) - at)) best = p;
      }
      if (best) { c = best.querySelector('canvas.pix'); best.dataset.painted = ''; }
    }
  }
  // Every page near the screen is drawn, over the budget if it must.
  c ||= el('canvas', { className: 'pix' });
  page.prepend(c);
  return c;
}
function giveCanvasBack(page) {
  const c = page.querySelector('canvas.pix');
  if (!c) return;
  c.remove();
  if (freeCanvases.length < CANVASES) freeCanvases.push(c);
  else c.width = c.height = 0;
}
/** A hidden PDF lets every canvas go (drawn again when shown). */
function dropCanvases() {
  for (const page of $('pages').children) { const c = page.querySelector('canvas.pix'); if (c) { c.width = c.height = 0; c.remove(); } page.dataset.painted = ''; }
  for (const c of freeCanvases) c.width = c.height = 0;
  freeCanvases = [];
}
function putPixels(canvas, out) {
  const dv = new DataView(out.buffer, out.byteOffset, 8);
  const w = dv.getUint32(0, true), h = dv.getUint32(4, true);
  if (!w || !h) return;
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d', { willReadFrequently: !canvas.classList.contains('pix') }).putImageData(new ImageData(new Uint8ClampedArray(out.buffer, out.byteOffset + 8, w * h * 4), w, h), 0, 0);
}

// Thumbnails are drawn when they come into view in their strip (all 60 of a long PDF were drawn
// at once before), and drawn again after an edit only if they show.
let thumbIo = null;
function drawThumb(c, i) {
  if (c.dataset.v === String(version)) return;
  c.dataset.v = String(version);
  const v = version;
  renderPage(i, 0.22).then((px) => { if (px && v === version && c.isConnected) putPixels(c, px); });
}
function thumbNear(t) {
  const st = $('thumbs').getBoundingClientRect(), r = t.getBoundingClientRect();
  return r.bottom > st.top - 300 && r.top < st.bottom + 300;
}
function drawThumbs() {
  const n = viewer.page_count();
  thumbIo?.disconnect();
  thumbIo = new IntersectionObserver((entries) => entries.forEach((e) => {
    const c = e.target.querySelector('canvas');
    if (e.isIntersecting) drawThumb(c, Number(e.target.dataset.i));
    else if (c && c.width && !thumbNear(e.target)) { c.width = c.height = 0; c.dataset.v = ''; }
  }), { root: $('thumbs'), rootMargin: '300px 0px' });
  const list = [];
  for (let i = 0; i < n; i++) {
    const [w, h] = viewer.page_size(i);
    const c = el('canvas');
    c.width = Math.max(1, Math.round(w * 0.22));
    c.height = Math.max(1, Math.round(h * 0.22));
    const b = el('button', { className: 'thumb', type: 'button', title: `Page ${i + 1}` }, [c, el('span', { className: 'num', textContent: String(i + 1) })]);
    b.dataset.i = String(i);
    b.addEventListener('click', () => goTo(i));
    list.push(b);
    thumbIo.observe(b);
  }
  $('thumbs').replaceChildren(...list);
  markCurrent();
}

function current() {
  const st = $('stage');
  const mid = st.scrollTop + st.clientHeight / 3;
  let best = 0;
  for (const p of $('pages').children) if (p.offsetTop <= mid) best = Number(p.dataset.i);
  return best;
}
function markCurrent() {
  const i = current();
  $('pageNo').value = String(i + 1);
  [...$('thumbs').children].forEach((t, k) => t.setAttribute('aria-current', String(k === i)));
}
function goTo(i) {
  const p = $('pages').children[Math.max(0, Math.min(i, $('pages').children.length - 1))];
  if (p) $('stage').scrollTo({ top: p.offsetTop - 20, behavior: 'smooth' });
}
$('stage').addEventListener('scroll', () => requestAnimationFrame(markCurrent), { passive: true });
$('prev').onclick = () => goTo(current() - 1);
$('next').onclick = () => goTo(current() + 1);
$('pageNo').addEventListener('change', () => goTo(Number($('pageNo').value) - 1));
const setZoom = (z) => { fitWidth = false; zoom = Math.min(4, Math.max(0.25, z)); const keep = current(); layout(); goTo(keep); };
$('zoomIn').onclick = () => setZoom(zoom * 1.2);
$('zoomOut').onclick = () => setZoom(zoom / 1.2);
$('zoomLabel').onclick = () => { fitWidth = true; layout(); };
addEventListener('resize', () => { if (viewer && fitWidth) layout(); });

// ---------------------------------------------------------------- where a click lands in PDF points

/** From a position on the page as shown (CSS px from its top-left) to PDF user space. */
function toPdf(i, sx, sy) {
  const [x0, y0, x1, y1, rot] = boxes[i];
  const u = sx / zoom, v = sy / zoom; // points, as shown
  if (rot === 90) return [x0 + v, y0 + u];
  if (rot === 180) return [x1 - u, y0 + v];
  if (rot === 270) return [x1 - v, y1 - u];
  return [x0 + u, y1 - v];
}
function rectToPdf(i, a, b) {
  const p = toPdf(i, a.x, a.y), q = toPdf(i, b.x, b.y);
  return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1])];
}

// ---------------------------------------------------------------- marking tools

function wirePage(page, i) {
  const ink = page.querySelector('canvas.ink');
  let start = null, path = [];
  const at = (e) => { const r = page.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const fitInk = () => { ink.width = page.clientWidth; ink.height = page.clientHeight; return ink.getContext('2d'); };
  page.addEventListener('pointerdown', (e) => {
    if (!['highlight', 'redact', 'draw'].includes(tool)) return;
    e.preventDefault();
    page.setPointerCapture(e.pointerId);
    start = at(e);
    path = [start];
    fitInk();
  });
  page.addEventListener('pointermove', (e) => {
    if (!start) return;
    const p = at(e);
    const g = ink.getContext('2d');
    g.clearRect(0, 0, ink.width, ink.height);
    if (tool === 'draw') {
      path.push(p);
      g.strokeStyle = `rgb(${inkColour.map((c) => c * 255).join(',')})`;
      g.lineWidth = 2 * zoom; g.lineCap = g.lineJoin = 'round';
      g.beginPath(); path.forEach((q, k) => (k ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y))); g.stroke();
    } else {
      g.fillStyle = tool === 'highlight' ? 'rgba(255,214,0,.38)' : 'rgba(0,0,0,.85)';
      g.strokeStyle = tool === 'redact' ? '#e5484d' : 'transparent';
      g.fillRect(start.x, start.y, p.x - start.x, p.y - start.y);
      g.strokeRect(start.x, start.y, p.x - start.x, p.y - start.y);
    }
  });
  page.addEventListener('pointerup', (e) => {
    if (!start) return;
    const end = at(e);
    const s = start;
    start = null;
    if (tool === 'draw') {
      const pts = path.flatMap((q) => toPdf(i, q.x, q.y));
      if (pts.length >= 4) edit((b) => eng.add_ink(b, i, Float32Array.from(pts), ...inkColour, 1.6), null, [i]);
    } else if (Math.abs(end.x - s.x) > 4 && Math.abs(end.y - s.y) > 4) {
      const [x, y, w, h] = rectToPdf(i, s, end);
      if (tool === 'highlight') edit((b) => eng.add_box(b, i, x, y, w, h, 1, 0.84, 0, 0.38), null, [i]);
      else {
        // Points as shown, from the page's top-left: the engine's own space for words and pixels.
        const r = [s.x, s.y, end.x, end.y].map((v) => v / zoom);
        edit((b) => eng.redact(b, i, Float32Array.from(r)), 'Redacted: what was under the box is gone from the file. Undo still brings it back until you download.', [i]);
      }
    }
  });
  page.addEventListener('click', (e) => {
    const p = at(e);
    if (tool === 'text') return askText(page, i, p);
    if (tool === 'sign' && signature) {
      const wPt = 180, hPt = (180 * signature.h) / signature.w;
      const [x, y] = toPdf(i, p.x, p.y);
      // One click, one signature: it is then selected in Arrange, to drag, resize or Delete
      // (clicking on again stacked copies, owner Nov 16 2026).
      edit((b) => eng.add_image(b, i, x - wPt / 2, y - hPt / 2, wPt, hPt, signature.rgba, signature.w, signature.h), null, [i]).then(() => {
        let objs = [];
        try { objs = chunk(eng.page_objects(bytes, i), 6); } catch { objs = []; }
        if (objs.length) selected = { page: i, op: objs[objs.length - 1][0] };
        setTool('arrange');
        toast('Signed. Drag it to move, a corner to resize, Delete to remove.');
      });
    }
  });
}

function askText(page, i, p) {
  page.querySelector('.textin')?.remove();
  const input = el('textarea', { className: 'textin', rows: 1, placeholder: 'Type, then Enter' });
  input.style.left = `${p.x}px`;
  input.style.top = `${p.y - 10}px`;
  input.style.fontSize = `${14 * zoom}px`;
  page.append(input);
  setTimeout(() => input.focus(), 0);
  const put = () => {
    const text = input.value.trim();
    input.remove();
    if (!text) return;
    // The baseline sits about 0.8 of the font size below the box's top.
    const [x, y] = toPdf(i, p.x + 4, p.y - 10 + 14 * zoom * 0.95);
    edit((b) => eng.add_text(b, i, x, y, 14, ...inkColour, text), null, [i]);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); put(); } if (e.key === 'Escape') input.remove(); });
  input.addEventListener('blur', put, { once: true });
}

const HINTS = {
  highlight: 'Drag over text to highlight it',
  draw: 'Draw with the mouse or a pen',
  text: 'Click where the text should go',
  redact: 'Drag over what must go: it leaves the file for good, not just hidden',
  edit: 'Click in the text and type. Enter keeps the change, Esc drops it.',
  arrange: 'Drag a picture to move it, a corner to resize it (Shift: stretch). Delete removes it.',
  form: 'Fill the fields, then Download. The values show in any PDF reader.',
  sign: 'Click where your signature goes',
};
function setTool(t) {
  if (t === 'sign' && !signature) return openSign();
  tool = t;
  document.body.dataset.tool = t;
  document.querySelectorAll('.tool[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  const hint = $('toolHint');
  hint.hidden = !HINTS[t];
  if (HINTS[t]) {
    const kids = [el('span', { textContent: HINTS[t] })];
    if (t === 'draw' || t === 'text') {
      for (const [c, css] of [[[0.12, 0.33, 0.85], '#1f54d9'], [[0.85, 0.15, 0.15], '#d92626'], [[0.05, 0.05, 0.05], '#0d0d0d']]) {
        const sw = el('button', { className: 'sw', type: 'button', title: 'Colour' });
        sw.style.setProperty('--c', css);
        sw.setAttribute('aria-pressed', String(String(c) === String(inkColour)));
        sw.onclick = () => { inkColour = c; setTool(t); };
        kids.push(sw);
      }
    }
    if (t === 'sign') kids.push(Object.assign(el('button', { className: 'quiet', type: 'button', textContent: 'New signature' }), { onclick: openSign }));
    hint.replaceChildren(...kids);
  }
  for (const p of $('pages').children) (t === 'arrange' ? objectLayer(p, Number(p.dataset.i)) : p.querySelector('.objlayer')?.remove());
  for (const p of $('pages').children) (t === 'form' ? formLayer(p, Number(p.dataset.i)) : p.querySelector('.formlayer')?.remove());
  if (t === 'edit' && bytes) askLocalFonts();
  // Edit text: the pages already drawn get their editable lines now, the others when drawn.
  for (const p of $('pages').children) if (t !== 'edit' || p.querySelector('canvas.pix')) editLayer(p, Number(p.dataset.i));
  if (t === 'form' && bytes && !fields().length) toast('This PDF has no form fields');
  if (t === 'arrange' && bytes && !$('pages').querySelector('.obj')) setTimeout(() => { if (tool === 'arrange' && !$('pages').querySelector('.obj')) toast('No pictures on these pages to arrange'); }, 300);
  const org = t === 'organize';
  $('grid').hidden = !org;
  $('pages').hidden = org;
  $('thumbs').hidden = org;
  $('stage').style.left = org ? 'var(--rail)' : '';
  if (org) drawGrid();
}
document.querySelectorAll('.tool[data-tool]').forEach((b) => b.addEventListener('click', () => (bytes || b.dataset.tool === 'view' ? setTool(b.dataset.tool) : toast('Open a PDF first'))));

// ---------------------------------------------------------------- organise

let dragFrom = -1;
function drawGrid() {
  if (!viewer) return;
  const n = viewer.page_count();
  const cells = [];
  for (let i = 0; i < n; i++) {
    const c = el('canvas', { draggable: true });
    const bar = el('div', { className: 'cellbar' }, [
      el('span', { className: 'n num', textContent: `Page ${i + 1}` }),
      iconBtn('Rotate left', 'M7 4L4 7l3 3M4.5 7H11a5 5 0 1 1-5 5', () => edit((b) => eng.rotate_pages(b, Uint32Array.of(i), 270))),
      iconBtn('Rotate right', 'M13 4l3 3-3 3M15.5 7H9a5 5 0 1 0 5 5', () => edit((b) => eng.rotate_pages(b, Uint32Array.of(i), 90))),
      iconBtn('Delete page', 'M5 6h10M8 6V4h4v2M6.5 6l.5 10h6l.5-10', () => edit((b) => eng.delete_pages(b, Uint32Array.of(i)), `Page ${i + 1} deleted`)),
    ]);
    const cell = el('div', { className: 'cell' }, [c, bar]);
    c.addEventListener('dragstart', () => { dragFrom = i; cell.classList.add('dragging'); });
    c.addEventListener('dragend', () => cell.classList.remove('dragging'));
    cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('over'); });
    cell.addEventListener('dragleave', () => cell.classList.remove('over'));
    cell.addEventListener('drop', (e) => {
      e.preventDefault();
      cell.classList.remove('over');
      if (dragFrom < 0 || dragFrom === i) return;
      const order = Array.from({ length: n }, (_, k) => k);
      const [moved] = order.splice(dragFrom, 1);
      order.splice(i, 0, moved);
      dragFrom = -1;
      edit((b) => eng.reorder_pages(b, Uint32Array.from(order)), 'Pages moved');
    });
    cells.push(cell);
    const v = version;
    renderPage(i, 0.3).then((px) => { if (px && v === version && c.isConnected) putPixels(c, px); });
  }
  const acts = el('div', { className: 'gridacts' }, [
    Object.assign(el('button', { type: 'button', textContent: 'Add a PDF at the end' }), { onclick: () => pick('pickPdf', 'merge') }),
    Object.assign(el('button', { type: 'button', textContent: 'Add images at the end' }), { onclick: () => pick('pickImg', 'append') }),
  ]);
  $('grid').replaceChildren(acts, ...cells);
}
function iconBtn(label, d, onclick) {
  const b = el('button', { className: 'ib', type: 'button', title: label, ariaLabel: label });
  b.innerHTML = `<svg viewBox="0 0 20 20"><path d="${d}"/></svg>`;
  b.onclick = onclick;
  return b;
}

// ---------------------------------------------------------------- files in

let pickFor = null;
function pick(id, purpose) { pickFor = purpose; $(id).value = ''; $(id).click(); }
const readFile = (f) => f.arrayBuffer().then((a) => new Uint8Array(a));

async function imagesToPdf(files) {
  let out = null;
  for (const f of files) {
    const bmp = await createImageBitmap(f);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0);
    const jpeg = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer());
    const one = eng.jpeg_to_pdf(jpeg, bmp.width, bmp.height, true);
    out = out ? eng.merge(out, one) : one;
  }
  return out;
}

async function takeFiles(files, purpose) {
  const pdfs = files.filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
  const imgs = files.filter((f) => f.type.startsWith('image/'));
  try {
    if (purpose === 'merge' && bytes) {
      let next = bytes;
      for (const f of pdfs) next = eng.merge(next, await readFile(f));
      if (imgs.length) next = eng.merge(next, await imagesToPdf(imgs));
      return edit(() => next, `${pdfs.length + imgs.length} file(s) added at the end`);
    }
    if (purpose === 'append' && bytes) {
      const add = await imagesToPdf(imgs);
      return edit((b) => eng.merge(b, add), `${imgs.length} image(s) added`);
    }
    // A new document: one PDF opens; several (or images) are joined into one.
    let next = null;
    for (const f of pdfs) { const b = await readFile(f); next = next ? eng.merge(next, b) : b; }
    if (imgs.length) { const add = await imagesToPdf(imgs); next = next ? eng.merge(next, add) : add; }
    if (!next) return;
    undo.length = 0; redo.length = 0;
    edited = pdfs.length !== 1 || imgs.length > 0;
    await openBytes(next, pdfs.length === 1 && !imgs.length ? pdfs[0].name : 'combined.pdf');
    sync();
    if (edited) toast(`Made one PDF from ${pdfs.length + imgs.length} file(s)`);
  } catch (e) {
    toast(String(e.message || e), true);
  }
}
$('pickPdf').addEventListener('change', (e) => takeFiles([...e.target.files], pickFor));
$('pickImg').addEventListener('change', (e) => takeFiles([...e.target.files], pickFor || 'new'));
addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  document.body.classList.remove('dropping');
  takeFiles([...e.dataTransfer.files], bytes ? 'merge' : 'new');
});

document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
  const a = b.dataset.act;
  if (a === 'open') return pick('pickPdf', 'new');
  if (a === 'merge0') return pick('pickPdf', 'new');
  if (a === 'merge') return bytes ? pick('pickPdf', 'merge') : pick('pickPdf', 'new');
  if (a === 'images') return pick('pickImg', bytes ? 'append' : 'new');
  if (a === 'watermark') return bytes ? $('wmDlg').showModal() : toast('Open a PDF first');
  if (a === 'protect') {
    if (!bytes) return toast('Open a PDF first');
    $('lockPw').value = $('lockPw2').value = '';
    $('lockBad').hidden = true;
    $('lockDlg').showModal();
    return $('lockPw').focus();
  }
  if (a === 'compress') {
    if (!bytes) return toast('Open a PDF first');
    const before = bytes.length;
    const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
    return edit((b) => eng.compress(b)).then(() => toast(bytes.length < before ? `Compressed: ${kb(before)} to ${kb(bytes.length)}` : `Already as small as it gets (${kb(before)})`));
  }
}));

// ---------------------------------------------------------------- protect

function saveAs(b, fileName) {
  lastSaved = b;
  const a = el('a', { href: URL.createObjectURL(new Blob([b], { type: 'application/pdf' })), download: fileName });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
let lastSaved = null;
$('lockOk').addEventListener('click', (e) => {
  const pw = $('lockPw').value;
  const bad = (t) => { e.preventDefault(); $('lockBad').textContent = t; $('lockBad').hidden = false; };
  if (pw.length < 4) return bad('Use at least 4 characters.');
  if (pw !== $('lockPw2').value) return bad('The two passwords are not the same.');
  try {
    const locked = eng.protect(bytes, pw, '', crypto.getRandomValues(new Uint8Array(32)));
    saveAs(locked, name.replace(/(\.pdf)?$/i, ' (locked).pdf'));
    toast('Locked copy saved. This view stays unlocked.');
  } catch (err) {
    bad(String(err.message || err));
  }
});

// ---------------------------------------------------------------- watermark

$('wmColour').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  [...$('wmColour').children].forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
});
$('wmDlg').addEventListener('close', () => {
  if ($('wmDlg').returnValue !== 'ok') return;
  const text = $('wmText').value.trim();
  if (!text) return;
  const c = $('wmColour').querySelector('[aria-pressed=true]').dataset.c.split(',').map(Number);
  edit((b) => eng.watermark(b, text, Number($('wmAlpha').value) / 100, ...c), 'Watermark added to every page');
});

// ---------------------------------------------------------------- signature

let signMode = 'draw';
function openSign() {
  const pad = $('signPad');
  const g = pad.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, pad.width, pad.height);
  $('signDlg').showModal();
}
(function wireSign() {
  const pad = $('signPad');
  const g = pad.getContext('2d');
  let down = false;
  const pos = (e) => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * (pad.width / r.width), (e.clientY - r.top) * (pad.height / r.height)]; };
  pad.addEventListener('pointerdown', (e) => { down = true; pad.setPointerCapture(e.pointerId); g.beginPath(); g.moveTo(...pos(e)); });
  pad.addEventListener('pointermove', (e) => { if (!down) return; g.lineTo(...pos(e)); g.strokeStyle = '#10204a'; g.lineWidth = 3.2; g.lineCap = g.lineJoin = 'round'; g.stroke(); });
  pad.addEventListener('pointerup', () => { down = false; });
  $('signClear').onclick = () => { g.fillStyle = '#fff'; g.fillRect(0, 0, pad.width, pad.height); $('signName').value = ''; };
  $('signMode').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    signMode = b.dataset.m;
    [...$('signMode').children].forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('signName').hidden = signMode !== 'type';
    if (signMode === 'type') $('signName').focus();
  });
  $('signName').addEventListener('input', () => {
    g.fillStyle = '#fff'; g.fillRect(0, 0, pad.width, pad.height);
    g.fillStyle = '#10204a'; g.font = "64px 'Segoe Script', 'Brush Script MT', cursive"; g.textBaseline = 'middle';
    g.fillText($('signName').value, 24, pad.height / 2);
  });
  $('signDlg').addEventListener('close', () => {
    if ($('signDlg').returnValue !== 'ok') return;
    // The ink only, on transparent: white becomes see-through, cropped to what was drawn.
    const img = g.getImageData(0, 0, pad.width, pad.height);
    let minX = pad.width, minY = pad.height, maxX = 0, maxY = 0;
    for (let y = 0; y < pad.height; y++) for (let x = 0; x < pad.width; x++) {
      const k = (y * pad.width + x) * 4;
      const dark = 255 - Math.min(img.data[k], img.data[k + 1], img.data[k + 2]);
      img.data[k + 3] = Math.min(255, dark * 1.6);
      if (dark > 30) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    if (maxX <= minX) return toast('Nothing was drawn', true);
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) rgba.set(img.data.subarray(((y + minY) * pad.width + minX) * 4, ((y + minY) * pad.width + minX + w) * 4), y * w * 4);
    signature = { rgba, w, h };
    setTool('sign');
  });
})();

// ---------------------------------------------------------------- undo, download, print, keys

$('undo').onclick = async () => { if (!undo.length) return; const e = undo.pop(); redo.push({ b: bytes, pages: e.pages }); await openBytes(e.b, undefined, e.pages); edited = undo.length > 0; sync(); saveDraftSoon(); };
$('redo').onclick = async () => { if (!redo.length) return; const e = redo.pop(); undo.push({ b: bytes, pages: e.pages }); await openBytes(e.b, undefined, e.pages); edited = true; sync(); saveDraftSoon(); };
$('download').onclick = () => {
  if (!bytes) return;
  saveAs(bytes, edited ? name.replace(/(\.pdf)?$/i, ' (edited).pdf') : name);
  if (sourceKey) draftDo('readwrite', (st) => st.delete(sourceKey)).catch(() => {});
};
$('print').onclick = async () => {
  if (!viewer) return;
  const area = $('printArea');
  area.replaceChildren();
  for (let i = 0; i < viewer.page_count(); i++) {
    const c = document.createElement('canvas');
    putPixels(c, viewer.render(i, 2));
    area.append(el('img', { src: c.toDataURL('image/png') }));
  }
  setTimeout(() => print(), 50);
};
for (const id of ['undo', 'redo', 'download', 'print']) {
  const run = $(id).onclick;
  $(id).onclick = async (e) => { await pendingEdit; return run(e); };
}
addEventListener('keydown', (e) => {
  // In a line being edited the keys belong to the typing (Ctrl+Z undoes a letter there).
  if (e.target.matches('input, textarea') || e.target.isContentEditable) return;
  if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('find').focus(); $('find').select(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); $('undo').click(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); $('redo').click(); }
  if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); $('download').click(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'p') { e.preventDefault(); $('print').click(); }
  if (e.key === 'Escape') setTool('view');
});

// ---------------------------------------------------------------- start

await init();
// On short windows the rail shows icons only: each keeps its name as a tooltip.
for (const t of document.querySelectorAll('.rail .tool')) if (!t.title) t.title = t.querySelector('span')?.textContent || '';
setTool('view');
sync();
window.__gmbPdf = { get pages() { return viewer?.page_count() ?? 0; }, get bytes() { return bytes; }, get edited() { return edited; }, words: (i) => wordsOf(i), lines: (i) => linesOf(i), get zoom() { return zoom; }, get version() { return version; }, get localFonts() { return localList ? localList.length : -1; },
  // For checks: fonts handed over as the browser would list them once a person allowed it
  // ([{ postscriptName, family, style, base64 }]); the question itself cannot be answered by a script.
  lendFonts(list) { localList = list.map((f) => ({ postscriptName: f.postscriptName, family: f.family, style: f.style, blob: async () => new Blob([Uint8Array.from(atob(f.base64), (ch) => ch.charCodeAt(0))]) })); return localList.length; }, get hits() { return hits.length; }, get lastSaved() { return lastSaved; }, pageWidth: (i) => viewer?.page_size?.(i)?.[0] ?? 0 };
const src = params.get('src');
const file = params.get('file');

/** A PDF on this computer, read through Gamblium's helper in pieces. */
async function readLocalPdf(fileUrl) {
  let parts = [], got = 0, size = 1, fileName = name;
  while (got < size) {
    const r = await chrome.runtime.sendMessage({ type: 'native', request: { type: 'pdf-read', url: fileUrl, offset: got } });
    if (!r?.ok) throw new Error(r?.error || 'the helper did not answer');
    const piece = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    if (!piece.length && got < r.size) throw new Error('the file ended early');
    size = r.size;
    fileName = r.name || fileName;
    parts.push(piece);
    got += piece.length;
  }
  const all = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return { bytes: all, fileName };
}
/** A website's PDF, fetched again with the person's cookies. */
async function readSitePdf(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`the site answered ${r.status}`);
  return { bytes: new Uint8Array(await r.arrayBuffer()), fileName: decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || 'document.pdf' };
}

if (embedded) {
  // Built in: the browser's own PDF page frames this viewer and says which PDF it shows (its
  // stream is only for the browser's own viewer). A PDF that cannot be read again (made after
  // a form was sent, a link that expires) goes back to the browser's own viewer, which still
  // has what the site sent.
  document.body.classList.add('embedded');
  name = params.get('name') || name;
  $('docName').textContent = name;
  const d = await embedPdf;
  try {
    if (d.type !== 'gamblium-pdf-url') throw new Error(d.error || 'no PDF');
    const { bytes: b, fileName } = /^file:/i.test(d.url) ? await readLocalPdf(d.url) : await readSitePdf(d.url);
    await openBytes(b, d.name || fileName);
    if (!bytes) throw new Error('it did not open');
    sourceKey = d.url;
    await restoreDraft();
  } catch (e) {
    window.parent.postMessage({ type: 'gamblium-pdf-fallback', error: String(e.message || e) }, BROWSER_PDF);
  }
} else if (file) {
  try {
    const { bytes: b, fileName } = await readLocalPdf(file);
    await openBytes(b, fileName);
    sourceKey = file;
    await restoreDraft();
  } catch (e) {
    $('start').hidden = false;
    toast(`Could not read the file: ${e.message || e}`, true);
  }
} else if (src) {
  try {
    const { bytes: b, fileName } = await readSitePdf(src);
    name = fileName;
    await openBytes(b, fileName);
    sourceKey = src;
    await restoreDraft();
  } catch (e) {
    $('start').hidden = false;
    toast(`Could not load the PDF: ${e.message || e}`, true);
    // Some PDFs cannot be fetched twice (made after a form was sent, links that expire): the
    // browser's own viewer can still show what the site sent.
    const back = el('button', { className: 'big', type: 'button', textContent: "Open in the browser's viewer" });
    back.onclick = () => chrome.runtime.sendMessage({ type: 'pdf-browser-viewer', url: src });
    document.querySelector('.startacts').append(back);
  }
} else {
  $('start').hidden = false;
}
keepAwakeIfNoSource();

// Changes not downloaded: closing the tab asks first (a No session window's draft goes with it).
addEventListener('beforeunload', (e) => {
  if (edited && bytes && lastSaved !== bytes) { e.preventDefault(); e.returnValue = ''; }
});
