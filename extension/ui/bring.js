// "Bring your stuff over" (owner, Nov 14 2026): what the other browsers on this computer are
// signed in to, so each can be signed in to again here, plus the browser's own importer for
// passwords, bookmarks and history. Used by Settings and by the welcome page (compact).
//
// The helper reads (never changes) the other browsers' profiles: their Google accounts and the
// sites they hold a saved login for, with the user name, never the password (bring.rs).
// Signed-in sessions themselves cannot move: they are encrypted for that browser.

const DONE_KEY = 'bringDone';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

function scan() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'native', request: { type: 'bring-scan' } }, (r) => resolve(chrome.runtime.lastError ? null : r));
  });
}

function openTab(url) {
  chrome.tabs.create({ url, active: true });
}

/** Google's account chooser, with the address filled in. */
export function googleSignIn(email) {
  return 'https://accounts.google.com/AccountChooser?Email=' + encodeURIComponent(email) + '&continue=' + encodeURIComponent('https://myaccount.google.com/');
}

/** One list of every account and site across browsers, each site once, newest browsers first. */
export function gather(result) {
  const accounts = new Map(); // email -> { email, name, from: [] }
  const sites = new Map(); // site -> { site, origin, users: [], from: [] }
  for (const b of (result && result.browsers) || []) {
    for (const p of b.profiles || []) {
      const from = p.name && p.name !== b.browser ? `${b.browser} · ${p.name}` : b.browser;
      for (const a of p.accounts || []) {
        const key = String(a.email).toLowerCase();
        const row = accounts.get(key) || { email: a.email, name: a.name || '', from: [] };
        if (!row.from.includes(from)) row.from.push(from);
        accounts.set(key, row);
      }
      for (const s of p.sites || []) {
        const row = sites.get(s.site) || { site: s.site, origin: s.origin, users: [], from: [] };
        for (const u of s.users || []) if (!row.users.includes(u) && row.users.length < 3) row.users.push(u);
        if (!row.from.includes(b.browser)) row.from.push(b.browser);
        sites.set(s.site, row);
      }
    }
  }
  return { accounts: [...accounts.values()], sites: [...sites.values()] };
}

/**
 * Fills `box`. `compact`: the welcome page's short form (accounts and the first sites only).
 */
export async function renderBring(box) {
  // One click (owner, Nov 16 2026): Brave's own importer, which brings passwords, addresses and
  // autofill, bookmarks and history from Chrome, Edge, Firefox and the rest, each by the other
  // browser's own protected route. Gamblium never reads another browser's passwords itself.
  // Signing in to Google accounts again is not offered: a sign-in cannot move between browsers.
  box.textContent = '';
  box.classList.add('bring');
  const actions = el('div', 'bring-actions');
  const imp = el('button', 'bring-import', 'Import everything from my other browsers');
  imp.type = 'button';
  imp.addEventListener('click', () => openTab('chrome://settings/importData'));
  actions.append(imp);
  box.append(actions);
  box.append(el('p', 'bring-note', 'Passwords, addresses and autofill, bookmarks and history. The browser\'s own importer opens: pick the browser there and press Import.'));
}
