// Links on darkened websites (../darklinks.js). Registered only while the browser darkens
// light-only websites, from the page's first byte, with content/darklinks.css.
// On a light page (each frame on its own: the browser decides per frame) it marks text
// coloured like a link (blue to purple, saturated, dark enough) just before the frame that
// would first show it is painted, so a link is never seen in another colour first (owner,
// Nov 14 2026: "first it shows in purple, then it goes green"). Work happens only when links
// are added; nothing runs on a timer. Pages that are dark already, or kept light, are left alone.
(() => {
  if (globalThis.__gambliumDarkLinks) return;
  globalThis.__gambliumDarkLinks = true;
  const root = document.documentElement;

  // The chosen colours (the worker keeps them ready as darkLinksVars); the stylesheet's own
  // values (cyan) hold until this answers, a few milliseconds into the page.
  chrome.storage.local.get({ darkLinksVars: null }).then(({ darkLinksVars: v }) => {
    if (v?.link) root.style.setProperty('--gamblium-link', v.link);
    if (v?.visited) root.style.setProperty('--gamblium-visited', v.visited);
  }, () => {});

  const rgbOf = (text) => {
    const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?/.exec(text || '');
    if (!m) return null;
    const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a: alpha };
  };

  // A link's colour: hue from blue to purple, clearly coloured, not light.
  const linkish = (text) => {
    const c = rgbOf(text);
    if (!c || c.a < 0.5) return false;
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (d < 0.15) return false;
    const s = d / (1 - Math.abs(2 * l - 1));
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    return h >= 195 && h <= 320 && s >= 0.35 && l >= 0.12 && l <= 0.6;
  };

  // Light page: the root's background (or the body's, or white when neither has one) is light,
  // and the page did not ask to stay light ("Keep these sites light" sets color-scheme: only light).
  let light = null; // decided at the first frame, when the page's styles are in
  const lightPage = () => {
    if (/only/.test(getComputedStyle(root).colorScheme || '')) return false;
    for (const el of [root, document.body]) {
      const c = el && rgbOf(getComputedStyle(el).backgroundColor);
      if (c && c.a > 0.5) return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255 > 0.5;
    }
    return true;
  };

  const mark = (a) => {
    if (a.hasAttribute('data-gamblium-link')) return;
    if (linkish(getComputedStyle(a).color)) a.setAttribute('data-gamblium-link', '');
    // Text inside the link with a link colour of its own (Google's result titles).
    let n = 0;
    for (const el of a.querySelectorAll('*')) {
      if (++n > 12) break;
      if (!el.hasAttribute('data-gamblium-link') && linkish(getComputedStyle(el).color)) el.setAttribute('data-gamblium-link', '');
    }
  };

  let added = [];
  let frame = 0;
  const run = () => {
    frame = 0;
    const batch = added;
    added = [];
    if (light === null) {
      if (!document.body) { frame = requestAnimationFrame(run); added = batch; return; }
      light = lightPage();
      if (!light) { watcher.disconnect(); return; }
    }
    for (const node of batch) {
      if (!node.isConnected) continue;
      if (node.tagName === 'A') mark(node);
      for (const a of node.querySelectorAll('a[href]')) mark(a);
    }
  };
  // Before the next paint: the page's styles are in by then (the browser does not paint before
  // its stylesheets), and our colour is in the same frame.
  const watcher = new MutationObserver((list) => {
    for (const m of list) for (const node of m.addedNodes) if (node.nodeType === 1 && (node.tagName === 'A' || node.firstElementChild)) added.push(node);
    if (!frame && added.length) frame = requestAnimationFrame(run);
  });
  watcher.observe(root, { childList: true, subtree: true });
  // What was parsed before this script ran.
  added.push(root);
  frame = requestAnimationFrame(run);
})();
