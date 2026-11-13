// Pure decision logic, kept free of chrome.* so it can be tested with node.

export const DEFAULTS = {
  enabled: true,
  // Seconds a tab must stay hidden before it is put to sleep (discarded: its
  // memory is freed and it reloads when opened). The launcher already freezes
  // hidden tabs after 30 s, which stops their CPU use and resumes instantly, so
  // sleeping can wait: it is there to give memory back.
  delaySec: 600,
  // When the machine is short on memory, sleep hidden tabs much sooner.
  lowMemoryDelaySec: 60,
  // "Short on memory" = less than this much RAM available, in MB.
  lowMemoryMb: 2048,
  // Host names that never sleep. "example.com" also covers its subdomains.
  allowlist: [],
  // Freezing ("0 Kelvin"): a hidden tab is stopped completely, keeps its
  // memory and comes back at once. The extension does it, so it can make
  // exceptions the browser's own freezer cannot.
  freezeEnabled: true,
  freezeDelaySec: 30,
  // Hidden tabs that load at the same time. When many tabs are opened at
  // once, the ones beyond this wait (asleep, with their address and title)
  // and load one after another as the others finish. The tab in front is
  // never held, and a waiting tab loads at once when it is opened.
  // 0 = no limit. Off in 0.7.0: with it on, a hidden tab sometimes reported
  // itself visible and kept drawing (twitch, producthunt; under investigation).
  loadAtOnce: 0,
  // The second level of the freeze engine: once a tab has been frozen this
  // long, the memory of its page process is moved out of RAM (it stays the
  // tab's, on disk, and comes back as the page touches it when shown).
  // Measured, 9 tabs: 1200 MB frozen, 398 MB just after, 512 MB a minute later.
  trimEnabled: true,
  trimDelaySec: 60,
  // Hosts that are never frozen and never put to sleep: they stay ordinary
  // background tabs (dashboards, anything that must keep updating).
  awakeHosts: [],
  // Hosts whose frozen tabs are woken for a moment every few minutes, so mail
  // and chat can fetch what is new and raise a notification.
  wakeHosts: [],
  wakeEveryMin: 5,
  wakeForSec: 3,
  // Background level, in kelvin: how much a hidden tab may still do.
  //   0 K   frozen solid, never wakes
  //   273 K never frozen: an ordinary background tab
  //   between: frozen, but woken for a few seconds on a schedule; the warmer,
  //   the more often and the longer (see tempPlan).
  // siteTemps: { "host": kelvin }. defaultTemp applies to every other site.
  siteTemps: {},
  defaultTemp: 0,
};

export const MAX_TEMP = 273;

// What a level means in practice.
//   { freeze: false }                              273 K
//   { freeze: true, wakeEveryMin: null }           0 K
//   { freeze: true, wakeEveryMin, wakeForSec }     between
// 39 K wakes for 4 s about every 26 min; 137 K for 7 s every 15 min;
// 234 K for 9 s about every 4 min.
export function tempPlan(kelvin) {
  const k = Math.max(0, Math.min(MAX_TEMP, Number(kelvin) || 0));
  if (k >= MAX_TEMP) return { freeze: false };
  if (k <= 0) return { freeze: true, wakeEveryMin: null };
  const share = k / MAX_TEMP;
  return { freeze: true, wakeEveryMin: Math.max(1, Math.round(30 * (1 - share))), wakeForSec: 3 + Math.round(7 * share) };
}

export function describeTemp(kelvin) {
  const p = tempPlan(kelvin);
  const k = Math.max(0, Math.min(MAX_TEMP, Math.round(Number(kelvin) || 0)));
  if (!p.freeze) return `Always awake, never frozen · ${k} K`;
  if (p.wakeEveryMin === null) return `Frozen while hidden · ${k} K`;
  return `Frozen, wakes for ${p.wakeForSec} s every ${p.wakeEveryMin} min · ${k} K`;
}

