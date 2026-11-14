// The command bar (owner, Nov 14 2026: "command bar like Zen"): one box, Alt+K, for actions,
// open tabs and addresses. Matching only; ui/commandbar.js draws it. No browser APIs here.

/** What the bar can do besides switching tabs. `do` is what ui/commandbar.js runs. */
export const ACTIONS = [
  { id: 'tabs', title: 'Tabs and memory', words: 'dashboard memory cpu processes', do: { page: 'tabs' } },
  { id: 'downloads', title: 'Downloads', words: 'files', do: { page: 'downloads' } },
  { id: 'history', title: 'History', words: 'visited library', do: { page: 'history' } },
  { id: 'sessions', title: 'Sessions', words: 'saved named agents', do: { page: 'sessions' } },
  { id: 'security', title: 'Security', words: 'check-up ports requests jwt decode base64', do: { page: 'security' } },
  { id: 'settings', title: 'Settings', words: 'preferences options', do: { page: 'settings' } },
  { id: 'shortcuts', title: 'Keyboard shortcuts', words: 'keys', do: { page: 'shortcuts' } },
  { id: 'bring', title: 'Bring your stuff over', words: 'import accounts passwords chrome edge', do: { page: 'settings#bring' } },
  { id: 'scratchpad', title: 'Scratchpad', words: 'notes side panel write', do: { sidePanel: true } },
  { id: 'sleep-others', title: 'Put the other tabs to sleep', words: 'memory free discard', do: { message: { type: 'sleep-now', scope: 'this-window' } } },
  { id: 'space-new', title: 'New space', words: 'group workspace', do: { message: { type: 'space-new' } } },
  { id: 'space-next', title: 'Next space', words: 'switch group workspace', do: { message: { type: 'space-next' } } },
  { id: 'container', title: 'Move this space into its own container', words: 'cookies logins separate profile', do: { container: true } },
  { id: 'pip-off', title: 'Stop popping out videos', words: 'picture in picture pip', do: { set: { popOutVideo: false } } },
  { id: 'pip-on', title: 'Pop out videos when leaving their tab', words: 'picture in picture pip', do: { set: { popOutVideo: true } } },
  { id: 'peek-off', title: 'Switch Peek off', words: 'shift click preview', do: { set: { peekOn: false } } },
  { id: 'peek-on', title: 'Switch Peek on', words: 'shift click preview', do: { set: { peekOn: true } } },
  { id: 'new-tab', title: 'New tab', words: 'open', do: { url: 'chrome://newtab/' } },
  { id: 'private', title: 'New private window', words: 'incognito', do: { private: true } },
  { id: 'extensions', title: 'Extensions', words: 'add-ons', do: { url: 'chrome://extensions/' } },
  { id: 'passwords', title: 'Passwords', words: 'logins autofill', do: { url: 'chrome://password-manager/passwords' } },
  { id: 'clear', title: 'Clear browsing data', words: 'cookies cache history delete', do: { url: 'chrome://settings/clearBrowserData' } },
  { id: 'browser-settings', title: "The browser's own settings", words: 'brave chrome', do: { url: 'chrome://settings/' } },
];

const norm = (s) => String(s ?? '').toLowerCase();

/** How well `query` fits `text`: 0 is no fit; words starting the same count most. */
export function fit(query, text) {
  const q = norm(query).trim();
  if (!q) return 1;
  const t = norm(text);
  let score = 0;
  for (const w of q.split(/\s+/)) {
    const at = t.indexOf(w);
    if (at < 0) return 0;
    score += at === 0 ? 4 : /\W/.test(t[at - 1]) ? 3 : 1;
  }
  return score;
}

/** Looks like an address someone typed: a scheme, or a dotted name without spaces. */
export function asAddress(text) {
  const t = String(text ?? '').trim();
  if (!t || /\s/.test(t)) return null;
  if (/^(https?|chrome|brave|gamblium):\/\//i.test(t)) return t;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(t)) return 'http://' + t;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(t) && /\.[a-z]{2,}(:\d+)?(\/|$)/i.test(t)) return 'https://' + t;
  return null;
}

/**
 * The lines to show for `query`, best first, at most `max`.
 * tabs: [{ id, windowId, title, url }]. A line: { kind: 'action'|'tab'|'go'|'search', title, note, ... }.
 */
export function suggest(query, tabs = [], max = 9) {
  const q = String(query ?? '').trim();
  const lines = [];
  const address = asAddress(q);
  if (address) lines.push({ kind: 'go', title: address, note: '', url: address, score: 100 });
  for (const a of ACTIONS) {
    const s = fit(q, a.title + ' ' + a.words);
    if (s) lines.push({ kind: 'action', id: a.id, title: a.title, note: 'Action', do: a.do, score: s + (fit(q, a.title) ? 2 : 0) });
  }
  if (q) {
    for (const t of tabs) {
      const s = fit(q, (t.title || '') + ' ' + (t.url || ''));
      if (s) lines.push({ kind: 'tab', tabId: t.id, windowId: t.windowId, title: t.title || t.url, note: hostOf(t.url), score: s + 1 });
    }
  }
  lines.sort((a, b) => b.score - a.score);
  const out = lines.slice(0, q ? max - 1 : max);
  if (q && !address) out.push({ kind: 'search', title: q, note: 'Search the web', query: q });
  return out;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
