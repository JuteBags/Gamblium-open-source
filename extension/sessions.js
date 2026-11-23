// Named sessions as checkpoints: save everything about the open windows under
// a name, close them to free memory, and bring it all back later.
// Pure logic, no chrome.* calls (the page functions at the bottom run inside
// web pages and use only the DOM).
//
// A checkpoint keeps:
//   - where it came from: profile id and label, profile folder, browser, time
//   - every window: position, size, state (maximised...), which one had focus
//   - every tab, in order: address, title, pinned, showing, group, muted, zoom,
//     whether it was asleep, when it was last used
//   - per page, where we are allowed to look: scroll position, what was typed
//     into forms (never passwords or card numbers), sessionStorage
//   - Gamblium's own settings and the dashboard's state
// It cannot keep what a page held in memory (a running game, an unsent upload)
// or a tab's back/forward history: the browser does not hand those to extensions.

export const SESSION_VERSION = 2;
export const MAX_NAME = 60;

// Pages an extension is allowed to reopen.
function restorable(url) {
  return /^(https?|file|ftp):/i.test(url || "");
}

export function cleanName(name) {
  const n = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return n || null;
}

const WINDOW_STATES = ["normal", "maximized", "minimized", "fullscreen"];

// Builds a checkpoint.
//   tabs, groups: chrome.tabs.query() and chrome.tabGroups.query() results
//   extra (all optional):
//     windows:  chrome.windows.getAll() results (position, size, state, focus)
//     pages:    { tabId: page state from capturePage() }
//     zooms:    { tabId: zoom factor }
//     profile:  { id, label, userDataDir, browser }
//     settings: Gamblium's stored settings
//     ui:       the dashboard's own state
// Returns { session, skipped } where skipped counts tabs that cannot be reopened.
export function snapshot(name, tabs, groups, now, extra = {}) {
  const winInfo = new Map((extra.windows || []).map((w) => [w.id, w]));
  const byWindow = new Map();
  let skipped = 0;
  let pagesCaptured = 0;
  for (const t of [...tabs].sort((a, b) => a.windowId - b.windowId || a.index - b.index)) {
    // A sleeping tab reports its real address in url; pendingUrl covers one still loading.
    const url = restorable(t.url) ? t.url : restorable(t.pendingUrl) ? t.pendingUrl : null;
    if (!url) {
      skipped++;
      continue;
    }
    if (!byWindow.has(t.windowId)) byWindow.set(t.windowId, { id: t.windowId, tabs: [], groups: [], groupIds: [] });
    const w = byWindow.get(t.windowId);
    let group = null;
    if (t.groupId !== undefined && t.groupId !== -1) {
      group = w.groupIds.indexOf(t.groupId);
      if (group === -1) {
        const g = (groups || []).find((x) => x.id === t.groupId) || {};
        w.groupIds.push(t.groupId);
        w.groups.push({ title: g.title || "", color: g.color || "grey", collapsed: !!g.collapsed });
        group = w.groups.length - 1;
      }
    }
    const page = (extra.pages && extra.pages[t.id]) || null;
    if (page) pagesCaptured++;
    const zoom = extra.zooms && Number.isFinite(extra.zooms[t.id]) ? extra.zooms[t.id] : null;
    w.tabs.push({
      url,
      title: t.title || "",
      pinned: !!t.pinned,
      active: !!t.active,
      group,
      muted: !!(t.mutedInfo && t.mutedInfo.muted),
      zoom,
      asleep: !!t.discarded,
      lastAccessed: Number.isFinite(t.lastAccessed) ? t.lastAccessed : null,
      page,
    });
  }
  const windows = [...byWindow.values()].map(({ id, tabs, groups }) => {
    // Exactly one tab per window is the one to show.
    if (!tabs.some((t) => t.active)) tabs[0].active = true;
    const info = winInfo.get(id);
    const bounds = info && [info.left, info.top, info.width, info.height].every(Number.isFinite)
      ? { left: info.left, top: info.top, width: info.width, height: info.height }
      : null;
    return {
      tabs,
      groups,
      bounds,
      state: info && WINDOW_STATES.includes(info.state) ? info.state : "normal",
      focused: !!(info && info.focused),
    };
  });
  const total = windows.reduce((n, w) => n + w.tabs.length, 0);
  return {
    session: {
      version: SESSION_VERSION,
      name: cleanName(name),
      savedAt: now,
      profile: extra.profile || null,
      settings: extra.settings || null,
      ui: extra.ui || null,
      windows,
      notes: { tabs: total, skipped, pagesCaptured, pagesNotCaptured: total - pagesCaptured },
    },
    skipped,
  };
}

