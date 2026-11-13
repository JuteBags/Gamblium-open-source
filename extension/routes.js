// Gamblium's own addresses. One map from a short name to where it really
// lives, used by the new tab page (which shows our pages under its own, empty
// address), by the search box, and by the background when someone types
// gamblium://something. No browser APIs here, so node --test can run it.
//
// Two kinds of target:
//   page    one of the extension's pages, shown inside the new tab document so
//           the address bar stays clean
//   browser one of the browser's own pages (chrome://...), opened as it is

/** Our pages: route name -> file inside the extension. */
export const PAGES = {
  tabs: 'ui/dashboard.html',
  history: 'ui/history.html',
  downloads: 'ui/downloads.html',
  sessions: 'ui/sessions.html',
  security: 'ui/security.html',
  settings: 'ui/settings.html',
  shortcuts: 'ui/shortcuts.html',
  welcome: 'ui/welcome.html',
};

/** Other words for our pages. */
const ALIASES = { dashboard: 'tabs', memory: 'tabs', library: 'history', keys: 'shortcuts', onboarding: 'welcome' };

/** The browser's own pages that have a name of ours. Anything else passes through: gamblium://x -> chrome://x. */
export const BROWSER = {
  gpu: 'chrome://gpu/',
  flags: 'chrome://flags/',
  version: 'chrome://version/',
  extensions: 'chrome://extensions/',
  bookmarks: 'chrome://bookmarks/',
  passwords: 'chrome://password-manager/passwords',
  browser: 'chrome://settings/',
  search: 'chrome://settings/search',
  privacy: 'chrome://settings/privacy',
  import: 'chrome://settings/importData',
  about: 'chrome://settings/help',
  system: 'chrome://system/',
  net: 'chrome://net-internals/',
  newtab: 'chrome://newtab/',
};

/** What each name is, for lists that offer them. */
export const TITLES = {
  tabs: 'Tabs and memory', history: 'History', downloads: 'Downloads', sessions: 'Sessions', security: 'Security check-up', settings: 'Settings',
  shortcuts: 'Keyboard shortcuts', welcome: 'Welcome', gpu: 'Graphics details', flags: 'Experiments', version: 'Version', extensions: 'Extensions',
  bookmarks: 'Bookmarks', passwords: 'Passwords', browser: 'Browser settings', search: 'Search engine', privacy: 'Privacy and security',
  import: 'Import from another browser', about: 'About', system: 'System details', net: 'Network internals', newtab: 'New tab',
};

const SCHEME = /^(gamblium|brave|chrome|about):(\/\/)?/i;

/**
 * Where a typed address leads.
 *   'gamblium://settings/look'  -> { kind: 'page', name: 'settings', file: 'ui/settings.html', rest: '#look', route: 'settings#look' }
 *   'gamblium://gpu'            -> { kind: 'browser', name: 'gpu', url: 'chrome://gpu/' }
 *   'gamblium://anything/else'  -> { kind: 'browser', url: 'chrome://anything/else' }
 * Text without the gamblium scheme gives null, unless `bare` is set (for a box
 * that already knows a name is being typed).
 */
export function resolve(text, { bare = false } = {}) {
  const raw = String(text ?? '').trim();
  const m = SCHEME.exec(raw);
  if (!m ? !bare : m[1].toLowerCase() !== 'gamblium') return null;
  const tail = raw.slice(m ? m[0].length : 0);
  if (!tail) return { kind: 'browser', name: 'newtab', url: BROWSER.newtab };
  const cut = tail.search(/[/?#]/);
  const head = (cut < 0 ? tail : tail.slice(0, cut)).toLowerCase();
  let rest = cut < 0 ? '' : tail.slice(cut);
  const name = ALIASES[head] ?? head;
  if (PAGES[name]) {
    // settings/look is the page's own #look; a query stays a query.
    if (rest.startsWith('/')) rest = rest.length > 1 ? '#' + rest.slice(1) : '';
    return { kind: 'page', name, file: PAGES[name], rest, route: name + rest };
  }
  if (BROWSER[name] && (rest === '' || rest === '/')) return { kind: 'browser', name, url: BROWSER[name] };
  if (!/^[a-z0-9-]+$/.test(head)) return null;
  return { kind: 'browser', url: `chrome://${head}${rest || '/'}` };
}

/** The route (what follows "#/" in the new tab's address) for one of our files, or null if it is not one of ours. */
export function routeOf(file) {
  const m = /^\/?(ui\/[a-z-]+\.html)(.*)$/.exec(String(file ?? ''));
  if (!m) return null;
  const name = Object.keys(PAGES).find((k) => PAGES[k] === m[1]);
  return name ? name + m[2] : null;
}

/** The file (with query and inner hash) a route stands for, or null. */
export function fileOf(route) {
  const r = String(route ?? '').replace(/^#?\/?/, '');
  const cut = r.search(/[?#]/);
  const head = (cut < 0 ? r : r.slice(0, cut)).toLowerCase();
  const name = ALIASES[head] ?? head;
  return PAGES[name] ? PAGES[name] + (cut < 0 ? '' : r.slice(cut)) : null;
}

/** How an address reads in our own words: 'gamblium://settings#look', 'gamblium://gpu'. Null when it is an ordinary web address. */
export function pretty(url, extensionId = '') {
  const u = String(url ?? '');
  const ext = /^chrome-extension:\/\/([a-p]{32})\/(.*)$/.exec(u);
  if (ext) {
    if (extensionId && ext[1] !== extensionId) return null;
    const route = routeOf(ext[2]);
    if (route) return 'gamblium://' + route;
    return /^newtab\/index\.html/.test(ext[2]) ? 'gamblium://newtab' : null;
  }
  const own = /^(chrome|brave):\/\/(.*)$/i.exec(u);
  if (!own) return null;
  const name = Object.keys(BROWSER).find((k) => BROWSER[k].replace(/\/$/, '') === ('chrome://' + own[2]).replace(/\/$/, ''));
  return 'gamblium://' + (name ?? own[2].replace(/\/$/, ''));
}

/** Names to offer while someone types after "gamblium://": every word must be in the name or its title. */
export function suggestRoutes(text, max = 6) {
  const typed = String(text ?? '').replace(SCHEME, '').toLowerCase();
  const words = typed.split(/[\s/]+/).filter(Boolean);
  return [...Object.keys(PAGES), ...Object.keys(BROWSER)]
    .filter((name) => words.every((w) => `${name} ${TITLES[name] ?? ''}`.toLowerCase().includes(w)))
    .slice(0, max)
    .map((name) => ({ name, address: 'gamblium://' + name, title: TITLES[name] ?? name, kind: PAGES[name] ? 'page' : 'browser' }));
}
