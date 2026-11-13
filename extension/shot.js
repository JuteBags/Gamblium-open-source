// Screenshots from the right-click menu (owner, Nov 13 2026): the visible part,
// the whole page, or an area the person selects, which may run far below the
// window ("scrolling capture"). The overlay that lets a person pick the area is
// design's (content/menu.js); this is the engine behind it.
//
// - Visible part: one Page.captureScreenshot of the viewport.
// - Whole page / area of a page that scrolls normally: one Page.captureScreenshot
//   with captureBeyondViewport and a clip in page coordinates. The browser draws
//   the region itself: no seams, sticky headers drawn once. Very tall regions are
//   taken in parts and joined.
// - Area inside a box that scrolls on its own (Gmail, Slack...): the box is
//   scrolled step by step and each step captured; the parts are joined at the
//   scroll positions the page reports, so nothing is guessed from pixels.
// - The debugger is attached for one capture and detached at once (the same rule
//   as freezing), so the tab keeps sleeping and freezing as usual.
//
// Pure helpers (planParts, partsForScroller) are tested in shot.test.mjs.

// One picture part at most this many device pixels tall; GPUs and canvases
// refuse very tall surfaces.
export const PART_PX = 8000;
// The joined picture at most this tall (canvas limit is 32767).
export const MAX_PX = 30000;

/** Splits a page region (CSS px) into parts no taller than PART_PX device pixels. */
export function planParts(rect, scale) {
  const step = Math.max(1, Math.floor(PART_PX / scale));
  const total = Math.min(rect.height, Math.floor(MAX_PX / scale));
  const parts = [];
  for (let y = 0; y < total; y += step) {
    parts.push({ x: rect.x, y: rect.y + y, width: rect.width, height: Math.min(step, total - y), at: y });
  }
  return { parts, truncated: total < rect.height };
}

/**
 * Scroll positions for an inner box: from `from` to `to` (scrollTop values),
 * moving by the box's visible height `view`; each step says which rows of the
 * box (top..bottom, in box content coordinates) it contributes.
 */
export function partsForScroller(from, to, view, maxScroll) {
  const steps = [];
  if (!(view > 0) || !(to > from)) return steps;
  let top = from;
  while (true) {
    const scroll = Math.min(top, maxScroll);
    const start = top;
    const end = Math.min(to, top + view);
    steps.push({ scroll, start, end, offset: start - scroll });
    if (end >= to || scroll >= maxScroll && end >= scroll + view) break;
    top = end;
  }
  return steps;
}

// A page that does not draw (its window covered or off screen, a heavy page still decoding)
// can keep a picture command waiting for minutes: seen on a 24,000 px Wikipedia article in a
// background test window, 105 s for the first part. Each command gets a limit instead, and the
// debugger is let go either way, so the next try is not refused as "already attached".
export const COMMAND_LIMIT_MS = 20000;
async function withDebugger(tabId, work) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  const limited = (method, params = {}) => {
    let timer;
    const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error("the page did not draw in time: show its window and try again")), COMMAND_LIMIT_MS); });
    return Promise.race([chrome.debugger.sendCommand(target, method, params), late]).finally(() => clearTimeout(timer));
  };
  try {
    return await work(limited);
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function bitmapOf(base64) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: "image/png" }));
}

async function dataUrlOf(canvas) {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return "data:image/png;base64," + btoa(s);
}

// The page's own scroll and scale, read in the page.
function pageFacts() {
  const d = document.documentElement;
  return { width: Math.max(d.scrollWidth, document.body ? document.body.scrollWidth : 0), height: Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0), dpr: window.devicePixelRatio || 1, vw: innerWidth, vh: innerHeight };
}

// In the page: images that load only when scrolled near (loading="lazy") are
// asked to load now, and waited for, 3 s at most; otherwise a capture beyond the
// window shows them blank (review, gamblium-2d).
function loadLazyImages() {
  const lazy = [...document.images].filter((i) => i.loading === "lazy" || !i.complete);
  for (const i of lazy) i.loading = "eager";
  const ready = Promise.all(lazy.map((i) => (i.complete ? null : i.decode().catch(() => null))));
  return Promise.race([ready, new Promise((r) => setTimeout(r, 3000))]).then(() => lazy.length);
}