// The level that applies to a tab: its own mark, then its site, then the default.
export function tempOf(tab, settings, ctx = {}) {
  if ((ctx.awakeTabs || []).includes(tab.id)) return MAX_TEMP;
  const host = hostOf(tab.url);
  let best = null;
  for (const [entry, k] of Object.entries(settings.siteTemps || {})) {
    const e = entry.trim().toLowerCase();
    if (e && (host === e || host.endsWith("." + e)) && (best === null || e.length > best[0].length)) best = [e, k];
  }
  if (best) return Math.max(0, Math.min(MAX_TEMP, Number(best[1]) || 0));
  if (isAllowlisted(tab.url, settings.awakeHosts || [])) return MAX_TEMP;
  return Math.max(0, Math.min(MAX_TEMP, Number(settings.defaultTemp) || 0));
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function isAllowlisted(url, allowlist) {
  const host = hostOf(url);
  if (!host) return false;
  return allowlist.some((entry) => {
    const e = entry.trim().toLowerCase();
    return e && (host === e || host.endsWith("." + e));
  });
}

// Why a tab is kept awake, or null if it may sleep now.
// ctx.awakeTabs: ids of tabs the user marked "keep awake".
export function keepReason(tab, settings, now, ctx = {}) {
  if (tab.discarded) return "already asleep";
  if (tab.active) return "visible";
  if (tab.audible) return "playing audio";
  if (tab.pinned) return "pinned";
  if (tab.autoDiscardable === false) return "marked never sleep";
  if (!/^https?:/.test(tab.url || "")) return "not a web page";
  if (tempOf(tab, settings, ctx) >= MAX_TEMP) return "kept awake";
  if (isAllowlisted(tab.url, settings.allowlist)) return "allowlisted";
  // Work the user is waiting for is never thrown away, however short memory
  // is: an upload in flight, a download the page itself is making, and a
  // site that is woken on a schedule to fetch mail or messages (a sleeping
  // tab cannot be woken). Such tabs are frozen between their turns instead.
  if ((ctx.busyTabs || []).includes(tab.id)) return "uploading or downloading";
  if (tempOf(tab, settings, ctx) > 0 || isAllowlisted(tab.url, settings.wakeHosts || [])) return "works in the background";
  const hiddenSec = (now - (tab.lastAccessed ?? now)) / 1000;
  if (hiddenSec < settings.delaySec) return "hidden only " + Math.round(hiddenSec) + " s";
  return null;
}

// The delay to use right now. availableMb is the RAM the system can still hand
// out, or null if unknown.
export function effectiveDelaySec(settings, availableMb) {
  const low = availableMb !== null && availableMb !== undefined && availableMb < settings.lowMemoryMb;
  return low ? Math.min(settings.delaySec, settings.lowMemoryDelaySec) : settings.delaySec;
}

// Which tabs to put to sleep now. Two rules, kept apart:
//
// - By time (the normal schedule): a tab hidden for `delaySec` sleeps. Before
//   that it is only frozen (30 s) and has its memory pushed out (a minute
//   later), both of which it comes back from at once.
// - By need (memory is short: less than `lowMemoryMb` available): the timer
//   is not waited for, but not every hidden tab is put to sleep either, as
//   it used to be. Hidden tabs (at least `lowMemoryDelaySec`) are ranked by
//   memory held x minutes since last shown, the biggest and stalest first,
//   and only as many sleep as it takes to get back above the line plus a
//   margin; the rest keep their state. The check runs every 30 s, so if
//   that was not enough the next ones follow.
//
// memoryByTab: { tabId: MB } from the helper, or null if it did not answer;
// then the stalest go first, three at a time.
export const PRESSURE_MARGIN_MB = 256;
export const PRESSURE_MOST_AT_ONCE = 10;

export function sleepPlan(tabs, settings, now, availableMb = null, ctx = {}, memoryByTab = null) {
  if (!settings.enabled) return [];
  const byTime = tabs.filter((t) => keepReason(t, settings, now, ctx) === null);
  const low = availableMb !== null && availableMb !== undefined && availableMb < settings.lowMemoryMb;
  if (!low) return byTime;
  const short = { ...settings, delaySec: Math.min(settings.delaySec, settings.lowMemoryDelaySec) };
  const taken = new Set(byTime.map((t) => t.id));
  const candidates = tabs.filter((t) => !taken.has(t.id) && keepReason(t, short, now, ctx) === null);
  const staleMin = (t) => Math.max(1, (now - (t.lastAccessed ?? ctx.firstSeen?.[t.id] ?? now)) / 60000);
  const mem = (t) => (memoryByTab && memoryByTab[t.id] > 0 ? memoryByTab[t.id] : 0);
  const known = candidates.some((t) => mem(t) > 0);
  candidates.sort((a, b) => (known ? mem(b) * staleMin(b) - mem(a) * staleMin(a) : 0) || staleMin(b) - staleMin(a));
  const need = settings.lowMemoryMb - availableMb + PRESSURE_MARGIN_MB;
  const picked = [];
  let freed = 0;
  for (const t of candidates) {
    if (picked.length >= (known ? PRESSURE_MOST_AT_ONCE : 3)) break;
    if (known && freed >= need) break;
    picked.push(t);
    freed += mem(t);
  }
  return [...byTime, ...picked];
}

export function tabsToSleep(tabs, settings, now, availableMb = null, ctx = {}) {
  if (!settings.enabled) return [];
  const s = { ...settings, delaySec: effectiveDelaySec(settings, availableMb) };
  return tabs.filter((t) => keepReason(t, s, now, ctx) === null);
}

// Why a tab is not frozen, or null if it may be frozen now.
//   ctx.awakeTabs: ids of tabs the user marked "keep awake"
//   ctx.busyTabs:  ids of tabs with an upload in flight
export function freezeReason(tab, settings, now, ctx = {}) {
  if (tab.discarded) return "asleep";
  if (tab.frozen) return "already frozen";
  if (tab.active) return "visible";
  if (tab.audible) return "playing audio";
  if (!/^https?:/.test(tab.url || "")) return "not a web page";
  // A page still loading is left to load for up to a minute, unless its
  // document is in (DOMContentLoaded, ctx.domReady): then only late extras
  // (adverts, trackers, pictures further down) are left, and it is frozen on
  // time like the rest. A page that never finishes must not escape for ever.
  const hiddenFor = (now - (tab.lastAccessed ?? ctx.firstSeen?.[tab.id] ?? now)) / 1000;
  const documentIn = !!(ctx.domReady && ctx.domReady[tab.id]);
  if (tab.status === "loading" && !documentIn && hiddenFor < Math.max(60, settings.freezeDelaySec)) return "still loading";
  if (tempOf(tab, settings, ctx) >= MAX_TEMP) return "kept awake";
  if ((ctx.busyTabs || []).includes(tab.id)) return "uploading";
  // A tab opened in the background may have no "last shown" time; then the
  // moment we first saw it counts (ctx.firstSeen: { tabId: time }).
  if (hiddenFor < settings.freezeDelaySec) return "hidden only " + Math.round(hiddenFor) + " s";
  return null;
}

// Whether a hidden tab that has just started loading should wait for its
// turn. `loadingHidden`: how many other hidden tabs are loading now (not
// frozen, not asleep). `released`: the tab was let go from the queue
// already (it is not held twice).
export function holdForLoading(tab, settings, loadingHidden, released = false) {
  const most = Number(settings.loadAtOnce) || 0;
  if (!settings.enabled || most <= 0 || released) return false;
  if (tab.active || tab.pinned || tab.audible || tab.discarded) return false;
  if (!/^https?:/.test(tab.url || tab.pendingUrl || "")) return false;
  if (isAllowlisted(tab.url || tab.pendingUrl, settings.awakeHosts || [])) return false;
  return loadingHidden >= most;
}

// When the next hidden tab becomes due for freezing (ms since 1970), or null.
// The freezer runs then instead of waiting for its once-a-minute check: with
// 45 tabs loading, tabs froze 30 to 120 s after being hidden and the pages
// left running cost about 44 core-seconds (tester: 319 against 276 with the
// browser's own freezer, which freezes at exactly 30 s).
// ctx.frozen: { tabId: time } of tabs we froze.
export function nextFreezeDue(tabs, settings, now, ctx = {}) {
  if (!settings.freezeEnabled) return null;
  let next = null;
  for (const t of tabs) {
    if (t.active || t.discarded || t.audible || (ctx.frozen && ctx.frozen[t.id]) || !/^https?:/.test(t.url || "")) continue;
    if (tempOf(t, settings, ctx) >= MAX_TEMP || isAllowlisted(t.url, settings.allowlist)) continue;
    const since = t.lastAccessed ?? ctx.firstSeen?.[t.id] ?? now;
    let due = since + settings.freezeDelaySec * 1000;
    if (t.status === "loading" && !(ctx.domReady && ctx.domReady[t.id])) due = Math.max(due, since + Math.max(60, settings.freezeDelaySec) * 1000);
    // Already due and still not frozen: kept for a reason the check knows
    // (an upload, the wake list ...); the once-a-minute check looks again.
    if (due <= now) continue;
    if (next === null || due < next) next = due;
  }
  return next;
}

export function tabsToFreeze(tabs, settings, now, ctx = {}) {
  if (!settings.freezeEnabled) return [];
  return tabs.filter((t) => freezeReason(t, settings, now, ctx) === null);
}

// Frozen tabs that are due a short wake-up: their host is on the wake list
// and the last wake-up (or the freeze) was long enough ago.
//   lastWake: { tabId: time in ms }
// Each tab returned carries wakeForSec: how long to let it run.
export function tabsToWake(tabs, settings, now, lastWake = {}, ctx = {}) {
  const out = [];
  for (const t of tabs) {
    if (!t.frozen || t.discarded) continue;
    const plan = tempPlan(tempOf(t, settings, ctx));
    // The level's schedule, or the older "wake these sites" list.
    const listed = isAllowlisted(t.url, settings.wakeHosts || []);
    const everyMin = plan.wakeEveryMin ?? (listed ? Math.max(1, settings.wakeEveryMin || 5) : null);
    if (everyMin === null) continue;
    if (now - (lastWake[t.id] ?? 0) >= everyMin * 60000) out.push({ ...t, wakeForSec: plan.wakeForSec ?? settings.wakeForSec ?? 3 });
  }
  return out;
}

// The colour scheme of our own pages for a launcher theme: "burgundy-dark"
// gives "burgundy". Light or dark is not part of it; pages follow the browser.
export function schemeOfTheme(theme) {
  const m = /^([a-z][a-z0-9]{0,30})(-[a-z0-9-]*)?$/.exec(String(theme || ""));
  return m ? m[1] : null;
}

// Which ink the toolbar's menu button is drawn in for a theme: "light" on a dark
// toolbar, "dark" on a light one, "mid" when the theme follows the system (the
// extension cannot see which way that went) or is not known.
export function menuInkOfTheme(theme) {
  const m = /-(dark|light|auto)$/.exec(String(theme || ""));
  return !m ? "mid" : m[1] === "dark" ? "light" : m[1] === "light" ? "dark" : "mid";
}

// "Keep these sites light": match patterns for the hosts that must escape
// forced dark mode. Anything that is not a plain host name is dropped, so a
// stored value can never turn into a pattern for every site.
export function lightSiteMatches(hosts) {
  const out = [];
  for (const raw of hosts || []) {
    const h = String(raw).trim().toLowerCase();
    if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)) continue;
    for (const m of [`*://${h}/*`, `*://*.${h}/*`]) if (!out.includes(m)) out.push(m);
  }
  return out;
}