// Adds or replaces a session in the stored map { name: session }.
export function withSession(store, session) {
  return { ...(store || {}), [session.name]: session };
}

export function withoutSession(store, name) {
  const next = { ...(store || {}) };
  delete next[name];
  return next;
}

// What the list screen shows, newest first.
export function summaries(store) {
  return Object.values(store || {})
    .map((s) => ({
      name: s.name,
      savedAt: s.savedAt,
      windows: s.windows.length,
      tabs: s.windows.reduce((n, w) => n + w.tabs.length, 0),
      hosts: topHosts(s, 3),
      profile: s.profile ? s.profile.label || s.profile.id || null : null,
      pagesCaptured: s.notes ? s.notes.pagesCaptured : 0,
      hasSettings: !!s.settings,
      shape: shapeOf(s),
    }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

// A session as it would look on screen: each window as its first tabs (address, pin, group
// colour), so a list can draw it and a person can recognise it by sight.
export const SHAPE_TABS = 28;
export function shapeOf(session) {
  return session.windows.map((w) => ({
    tabs: w.tabs.length,
    icons: w.tabs.slice(0, SHAPE_TABS).map((t) => ({
      url: String(t.url).slice(0, 300),
      pinned: !!t.pinned,
      color: Number.isInteger(t.group) && w.groups && w.groups[t.group] ? w.groups[t.group].color || "grey" : null,
    })),
  }));
}

// The most common sites in a session, to recognise it by.
export function topHosts(session, limit) {
  const count = new Map();
  for (const w of session.windows) {
    for (const t of w.tabs) {
      let host = "";
      try {
        host = new URL(t.url).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }
      if (host) count.set(host, (count.get(host) || 0) + 1);
    }
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([h]) => h);
}

// A stored session is only trusted after this check (it may come from an import).
// Version 1 sessions (tabs and groups only) are still accepted.
export function isValidSession(s) {
  return !!(
    s && (s.version === 1 || s.version === SESSION_VERSION) && cleanName(s.name) && Number.isFinite(s.savedAt) &&
    Array.isArray(s.windows) && s.windows.length > 0 &&
    s.windows.every((w) =>
      Array.isArray(w.tabs) && w.tabs.length > 0 && Array.isArray(w.groups) &&
      (w.bounds === undefined || w.bounds === null || [w.bounds.left, w.bounds.top, w.bounds.width, w.bounds.height].every(Number.isFinite)) &&
      w.tabs.every((t) => restorable(t.url) && (t.group === null || (Number.isInteger(t.group) && t.group >= 0 && t.group < w.groups.length))))
  );
}

// Window placement to ask for when reopening: the saved rectangle if it still
// fits a sane screen, otherwise let the browser decide.
export function placement(win) {
  const b = win.bounds;
  if (!b || b.width < 200 || b.height < 150 || b.width > 20000 || b.height > 20000 || Math.abs(b.left) > 30000 || Math.abs(b.top) > 30000) {
    return {};
  }
  return { left: Math.round(b.left), top: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) };
}

// ---- Functions that run inside a web page ------------------------------------
// They are passed to chrome.scripting.executeScript, so they must be
// self-contained: no outside variables, no imports.

// Reads scroll position, form contents and sessionStorage.
export function capturePage() {
  const cssPath = (el) => {
    if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) return "#" + CSS.escape(el.id);
    const tag = el.tagName.toLowerCase();
    if (el.name) {
      const byName = tag + '[name="' + CSS.escape(el.name) + '"]';
      if (document.querySelectorAll(byName).length === 1) return byName;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 8) {
      let i = 1;
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === node.tagName) i++;
      parts.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + i + ")");
      node = node.parentElement;
    }
    const sel = parts.join(" > ");
    try {
      return document.querySelectorAll(sel).length === 1 ? sel : null;
    } catch {
      return null;
    }
  };
  const SECRET = /password|cc-|card|cvc|cvv|one-time-code|otp|secret|token/i;
  const fields = [];
  for (const el of document.querySelectorAll("input, textarea, select")) {
    if (fields.length >= 200) break;
    const type = (el.getAttribute("type") || el.type || "").toLowerCase();
    if (["password", "hidden", "file", "submit", "button", "image", "reset"].includes(type)) continue;
    if (SECRET.test(el.autocomplete || "") || SECRET.test(el.name || "") || SECRET.test(el.id || "")) continue;
    const sel = cssPath(el);
    if (!sel) continue;
    if (type === "checkbox" || type === "radio") {
      if (el.checked !== el.defaultChecked) fields.push({ sel, checked: el.checked });
    } else if (el.tagName === "SELECT") {
      if ([...el.options].some((o) => o.selected !== o.defaultSelected)) fields.push({ sel, value: el.value });
    } else if (el.value !== el.defaultValue) {
      fields.push({ sel, value: String(el.value).slice(0, 20000) });
    }
  }
  let storage = null;
  try {
    storage = {};
    let size = 0;
    for (let i = 0; i < sessionStorage.length && i < 200; i++) {
      const k = sessionStorage.key(i);
      const v = sessionStorage.getItem(k);
      size += k.length + v.length;
      if (size > 200000) break;
      storage[k] = v;
    }
  } catch {
    storage = null;
  }
  return { scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY), fields, sessionStorage: storage };
}

