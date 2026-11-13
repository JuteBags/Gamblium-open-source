// Screenshot: the overlay and the result card. Put into the page by the background (right-click >
// Screenshot) or the popup (its Screenshot button) only when asked; nothing waits in pages before that.
//
// - One overlay, three modes on its toolbar: Area (default), Visible, Whole page (A, V, W).
// - Area: drag a box. Dragging past the window's top or bottom edge scrolls the page (or the box that
//   scrolls, as in a mail app) and the box grows with it; once let go, the size pill adds "scroll over it
//   to make it longer". The wheel grows the box while the pointer is inside it and scrolls
//   the page when outside. Arrows move the box; Shift+arrows resize it by 10 px, Alt+arrows by 1 px.
//   Enter captures; Esc clears the box, a second Esc closes the overlay. The label gives the saved size.
// - The result card: "Copied to the clipboard" (or a Copy button until it is), Save (Ctrl+S), Open, ×;
//   8 s, held while hovered or focused. It takes the progress card's place without a fade.
//
// The capture itself is the engine's (extension/shot.js, in the background): {type:'menu-do',
// what:'screenshot', mode:'area'|'visible'|'page', rect:{x,y,width,height}|null in page CSS px, scroller:
// CSS path|null} -> {ok, dataUrl, width, height (device px), truncated}. With a scroller, rect.y/height
// are rows of that box's content (its scrollTop space). Save: {what:'screenshot-save', dataUrl} ->
// {ok, name}. Copy and Open happen here, in the page (the service worker cannot).
//
// A classic script; the pure part hands itself over to shot.test.mjs.
(() => {
  /** The box between two points, whatever way it was dragged. */
  function boxOf(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }
  /** How far to scroll this frame while the pointer is near (or past) the top or bottom edge: faster the closer. */
  function edgeSpeed(clientY, height, zone = 56, max = 24) {
    if (clientY > height - zone) return Math.min(max, Math.ceil(((clientY - (height - zone)) / zone) * max));
    if (clientY < zone) return -Math.min(max, Math.ceil(((zone - clientY) / zone) * max));
    return 0;
  }
  /** "1280 × 5400 px": the size that will be saved, in device pixels. */
  const sizeLabel = (w, h, dpr = 1) => `${Math.round(w * dpr)} × ${Math.round(h * dpr)} px`;
  /** What an arrow key does to the box: move it, or with Shift / Alt grow or shrink its right and bottom edges. */
  function nudge(box, key, { shift = false, alt = false } = {}) {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];
    if (!d) return box;
    if (shift || alt) {
      const step = shift ? 10 : 1;
      return { ...box, w: Math.max(4, box.w + d[0] * step), h: Math.max(4, box.h + d[1] * step) };
    }
    return { ...box, x: Math.max(0, box.x + d[0] * 10), y: Math.max(0, box.y + d[1] * 10) };
  }
  /** "example.com 2026-11-13 21.04.png" */
  function fileName(host, now = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    const site = String(host || 'page').replace(/^www\./, '').replace(/[\\/:*?"<>|]+/g, '-') || 'page';
    return `${site} ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}.${p(now.getMinutes())}.png`;
  }
  /** A selector that finds this element again (ids where there are any, otherwise child positions). */
  function cssPath(el) {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
      if (e.id && /^[A-Za-z][\w-]*$/.test(e.id)) { parts.unshift(`#${e.id}`); break; }
      parts.unshift(`${e.localName}:nth-child(${[...e.parentElement.children].indexOf(e) + 1})`);
    }
    return parts.join(' > ');
  }
  /** The box that scrolls under a point, when it is not the page itself. */
  function scrollerAt(el) {
    for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      if (/(auto|scroll|overlay)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4) return e;
    }
    return null;
  }

  if (globalThis.__gambliumShotTest) {
    Object.assign(globalThis.__gambliumShotTest, { boxOf, edgeSpeed, sizeLabel, nudge, fileName });
    return;
  }
  document.querySelector('gamblium-shot')?.remove(); // a second start replaces the first

  const CSS = `
    :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; font: 400 13px/1.3 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif; color: #E9EBF0;
      --panel: rgba(20,21,26,.94); --rim: rgba(255,255,255,.1); --muted: #C9CED8; --hi: #8FA3C4; --go-bg: #E4E6EB; --go-ink: #030304; --bad: #FF8A80; --shade: 0 10px 30px rgba(0,0,0,.5); }
    @media (prefers-color-scheme: light) { :host { color: #121316; --panel: rgba(250,250,252,.97); --rim: rgba(0,0,0,.1); --muted: #3A3F4A; --hi: #3F5A85; --go-bg: #121316; --go-ink: #fff; --bad: #B3261E; --shade: 0 10px 30px rgba(0,0,0,.18); } }
    [hidden] { display: none !important; }
    .veil { position: fixed; inset: 0; cursor: crosshair; background: rgba(3,3,4,.42); }
    .veil.has { background: transparent; }
    .box { position: fixed; box-shadow: 0 0 0 100vmax rgba(3,3,4,.42); outline: 1px solid var(--hi); pointer-events: none; }
    .bar, .tag, .card { background: var(--panel); box-shadow: var(--shade), inset 0 0 0 1px var(--rim); }
    .bar { position: fixed; left: 50%; top: 14px; transform: translateX(-50%); display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: 12px; }
    .bar .seg { display: flex; gap: 2px; margin-right: 6px; }
    .bar small { margin: 0 8px 0 6px; color: var(--muted); }
    .tag { position: fixed; display: flex; align-items: center; gap: 4px; padding: 4px 4px 4px 10px; border-radius: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .tag span { margin-right: 6px; color: var(--muted); }
    .tag span b { font-weight: 400; opacity: .8; }
    button { all: unset; box-sizing: border-box; display: inline-grid; place-items: center; min-width: 30px; height: 28px; padding: 0 10px; border-radius: 8px; cursor: default; }
    button:hover { background: rgba(127,127,127,.18); }
    button:disabled { opacity: .4; background: none; }
    button:focus-visible { outline: 2px solid var(--hi); outline-offset: 1px; }
    button[aria-pressed="true"] { background: rgba(127,127,127,.24); box-shadow: inset 0 -2px 0 var(--hi); font-weight: 600; }
    button.go { background: var(--go-bg); color: var(--go-ink); font-weight: 600; }
    .card { position: fixed; right: 16px; bottom: 16px; width: 264px; padding: 10px; border-radius: 14px; animation: up .16s ease-out; }
    .card img { display: block; width: 100%; max-height: 180px; object-fit: cover; object-position: top; border-radius: 8px; background: #000; }
    .card p { margin: 8px 2px; color: var(--muted); }
    .card .row { display: flex; gap: 4px; }
    .card .row button:last-child { margin-left: auto; }
    .bad { color: var(--bad) !important; }
    @keyframes up { from { opacity: 0; transform: translateY(8px); } }
    .card.still { animation: none; }
    @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
  `;
  const host = document.createElement('gamblium-shot');
  const root = host.attachShadow({ mode: 'closed' });
  root.append(Object.assign(document.createElement('style'), { textContent: CSS }));
  document.documentElement.append(host);
  const el = (tag, props = {}, kids = []) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const btn = (text, title, fn, cls = '') => { const b = el('button', { textContent: text, title, className: cls }); b.addEventListener('click', fn); return b; };
  const send = (msg) => chrome.runtime.sendMessage({ type: 'menu-do', ...msg }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  const frames = (n) => new Promise((r) => { const step = () => (n-- <= 0 ? r() : requestAnimationFrame(step)); requestAnimationFrame(step); });
  const off = [];
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); off.push(() => target.removeEventListener(type, fn, opts)); };
  const clear = () => { for (const f of off.splice(0)) f(); root.querySelectorAll(':not(style)').forEach((n) => n.remove()); };
  const finish = () => { clear(); host.remove(); };

  // ---- capture and the result card -------------------------------------------------
  let capturing = false;
  let shown = false; // the progress card was up: the result takes its place without a fade
  async function capture(req) {
    shown = false;
    capturing = true;
    clear();
    host.style.display = 'none'; // never in the picture
    await frames(2);
    // A capture that takes long says so and can be stopped (engine checks screenshot-cancel).
    const slow = setTimeout(() => {
      host.style.display = '';
      shown = true;
      // No fade: the page is busy while the engine scrolls and an animation can stall half-way.
      root.append(el('div', { className: 'card still', role: 'status' }, [el('p', { textContent: 'Capturing… Esc stops.' })]));
      on(document, 'keydown', (e) => { if (e.isTrusted && e.key === 'Escape') finish(); }, true); // the result is dropped
    }, 1000);
    let r = await send({ what: 'screenshot', ...req });
    if (req.cut && r && r.ok !== false && r.dataUrl) r = await cutOut(r, req.cut).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    clearTimeout(slow);
    capturing = false;
    if (!host.isConnected) return; // stopped
    host.style.display = '';
    clear();
    card(r);
  }
  // The window picture covers the whole page area of the tab (our page may sit in the New Tab shell's
  // frame): the box is placed by the frame's offset and scaled to the picture's pixels.
  async function cutOut(r, c) {
    const top = window.top;
    const fr = window.frameElement ? window.frameElement.getBoundingClientRect() : { left: 0, top: 0 };
    const img = await createImageBitmap(await (await fetch(r.dataUrl)).blob());
    const k = img.width / top.innerWidth;
    const x = Math.max(0, (fr.left + c.x) * k), y = Math.max(0, (fr.top + c.y) * k);
    const w = Math.min(img.width - x, c.w * k), h = Math.min(img.height - y, c.h * k);
    const out = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) });
    out.getContext('2d').drawImage(img, x, y, w, h, 0, 0, out.width, out.height);
    return { ok: true, dataUrl: out.toDataURL('image/png'), width: out.width, height: out.height };
  }
  async function copy(dataUrl) {
    const blob = await (await fetch(dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
  }
  function card(r) {
    const say = el('p');
    const close = btn('×', 'Close (Esc)', finish);
    close.setAttribute('aria-label', 'Close');
    const box = el('div', { className: shown ? 'card still' : 'card', role: 'status' });
    let timer = 0;
    const later = () => { clearTimeout(timer); timer = setTimeout(finish, 8000); };
    const hold = () => clearTimeout(timer);
    on(box, 'pointerenter', hold); on(box, 'pointerleave', later); on(box, 'focusin', hold); on(box, 'focusout', later);
    if (!r || r.ok === false || !r.dataUrl) {
      say.className = r?.say ? '' : 'bad'; // an explanation is not an error
      say.textContent = r?.say || `No screenshot: ${r?.error || 'the page could not be captured.'}`;
      box.append(say, el('div', { className: 'row' }, [close]));
    } else {
      const size = r.width && r.height ? `${r.width} × ${r.height} px` : '';
      const parts = r.truncated ? `${size}, cut at the longest picture the browser makes` : size;
      say.textContent = parts;
      const save = async () => { const s = await send({ what: 'screenshot-save', dataUrl: r.dataUrl, name: fileName(location.hostname) }); say.textContent = s?.ok === false ? s.error || 'Not saved.' : `Saved to your downloads${s?.name ? `: ${s.name}` : ''}.`; };
      // A page may not open a data: address in a new tab; a blob of the same picture it may.
      const open = async () => { const blob = await (await fetch(r.dataUrl)).blob(); window.open(URL.createObjectURL(blob), '_blank', 'noopener'); };
      // The Copy button is there until the copy is done, so the card always shows one or the other:
      // after a long capture the page has lost the click's permission and the automatic copy fails (or hangs).
      const copied = () => { say.textContent = `Copied to the clipboard. ${parts}`.trim(); c.remove(); };
      const c = btn('Copy', 'Copy to the clipboard', async () => { try { await copy(r.dataUrl); copied(); } catch { say.textContent = 'The page did not allow copying; use Save.'; } });
      box.append(el('img', { src: r.dataUrl, alt: 'The screenshot' }), say,
        el('div', { className: 'row' }, [c, btn('Save', 'Save (Ctrl+S)', save), btn('Open', 'Open in a new tab', open), close]));
      on(document, 'keydown', (e) => { if (e.isTrusted && e.ctrlKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); } }, true);
      copy(r.dataUrl).then(copied, () => {});
    }
    on(document, 'keydown', (e) => { if (e.isTrusted && e.key === 'Escape') finish(); }, true);
    root.append(box);
    later();
  }

  // Gamblium's own pages (New Tab, Settings, History...): the browser gives extensions no picture of
  // them, so the helper takes one of the window from Windows (#174): what the window shows, nothing
  // below it. So here an area must lie inside the window (it is cut from that picture), Whole page
  // is greyed and says why, and nothing scrolls while dragging.
  const OWN = location.protocol === 'chrome-extension:';

  // ---- the overlay: modes, and the Area picker --------------------------------------
  const veil = el('div', { className: 'veil' });
  const box = el('div', { className: 'box', hidden: true });
  const label = el('span');
  const go = () => {
    if (!start || dragging || capturing) return;
    const b = boxOf(start, end);
    if (OWN) {
      // Inside the window only: the part of the box the window shows.
      const c = clientBox();
      const x = Math.max(0, c.x), y = Math.max(0, c.y);
      return capture({ mode: 'visible', cut: { x, y, w: Math.min(innerWidth, c.x + c.w) - x, h: Math.min(innerHeight, c.y + c.h) - y } });
    }
    capture({ mode: 'area', rect: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.w), height: Math.round(b.h) }, scroller: scroller ? cssPath(scroller) : null });
  };
  const ok = btn('✓', 'Capture (Enter)', () => go(), 'go');
  ok.setAttribute('aria-label', 'Capture');
  const tag = el('div', { className: 'tag', hidden: true }, [label, ok]);
  const modes = [['Area', 'A', 'area'], ['Visible', 'V', 'visible'], ['Whole page', 'W', 'page']].map(([text, k, m]) => {
    const b = btn(text, `${text} (${k})`, () => pick(m));
    b.setAttribute('aria-pressed', String(m === 'area'));
    if (OWN && m === 'page') { b.disabled = true; b.title = 'Here only what the window shows can be captured'; }
    return b;
  });
  const hint = el('small', { textContent: 'Drag over what you want' });
  const shut = btn('×', 'Close (Esc)', () => finish());
  shut.setAttribute('aria-label', 'Close');
  const bar = el('div', { className: 'bar', role: 'toolbar', ariaLabel: 'Screenshot' }, [el('div', { className: 'seg' }, modes), hint, shut]);
  root.append(veil, box, tag, bar);
  const pick = (m) => (m === 'area' || (OWN && m === 'page') ? null : capture({ mode: m, rect: null, scroller: null }));

  let scroller = null; // the element that scrolls, when it is not the page
  let start = null; // corners of the box in content coordinates
  let end = null;
  let dragging = false;
  let lastClient = null;
  let raf = 0;
  const scrollPos = () => (scroller ? { x: scroller.scrollLeft, y: scroller.scrollTop } : { x: scrollX, y: scrollY });
  const origin = () => (scroller ? scroller.getBoundingClientRect() : { left: 0, top: 0 });
  const toContent = (cx, cy) => { const s = scrollPos(); const o = origin(); return { x: cx - o.left + s.x, y: cy - o.top + s.y }; };
  const scrollBy = (dy) => (scroller ? scroller.scrollBy(0, dy) : window.scrollBy(0, dy));
  const clientBox = () => { const b = boxOf(start, end); const s = scrollPos(); const o = origin(); return { x: b.x - s.x + o.left, y: b.y - s.y + o.top, w: b.w, h: b.h }; };

  function paint() {
    if (!start || !end) return;
    const c = clientBox();
    Object.assign(box.style, { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px`, height: `${c.h}px` });
    box.hidden = false;
    veil.classList.add('has');
    // Once let go, the pill also says how to make it longer (the wheel over the box).
    label.replaceChildren(sizeLabel(c.w, c.h, devicePixelRatio), ...(dragging || OWN ? [] : [' · ', el('b', { textContent: 'scroll over it to make it longer' })]));
    tag.hidden = false;
    hint.hidden = true;
    const left = Math.max(8, Math.min(innerWidth - (dragging ? 200 : 420), c.x));
    Object.assign(tag.style, { left: `${left}px`, top: `${Math.max(8, Math.min(innerHeight - 44, c.y + c.h + 8))}px` });
  }
  function edgeLoop() {
    raf = 0;
    if (!dragging || !lastClient) return;
    const v = edgeSpeed(lastClient.y, innerHeight);
    if (!v) return;
    const before = scrollPos().y;
    scrollBy(v);
    const moved = scrollPos().y - before;
    if (moved) { end = { x: end.x, y: end.y + moved }; paint(); raf = requestAnimationFrame(edgeLoop); } // stops at the end of the page
  }
  on(veil, 'pointerdown', (e) => {
    if (!e.isTrusted || e.button !== 0) return;
    host.style.pointerEvents = 'none';
    const under = document.elementFromPoint(e.clientX, e.clientY);
    host.style.pointerEvents = '';
    const docScrolls = document.scrollingElement && document.scrollingElement.scrollHeight > innerHeight + 4;
    scroller = docScrolls ? null : scrollerAt(under);
    start = end = toContent(e.clientX, e.clientY);
    dragging = true;
    veil.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  on(veil, 'pointermove', (e) => {
    if (!dragging || !e.isTrusted) return;
    lastClient = { x: e.clientX, y: e.clientY };
    end = toContent(e.clientX, Math.max(0, Math.min(innerHeight, e.clientY)));
    paint();
    if (!raf && !OWN && edgeSpeed(e.clientY, innerHeight)) raf = requestAnimationFrame(edgeLoop);
  });
  on(veil, 'pointerup', (e) => {
    if (!dragging || !e.isTrusted) return;
    dragging = false;
    cancelAnimationFrame(raf);
    raf = 0;
    const b = boxOf(start, end);
    if (b.w < 4 || b.h < 4) return reset();
    paint();
    ok.focus();
  });
  function reset() {
    start = end = null;
    box.hidden = tag.hidden = true;
    hint.hidden = false;
    veil.classList.remove('has');
  }
  // The wheel grows the box while the pointer is inside it; outside it scrolls the page as always.
  on(veil, 'wheel', (e) => {
    if (!e.isTrusted || dragging || !start || OWN) return; // our pages: nothing below the window to reach
    const c = clientBox();
    const inside = e.clientX >= c.x && e.clientX <= c.x + c.w && e.clientY >= c.y && e.clientY <= Math.min(innerHeight, c.y + c.h);
    if (!inside) return;
    e.preventDefault();
    const b = boxOf(start, end);
    start = { x: b.x, y: b.y };
    end = { x: b.x + b.w, y: Math.max(b.y + 4, b.y + b.h + e.deltaY) };
    const bottom = end.y - scrollPos().y + origin().top;
    if (bottom > innerHeight - 64) scrollBy(bottom - (innerHeight - 64)); // keep the moving edge in view
    paint();
  }, { passive: false });
  on(document, 'keydown', (e) => {
    if (!e.isTrusted || capturing) return;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'Escape') { stop(); return start && !dragging ? reset() : finish(); }
    if (e.key === 'Enter' && start && !dragging && !e.target?.closest?.('button')) { stop(); return go(); }
    if (!e.ctrlKey && !e.metaKey && /^[avw]$/i.test(e.key) && !e.altKey) { stop(); return pick({ a: 'area', v: 'visible', w: 'page' }[e.key.toLowerCase()]); }
    if (start && !dragging && e.key.startsWith('Arrow')) {
      stop();
      const b = nudge(boxOf(start, end), e.key, { shift: e.shiftKey, alt: e.altKey });
      start = { x: b.x, y: b.y };
      end = { x: b.x + b.w, y: b.y + b.h };
      paint();
    }
  }, true);
  on(window, 'scroll', paint, true);
  modes[0].focus();
})();