async function facts(tabId) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: pageFacts });
  return r.result;
}

/** A region of the page (CSS px, page coordinates) as one PNG data URL. */
async function captureRegion(tabId, rect, scale) {
  const { parts, truncated } = planParts(rect, scale);
  const t0 = performance.now();
  const shots = await withDebugger(tabId, async (send) => {
    const out = [];
    for (const p of parts) {
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true, clip: { x: p.x, y: p.y, width: p.width, height: p.height, scale: 1 } });
      out.push({ at: p.at, data: shot.data });
    }
    return out;
  });
  const t1 = performance.now();
  if (shots.length === 1 && !truncated) return { dataUrl: "data:image/png;base64," + shots[0].data, width: Math.round(rect.width * scale), height: Math.round(rect.height * scale), truncated, timing: { captureMs: Math.round(t1 - t0), joinMs: 0 } };
  const width = Math.round(rect.width * scale);
  const height = Math.round(parts.reduce((h, p) => h + p.height, 0) * scale);
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext("2d");
  for (const s of shots) g.drawImage(await bitmapOf(s.data), 0, Math.round(s.at * scale));
  const dataUrl = await dataUrlOf(canvas);
  // How long the browser took to draw the parts, and how long joining and encoding took here:
  // the second is what a native joiner (the Rust helper) could save.
  return { dataUrl, width, height, truncated, timing: { captureMs: Math.round(t1 - t0), joinMs: Math.round(performance.now() - t1) } };
}

// In the page: the inner box's geometry and scroll range.
function scrollerFacts(path) {
  const el = document.querySelector(path);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // Inner edges on whole device pixels: on a fractional edge the box's border
  // blends into the first row of every step (a dark line at each join).
  const dpr = window.devicePixelRatio || 1;
  const inner = (v) => Math.ceil(v * dpr) / dpr;
  const left = inner(r.left + el.clientLeft);
  const top = inner(r.top + el.clientTop);
  const height = Math.floor((r.top + el.clientTop + el.clientHeight - top) * dpr) / dpr;
  return { left, top, width: Math.floor((r.left + el.clientLeft + el.clientWidth - left) * dpr) / dpr, height, scrollTop: el.scrollTop, maxScroll: el.scrollHeight - el.clientHeight, scrollHeight: el.scrollHeight };
}
function scrollBoxTo(path, top) {
  const el = document.querySelector(path);
  if (!el) return null;
  el.scrollTop = top;
  return el.scrollTop;
}

/** An inner scrolling box, from content row `from` to `to`, joined at the scroll positions. */
async function captureScroller(tabId, path, from, to, scale) {
  const run = async (func, args) => (await chrome.scripting.executeScript({ target: { tabId }, func, args }))[0].result;
  const box = await run(scrollerFacts, [path]);
  if (!box) return { ok: false, error: "that part of the page is gone" };
  const end = Math.min(to, box.scrollHeight, from + Math.floor(MAX_PX / scale));
  const steps = partsForScroller(from, end, box.height, box.maxScroll);
  const width = Math.round(box.width * scale);
  const height = Math.round((end - from) * scale);
  const canvas = new OffscreenCanvas(width, Math.max(1, height));
  const g = canvas.getContext("2d");
  const before = box.scrollTop;
  let bottom = 0; // lowest device row drawn
  try {
    await withDebugger(tabId, async (send) => {
      for (const s of steps) {
        const actual = await run(scrollBoxTo, [path, s.scroll]);
        await new Promise((r) => setTimeout(r, 120)); // let the page draw what scrolled in
        const offset = s.start - actual;
        // Never past the box's inner bottom edge (its border would show).
        const rows = Math.min(s.end - s.start, box.height - offset);
        if (rows <= 0) continue;
        const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true, clip: { x: box.left, y: box.top + offset, width: box.width, height: rows, scale: 1 } });
        const bmp = await bitmapOf(shot.data);
        const y = Math.round((s.start - from) * scale);
        g.drawImage(bmp, 0, y);
        bottom = Math.max(bottom, y + bmp.height);
      }
    });
  } finally {
    await run(scrollBoxTo, [path, before]).catch(() => {});
  }
  // Rows the last step could not reach would stay transparent (black in viewers): cut them.
  let result = canvas;
  if (bottom > 0 && bottom < height) {
    result = new OffscreenCanvas(width, bottom);
    result.getContext("2d").drawImage(canvas, 0, 0);
  }
  return { ok: true, dataUrl: await dataUrlOf(result), width, height: result.height, truncated: end < to };
}

