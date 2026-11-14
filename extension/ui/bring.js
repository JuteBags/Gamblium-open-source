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
export async function renderBring(box, { compact = false } = {}) {
  box.textContent = '';
  box.classList.add('bring');
  const actions = el('div', 'bring-actions');
  const imp = el('button', 'bring-import', 'Import passwords, bookmarks and history');
  imp.type = 'button';
  imp.addEventListener('click', () => openTab('chrome://settings/importData'));
  actions.append(imp);
  // The welcome page asks about the importer with its own YES / NO.
  if (!compact) box.append(actions);
  const note = el('p', 'bring-note', 'Logins themselves cannot move between browsers. Below is where you are signed in elsewhere; one click each to sign in here.');
  box.append(note);
  const status = el('p', 'bring-status', 'Looking at the other browsers on this computer…');
  box.append(status);

  const result = await scan();
  if (!result || result.ok === false) {
    status.textContent = 'Could not look at the other browsers (Gamblium\'s helper did not answer).';
    return;
  }
  const { accounts, sites } = gather(result);
  const found = (result.browsers || []).map((b) => b.browser);
  if (!accounts.length && !sites.length) {
    status.textContent = found.length ? `Nothing to sign in to again in ${found.join(', ')}.` : 'No other browser found on this computer.';
    return;
  }
  status.textContent = `Found in ${found.join(', ')}: ${accounts.length} Google account${accounts.length === 1 ? '' : 's'}, ${sites.length} site${sites.length === 1 ? '' : 's'} with a saved login.`;
  const { [DONE_KEY]: doneList = [] } = await chrome.storage.local.get({ [DONE_KEY]: [] });
  const done = new Set(doneList);
  const mark = async (key, row) => {
    done.add(key);
    row.classList.add('done');
    await chrome.storage.local.set({ [DONE_KEY]: [...done].slice(-500) });
  };

  if (accounts.length) {
    box.append(el('h3', 'bring-head', 'Google accounts'));
    const list = el('ul', 'bring-list');
    for (const a of accounts) {
      const li = el('li', 'bring-row' + (done.has('g:' + a.email) ? ' done' : ''));
      const text = el('div', 'bring-text');
      text.append(el('span', 'bring-name', a.email), el('span', 'bring-from', (a.name ? a.name + ' · ' : '') + a.from.join(', ')));
      const go = el('button', 'bring-go', 'Sign in');
      go.type = 'button';
      go.addEventListener('click', () => { openTab(googleSignIn(a.email)); mark('g:' + a.email, li); });
      li.append(text, go);
      list.append(li);
    }
    box.append(list);
  }

  if (sites.length) {
    box.append(el('h3', 'bring-head', 'Sites with a saved login'));
    const list = el('ul', 'bring-list bring-sites');
    const first = compact ? 6 : 20;
    sites.forEach((s, i) => {
      const li = el('li', 'bring-row' + (done.has('s:' + s.site) ? ' done' : ''));
      if (i >= first) li.hidden = true;
      const text = el('div', 'bring-text');
      text.append(el('span', 'bring-name', s.site), el('span', 'bring-from', [s.users.join(', '), s.from.join(', ')].filter(Boolean).join(' · ')));
      const go = el('button', 'bring-go', 'Sign in');
      go.type = 'button';
      go.title = 'Open ' + s.origin;
      go.addEventListener('click', () => { openTab(s.origin); mark('s:' + s.site, li); });
      li.append(text, go);
      list.append(li);
    });
    box.append(list);
    if (sites.length > first) {
      const more = el('button', 'bring-more', `Show all ${sites.length}`);
      more.type = 'button';
      more.addEventListener('click', () => {
        for (const li of list.children) li.hidden = false;
        more.remove();
      });
      box.append(more);
    }
  }
}
