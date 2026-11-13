// Shows one of our pages inside the new tab document. The page runs as it
// always does (same origin, all extension APIs); this only keeps the tab's
// title, icon and "#/<route>" in step with it, and sends links that leave
// Gamblium to the tab itself instead of into the frame.
import { fileOf, routeOf } from '../routes.js';

const HOME = location.pathname; // /newtab/index.html

export function show(file) {
  document.documentElement.dataset.route = '';
  const frame = Object.assign(document.createElement('iframe'), { id: 'shell', title: 'Gamblium', src: chrome.runtime.getURL(file) });
  document.body.append(frame);
  let watching = null;

  function sync() {
    let win;
    let here;
    try {
      win = frame.contentWindow;
      here = win.location;
      void here.pathname;
    } catch {
      return; // the frame went somewhere that is not ours; the click handler below prevents this
    }
    // A page that goes "home" (the welcome page when it is done) means the real new tab page.
    if (here.pathname === HOME) return void location.replace(HOME);
    const route = routeOf(here.pathname + here.search + here.hash);
    if (route && location.hash !== '#/' + route) history.replaceState(null, '', '#/' + route);
    document.title = win.document.title || 'Gamblium';
    const icon = win.document.querySelector('link[rel~="icon"]');
    if (icon) document.querySelector('link[rel~="icon"]')?.setAttribute('href', icon.href);
    if (watching === win.document) return;
    watching = win.document;
    win.addEventListener('hashchange', sync);
    const title = win.document.querySelector('title');
    if (title) new win.MutationObserver(sync).observe(title, { childList: true, characterData: true, subtree: true });
    // A link to the web, or to one of the browser's pages, belongs to the tab, not to this frame.
    win.document.addEventListener('click', (e) => {
      const a = e.target.closest?.('a[href]');
      if (!a || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey || a.target === '_blank') return;
      if (new URL(a.href, here.href).origin === location.origin) return;
      e.preventDefault();
      chrome.tabs.update({ url: a.href });
    }, true);
    frame.focus();
  }
  frame.addEventListener('load', sync);

  // Back and forward in the tab, or a route typed into the hash.
  addEventListener('hashchange', () => {
    const next = location.hash.startsWith('#/') ? fileOf(location.hash.slice(2)) : null;
    if (!next) return void location.replace(HOME);
    let now = '';
    try {
      const l = frame.contentWindow.location;
      now = routeOf(l.pathname + l.search + l.hash) ?? '';
    } catch {}
    if ('#/' + now !== location.hash) frame.contentWindow.location.replace(chrome.runtime.getURL(next));
  });
}