/**
 * The one entry point. req: { mode: "visible" | "page" | "area", rect?: {x,y,width,height}
 * in page CSS px, scroller?: CSS path of an inner scrolling box (then rect.y/height are
 * rows of that box's content) }.
 */
/**
 * The browser's own pages (New Tab, Settings, chrome://, the Web Store): the browser gives no
 * picture, so the helper asks Windows for one of the window (the page area only). What the
 * window shows: the visible part, and the tab must be the one in front of its window.
 */
async function windowPicture(tab, native) {
  if (!native) return { ok: false, error: "the browser does not allow pictures of this page" };
  if (!tab.active) return { ok: false, error: "only the tab in front of its window can be pictured here" };
  const w = await chrome.windows.get(tab.windowId);
  if (w.state === "minimized") return { ok: false, error: "the window is minimised" };
  const r = await native({ type: "capture-window", left: w.left, top: w.top, width: w.width, height: w.height });
  if (!r || r.ok === false) return { ok: false, error: (r && r.error) || "no picture" };
  let data = "";
  for (let i = 0, total = 1; i < total; i++) {
    const p = await native({ type: "capture-piece", picture: r.picture, index: i });
    if (!p || p.ok === false) return { ok: false, error: (p && p.error) || "the picture did not arrive" };
    data += p.data;
    total = p.total;
  }
  return { ok: true, mode: "visible", dataUrl: "data:image/png;base64," + data, width: r.width, height: r.height, window: true };
}

export async function screenshot(tab, req, native) {
  if (!tab) return { ok: false, error: "no tab" };
  if (!/^https?:|^file:/.test(tab.url || "")) return windowPicture(tab, native);
  try {
    const f = await facts(tab.id);
    // Pictures come out at the screen's own scale (device pixels): the clip's
    // own scale stays 1, or the two multiply.
    const scale = f.dpr;
    if (req.mode === "visible") {
      const shot = await withDebugger(tab.id, (send) => send("Page.captureScreenshot", { format: "png", fromSurface: true }));
      return { ok: true, mode: "visible", dataUrl: "data:image/png;base64," + shot.data, width: Math.round(f.vw * scale), height: Math.round(f.vh * scale) };
    }
    if (req.mode === "area" && req.scroller) {
      const r = req.rect || {};
      return { ...(await captureScroller(tab.id, String(req.scroller), Math.max(0, r.y | 0), Math.max(0, (r.y | 0) + (r.height | 0)), scale)), mode: "area" };
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: loadLazyImages }).catch(() => null);
    const rect = req.mode === "area" && req.rect
      ? { x: Math.max(0, req.rect.x), y: Math.max(0, req.rect.y), width: Math.max(1, req.rect.width), height: Math.max(1, req.rect.height) }
      : { x: 0, y: 0, width: f.vw, height: f.height };
    return { ok: true, mode: req.mode, ...(await captureRegion(tab.id, rect, scale)) };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/** Saves a picture to Downloads (our folder rules sort it); returns the download id. */
export async function saveShot(dataUrl, pageUrl) {
  let host = "page";
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, "") || host;
  } catch {}
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const name = `Screenshot ${host} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}.png`;
  const id = await chrome.downloads.download({ url: dataUrl, filename: name.replace(/[\\/:*?"<>|]/g, "_"), saveAs: false });
  return { ok: true, download: id, name };
}