// ---- Freeze engine, level 2: which page processes to trim now ---------------------
// frozen:   { tabId: time of the freeze or of the last short wake-up }
// trimmed:  { tabId: the `frozen` time it was trimmed for }  (a wake-up changes
//           the time, so the tab is trimmed again after it)
// framesByTab: { tabId: [process ids as the browser numbers them] }
// processes:   the helper's reading: [{ pid, client_id }]
// A process that also serves a tab that is not frozen is left alone: trimming
// it would make the tab the user is looking at stutter.
export function trimPlan(frozen, trimmed, framesByTab, processes, now, settings) {
  if (!settings.trimEnabled) return { tabs: [], pids: [] };
  const wait = Math.max(0, Number(settings.trimDelaySec) || 0) * 1000;
  const due = Object.keys(frozen).map(Number).filter((id) => now - frozen[id] >= wait && trimmed[id] !== frozen[id] && framesByTab[id]);
  if (!due.length) return { tabs: [], pids: [] };
  const pidOf = new Map();
  for (const p of processes || []) if (p.client_id !== null && p.client_id !== undefined) pidOf.set(p.client_id, p.pid);
  const busy = new Set();
  for (const [id, frames] of Object.entries(framesByTab)) {
    if (frozen[id] !== undefined) continue;
    for (const c of frames) if (pidOf.has(c)) busy.add(pidOf.get(c));
  }
  const pids = new Set();
  for (const id of due) for (const c of framesByTab[id]) if (pidOf.has(c) && !busy.has(pidOf.get(c))) pids.add(pidOf.get(c));
  return { tabs: due, pids: [...pids] };
}

/** Is any frozen tab waiting for its trim? (Cheap: asked before the helper is.) */
export function trimWaiting(frozen, trimmed, now, settings) {
  if (!settings.trimEnabled) return false;
  const wait = Math.max(0, Number(settings.trimDelaySec) || 0) * 1000;
  return Object.keys(frozen).some((id) => now - frozen[id] >= wait && trimmed[id] !== frozen[id]);
}