// Puts a captured page state back. Returns how many form fields were filled.
export function restorePage(state) {
  if (!state) return 0;
  try {
    for (const [k, v] of Object.entries(state.sessionStorage || {})) {
      if (sessionStorage.getItem(k) === null) sessionStorage.setItem(k, v);
    }
  } catch {
    // Storage is blocked on this page.
  }
  let filled = 0;
  for (const f of state.fields || []) {
    let el = null;
    try {
      el = document.querySelector(f.sel);
    } catch {
      el = null;
    }
    if (!el) continue;
    if ("checked" in f) el.checked = f.checked;
    else el.value = f.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    filled++;
  }
  window.scrollTo(state.scrollX || 0, state.scrollY || 0);
  return filled;
}

// ---- Finding things in saved sessions --------------------------------------------------

// One page, however its address was written: no "www.", no fragment, no trailing slash.
export function urlKey(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "") + u.search).toLowerCase();
  } catch {
    return String(url || "").toLowerCase();
  }
}

// Which saved sessions hold a tab whose address or title contains every word typed (or whose
// name does). -> [{ name, nameHit, total, tabs: [{ window, url, title, pinned }] }], newest
// session first; tabs holds the first `perSession` hits, total counts them all.
export function findInSessions(store, query, perSession = 12) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const has = (text) => words.every((w) => text.includes(w));
  const out = [];
  for (const s of Object.values(store || {}).sort((a, b) => b.savedAt - a.savedAt)) {
    const tabs = [];
    let total = 0;
    s.windows.forEach((w, wi) => {
      for (const t of w.tabs) {
        if (!has(`${t.url} ${t.title || ""}`.toLowerCase())) continue;
        total++;
        if (tabs.length < perSession) tabs.push({ window: wi, url: t.url, title: t.title || "", pinned: !!t.pinned });
      }
    });
    const nameHit = has(String(s.name).toLowerCase());
    if (total || nameHit) out.push({ name: s.name, nameHit, total, tabs });
  }
  return out;
}

// Every saved page and the sessions it is in: { urlKey: [session names, newest first] }.
/**
 * The saved session the open tabs are (owner, Nov 15 2026: "Main Session" came back after a
 * restart, the browser reopened its tabs, and Sessions offered to save them as a new one).
 * A window's id changes when the browser starts again, so the tabs themselves are compared:
 * the share of addresses the two have in common, against the larger of the two. The best at
 * `min` or above wins (the newer on a tie); null when none is that close.
 */
export function matchSession(store, urls, min = 0.6) {
  const open = new Set((urls || []).map(urlKey));
  if (!open.size) return null;
  let best = null;
  for (const s of Object.values(store || {})) {
    const saved = new Set((s.windows || []).flatMap((w) => (w.tabs || []).map((t) => urlKey(t.url))));
    if (!saved.size) continue;
    let same = 0;
    for (const k of open) if (saved.has(k)) same++;
    const score = same / Math.max(open.size, saved.size);
    if (score < min) continue;
    if (!best || score > best.score || (score === best.score && (s.savedAt || 0) > best.savedAt)) {
      best = { name: s.name, score: Math.round(score * 100) / 100, same, open: open.size, saved: saved.size, savedAt: s.savedAt || 0 };
    }
  }
  return best;
}

export function sessionsByUrl(store) {
  const map = {};
  for (const s of Object.values(store || {}).sort((a, b) => b.savedAt - a.savedAt)) {
    for (const w of s.windows) {
      for (const t of w.tabs) {
        const k = urlKey(t.url);
        if (!map[k]) map[k] = [];
        if (!map[k].includes(s.name)) map[k].push(s.name);
      }
    }
  }
  return map;
}
