import {
  DEFAULTS, effectiveDelaySec, freezeReason, hostOf, isAllowlisted, keepReason, lightSiteMatches, menuInkOfTheme, schemeOfTheme, tabsToFreeze, nextFreezeDue, holdForLoading,
  sleepPlan, tabsToSleep, tabsToWake, tempOf, MAX_TEMP, trimPlan, trimWaiting,
} from "./rules.js";
import { DOWNLOAD_DEFAULTS, OWN_DEFAULTS, isBrowserDownloadsPage, isTorrent, routedFilename, splitPath, stayReason } from "./download-rules.js";
import { applyEvent, emptyState, listRecords, toCurl } from "./capture.js";
import {
  capturePage, cleanName, isValidSession, placement, restorePage, snapshot, summaries, withSession, withoutSession,
  findInSessions, sessionsByUrl,
} from "./sessions.js";
import { attribute, proxyConfig, proxySummary, groupTotals, groupLimitPlan } from "./tabstats.js";
import { adoptIds, emptyIdMaps, firstId, makeCtl, noteReplaced } from "./agent.js";
import { pack, unpack } from "./pack.js";
import { freeColour, listSpaces, nextSpace, switchPlan } from "./spaces.js";
import { saveShot, screenshot } from "./shot.js";

const ALARM = "gamblium-sleep-check";

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

async function sleep(tabs) {
  let n = 0;
  for (const t of tabs) {
    try {
      await chrome.tabs.discard(t.id);
      n++;
    } catch {
      // The tab closed or became active in the meantime.
    }
  }
  return n;
}

// RAM the system can still hand out, in MB, or null if the browser will not say.
async function availableMb() {
  try {
    return (await chrome.system.memory.getInfo()).availableCapacity / (1024 * 1024);
  } catch {
    return null;
  }
}

// `timed`: run by the freeze timer (every few seconds while tabs load), not
// by the once-a-minute alarm. The slow sweep for frozen tabs still loading
// runs on the alarm only.
async function check(timed = false) {
  checkIsTimed = timed;
  // The browser runs this extension's process at idle priority; the helper
  // raises it, at start and once a minute in case the browser resets it.
  if (!timed) native({ type: "lift-extension" });
  const s = await settings();
  const tabs = await allTabs();
  const now = Date.now();
  const ctx = { awakeTabs: await awakeTabs(), busyTabs: [...new Set([...busyTabs(), ...(await pageDownloadTabs(tabs))])], domReady: Object.fromEntries(domReady) };
  // In an agent's browser "hidden" means: the agent has left the tab alone.
  if (IS_AGENT_BUILD) {
    const { agentTouched } = await chrome.storage.session.get({ agentTouched: {} });
    for (const t of tabs) if (agentTouched[t.id]) t.lastAccessed = Math.max(t.lastAccessed ?? 0, agentTouched[t.id]);
    // Our New Tab page draws a clock and a background without pause. Behind
    // an agent's tabs, with nobody to see it, it is put to sleep (it cost an
    // idle session 3% of one core, half of it in the graphics process).
    for (const t of tabs) {
      if (!t.active && !t.discarded && /^chrome:\/\/newtab\//.test(t.url || "")) chrome.tabs.discard(t.id).catch(() => {});
    }
    if (NO_WINDOW) for (const t of tabs) t.active = false;
    s.freezeDelaySec = Math.max(s.freezeDelaySec, AGENT_IDLE_SEC);
  }
  await syncLaunchScheme();
  await freezeCheck(tabs, s, now, ctx);
  planFreeze();
  loadNext();
  const available = await availableMb();
  // Short on memory: what each tab holds decides which ones sleep first.
  let memoryByTab = null;
  if (available !== null && available < s.lowMemoryMb) {
    const stats = await tabStats().catch(() => null);
    if (stats && stats.ok && Array.isArray(stats.tabs)) memoryByTab = Object.fromEntries(stats.tabs.filter((t) => t.memoryMb > 0).map((t) => [t.tabId, t.memoryMb]));
  }
  return sleep(sleepPlan(tabs, s, now, available, ctx, memoryByTab));
}

// ---- Freezing ("0 Kelvin") ---------------------------------------------------
// A hidden tab is stopped completely after 30 s: no processor time, memory
// kept, back at once when shown. The browser's own freezer cannot make
// exceptions per tab (measured), so the extension freezes tabs itself: a
// debugger is attached to the tab for one command and detached again. The
// launcher starts the browser so that this shows no warning bar, and tells us
// through the helper that it did; without that we leave tabs alone.
// Never frozen: the tab showing in each window, tabs playing sound, tabs with
// an upload in flight (when we may see requests), tabs marked "keep awake" and
// sites on the always-awake list.

// A download the page itself is making (a file put together by its script,
// as Mega and some archive sites do) lives in the tab: put the tab to sleep
// and the download is lost. An ordinary download belongs to the browser and
// goes on without its tab. Such a download's address starts with "blob:"
// and names the site it came from.
async function pageDownloadTabs(tabs) {
  if (!chrome.downloads) return [];
  const running = await chrome.downloads.search({ state: "in_progress" }).catch(() => []);
  const origins = new Set();
  for (const d of running) {
    const m = /^blob:(https?:\/\/[^/]+)/i.exec(d.url || d.finalUrl || "");
    if (m) origins.add(m[1].toLowerCase());
  }
  if (!origins.size) return [];
  return tabs.filter((t) => { try { return origins.has(new URL(t.url).origin.toLowerCase()); } catch { return false; } }).map((t) => t.id);
}

// An agent's browser: a tab the agent has not sent a command to for this
// long is frozen; the next command for it wakes it.
const AGENT_IDLE_SEC = 120;
// With no window nothing is "showing": the front tab is left alone only
// while the agent works with it, like any other.
const NO_WINDOW = /Headless/.test(navigator.userAgent);

// A Cloudflare check seen with no window leaves state in the profile, and the same site then
// failed the check even after `set NAME window=on`, where a fresh session passes (tester,
// Nov 13 2026; again Nov 14 on stackoverflow.com: dropping only its cf_* cookies and cache
// was not enough). So the moment a hidden session meets the check, everything that site keeps
// in this session is dropped (cookies, storage, cache): the next try, in a window, is a fresh
// visit. A login to that site in this session goes too; it could not be used past the check.
async function forgetCloudflareCheck(url) {
  let origin;
  try { origin = new URL(url).origin; } catch { return; }
  const host = new URL(origin).hostname;
  const site = host.split(".").slice(-2).join(".");
  for (const c of await chrome.cookies.getAll({ domain: site }).catch(() => [])) {
    const scheme = c.secure ? "https://" : "http://";
    await chrome.cookies.remove({ url: scheme + c.domain.replace(/^\./, "") + c.path, name: c.name, storeId: c.storeId }).catch(() => {});
  }
  if (chrome.browsingData) {
    const origins = [...new Set([origin, "https://" + site, "https://www." + site])];
    await chrome.browsingData.remove({ origins }, { cache: true, cacheStorage: true, cookies: true, fileSystems: true, indexedDB: true, localStorage: true, serviceWorkers: true, webSQL: true }).catch(() => {});
  }
}

// Stops a tab now (a check for people an agent cannot pass).
async function parkTab(tabId) {
  if (!chrome.debugger || !(await setLifecycle(tabId, "frozen"))) return;
  const frozen = await frozenByUs();
  frozen[tabId] = Date.now();
  await chrome.storage.session.set({ frozenTabs: frozen });
}

// ---- An agent with no window: load, then stop (owner, Nov 12 2026) ----------------
// "If a bot is controlling it, why is it redrawing? Once the page is loaded,
// stop." A page an agent works with is frozen as soon as it has loaded and
// settled; each command wakes it, acts, and it is frozen again. Nothing
// runs, animates or is drawn between commands. Pictures are off (`lean`);
// `full-reload` loads one page as a person would get it and leaves it
// running until the next command. Windows people use are not touched.
const AGENT_SETTLE_MS = 1500;
const restTimers = new Map();
function agentRest(tabId) {
  if (!IS_AGENT_BUILD || !NO_WINDOW || !chrome.debugger) return;
  clearTimeout(restTimers.get(tabId));
  const mine = setTimeout(async () => {
    // Loading still: wait for it (20 s at most), then let it settle once more.
    for (let i = 0; i < 80; i++) {
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (!t || t.discarded) return restTimers.delete(tabId);
      if (t.status === "complete") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, AGENT_SETTLE_MS));
    // A newer command took the tab meanwhile: its own rest will follow.
    if (restTimers.get(tabId) !== mine) return;
    restTimers.delete(tabId);
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (t && !t.discarded && !t.audible && /^https?:/.test(t.url || "")) await parkTab(tabId);
  }, AGENT_SETTLE_MS);
  restTimers.set(tabId, mine);
}

// Pictures off for every page of the profile, or back to the browser's own rule.
async function agentLean(on) {
  if (!chrome.contentSettings) return { ok: false, error: "this copy of the extension cannot change content settings" };
  if (on) await chrome.contentSettings.images.set({ primaryPattern: "<all_urls>", setting: "block" });
  else await chrome.contentSettings.images.clear({});
  await chrome.storage.session.set({ agentLean: !!on });
  return { ok: true, lean: !!on };
}

// One page as a person would get it: pictures allowed for its site, loaded again.
async function agentFullReload(tab) {
  // The rule goes by the picture's own address, and a page's pictures come
  // from anywhere (seen: allowing the page's site brought back 3 of 12). So
  // the block is lifted while this page loads and put back a little after.
  const { agentLean: lean } = await chrome.storage.session.get({ agentLean: false });
  if (lean && chrome.contentSettings) await chrome.contentSettings.images.clear({});
  clearTimeout(restTimers.get(tab.id));
  restTimers.delete(tab.id);
  if ((await frozenByUs())[tab.id]) await thaw(tab.id);
  await chrome.tabs.reload(tab.id);
  if (lean && chrome.contentSettings) {
    (async () => {
      for (let i = 0; i < 80; i++) {
        const t = await chrome.tabs.get(tab.id).catch(() => null);
        if (!t || t.status === "complete") break;
        await new Promise((r) => setTimeout(r, 250));
      }
      await new Promise((r) => setTimeout(r, 3000));
      const { agentLean: still } = await chrome.storage.session.get({ agentLean: false });
      if (still) await chrome.contentSettings.images.set({ primaryPattern: "<all_urls>", setting: "block" });
    })();
  }
}

// Commands that mean the front tab when they name none.
const FRONT_TAB_OPS = new Set(["navigate", "reload", "back", "forward", "full-reload", "screenshot"]);

// `tabId` null: a command that reads or acts on a page without naming one
// means the front tab. Returns the tab the command is for, if any.
async function agentTouch(tabId, group, op) {
  if (typeof tabId !== "number" && (group === "read" || group === "act" || FRONT_TAB_OPS.has(op))) {
    const [front] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tabId = front ? front.id : null;
  }
  if (typeof tabId !== "number") return null;
  clearTimeout(restTimers.get(tabId));
  restTimers.delete(tabId);
  await noteTouch(tabId);
  return tabId;
}

async function noteTouch(tabId) {
  const { agentTouched } = await chrome.storage.session.get({ agentTouched: {} });
  agentTouched[tabId] = Date.now();
  await chrome.storage.session.set({ agentTouched });
  if ((await frozenByUs())[tabId]) await thaw(tabId);
}

async function awakeTabs() {
  return (await chrome.storage.session.get({ awakeTabs: [] })).awakeTabs;
}

// Uploads in flight, by request. Filled only when the user allowed us to see
// requests ("protect uploads" in Settings, or while request capture is on).
const uploads = new Map();
const busyTabs = () => [...new Set(uploads.values())];
// An upload carries a body of at least this size. Pages send small POSTs all
// the time (statistics, long-polls); counted as uploads, they kept tabs such
// as Stack Overflow and Google Maps from ever being frozen.
const UPLOAD_MIN_BYTES = 32 * 1024;
function bodyBytes(body) {
  if (!body) return 0;
  if (body.raw) return body.raw.reduce((n, p) => n + (p.bytes ? p.bytes.byteLength : p.file ? UPLOAD_MIN_BYTES : 0), 0);
  return 0; // form fields only: no file in it
}
function trackUpload(kind, d) {
  if (kind === "before") {
    if (d.tabId >= 0 && /^(POST|PUT|PATCH)$/.test(d.method) && bodyBytes(d.requestBody) >= UPLOAD_MIN_BYTES) uploads.set(d.requestId, d.tabId);
  } else if (kind === "completed" || kind === "error") uploads.delete(d.requestId);
}

async function freezeAllowed(s) {
  if (!s.freezeEnabled || !chrome.debugger) return false;
  const { launchFreeze } = await chrome.storage.local.get({ launchFreeze: null });
  return launchFreeze === true;
}

// state: "frozen" or "active". True if the tab took it.
let lastFreezeError = null; // why the last attempt failed, for the log
async function setLifecycle(tabId, state) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (e) {
    lastFreezeError = "attach: " + String(e && e.message ? e.message : e); // DevTools is open on it, or the tab is gone
    return false;
  }
  try {
    // A tab frozen while it is still loading never finishes, and its
    // spinner in the tab strip turns for good: 8 such tabs cost 6% of one
    // core in the browser process and 7.7% in the graphics process, with
    // the pages themselves at 0. So what is still coming in is stopped first.
    // The page itself must say "stopped", and a frozen page cannot: so the
    // freeze waits until the tab no longer counts as loading (a fixed half
    // second was too short with 45 tabs loading at once: theverge, imdb,
    // espn, weather.com and timesofindia were frozen while loading; tester).
    if (state === "frozen") await stopAndWait(target, tabId);
    await chrome.debugger.sendCommand(target, "Page.setWebLifecycleState", { state });
    return true;
  } catch (e) {
    lastFreezeError = "freeze: " + String(e && e.message ? e.message : e);
    return false;
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

// With the debugger attached: stops what a tab is still loading and waits,
// 2 s at most, until the tab says so. True if it is not loading any more.
async function stopAndWait(target, tabId) {
  const loading = async () => ((await chrome.tabs.get(tabId).catch(() => null)) || {}).status === "loading";
  if (!(await loading())) return true;
  for (let i = 0; i < 20; i++) {
    // Asked again once a second: a heavy page starts the next thing when one is stopped.
    if (i % 10 === 0) await chrome.debugger.sendCommand(target, "Page.stopLoading").catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    if (!(await loading())) return true;
  }
  return false;
}

// A tab that is frozen and still loading: woken, stopped, frozen again.
async function stopLoading(tabId) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch {
    return false;
  }
  try {
    await chrome.debugger.sendCommand(target, "Page.setWebLifecycleState", { state: "active" });
    const stopped = await stopAndWait(target, tabId);
    await chrome.debugger.sendCommand(target, "Page.setWebLifecycleState", { state: "frozen" });
    return stopped;
  } catch {
    return false;
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

// Tabs we froze, with the time of the freeze or of the last short wake-up.
async function frozenByUs() {
  return (await chrome.storage.session.get({ frozenTabs: {} })).frozenTabs;
}

function mark(tabId, on) {
  chrome.action.setBadgeText({ tabId, text: on ? "ON" : "" }).catch(() => {});
  if (on) chrome.action.setBadgeBackgroundColor({ tabId, color: "#1FC98A" }).catch(() => {});
  chrome.action.setTitle({ tabId, title: on ? "Gamblium menu: this tab is kept awake" : "Gamblium menu" }).catch(() => {});
}

// Split view (two tabs side by side in one window): both are on screen, but only one is
// "active". The other must count as shown, or it would be frozen and put to sleep in plain
// sight. Every list of tabs the planners see goes through here.
async function allTabs() {
  return markSplitShown(await chrome.tabs.query({}));
}
function markSplitShown(tabs) {
  const shownSplits = new Set(tabs.filter((t) => t.active && t.splitViewId > 0).map((t) => t.splitViewId));
  if (shownSplits.size) for (const t of tabs) if (!t.active && shownSplits.has(t.splitViewId)) { t.active = true; t.splitPartner = true; }
  return tabs;
}
async function onScreen(t) {
  if (!t) return false;
  if (t.active) return true;
  if (!(t.splitViewId > 0)) return false;
  return (await chrome.tabs.query({ windowId: t.windowId, active: true }).catch(() => [])).some((a) => a.splitViewId === t.splitViewId);
}

async function wakeBriefly(tabId, seconds) {
  if (!(await setLifecycle(tabId, "active"))) return;
  await new Promise((r) => setTimeout(r, Math.min(20, Math.max(1, seconds)) * 1000));
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (t && !(await onScreen(t)) && !t.audible && !t.discarded) await setLifecycle(tabId, "frozen");
}

// What the last check did, readable from our pages and by the tester:
// chrome.storage.local "freezeLog".
async function freezeLog(entry) {
  await chrome.storage.local.set({ freezeLog: { at: new Date().toISOString(), ...entry } });
}

async function freezeCheck(tabs, s, now, ctx) {
  if (!(await freezeAllowed(s))) {
    const { launchFreeze } = await chrome.storage.local.get({ launchFreeze: null });
    await freezeLog({
      ran: false,
      why: !s.freezeEnabled ? "freezing is switched off in Settings"
        : !chrome.debugger ? "this copy of the extension has no debugger permission"
        : launchFreeze === null ? "the helper did not answer, so we do not know how the browser was started"
        : "the browser was not started by gamblium launch with a freezing preset",
    });
    return 0;
  }
  // First sight of each tab, for tabs that carry no "last shown" time.
  const { firstSeen } = await chrome.storage.session.get({ firstSeen: {} });
  for (const t of tabs) firstSeen[t.id] ??= now;
  for (const id of Object.keys(firstSeen)) if (!tabs.some((t) => t.id === Number(id))) delete firstSeen[id];
  await chrome.storage.session.set({ firstSeen });
  ctx = { ...ctx, firstSeen };
  const reasons = {};
  const leftAwake = []; // hidden tabs neither frozen nor asleep, with the reason
  const failed = [];
  const frozen = await frozenByUs();
  const open = new Set(tabs.map((t) => t.id));
  for (const id of Object.keys(frozen)) if (!open.has(Number(id))) delete frozen[id];
  // The browser thaws a tab when it is shown; forget those.
  for (const t of tabs) if (t.active && frozen[t.id]) delete frozen[t.id];
  const seen = tabs.map((t) => ({ ...t, frozen: (!t.discarded && !!t.frozen) || !!frozen[t.id] }));

  for (const t of tabsToWake(seen, s, now, frozen, ctx)) {
    frozen[t.id] = now;
    wakeBriefly(t.id, t.wakeForSec);
  }
  let n = 0;
  const due = [];
  for (const t of seen) {
    const why = freezeReason(t, s, now, ctx);
    if (why === "kept awake") mark(t.id, true);
    const key = (why ?? "frozen now").replace(/hidden only .*/, "hidden, waiting");
    if (why !== null) {
      reasons[key] = (reasons[key] || 0) + 1;
      if (!t.active && !t.discarded && !t.frozen && leftAwake.length < 60) leftAwake.push({ site: hostOf(t.url) || (t.url || "").slice(0, 40), why });
      continue;
    }
    due.push(t);
  }
  // Four at a time: a tab still loading can take up to 2 s to stop, and with
  // 45 tabs one after the other a check took most of a minute.
  const freezeOne = async (t) => {
    if (await setLifecycle(t.id, "frozen")) {
      frozen[t.id] = now;
      n++;
      reasons["frozen now"] = (reasons["frozen now"] || 0) + 1;
    } else {
      failed.push({ tab: t.id, url: (t.url || "").slice(0, 80), error: lastFreezeError });
    }
  };
  for (let i = 0; i < due.length; i += 4) await Promise.all(due.slice(i, i + 4).map(freezeOne));
  await chrome.storage.session.set({ frozenTabs: frozen });
  frozenNow.clear();
  for (const id of Object.keys(frozen)) frozenNow.add(Number(id));
  // A tab that is frozen and still counts as loading (frozen by the browser
  // itself, or it began something new in the instant before our freeze):
  // its spinner turns for good. Stopped where it stands, at most 8 a check.
  // Once a minute, and once per tab: run on every timed check it woke the
  // same pages again and again (tester, 45 tabs: browser 88, graphics 36
  // core-seconds while loading).
  let stopped = 0, tried = 0;
  for (const t of checkIsTimed ? [] : seen) {
    if (tried >= 6) break;
    if (t.status !== "loading" || !t.frozen || t.active || t.discarded || !/^https?:/.test(t.url || "")) continue;
    if (stoppedOnce.has(t.id)) continue;
    stoppedOnce.add(t.id);
    tried++;
    if (await stopLoading(t.id)) stopped++;
  }
  // What this check saw still loading, for the log (to tell a spinner that
  // turns for good from one the check never sees).
  const loadingSeen = seen.filter((t) => t.status === "loading").slice(0, 12).map((t) => ({
    site: hostOf(t.url) || (t.pendingUrl || t.url || "").slice(0, 40), frozen: !!t.frozen, byUs: !!frozen[t.id], front: !!t.active, asleep: !!t.discarded,
  }));
  const after = await chrome.tabs.query({ status: "loading" }).catch(() => []);
  if (tried) reasons["frozen while loading"] = tried;
  if (stopped) reasons["loading stopped"] = stopped;
  const trim = await trimCheck(tabs, s, now, frozen);
  await freezeLog({
    ran: true, tabs: tabs.length, frozenNow: n, frozenInAll: Object.keys(frozen).length, reasons, failed: failed.slice(0, 10),
    trimmedNow: trim.pids, trimmedInAll: trim.tabs, trimNote: trim.note, leftAwake, loadingSeen, loadingAfter: after.length,
  });
  return n;
}

// Level 2 of the freeze engine: a tab that has stayed frozen has the memory
// of its page process moved out of RAM by the helper. The page keeps
// everything (it is the tab's own memory, on disk) and takes it back as it
// touches it when shown. Returns what was done, for the log.
async function trimCheck(tabs, s, now, frozen) {
  const { trimmedTabs } = await chrome.storage.session.get({ trimmedTabs: {} });
  for (const id of Object.keys(trimmedTabs)) if (frozen[id] === undefined) delete trimmedTabs[id];
  const done = { pids: 0, tabs: Object.keys(trimmedTabs).length, note: null };
  // Only when memory is short. Trimming every frozen tab cost 45 points of
  // CPU while 45 tabs loaded (tester: 343% against 298% with it off), for a
  // lower working set that Windows takes back by itself when it needs to;
  // idle CPU and private memory were the same either way.
  const mem = chrome.system && chrome.system.memory ? await chrome.system.memory.getInfo().catch(() => null) : null;
  const short = mem && mem.availableCapacity / 1048576 < s.lowMemoryMb;
  if (!short) {
    done.note = "memory is not short";
  } else if (trimWaiting(frozen, trimmedTabs, now, s)) {
    const reading = await native({ type: "stats" });
    if (!reading || !reading.ok) {
      done.note = "the helper did not answer";
    } else {
      const framesByTab = {};
      await Promise.all(tabs.filter((t) => !t.discarded).map(async (t) => {
        const frames = await chrome.webNavigation.getAllFrames({ tabId: t.id }).catch(() => null);
        if (frames) framesByTab[t.id] = frames.map((f) => f.processId);
      }));
      const plan = trimPlan(frozen, trimmedTabs, framesByTab, reading.processes, now, s);
      if (plan.pids.length) {
        const r = await native({ type: "trim", pids: plan.pids });
        done.pids = r && r.ok && Array.isArray(r.pids) ? r.pids.length : 0;
        if (!r || !r.ok) done.note = (r && r.error) || "trim failed";
      }
      for (const id of plan.tabs) trimmedTabs[id] = frozen[id];
      done.tabs = Object.keys(trimmedTabs).length;
    }
  }
  await chrome.storage.session.set({ trimmedTabs });
  return done;
}

async function thaw(tabId) {
  const frozen = await frozenByUs();
  if (frozen[tabId]) {
    delete frozen[tabId];
    await chrome.storage.session.set({ frozenTabs: frozen });
  }
  await setLifecycle(tabId, "active");
}

// What the popup and the right-click menu show for one tab.
async function awakeGet(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, error: "that tab is gone" };
  const s = await settings();
  const host = /^https?:/.test(tab.url || "") ? hostOf(tab.url) : "";
  return {
    ok: true, host, tab: (await awakeTabs()).includes(tabId), site: !!host && tempOf({ id: -1, url: tab.url }, s) >= MAX_TEMP,
    // The site's background level in kelvin, leaving this tab's own mark aside.
    temp: host ? tempOf({ id: -1, url: tab.url }, s) : null,
    freezing: await freezeAllowed(s), frozen: (!tab.discarded && !!tab.frozen) || !!(await frozenByUs())[tabId],
  };
}

// { tabId, tab: true|false } and/or { tabId, site: true|false }
/** Every tab of the group is on the keep-awake list. */
async function groupAwake(groupId) {
  const awake = new Set(await awakeTabs());
  const ids = (await chrome.tabs.query({ groupId }).catch(() => [])).map((t) => t.id);
  return ids.length > 0 && ids.every((id) => awake.has(id));
}
async function awakeSet(msg) {
  const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
  if (!tab) return { ok: false, error: "that tab is gone" };
  if (typeof msg.tab === "boolean") {
    const list = (await awakeTabs()).filter((id) => id !== tab.id);
    if (msg.tab) list.push(tab.id);
    await chrome.storage.session.set({ awakeTabs: list });
  }
  if (typeof msg.site === "boolean") {
    const host = /^https?:/.test(tab.url || "") ? hostOf(tab.url) : "";
    if (!host) return { ok: false, error: "this is not a web page" };
    const s = await settings();
    const rest = s.awakeHosts.filter((e) => !(host === e || host.endsWith("." + e)));
    const siteTemps = { ...s.siteTemps };
    delete siteTemps[host];
    await chrome.storage.local.set({ awakeHosts: msg.site ? [...rest, host] : rest, siteTemps });
  }
  // { tabId, temp: 0..273 }: the background level of this tab's site.
  if (typeof msg.temp === "number") {
    const host = /^https?:/.test(tab.url || "") ? hostOf(tab.url) : "";
    if (!host) return { ok: false, error: "this is not a web page" };
    const s = await settings();
    const temp = Math.max(0, Math.min(MAX_TEMP, Math.round(msg.temp)));
    await chrome.storage.local.set({
      siteTemps: { ...s.siteTemps, [host]: temp },
      awakeHosts: s.awakeHosts.filter((e) => !(host === e || host.endsWith("." + e))),
    });
    msg = { ...msg, site: temp >= MAX_TEMP };
  }
  const now = await awakeGet(tab.id);
  const awake = now.tab || now.site;
  mark(tab.id, awake);
  if (awake) {
    // Wake what is already frozen: this tab, and for a site every tab of it.
    const all = msg.site ? await allTabs() : [tab];
    const s = await settings();
    for (const t of all) if (t.id === tab.id || tempOf(t, s) >= MAX_TEMP) await thaw(t.id);
  }
  syncAwakeMenu(tab.id);
  return now;
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const list = await awakeTabs();
  if (list.includes(tabId)) await chrome.storage.session.set({ awakeTabs: list.filter((id) => id !== tabId) });
});

// Sleep hidden tabs right now, ignoring the delay but keeping every other rule.
async function sleepNow(scope, windowId) {
  const s = { ...(await settings()), enabled: true, delaySec: 0 };
  let tabs = await allTabs();
  if (scope === "this-window") tabs = tabs.filter((t) => t.windowId === windowId);
  if (scope === "other-windows") {
    // A whole other window sleeps, including the tab it was showing.
    tabs = tabs.filter((t) => t.windowId !== windowId).map((t) => ({ ...t, active: false }));
  }
  return sleep(tabsToSleep(tabs, s, Date.now()));
}

async function status() {
  const s = await settings();
  const tabs = await allTabs();
  const now = Date.now();
  const reasons = {};
  for (const t of tabs) {
    const r = (keepReason(t, s, now) ?? "due to sleep").replace(/hidden only .*/, "hidden, waiting");
    reasons[r] = (reasons[r] || 0) + 1;
  }
  const mb = await availableMb();
  return {
    settings: s,
    total: tabs.length,
    frozen: tabs.filter((t) => frozenNow.has(t.id)).length, // frozen by us now (kept in memory, no processor time)
    reasons,
    availableMb: mb === null ? null : Math.round(mb),
    delaySecNow: effectiveDelaySec(s, mb),
  };
}

// ---- Freezing on time ---------------------------------------------------------
// The once-a-minute check is the backstop. Between checks a timer runs the
// freezer when the next hidden tab is due (30 s after it was hidden, or once
// its document is in when it is still loading). Tab events re-plan it.
const domReady = new Map(); // tabId -> time its page's document was in
let checkIsTimed = false;
const frozenNow = new Set(); // tabs frozen by us, mirrored from storage for quick counting
const stoppedOnce = new Set(); // frozen-while-loading tabs the sweep has handled
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0) domReady.delete(d.tabId);
});
chrome.webNavigation.onDOMContentLoaded.addListener((d) => {
  if (d.frameId !== 0) return;
  domReady.set(d.tabId, Date.now());
  planFreezeSoon();
});
chrome.tabs.onRemoved.addListener((tabId) => void domReady.delete(tabId));

// Events come in bursts while tabs load: the plan is made at most once a second.
let planSoon = null;
function planFreezeSoon() {
  if (planSoon) return;
  planSoon = setTimeout(() => {
    planSoon = null;
    planFreeze();
  }, 1000);
}
let freezeTimer = null;
let freezeTimerAt = 0;
let lastTimedCheck = 0;
const FREEZE_TIMER_GAP_MS = 3000; // never more often than this
async function planFreeze() {
  if (IS_AGENT_BUILD) return; // an agent's browser freezes by its own rules (agentRest, AGENT_IDLE_SEC)
  const s = await settings();
  if (!s.enabled || !(await freezeAllowed(s))) return;
  const tabs = await allTabs();
  const now = Date.now();
  const { firstSeen } = await chrome.storage.session.get({ firstSeen: {} });
  const due = nextFreezeDue(tabs, s, now, { frozen: await frozenByUs(), firstSeen, domReady: Object.fromEntries(domReady), siteTemps: s.siteTemps });
  if (due === null) return;
  const at = Math.max(due + 250, now + 500, lastTimedCheck + FREEZE_TIMER_GAP_MS);
  if (freezeTimer && freezeTimerAt <= at) return; // an earlier run is already planned
  clearTimeout(freezeTimer);
  freezeTimerAt = at;
  freezeTimer = setTimeout(async () => {
    freezeTimer = null;
    lastTimedCheck = Date.now();
    await check(true);
  }, at - now);
}
chrome.tabs.onActivated.addListener(() => planFreezeSoon());

// ---- Hidden tabs load a few at a time ----------------------------------------------
// Many tabs opened at once all load together and the machine peaks. A hidden
// tab that starts loading while `loadAtOnce` other hidden tabs are loading is
// put to sleep the moment its address is committed (so it keeps its address
// and title) and queued; each time a hidden tab finishes, is frozen or
// closes, the next one in the queue is loaded. Opening a waiting tab loads it
// at once, as for any sleeping tab. Not in an agent's browser.
const loadQueue = []; // tab ids, oldest first
// When each tab was created. The newest tab of a window is never held: a
// page that opens tabs with window.open shows the last one, and that tab
// can still be hidden for a moment when its address is committed. Put to
// sleep then, the browser showed an older tab instead (tester, window 2).
const createdAt = new Map();
chrome.tabs.onCreated.addListener((t) => createdAt.set(t.id, Date.now()));
function newestInWindow(tabId) {
  const mine = createdAt.get(tabId) ?? 0;
  const win = windowOf.get(tabId);
  for (const [other, w] of windowOf) if (other !== tabId && w === win && (createdAt.get(other) ?? 0) > mine) return false;
  return true;
}
const letGo = new Set(); // tabs loaded from the queue: not held again
const queueLog = []; // for the test: tabs that left the queue without being loaded by it
globalThis.gambliumQueue = () => ({ waiting: [...loadQueue], letGo: [...letGo], dropped: queueLog.slice(-60) });
// Kept in session storage too: a worker that restarts picks the queue up again.
const saveQueue = () => chrome.storage.session.set({ loadQueue: [...loadQueue] }).catch(() => {});
chrome.storage.session.get({ loadQueue: [] }).then(({ loadQueue: saved }) => {
  for (const id of saved) if (!loadQueue.includes(id)) loadQueue.push(id);
  if (saved.length) keepReleasing();
});
// Which tabs are loading, and which tab each window shows, kept from events.
// Asking the browser instead (tabs.query with a status filter) did not
// answer for seconds while 15 heavy pages loaded, so the queue decided too
// late or never (backend, window.open of 15 sites).
const loadingNow = new Set();
const shownIn = new Map(); // windowId -> tabId in front
const windowOf = new Map(); // tabId -> windowId
chrome.webNavigation.onBeforeNavigate.addListener((d) => void (d.frameId === 0 && loadingNow.add(d.tabId)));
for (const ev of [chrome.webNavigation.onCompleted, chrome.webNavigation.onErrorOccurred]) {
  ev.addListener((d) => {
    if (d.frameId !== 0) return;
    loadingNow.delete(d.tabId);
    if (loadQueue.length) loadNext();
  });
}
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  shownIn.set(windowId, tabId);
  windowOf.set(tabId, windowId);
});
chrome.tabs.onCreated.addListener((t) => windowOf.set(t.id, t.windowId));
chrome.tabs.onAttached.addListener((id, info) => windowOf.set(id, info.newWindowId));
chrome.tabs.onRemoved.addListener((id) => {
  loadingNow.delete(id);
  windowOf.delete(id);
});
// One id per tab for its whole life, for agents (agent.js): the ids a tab
// had before the browser renumbered it, and the last address of each tab
// (by its first id), so a sleeping tab wakes where the agent left it.
// Writes are chained in event order, and a command waits for them, so one
// sent right after a discard already sees the new id.
let idWrite = Promise.resolve();
const idChain = (f) => (idWrite = idWrite.then(f).catch(() => {}));
async function tabIdMaps() {
  await idWrite;
  return (await chrome.storage.session.get({ tabIdMaps: emptyIdMaps() })).tabIdMaps;
}
async function tabLastUrl(id) {
  const maps = await tabIdMaps();
  const { tabLastUrl: urls } = await chrome.storage.session.get({ tabLastUrl: {} });
  return urls[firstId(maps, id)] || null;
}
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!change.url || tab.discarded || !/^https?:/.test(change.url)) return;
  idChain(async () => {
    const maps = (await chrome.storage.session.get({ tabIdMaps: emptyIdMaps() })).tabIdMaps;
    const { tabLastUrl: urls } = await chrome.storage.session.get({ tabLastUrl: {} });
    urls[firstId(maps, tabId)] = change.url;
    const keys = Object.keys(urls);
    for (const k of keys.slice(0, Math.max(0, keys.length - 4000))) delete urls[k];
    await chrome.storage.session.set({ tabLastUrl: urls });
  });
});
chrome.tabs.onReplaced.addListener((added, removed) => {
  idChain(async () => {
    const maps = (await chrome.storage.session.get({ tabIdMaps: emptyIdMaps() })).tabIdMaps;
    await chrome.storage.session.set({ tabIdMaps: noteReplaced(maps, added, removed) });
  });
  windowOf.set(added, windowOf.get(removed));
  windowOf.delete(removed);
  loadingNow.delete(removed);
});
allTabs().then((tabs) => {
  for (const t of tabs) {
    windowOf.set(t.id, t.windowId);
    if (t.active) shownIn.set(t.windowId, t.id);
    if (t.status === "loading" && !t.discarded) loadingNow.add(t.id);
  }
});
const isShown = (tabId) => shownIn.get(windowOf.get(tabId)) === tabId;
function hiddenLoading(except) {
  let n = 0;
  for (const id of loadingNow) if (id !== except && !isShown(id) && !loadQueue.includes(id) && !frozenNow.has(id)) n++;
  return n;
}
chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0 || IS_AGENT_BUILD || letGo.has(d.tabId) || loadQueue.includes(d.tabId)) return;
  if (isShown(d.tabId) || newestInWindow(d.tabId)) return;
  const s = await settings();
  const busy = hiddenLoading(d.tabId);
  if (busy < (Number(s.loadAtOnce) || 0) && Number(s.loadAtOnce) > 0) return;
  // Still hidden a moment later? A tab about to be shown is not held.
  await new Promise((r) => setTimeout(r, 300));
  if (isShown(d.tabId) || newestInWindow(d.tabId)) return;
  const tab = await chrome.tabs.get(d.tabId).catch(() => null);
  if (!tab || !holdForLoading(tab, s, hiddenLoading(d.tabId))) return;
  try {
    // A tab that is put to sleep can come back under a new id.
    const slept = await chrome.tabs.discard(d.tabId);
    const id = slept && typeof slept.id === "number" ? slept.id : d.tabId;
    loadingNow.delete(d.tabId);
    loadQueue.push(id);
    saveQueue();
    keepReleasing();
  } catch {
    // shown or closed meanwhile
  }
});


// While tabs wait, the queue is looked at every 2 s as well: a tab that
// finished before the others were queued leaves no event behind.
let releaser = null;
function keepReleasing() {
  if (releaser) return;
  releaser = setInterval(() => {
    if (!loadQueue.length) return void (clearInterval(releaser), (releaser = null));
    loadNext();
  }, 2000);
}
let releasing = false;
async function loadNext() {
  if (releasing) return;
  releasing = true;
  try {
    await releaseFromQueue();
  } finally {
    releasing = false;
  }
}
async function releaseFromQueue() {
  if (!loadQueue.length) return;
  const s = await settings();
  const most = Number(s.loadAtOnce) || 0;
  while (loadQueue.length && (most <= 0 || hiddenLoading(null) < most)) {
    const id = loadQueue.shift();
    saveQueue();
    const t = await chrome.tabs.get(id).catch(() => null);
    if (!t || !t.discarded) {
      queueLog.push({ id, gone: !t });
      continue; // closed, or opened by the user (it loaded by itself)
    }
    letGo.add(id);
    await chrome.tabs.reload(id).catch(() => {});
  }
}
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.status !== "complete" || tab.active) return; // the tab in front costs nothing here
  letGo.delete(id);
  if (loadQueue.length) loadNext();
});
chrome.tabs.onRemoved.addListener((id) => {
  letGo.delete(id);
  createdAt.delete(id);
  stoppedOnce.delete(id);
  const i = loadQueue.indexOf(id);
  if (i >= 0) loadQueue.splice(i, 1), saveQueue();
  loadNext();
});
// Opened by the user while waiting: it loads by itself; it leaves the queue.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  const i = loadQueue.indexOf(tabId);
  if (i >= 0) loadQueue.splice(i, 1), saveQueue();
});
chrome.tabs.onCreated.addListener(() => planFreezeSoon());
// Only hidden tabs matter here. A page in front that loads frames all the
// time (Speedometer runs its tests in an iframe) flips its own status many
// times a second; it must cost the extension nothing.
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (change.status && !tab.active) planFreezeSoon();
});

function arm() {
  // 30 s is the shortest period Chromium allows for an extension alarm.
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => {
  arm();
  createMenus();
});
chrome.runtime.onStartup.addListener(arm);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== ALARM) return;
  check();
  enforceGroupLimits().catch(() => {});
  bridgeEnsure(); // reconnect if the helper went away
});

// ---- Downloads -------------------------------------------------------------
// Brave's own downloader does the transfer. We add routing rules and give the
// UI a list and controls.

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  chrome.storage.local.get(DOWNLOAD_DEFAULTS).then((stored) => {
    const filename = routedFilename(item, { ...DOWNLOAD_DEFAULTS, ...stored });
    if (filename) suggest({ filename, conflictAction: "uniquify" });
    else suggest();
  });
  return true; // suggest() is called later
});

// A big download goes to our own downloader as soon as Brave knows where the
// file is to be saved (the user may have been asked). Brave's copy is then
// cancelled. If ours cannot fetch it (a one-time link, a login we do not
// have), the download is given back to Brave.
const GIVE_BACK_AFTER_MS = 6000;

async function cookieHeader(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    // The soonest moment any of them runs out (session cookies carry none).
    const ends = cookies.map((c) => c.expirationDate).filter((t) => t > 0);
    return { header: cookies.map((c) => c.name + "=" + c.value).join("; "), expires: ends.length ? Math.floor(Math.min(...ends)) : null };
  } catch {
    return { header: "", expires: null };
  }
}

async function handOver(id) {
  const [item] = await chrome.downloads.search({ id });
  const own = await chrome.storage.local.get(OWN_DEFAULTS);
  if (stayReason(item, own, chrome.runtime.id)) return;
  const { dir, name } = splitPath(item.filename);
  const url = item.finalUrl || item.url;
  // The login for this address rides along (Drive, forums, anything behind a
  // sign-in), under the browser's own name. The downloader does not follow
  // redirects when it carries a cookie, so the cookie stays with its site.
  const login = await cookieHeader(url);
  const started = await native({ type: "dl-start", url, dir, name, referer: item.referrer || "", cookie: login.header, cookieExpires: login.expires, userAgent: navigator.userAgent, startConnections: 4 });
  if (!started || started.ok === false || !started.download) return; // no helper: Brave carries on
  const note = { at: Date.now(), url, ours: started.download, braveId: id };
  note.cancel = await chrome.downloads.cancel(id).then(() => "ok", (e) => String(e && e.message ? e.message : e));
  const [after] = await chrome.downloads.search({ id });
  note.after = after ? { state: after.state, error: after.error, paused: after.paused, danger: after.danger, received: after.bytesReceived } : null;
  // The last few hand-overs, for the Downloads page and for finding faults.
  const { handovers = [] } = await chrome.storage.local.get({ handovers: [] });
  await chrome.storage.local.set({ handovers: [note, ...handovers].slice(0, 20) });
  // Brave removes its half-written file a moment after the cancel; taking the
  // entry off the list before that leaves the file behind.
  setTimeout(() => chrome.downloads.erase({ id }).catch(() => {}), 2000);
  setTimeout(async () => {
    const list = await native({ type: "dl-list" });
    const row = ((list && list.downloads) || []).find((d) => d.id === started.download);
    if (row && row.state === "error" && !(row.done > 0)) {
      await native({ type: "dl-forget", id: started.download });
      // Started by this extension, so stayReason leaves it with Brave.
      chrome.downloads.download({ url }).catch(() => {});
    }
  }, GIVE_BACK_AFTER_MS);
}

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.filename && delta.filename.current) handOver(delta.id).catch(() => {});
  if (delta.state && delta.state.current === "complete") torrentFileSaved(delta.id).catch(() => {});
});

// ---- Torrents and magnet links ------------------------------------------------------
// Brave only saves a .torrent file and cannot open a magnet link at all. A
// saved .torrent file is started in our downloader, next to where it was
// saved; a magnet link or a link to a .torrent file is started from the
// right-click menu or from the Downloads page.
async function startTorrent(address, dir) {
  const own = await chrome.storage.local.get(OWN_DEFAULTS);
  const request = { type: "dl-start", url: address, seedMinutes: own.seedMinutes };
  if (dir) request.dir = dir;
  return native(request);
}

async function torrentFileSaved(id) {
  const [item] = await chrome.downloads.search({ id });
  const own = await chrome.storage.local.get(OWN_DEFAULTS);
  if (!own.ownTorrents || !item || item.incognito || !/\.torrent$/i.test(item.filename || "")) return;
  await startTorrent(item.filename, splitPath(item.filename).dir);
}

async function downloadsList(limit) {
  const items = await chrome.downloads.search({ limit: limit || 100, orderBy: ["-startTime"] });
  return items.map((d) => ({
    id: d.id,
    filename: d.filename,
    url: d.finalUrl || d.url,
    state: d.state, // in_progress | interrupted | complete
    paused: d.paused,
    canResume: d.canResume,
    error: d.error || null,
    bytesReceived: d.bytesReceived,
    totalBytes: d.totalBytes,
    startTime: d.startTime,
    endTime: d.endTime || null,
    exists: d.exists,
    mime: d.mime,
  }));
}

const DOWNLOAD_ACTIONS = {
  pause: (id) => chrome.downloads.pause(id),
  resume: (id) => chrome.downloads.resume(id),
  cancel: (id) => chrome.downloads.cancel(id),
  show: (id) => chrome.downloads.show(id),
  erase: (id) => chrome.downloads.erase({ id }), // removes it from the list, not from disk
};

async function downloadsAction(id, action) {
  const fn = DOWNLOAD_ACTIONS[action];
  if (!fn) return { ok: false, error: "unknown action" };
  try {
    await fn(id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// ---- Request capture --------------------------------------------------------
// The extension may read every site (downloads behind a login need it), so
// the browser would hand a listener for all requests every request of every
// page. The listeners that take headers and bodies of everything are
// therefore added only while capture is on and taken away when it goes off.
// With capture off, only the three light listeners at the bottom remain,
// which watch for uploads among the kinds of request that can be one.
// Records live in session storage: memory only, gone when the browser closes.

const ALL_SITES = { origins: ["<all_urls>"] };
let cap = null;
let capOn = false;
let capReady = null;
let capTimer = null;

function capLoad() {
  if (!capReady) {
    capReady = chrome.storage.session.get({ capture: null, captureOn: false }).then((s) => {
      cap = s.capture || emptyState();
      capOn = s.captureOn;
      capListen(capOn);
    });
  }
  return capReady;
}

function capSave() {
  if (capTimer) return;
  capTimer = setTimeout(async () => {
    capTimer = null;
    try {
      await chrome.storage.session.set({ capture: cap });
    } catch {
      // Over the storage quota: keep the newest half.
      for (const id of cap.order.splice(0, Math.ceil(cap.order.length / 2))) delete cap.byId[id];
      await chrome.storage.session.set({ capture: cap }).catch(() => {});
    }
  }, 2000);
}

function onNet(kind) {
  return (details) => {
    if (!capOn || !cap) return;
    applyEvent(cap, kind, details);
    capSave();
  };
}

const EVERY_URL = { urls: ["<all_urls>"] };
const CAPTURE_LISTENERS = [
  ["onBeforeRequest", onNet("before"), ["requestBody"]],
  ["onSendHeaders", onNet("sendHeaders"), ["requestHeaders", "extraHeaders"]],
  ["onHeadersReceived", onNet("headersReceived"), ["responseHeaders", "extraHeaders"]],
  ["onCompleted", onNet("completed")],
  ["onErrorOccurred", onNet("error")],
];
// A worker that sleeps is woken only by listeners added when its script
// starts. These are added later, so while capture is on the worker is kept
// awake (one cheap call every 20 s); with capture off it sleeps as before.
let capAwake = null;
function capListen(on) {
  for (const [event, fn, extra] of CAPTURE_LISTENERS) {
    const have = chrome.webRequest[event].hasListener(fn);
    if (on && !have) chrome.webRequest[event].addListener(fn, EVERY_URL, ...(extra ? [extra] : []));
    if (!on && have) chrome.webRequest[event].removeListener(fn);
  }
  if (on && !capAwake) capAwake = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20_000);
  if (!on && capAwake) capAwake = void clearInterval(capAwake);
}
capLoad();

// Uploads in flight (a tab with one is not put to sleep). An upload is a
// page load, a frame, or a request a script makes; pictures, scripts,
// styles, fonts and media, which are most of what a page asks for, are
// never delivered to these.
const MAY_UPLOAD = { urls: ["<all_urls>"], types: ["main_frame", "sub_frame", "xmlhttprequest", "other"] };
chrome.webRequest.onBeforeRequest.addListener((d) => trackUpload("before", d), MAY_UPLOAD, ["requestBody"]);
chrome.webRequest.onCompleted.addListener((d) => trackUpload("completed", d), MAY_UPLOAD);
chrome.webRequest.onErrorOccurred.addListener((d) => trackUpload("error", d), MAY_UPLOAD);

async function captureStatus() {
  await capLoad();
  return { on: capOn, count: cap.order.length, hasPermission: await chrome.permissions.contains(ALL_SITES) };
}

async function captureStart() {
  await capLoad();
  // Only a click in our own page can ask for the permission; see the capture page.
  if (!(await chrome.permissions.contains(ALL_SITES))) return { ok: false, needPermission: true };
  capOn = true;
  capListen(true);
  await chrome.storage.session.set({ captureOn: true });
  return { ok: true };
}

async function captureStop() {
  await capLoad();
  capOn = false;
  capListen(false);
  await chrome.storage.session.set({ captureOn: false });
  // Upload protection needs the same permission; keep it if that is on.
  const { protectUploads } = await chrome.storage.local.get({ protectUploads: false });
  if (!protectUploads) await chrome.permissions.remove(ALL_SITES).catch(() => {});
  return { ok: true };
}

const summary = (r) => ({
  id: r.id, method: r.method, url: r.url, type: r.type, tabId: r.tabId, status: r.status ?? null,
  mime: r.mime ?? null, contentLength: r.contentLength ?? null, durationMs: r.durationMs ?? null,
  startTime: r.startTime, ip: r.ip ?? null, error: r.error ?? null, fromCache: !!r.fromCache, done: !!r.done,
});

async function captureList(filter, limit) {
  await capLoad();
  return listRecords(cap, filter || {}, limit || 500).map(summary);
}

async function captureGet(id) {
  await capLoad();
  const r = cap.byId[id];
  return r ? { record: r, curl: toCurl(r) } : null;
}

async function captureClear() {
  await capLoad();
  cap = emptyState();
  await chrome.storage.session.set({ capture: cap });
  return { ok: true };
}

// ---- Keep these sites light -------------------------------------------------
// With forced dark mode on, a site on this list gets one static stylesheet
// (ui/keep-light.css, "color-scheme: only light") and so stays as designed.
// No script runs in any page, and no other site is touched.

const KEEP_LIGHT_ID = "keep-light";

async function syncLightSites() {
  const { lightSites } = await chrome.storage.local.get({ lightSites: [] });
  const matches = lightSiteMatches(lightSites);
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [KEEP_LIGHT_ID] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [KEEP_LIGHT_ID] });
    if (matches.length) {
      await chrome.scripting.registerContentScripts([
        { id: KEEP_LIGHT_ID, css: ["ui/keep-light.css"], matches, runAt: "document_start", allFrames: true },
      ]);
    }
    return { ok: true, sites: matches.length / 2 };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.lightSites) syncLightSites();
});

// ---- Named sessions (checkpoints) -------------------------------------------
// Save everything about the open windows under a name, optionally close them
// to free memory, and bring it all back later: which profile it came from,
// window positions, every tab with its pin, group, mute, zoom and sleep state,
// scroll position and typed form text where we may look, and our own settings.
// On reopening only the tab that was showing is loaded; the others come back
// asleep and get their scroll position and form text when first opened.

const SETTINGS_KEYS = ["enabled", "delaySec", "lowMemoryDelaySec", "lowMemoryMb", "allowlist", "lightSites", "routingEnabled", "rules", "ui"];

// Saved sessions are stored packed (gzip, about a tenth of the size) and
// sealed by the helper with the sessions key, which Windows keeps for this
// user account only: a copy of the profile folder on another machine or
// under another account cannot read them. Without the helper they are stored
// packed but not sealed. An exported session is plain JSON, on purpose.
const SESSIONS_LABEL = "saved sessions";
// The helper's answer may be 1 MB at most; a packed store beyond this is kept unsealed.
const SEAL_LIMIT = 500_000;
let sessionCache = null;

async function sessionStore() {
  if (sessionCache) return sessionCache;
  const got = await chrome.storage.local.get({ sessionsPacked: null, sessions: null });
  if (got.sessionsPacked) {
    let data = got.sessionsPacked.data;
    if (got.sessionsPacked.sealed) {
      const r = await native({ type: "open", label: SESSIONS_LABEL, sealed: data });
      // Never read as "no sessions": the next save would then overwrite them.
      if (!r || !r.ok || typeof r.text !== "string") {
        throw new Error("Your saved sessions are sealed for this Windows account and could not be opened (" + ((r && r.error) || "no answer from the helper") + ").");
      }
      data = r.text;
    }
    sessionCache = await unpack(data);
    return sessionCache;
  }
  // Stored the old way (plain): pack them now.
  const old = got.sessions || {};
  if (Object.keys(old).length) await saveSessions(old);
  else sessionCache = old;
  return sessionCache;
}

async function saveSessions(store) {
  const data = await pack(store);
  let packed = { v: 1, sealed: false, data };
  if (data.length <= SEAL_LIMIT) {
    const r = await native({ type: "seal", label: SESSIONS_LABEL, text: data });
    if (r && r.ok && typeof r.sealed === "string") packed = { v: 1, sealed: true, data: r.sealed };
  }
  await chrome.storage.local.set({ sessionsPacked: packed });
  await chrome.storage.local.remove("sessions");
  sessionCache = store;
}

// Who is saving: a stable id for this profile, its label, and its folder.
async function profileInfo() {
  let { profileId, profileLabel } = await chrome.storage.local.get({ profileId: null, profileLabel: "" });
  if (!profileId) {
    profileId = crypto.randomUUID();
    await chrome.storage.local.set({ profileId });
  }
  const ping = await native({ type: "ping" });
  const browser = (navigator.userAgent.match(/Chrome\/[\d.]+/) || [null])[0];
  return { id: profileId, label: profileLabel || null, userDataDir: ping.ok ? ping.userDataDir || "(default)" : null, browser };
}

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(() => r(null), ms))]);

// Scroll position, form text and sessionStorage of the pages we are allowed to
// look at. A frozen page answers only when it wakes, so each gets a short wait.
async function capturePages(tabs) {
  const pages = {};
  const zooms = {};
  await Promise.all(
    tabs.filter((t) => !t.discarded && /^https?:/.test(t.url || "")).map(async (t) => {
      try {
        zooms[t.id] = await withTimeout(chrome.tabs.getZoom(t.id), 1000);
      } catch {
        // No zoom for this tab.
      }
      try {
        const r = await withTimeout(chrome.scripting.executeScript({ target: { tabId: t.id }, func: capturePage }), 1500);
        if (r && r[0] && r[0].result) pages[t.id] = r[0].result;
      } catch {
        // No permission for this site, or the page does not allow scripts.
      }
    }),
  );
  return { pages, zooms };
}

async function sessionSave({ name, scope, windowId, closeAfter, withPages }) {
  const clean = cleanName(name);
  if (!clean) return { ok: false, error: "Give the session a name." };
  let tabs = await allTabs();
  if (scope === "window") tabs = tabs.filter((t) => t.windowId === windowId);
  const groups = chrome.tabGroups ? await chrome.tabGroups.query({}) : [];
  const { pages, zooms } = withPages === false ? { pages: {}, zooms: {} } : await capturePages(tabs);
  const settings = await chrome.storage.local.get(SETTINGS_KEYS);
  settings.proxy = await proxyGet().catch(() => null);
  const { session, skipped } = snapshot(clean, tabs, groups, Date.now(), {
    windows: await chrome.windows.getAll(),
    pages,
    zooms,
    profile: await profileInfo(),
    settings,
    ui: settings.ui || null,
  });
  if (!session.windows.length) return { ok: false, error: "Nothing here can be reopened later." };
  await saveSessions(withSession(await sessionStore(), session));
  if (closeAfter) {
    const ids = [...new Set(tabs.map((t) => t.windowId))];
    const all = await chrome.windows.getAll();
    // Closing the last window would quit the browser: leave an empty one.
    if (all.every((w) => ids.includes(w.id))) await chrome.windows.create({});
    for (const id of ids) await chrome.windows.remove(id).catch(() => {});
  }
  return { ok: true, name: clean, windows: session.windows.length, ...session.notes };
}

// Put a freshly created background tab to sleep before it loads.
async function sleepSoon(tabId) {
  for (const waitMs of [400, 1500, 4000]) {
    await new Promise((r) => setTimeout(r, waitMs));
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.active || t.discarded) return;
      await chrome.tabs.discard(tabId);
      return;
    } catch {
      // Not ready to sleep yet, or already closed; try again or give up.
    }
  }
}

// Scroll position, form text and zoom waiting for a restored tab to load.
// A sleeping tab gets a new id when it wakes, so the address is checked too.
async function applyPending(tabId) {
  const { pendingPages } = await chrome.storage.session.get({ pendingPages: {} });
  let tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  const key = Object.keys(pendingPages).find((k) => Number(k) === tabId || pendingPages[k].url === (tab.pendingUrl || tab.url));
  if (!key) return;
  const pending = pendingPages[key];
  for (let i = 0; i < 60 && tab && (tab.status !== "complete" || tab.discarded); i++) {
    await new Promise((r) => setTimeout(r, 250));
    tab = await chrome.tabs.get(tabId).catch(() => null);
  }
  if (!tab) return;
  delete pendingPages[key];
  await chrome.storage.session.set({ pendingPages });
  if (pending.zoom) await chrome.tabs.setZoom(tabId, pending.zoom).catch(() => {});
  if (pending.page) {
    await chrome.scripting.executeScript({ target: { tabId }, func: restorePage, args: [pending.page] }).catch(() => {});
  }
}

// Fires only when the user switches tabs, which is when a restored tab wakes.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  applyPending(tabId);
});

async function sessionRestore({ name, withSettings }) {
  const s = (await sessionStore())[name];
  if (!isValidSession(s)) return { ok: false, error: "That session is missing or damaged." };
  const { pendingPages } = await chrome.storage.session.get({ pendingPages: {} });
  let opened = 0;
  let focusLast = null;
  for (const w of s.windows) {
    const showing = Math.max(0, w.tabs.findIndex((t) => t.active));
    const win = await chrome.windows.create({ url: w.tabs[showing].url, focused: true, ...placement(w) });
    if (w.state && w.state !== "normal") await chrome.windows.update(win.id, { state: w.state }).catch(() => {});
    if (w.focused) focusLast = win.id;
    const ids = new Array(w.tabs.length);
    ids[showing] = win.tabs[0].id;
    for (let i = 0; i < w.tabs.length; i++) {
      if (i === showing) continue;
      const t = await chrome.tabs.create({ windowId: win.id, url: w.tabs[i].url, active: false, index: i });
      ids[i] = t.id;
      sleepSoon(t.id);
    }
    for (let i = 0; i < w.tabs.length; i++) {
      const t = w.tabs[i];
      if (t.pinned) await chrome.tabs.update(ids[i], { pinned: true }).catch(() => {});
      if (t.muted) await chrome.tabs.update(ids[i], { muted: true }).catch(() => {});
      if (t.page || t.zoom) pendingPages[ids[i]] = { url: t.url, page: t.page || null, zoom: t.zoom || null };
    }
    if (chrome.tabGroups) {
      for (let g = 0; g < w.groups.length; g++) {
        const tabIds = ids.filter((_, i) => w.tabs[i].group === g);
        if (!tabIds.length) continue;
        try {
          const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId: win.id } });
          await chrome.tabGroups.update(groupId, w.groups[g]);
        } catch {
          // Groups are a nicety; the tabs are open either way.
        }
      }
    }
    await chrome.storage.session.set({ pendingPages });
    applyPending(ids[showing]);
    opened += w.tabs.length;
  }
  if (focusLast !== null) await chrome.windows.update(focusLast, { focused: true }).catch(() => {});
  let settingsRestored = false;
  if (withSettings && s.settings) {
    const { proxy, ...stored } = s.settings;
    await chrome.storage.local.set(stored);
    if (proxy && proxy.ok && proxy.mode !== "other") await proxySet(proxy).catch(() => {});
    settingsRestored = true;
  }
  return { ok: true, tabs: opened, windows: s.windows.length, settingsRestored, from: s.profile || null };
}

async function sessionDelete({ name }) {
  await saveSessions(withoutSession(await sessionStore(), name));
  return { ok: true };
}

async function sessionImport({ session }) {
  if (!isValidSession(session)) return { ok: false, error: "That file is not a Gamblium session." };
  const clean = { ...session, name: cleanName(session.name) };
  await saveSessions(withSession(await sessionStore(), clean));
  return { ok: true, name: clean.name };
}

// ---- Native host --------------------------------------------------------------
// The Rust helper (gamblium.exe native-host) does what an extension cannot:
// per-process numbers, and the security tools with their scope rule.

const NATIVE_HOST = "com.gamblium.host";
const NATIVE_TYPES = new Set([
  "ping", "stats", "freeze", "thaw", "trim", "lift-extension", "brand-get", "brand-set", "restart", "dl-start", "dl-list", "dl-cancel", "dl-resume", "dl-forget", "dl-action", "open-folder", "open-tor", "update-check", "update-status", "update-restart", "capture-window", "capture-piece", "seal", "open", "named-sessions", "permit-check", "permit-get", "permit-set", "scope-list", "scope-add", "scope-check", "audit", "scan", "cve",
]);

async function native(request) {
  if (!request || !NATIVE_TYPES.has(request.type)) return { ok: false, error: "unknown helper request" };
  try {
    return await chrome.runtime.sendNativeMessage(NATIVE_HOST, request);
  } catch (e) {
    return {
      ok: false,
      helperMissing: true,
      error: "The Gamblium helper is not reachable. Run: gamblium install-host (" + String(e && e.message ? e.message : e) + ")",
    };
  }
}

// ---- Colour scheme of our own pages ----------------------------------------------
// Our pages cannot read browser prefs, so they cannot see which theme the
// launcher applied. The helper can: once per browser start we ask it, and when
// the theme is a different one from last time, our pages switch to its scheme.
// A scheme the user picks in Settings afterwards stands until the theme changes.

async function syncLaunchScheme() {
  const { launchChecked } = await chrome.storage.session.get({ launchChecked: false });
  if (launchChecked) return;
  const ping = await native({ type: "ping" });
  // No answer (a busy start): asked again at the next check, every 30 s,
  // until the helper answers. Giving up once left a whole session unfrozen.
  if (ping && ping.ok !== false) await chrome.storage.session.set({ launchChecked: true });
  // Did the launcher set this browser up for freezing by the extension?
  await chrome.storage.local.set({ launchFreeze: ping.ok === false ? null : ping.freeze === true });
  // A pen-test profile (gamblium launch --pentest): the right-click menu puts Inspect first (content/menu.js reads it).
  if (ping.ok !== false) await chrome.storage.local.set({ pentestProfile: ping.pentest === true });
  // The toolbar button is the menu (the four pips; Brave's own menu button is hidden in the copy),
  // drawn in the ink that reads on this theme's toolbar.
  if (ping.ok !== false) {
    const ink = menuInkOfTheme(ping.theme);
    chrome.action.setIcon({ path: { 16: `ui/icons/menu-${ink}-16.png`, 32: `ui/icons/menu-${ink}-32.png` } }).catch(() => {});
  }
  const scheme = ping.ok === false ? null : schemeOfTheme(ping.theme);
  if (!scheme) return;
  const { launchTheme } = await chrome.storage.local.get({ launchTheme: null });
  if (launchTheme !== ping.theme) await chrome.storage.local.set({ launchTheme: ping.theme, scheme });
}
syncLaunchScheme();
native({ type: "lift-extension" });

// ---- First run ---------------------------------------------------------------------
// A profile that has not been through the welcome page gets it once, in a tab.
// The page sets chrome.storage.local "onboarded" when the user finishes or skips.
async function welcomeOnce() {
  if (IS_AGENT_BUILD) return;
  const { onboarded, welcomeShown } = await chrome.storage.local.get({ onboarded: false, welcomeShown: false });
  if (onboarded || welcomeShown) return;
  // A test window, an agent's or a pen-test profile (the launcher says so):
  // no welcome page in front. Nothing is marked, so a normal start later
  // still shows it.
  const ping = await native({ type: "ping" });
  if (ping && ping.welcome === false) return;
  const url = chrome.runtime.getURL("ui/welcome.html");
  // The page ships with the design session's work; without it there is nothing to show.
  if (!(await fetch(url).then((r) => r.ok, () => false))) return;
  await chrome.storage.local.set({ welcomeShown: true });
  // Opened inside the new tab page, so the address bar stays clean.
  chrome.tabs.create({ url: "chrome://newtab/#/welcome" });
}
chrome.runtime.onInstalled.addListener(welcomeOnce);
chrome.runtime.onStartup.addListener(welcomeOnce);

// The browser opens its first tab before it knows this extension supplies the
// new tab page, so that tab shows Brave's own page (owner, Nov 13 2026: "this
// is the tab I see; where is our new tab?"). Once we are up, a new-tab tab
// that is not one of our pages is loaded again and becomes ours. A tab showing
// our page is one of this extension's contexts; private windows keep Brave's
// page (an extension cannot replace it there).
async function ownTheFirstNewTab() {
  for (let round = 0; round < 3; round++) {
    const tabs = (await allTabs()).filter((t) => !t.incognito && !t.discarded && /^chrome:\/\/newtab\/?(#.*)?$/.test(t.pendingUrl || t.url || ""));
    if (!tabs.length) return;
    const ours = new Set((await chrome.runtime.getContexts({ contextTypes: ["TAB"] })).map((c) => c.tabId));
    const theirs = tabs.filter((t) => !ours.has(t.id) && t.status === "complete");
    for (const t of theirs) await chrome.tabs.reload(t.id).catch(() => {});
    if (tabs.every((t) => ours.has(t.id))) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
chrome.runtime.onInstalled.addListener(ownTheFirstNewTab);
chrome.runtime.onStartup.addListener(ownTheFirstNewTab);

// The user's own colours (Settings > Appearance) are told to the helper, so
// the launcher can dress the browser's frame in them at the next start and
// tell websites whether the browser is light or dark.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.colours) native({ type: "brand-set", colours: changes.colours.newValue ?? null });
});

// ---- Per-tab memory and CPU -----------------------------------------------------
// The helper reads every browser process; frames tell us which process a tab
// lives in. CPU needs two readings, so the first answer has memory only.

let previousReading = null;

async function tabStats() {
  const reading = await native({ type: "stats" });
  if (!reading.ok) return reading;
  const tabs = await allTabs();
  const framesByTab = {};
  await Promise.all(
    tabs.filter((t) => !t.discarded).map(async (t) => {
      try {
        const frames = await chrome.webNavigation.getAllFrames({ tabId: t.id });
        framesByTab[t.id] = (frames || []).map((f) => f.processId);
      } catch {
        // The tab closed while we were asking.
      }
    }),
  );
  const result = attribute(tabs, framesByTab, reading, previousReading);
  previousReading = { at_ms: reading.at_ms, processes: reading.processes.map((p) => ({ pid: p.pid, cpu_ms: p.cpu_ms })) };
  const tabGroups = chrome.tabGroups ? await chrome.tabGroups.query({}).catch(() => []) : [];
  const { groupLimits = {} } = await chrome.storage.local.get({ groupLimits: {} });
  const groups = groupTotals(result.tabs, tabGroups).map((g) => ({ ...g, limit: (g.title && groupLimits[g.title]) || null }));
  return { ok: true, ...result, groups, systemAvailableMb: reading.system_available_mb };
}

// Limits per tab group (by name), checked with the minute alarm while any limit is set: a group
// over its memory has its hidden tabs put to sleep, over its processor has them frozen.
async function enforceGroupLimits() {
  const { groupLimits = {} } = await chrome.storage.local.get({ groupLimits: {} });
  if (!Object.keys(groupLimits).length || !chrome.tabGroups) return;
  const stats = await tabStats();
  if (!stats.ok) return;
  const tabGroups = await chrome.tabGroups.query({}).catch(() => []);
  const plan = groupLimitPlan(stats.tabs, tabGroups, groupLimits, new Set(await awakeTabs()));
  for (const id of plan.sleep) await chrome.tabs.discard(id).catch(() => null);
  for (const id of plan.freeze) await setLifecycle(id, "frozen");
  if (plan.sleep.length || plan.freeze.length) await chrome.storage.local.set({ groupLimitLog: { at: new Date().toISOString(), ...plan } });
}

// ---- Proxy ----------------------------------------------------------------------
// One setting for the whole profile (that is all Chromium offers an extension).
// A "pen-test window" is therefore a pen-test profile.

async function proxyGet() {
  const got = await chrome.proxy.settings.get({ incognito: false });
  return { ok: true, ...proxySummary(got.value), controlledBy: got.levelOfControl };
}

async function proxySet(input) {
  const r = proxyConfig(input);
  if (!r.ok) return r;
  if (r.config.mode === "system") await chrome.proxy.settings.clear({ scope: "regular" });
  else await chrome.proxy.settings.set({ value: r.config, scope: "regular" });
  return proxyGet();
}

// ---- Agent bridge ---------------------------------------------------------------
// When switched on, a long-lived connection to the helper lets `gamblium ctl`
// send commands to this browser. It is on by default only in the agent
// profile (whose copy of the extension may look at every page); on any other
// profile the user switches it on.

const IS_AGENT_BUILD = (chrome.runtime.getManifest().host_permissions || []).includes("<all_urls>");
const ctl = makeCtl({
  native: (request) => native(request),
  // No helper, no answer: not allowed.
  permit: async (command) => {
    const r = await native({ type: "permit-check", what: "settings", command });
    return r && r.ok ? r : { allowed: false, asked: false };
  },
  profileInfo: () => profileInfo(),
  frozenTabs: () => frozenByUs(),
  touch: (tabId, group, op) => agentTouch(tabId, group, op),
  idMaps: () => tabIdMaps(),
  adoptIds: async (pairs) => {
    idChain(async () => {
      const maps = (await chrome.storage.session.get({ tabIdMaps: emptyIdMaps() })).tabIdMaps;
      await chrome.storage.session.set({ tabIdMaps: adoptIds(maps, pairs) });
    });
    await idWrite;
  },
  lastUrl: (id) => tabLastUrl(id),
  rest: (tabId) => agentRest(tabId),
  lean: (on) => agentLean(on),
  fullReload: (tab) => agentFullReload(tab),
  park: (tabId) => parkTab(tabId),
  forgetCheck: (url) => forgetCloudflareCheck(url),
  noWindow: NO_WINDOW,
  tabStats: () => tabStats(),
  downloadsList: (limit) => downloadsList(limit),
  downloadsAction: (id, action) => downloadsAction(id, action),
  defaultDownloadRules: DOWNLOAD_DEFAULTS.rules,
  capture: {
    start: () => captureStart(),
    stop: () => captureStop(),
    status: () => captureStatus(),
    list: (filter, limit) => captureList(filter, limit),
    get: (id) => captureGet(id),
    clear: () => captureClear(),
  },
  settingsGet: async () => ({
    ...DEFAULTS,
    lightSites: [],
    routingEnabled: DOWNLOAD_DEFAULTS.routingEnabled,
    profileLabel: "",
    ...(await chrome.storage.local.get(["enabled", "delaySec", "lowMemoryDelaySec", "lowMemoryMb", "allowlist", "lightSites", "routingEnabled", "profileLabel"])),
  }),
  proxyGet: () => proxyGet(),
  proxySet: (input) => proxySet(input),
  sessionList: () => sessionStore().then(summaries),
  sessionSave: (m) => sessionSave(m),
  sessionRestore: (m) => sessionRestore(m),
  sessionDelete: (m) => sessionDelete(m),
  sessionExport: (name) => sessionStore().then((st) => st[name] || null),
  sessionImport: (m) => sessionImport(m),
});
let bridgePort = null;
let bridgeInfo = { connected: false, port: null, error: null };

async function bridgeWanted() {
  const { agentBridge } = await chrome.storage.local.get({ agentBridge: null });
  return agentBridge === null ? IS_AGENT_BUILD : agentBridge === true;
}

async function bridgeEnsure() {
  const wanted = await bridgeWanted();
  if (!wanted) {
    if (bridgePort) bridgePort.disconnect();
    bridgePort = null;
    bridgeInfo = { connected: false, port: null, error: null };
    return;
  }
  if (bridgePort) return;
  try {
    bridgePort = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    bridgeInfo = { connected: false, port: null, error: String(e && e.message ? e.message : e) };
    return;
  }
  bridgePort.onMessage.addListener(async (msg) => {
    if (msg.type === "bridge-started") {
      bridgeInfo = { connected: !!msg.ok, port: msg.port || null, error: msg.ok ? null : msg.error };
      return;
    }
    if (msg.type !== "ctl") return;
    let result;
    try {
      result = await ctl(msg.cmd || {});
    } catch (e) {
      result = { ok: false, error: String(e && e.message ? e.message : e) };
    }
    if (bridgePort) bridgePort.postMessage({ type: "ctl-reply", id: msg.id, result });
  });
  bridgePort.onDisconnect.addListener(() => {
    bridgePort = null;
    bridgeInfo = { connected: false, port: null, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : null };
  });
  bridgePort.postMessage({ type: "bridge-start" });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.agentBridge) bridgeEnsure();
});
bridgeEnsure();

// ---- Right-click menu -----------------------------------------------------------
// Chromium groups an extension's entries under one "Gamblium" submenu.

const MENU = [
  { id: "security", title: "Security dashboard for this site", panel: "" },
  { id: "audit", title: "Audit this page", panel: "audit" },
  { id: "capture", title: "Capture this tab's requests", panel: "capture" },
];

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    const contexts = ["page", "frame", "link", "image", "selection"];
    chrome.contextMenus.create({ id: "awake-tab", type: "checkbox", title: "Keep this tab awake", contexts });
    chrome.contextMenus.create({ id: "awake-site", type: "checkbox", title: "Always keep this site awake", contexts });
    chrome.contextMenus.create({ id: "awake-sep", type: "separator", contexts });
    for (const m of MENU) chrome.contextMenus.create({ id: m.id, title: m.title, contexts });
    // Shown only on magnet links and links to .torrent files.
    chrome.contextMenus.create({ id: "torrent", title: "Download this torrent with Gamblium", contexts: ["link"], targetUrlPatterns: ["magnet:*", "*://*/*.torrent", "*://*/*.torrent?*"] });
  });
}

// The two ticks follow the tab in front.
async function syncAwakeMenu(tabId) {
  const a = await awakeGet(tabId);
  if (!a.ok) return;
  chrome.contextMenus.update("awake-tab", { checked: a.tab }, () => void chrome.runtime.lastError);
  chrome.contextMenus.update("awake-site", { checked: a.site, enabled: !!a.host, title: a.host ? `Always keep ${a.host} awake` : "Always keep this site awake" }, () => void chrome.runtime.lastError);
}
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  syncAwakeMenu(tabId);
  // The browser usually wakes a frozen tab when it is shown, but not always
  // (seen once in tools/freeze-check.mjs). Do not leave that to chance.
  const frozen = await frozenByUs();
  if (frozen[tabId]) thaw(tabId);
  // The other half of a split view comes on screen with it.
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (t && t.splitViewId > 0) for (const p of await chrome.tabs.query({ windowId: t.windowId })) if (p.id !== tabId && p.splitViewId === t.splitViewId && (frozen[p.id] || p.frozen)) thaw(p.id);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab && info.menuItemId === "awake-tab") return void awakeSet({ tabId: tab.id, tab: !!info.checked });
  if (tab && info.menuItemId === "awake-site") return void awakeSet({ tabId: tab.id, site: !!info.checked });
  if (info.menuItemId === "torrent") {
    // Private windows never hand anything to our downloader (it keeps a list on disk).
    if (!isTorrent(info.linkUrl) || (tab && tab.incognito)) return;
    return void startTorrent(info.linkUrl).then(() => chrome.tabs.create({ url: "chrome://newtab/#/downloads" }));
  }
  const m = MENU.find((x) => x.id === info.menuItemId);
  if (!m) return;
  const target = info.linkUrl && m.id !== "capture" ? info.linkUrl : info.pageUrl || (tab && tab.url) || "";
  const q = new URLSearchParams({ url: target, tab: String(tab ? tab.id : ""), panel: m.panel });
  chrome.tabs.create({ url: "chrome://newtab/#/security?" + q.toString(), index: tab ? tab.index + 1 : undefined });
});

// ---- Our own right-click menu in web pages (content/menu.js) ----------------------
// The script is put into pages only while the setting is on, so switched off it costs
// nothing. Pages opened before a change keep what they had until they are reloaded.

const OWN_MENU = { id: "own-menu", js: ["content/menu.js"], matches: ["*://*/*"], allFrames: false, runAt: "document_start", persistAcrossSessions: true };
async function syncOwnMenu() {
  const { ownRightClick } = await chrome.storage.local.get({ ownRightClick: true });
  const have = (await chrome.scripting.getRegisteredContentScripts({ ids: [OWN_MENU.id] }).catch(() => [])).length > 0;
  if (ownRightClick && !have) await chrome.scripting.registerContentScripts([OWN_MENU]).catch(() => {});
  if (!ownRightClick && have) await chrome.scripting.unregisterContentScripts({ ids: [OWN_MENU.id] }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(syncOwnMenu);
chrome.runtime.onStartup.addListener(syncOwnMenu);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.ownRightClick) syncOwnMenu();
});

// Focus: a tab alone in a bare window (no tab strip, no toolbar), and back to where it was.
// Where it came from is kept for the session, so "Leave focus" can put it back.
async function focusPlace(tabId) {
  const key = "focus:" + tabId;
  return (await chrome.storage.session.get({ [key]: null }))[key];
}
async function focusToggle(tab) {
  const key = "focus:" + tab.id;
  const from = await focusPlace(tab.id);
  const win = await chrome.windows.get(tab.windowId);
  if (from && win.type === "popup") {
    await chrome.storage.session.remove(key);
    // A tab leaves a bare window only by getting a window of its own; from there it can go home.
    const own = await chrome.windows.create({ tabId: tab.id, type: "normal", state: win.state === "normal" ? undefined : win.state, focused: true });
    const home = await chrome.windows.get(from.windowId).catch(() => null);
    if (home && home.type === "normal") {
      await chrome.tabs.move(tab.id, { windowId: from.windowId, index: from.index });
      await chrome.tabs.update(tab.id, { active: true, pinned: !!from.pinned });
      await chrome.windows.update(from.windowId, { focused: true });
      if (own?.id !== undefined) await chrome.windows.remove(own.id).catch(() => {}); // gone by itself once it is empty
    }
    return { ok: true, focused: false };
  }
  await chrome.storage.session.set({ [key]: { windowId: tab.windowId, index: tab.index, pinned: !!tab.pinned } });
  const big = win.state === "maximized" || win.state === "fullscreen";
  await chrome.windows.create({ tabId: tab.id, type: "popup", focused: true, ...(big ? { state: "maximized" } : { left: win.left, top: win.top, width: win.width, height: win.height }) });
  // The house is quiet: the tabs left behind are frozen now, not after the usual delay.
  quietWindow(tab.windowId).catch(() => {});
  return { ok: true, focused: true };
}

// Freezes the hidden tabs of one window at once, with every usual exception (sound,
// kept awake, uploads, the tab in front). The other windows keep their own timing.
// They thaw by themselves when shown again.
async function quietWindow(windowId) {
  const s = await settings();
  const tabs = await allTabs();
  for (const t of tabs) if (t.windowId === windowId) t.lastAccessed = 0; // as if hidden long ago
  const ctx = { awakeTabs: await awakeTabs(), busyTabs: [...new Set([...busyTabs(), ...(await pageDownloadTabs(tabs))])], domReady: Object.fromEntries(domReady) };
  return freezeCheck(tabs, s, Date.now(), ctx);
}

// The keyboard way in and out of focus: the tab in front of the window in front.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "focus-tab") return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && isHttp(tab.url)) await focusToggle(tab).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => void chrome.storage.session.remove("focus:" + tabId));

// What the menu cannot know from inside the page.
async function menuOpen(sender, msg) {
  const tab = sender.tab;
  if (!tab) return { ok: false };
  // The named sessions, asked of the helper only when a link was clicked, and not waited for long.
  const listed = msg?.link ? await Promise.race([native({ type: "named-sessions", args: ["list"] }).catch(() => null), new Promise((r) => setTimeout(() => r(null), 700))]) : null;
  const sessions = Array.isArray(listed?.sessions) ? listed.sessions.map((s) => ({ name: String(s.name), state: String(s.state || "") })) : [];
  const a = await awakeGet(tab.id).catch(() => ({}));
  const focused = !!(await focusPlace(tab.id)) && (await chrome.windows.get(tab.windowId).catch(() => ({}))).type === "popup";
  const marks = isHttp(tab.url) ? await chrome.bookmarks.search({ url: tab.url }).catch(() => []) : [];
  // This window's spaces, for "Move to space" (not in agent builds).
  const sp = IS_AGENT_BUILD ? null : await spacesList(tab.windowId).catch(() => null);
  const spaces = sp?.ok ? sp.spaces.map((s) => ({ id: s.id, title: s.title || "Untitled space", here: s.id === tab.groupId })) : [];
  // A pen-test profile (the helper says so at start, #143): Inspect moves up in the menu. Missing means no.
  const { pentestProfile } = await chrome.storage.local.get({ pentestProfile: false }).catch(() => ({}));
  return {
    ok: true, focused, pinned: !!tab.pinned, muted: !!tab.mutedInfo?.muted, awakeTab: !!a.tab, awakeSite: !!a.site, host: a.host || "",
    bookmarked: marks.length > 0, tools: MENU.map((m) => ({ id: m.id, title: m.title })), sessions, spaces, inSpace: tab.groupId !== -1,
    groupAwake: tab.groupId !== -1 && await groupAwake(tab.groupId),
    pentest: pentestProfile === true,
  };
}

const isHttp = (u) => /^https?:\/\//i.test(String(u || ""));
const isOurs = (sender) => (sender.origin ? sender.origin === OUR_ORIGIN : String(sender.url || "").startsWith(OUR_ORIGIN + "/"));
const isOwnPage = (u) => String(u || "").startsWith(OUR_ORIGIN + "/") || /^chrome:\/\/newtab\//.test(String(u || ""));
// What the menu asks for. Every request acts on the tab it came from, and addresses a page
// hands over are opened only when they are plain web addresses.
async function menuDo(msg, sender) {
  const tab = sender.tab;
  if (!tab) return { ok: false };
  const next = { index: tab.index + 1, openerTabId: tab.id, windowId: tab.windowId };
  switch (msg.what) {
    case "open":
      // Our own pages may also open their own addresses (a link to Settings), in a tab only.
      if (msg.where === "tab" && isOurs(sender) && isOwnPage(msg.url)) {
        await chrome.tabs.create({ url: msg.url, active: false, ...next });
        return { ok: true };
      }
      if (!isHttp(msg.url)) return { ok: false, error: "not a web address" };
      if (msg.where === "window") await chrome.windows.create({ url: msg.url });
      else if (msg.where === "private") await chrome.windows.create({ url: msg.url, incognito: true });
      else if (msg.where === "tor") {
        // Only the browser itself opens Tor windows; the helper hands it the address.
        const r = await native({ type: "open-tor", url: msg.url });
        return r && r.ok === false ? r : { ok: true };
      }
      else await chrome.tabs.create({ url: msg.url, active: false, ...next });
      return { ok: true };
    case "save":
      if (!isHttp(msg.url)) return { ok: false, error: "not a web address" };
      await chrome.downloads.download({ url: msg.url, saveAs: !!msg.ask });
      return { ok: true };
    case "source":
      if (!isHttp(msg.url)) return { ok: false };
      await chrome.tabs.create({ url: "view-source:" + msg.url, ...next });
      return { ok: true };
    case "tor-window": {
      // An empty Tor window: only the browser opens those; the helper asks it.
      const r = await native({ type: "open-tor" });
      return r && r.ok === false ? r : { ok: true };
    }
    case "screenshot-start": {
      // Our part of Screenshot (design): the area picker and the result card go into the page now, not
      // before. The capture itself answers "screenshot" (engine, backend). Our own pages load it themselves.
      if (isOwnPage(tab.url)) {
        await chrome.tabs.sendMessage(tab.id, { type: "gamblium-shot-start" }).catch(() => null);
        return { ok: true };
      }
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/shot.js"] });
      return { ok: true };
    }
    case "search":
      await chrome.search.query({ text: String(msg.text || "").slice(0, 500), disposition: "NEW_TAB" });
      return { ok: true };
    case "translate": {
      // The selection only, to Google Translate, in a new tab: the entry says "with Google".
      const text = String(msg.text || "").slice(0, 2000);
      if (!text.trim()) return { ok: false };
      await chrome.tabs.create({ url: "https://translate.google.com/?sl=auto&op=translate&text=" + encodeURIComponent(text), ...next });
      return { ok: true };
    }
    // Right-click > Screenshot: the visible part, the whole page, or an area that may run
    // below the window (shot.js). The page gets the picture back for its card; Save puts it
    // in Downloads. Only for the tab the request came from.
    case "screenshot":
      return screenshot(tab, { mode: msg.mode, rect: msg.rect, scroller: msg.scroller || null }, native);
    case "screenshot-save":
      if (!/^data:image\/png;base64,/.test(String(msg.dataUrl || ""))) return { ok: false };
      return saveShot(msg.dataUrl, tab.url);
    case "torrent":
      if (!isTorrent(msg.url)) return { ok: false };
      if (sender && sender.tab && sender.tab.incognito) return { ok: false, error: "private window" };
      await startTorrent(msg.url);
      await chrome.tabs.create({ url: "chrome://newtab/#/downloads" });
      return { ok: true };
    case "bookmark": {
      if (!isHttp(tab.url)) return { ok: false };
      const have = await chrome.bookmarks.search({ url: tab.url });
      if (have.length) for (const b of have) await chrome.bookmarks.remove(b.id);
      else await chrome.bookmarks.create({ title: tab.title || tab.url, url: tab.url });
      return { ok: true, bookmarked: !have.length };
    }
    case "image-data": {
      // The picture as a data address, for the page to put on the clipboard (20 MB at most).
      if (!isHttp(msg.url)) return { ok: false };
      const r = await fetch(msg.url);
      const blob = await r.blob();
      if (!r.ok || blob.size > 20 * 1024 * 1024 || !/^image\//.test(blob.type)) return { ok: false };
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { ok: true, data: `data:${blob.type};base64,${btoa(bin)}` };
    }
    case "open-session":
      // The helper checks the name and the address again; only web addresses go.
      if (!isHttp(msg.url)) return { ok: false, error: "not a web address" };
      return native({ type: "named-sessions", args: ["open-url", String(msg.name || "").slice(0, 64), msg.url] });
    case "focus": return focusToggle(tab);
    case "space-move": return spaceMoveTab(tab, msg.groupId ?? null);
    case "space-leave": return IS_AGENT_BUILD ? { ok: false } : chrome.tabs.ungroup(tab.id).then(() => ({ ok: true }));
    case "tab-duplicate": await chrome.tabs.duplicate(tab.id); return { ok: true };
    case "sleep-others": return { ok: true, slept: await sleepNow("all", tab.windowId) }; // every hidden tab; the one showing stays
    // A whole tab group: asleep at once (the tabs on screen stay), or kept awake as one.
    case "group-sleep": {
      if (tab.groupId === -1) return { ok: false, error: "this tab is in no group" };
      let slept = 0;
      for (const t of await allTabs()) {
        if (t.groupId !== tab.groupId || t.active || t.discarded || t.audible) continue;
        if (await chrome.tabs.discard(t.id).catch(() => null)) slept++;
      }
      return { ok: true, slept };
    }
    case "group-awake": {
      if (tab.groupId === -1) return { ok: false, error: "this tab is in no group" };
      const ids = (await chrome.tabs.query({ groupId: tab.groupId })).map((t) => t.id);
      const list = (await awakeTabs()).filter((id) => !ids.includes(id));
      await chrome.storage.session.set({ awakeTabs: msg.on === false ? list : [...list, ...ids] });
      return { ok: true, tabs: ids.length };
    }
    case "tab-pin": await chrome.tabs.update(tab.id, { pinned: !tab.pinned }); return { ok: true };
    case "tab-mute": await chrome.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted }); return { ok: true };
    case "awake": return awakeSet({ tabId: tab.id, ...(typeof msg.tab === "boolean" ? { tab: msg.tab } : {}), ...(typeof msg.site === "boolean" ? { site: msg.site } : {}) });
    case "open-dashboard": await chrome.tabs.create({ url: "chrome://newtab/#/dashboard", ...next }); return { ok: true };
    case "open-settings": await chrome.tabs.create({ url: "chrome://newtab/#/settings", ...next }); return { ok: true };
    case "tool": {
      const m = MENU.find((x) => x.id === msg.id);
      if (!m) return { ok: false };
      const target = isHttp(msg.link) && m.id !== "capture" ? msg.link : tab.url || "";
      const q = new URLSearchParams({ url: target, tab: String(tab.id), panel: m.panel });
      await chrome.tabs.create({ url: "chrome://newtab/#/security?" + q.toString(), ...next });
      return { ok: true };
    }
    default: return { ok: false, error: "unknown" };
  }
}

// ---- Messages from our own pages --------------------------------------------

// A script of ours inside a web page may ask for the menu's own two things and nothing
// else: everything below is for our own pages only.
const OUR_ORIGIN = new URL(chrome.runtime.getURL("")).origin;
const FROM_A_PAGE = new Set(["menu-open", "menu-do"]);

// ---- Closed tab groups (owner, Nov 14 2026) ------------------------------------------
// The browser's own "recently closed" list has tabs and windows, not groups. So the extension
// keeps a picture of every group (name, colour, its tabs in order) and, when a group goes away
// because its tabs were closed (not ungrouped, not its whole window), keeps it in
// storage.local.closedGroups (newest first, at most 10). New Tab's Recently closed lists them;
// a click reopens the group as it was.
const groupShape = new Map(); // groupId -> { title, color, windowId, tabs: [{ url, title, pinned }] }
async function noteGroup(groupId) {
  if (typeof groupId !== "number" || groupId < 0 || !chrome.tabGroups) return;
  const g = await chrome.tabGroups.get(groupId).catch(() => null);
  if (!g) return;
  const tabs = (await chrome.tabs.query({ groupId }).catch(() => [])).sort((a, b) => a.index - b.index);
  groupShape.set(groupId, { title: g.title || "", color: g.color, windowId: g.windowId, ids: tabs.map((t) => t.id), tabs: tabs.filter((t) => /^https?:/.test(t.url || t.pendingUrl || "")).map((t) => ({ url: t.url || t.pendingUrl, title: t.title || "", pinned: !!t.pinned })) });
}
async function noteAllGroups() {
  if (!chrome.tabGroups) return;
  for (const g of await chrome.tabGroups.query({}).catch(() => [])) await noteGroup(g.id);
}
if (chrome.tabGroups) {
  chrome.tabGroups.onCreated.addListener((g) => noteGroup(g.id));
  chrome.tabGroups.onUpdated.addListener((g) => noteGroup(g.id));
  chrome.tabGroups.onRemoved.addListener(async (g) => {
    const shape = groupShape.get(g.id);
    groupShape.delete(g.id);
    if (!shape || !shape.tabs.length) return;
    // Its window closing takes its groups with it: that is the browser's own "window" entry.
    await new Promise((r) => setTimeout(r, 400));
    if (!(await chrome.windows.get(shape.windowId).catch(() => null))) return;
    // Ungrouped, not closed: its tabs are still open.
    const still = await Promise.all(shape.ids.map((id) => chrome.tabs.get(id).catch(() => null)));
    if (still.some(Boolean)) return;
    const { closedGroups = [] } = await chrome.storage.local.get({ closedGroups: [] });
    const entry = { id: `${Date.now()}-${g.id}`, at: Date.now(), title: shape.title, color: shape.color, tabs: shape.tabs };
    await chrome.storage.local.set({ closedGroups: [entry, ...closedGroups].slice(0, 10) });
  });
}
chrome.tabs.onUpdated.addListener((_id, change, tab) => { if (tab.groupId >= 0 && (change.url || change.title || "groupId" in change || change.pinned !== undefined)) noteGroup(tab.groupId); });
chrome.tabs.onMoved.addListener(async (id) => { const t = await chrome.tabs.get(id).catch(() => null); if (t && t.groupId >= 0) noteGroup(t.groupId); });
noteAllGroups();

/** Reopens a closed group in the given window (or the last focused one), as it was. */
async function reopenGroup(entryId, windowId) {
  const { closedGroups = [] } = await chrome.storage.local.get({ closedGroups: [] });
  const e = closedGroups.find((x) => x.id === entryId);
  if (!e) return { ok: false, error: "that group is no longer in the list" };
  const win = windowId ?? (await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null))?.id;
  const ids = [];
  for (const t of e.tabs) ids.push((await chrome.tabs.create({ url: t.url, active: false, pinned: false, ...(win ? { windowId: win } : {}) })).id);
  const groupId = await chrome.tabs.group({ tabIds: ids, ...(win ? { createProperties: { windowId: win } } : {}) });
  await chrome.tabGroups.update(groupId, { title: e.title, ...(e.color ? { color: e.color } : {}) }).catch(() => {});
  await chrome.tabs.update(ids[0], { active: true }).catch(() => {});
  await chrome.storage.local.set({ closedGroups: closedGroups.filter((x) => x.id !== entryId) });
  return { ok: true, groupId, tabs: ids.length };
}

// ---- Updates (owner, Nov 14 2026) ---------------------------------------------------------
// At start and every 6 hours the helper checks the public repository's releases and downloads a
// newer one in the background. When one is ready, our toolbar button shows a mark and our pages
// can offer "Restart to update" (update-state, update-restart).
async function updateCheck(force = false) {
  const r = await native({ type: "update-check", force });
  if (r && r.ready) {
    chrome.action.setBadgeText({ text: "↑" }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: "#3B82F6" }).catch(() => {});
    chrome.action.setTitle({ title: `Gamblium: version ${r.update?.version} is ready. Restart to update.` }).catch(() => {});
  }
  return r;
}
// Restart to update closes every window one by one, and nothing would reopen them: so the tabs are
// saved first as a session, and the next start (within 15 minutes) reopens it and forgets it again.
const UPDATE_SESSION = "Before the update";
async function updateRestart() {
  const saved = await sessionSave({ name: UPDATE_SESSION, withPages: false }).catch(() => null);
  if (saved && saved.ok !== false) await chrome.storage.local.set({ reopenAfterUpdate: { name: UPDATE_SESSION, at: Date.now() } });
  const r = await native({ type: "update-restart" });
  if (!r || r.ok === false) {
    await chrome.storage.local.remove("reopenAfterUpdate");
    return r;
  }
  // The updater installs once every window is closed, then starts Gamblium again.
  setTimeout(async () => { for (const w of await chrome.windows.getAll()) chrome.windows.remove(w.id).catch(() => {}); }, 400);
  return { ok: true };
}
// Once each time Gamblium starts, no polling (owner, Nov 14 2026): if a newer version is there it
// is downloaded now and installed at the next start (or at once with Restart to update);
// otherwise nothing happens until the next start. Settings can switch this off
// (storage.local.autoUpdate = false); "Check for updates" still works.
chrome.alarms.clear("gamblium-update").catch(() => {}); // the 6-hour check of #212, gone
async function updateOnStart() {
  if (IS_AGENT_BUILD) return;
  const { autoUpdate } = await chrome.storage.local.get({ autoUpdate: true });
  if (autoUpdate !== false) updateCheck(true);
}
chrome.runtime.onStartup.addListener(() => { updateOnStart(); });
// After Restart to update: the browser may reopen only the window closed last (its own "continue where
// you left off"), or none. A few seconds after the worker starts (onStartup did not fire in a test),
// every saved window that is not open again is reopened, the lone new tab window closed, and the
// session forgotten.
setTimeout(() => { reopenAfterUpdate().catch(() => {}); }, 4000);
async function reopenAfterUpdate() {
  const { reopenAfterUpdate: r } = await chrome.storage.local.get({ reopenAfterUpdate: null });
  if (!r) return;
  await chrome.storage.local.remove("reopenAfterUpdate");
  const store = await sessionStore();
  const s = store[r.name];
  if (Date.now() - r.at > 15 * 60_000 || !isValidSession(s)) return sessionDelete({ name: r.name });
  const isNewTab = (t) => /^chrome:\/\/newtab|^chrome-extension:\/\/[a-z]+\/newtab/.test(t.url || t.pendingUrl || "");
  const before = await chrome.windows.getAll({ populate: true });
  const open = new Set(before.flatMap((w) => (w.tabs || []).map((t) => t.url || t.pendingUrl)));
  const missing = s.windows.filter((w) => !w.tabs.every((t) => open.has(t.url)));
  if (missing.length) {
    await saveSessions(withSession(store, { ...s, windows: missing }));
    const done = await sessionRestore({ name: r.name }).catch(() => null);
    // The window the browser opened by itself with only a new tab is not wanted beside the reopened ones.
    if (done && done.ok !== false) for (const w of before) if ((w.tabs || []).every(isNewTab)) chrome.windows.remove(w.id).catch(() => {});
  }
  await sessionDelete({ name: r.name });
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const ours = _sender.origin ? _sender.origin === OUR_ORIGIN : String(_sender.url || "").startsWith(OUR_ORIGIN + "/");
  if (!ours && !FROM_A_PAGE.has(msg?.type)) {
    reply({ ok: false, error: "not allowed from a web page" });
    return false;
  }
  if (msg.type === "menu-open" || msg.type === "menu-do") {
    (msg.type === "menu-open" ? menuOpen(_sender, msg) : menuDo(msg, _sender)).then(reply, (e) => reply({ ok: false, error: String(e?.message ?? e) }));
    return true;
  }
  const run =
    msg.type === "status" ? status()
    : msg.type === "group-limit-set" ? chrome.storage.local.get({ groupLimits: {} }).then(({ groupLimits }) => {
        const title = String(msg.title || "").slice(0, 80);
        if (!title) return { ok: false, error: "a group needs a name to have a limit" };
        const lim = { ...(msg.memoryMb > 0 ? { memoryMb: Math.round(msg.memoryMb) } : {}), ...(msg.cpuPct > 0 ? { cpuPct: Number(msg.cpuPct) } : {}) };
        if (Object.keys(lim).length) groupLimits[title] = lim; else delete groupLimits[title];
        return chrome.storage.local.set({ groupLimits }).then(() => ({ ok: true, groupLimits }));
      })
    : msg.type === "update-state" ? native({ type: "update-status" })
    : msg.type === "update-check" ? updateCheck(true)
    : msg.type === "update-restart" ? updateRestart()
    : msg.type === "closed-groups" ? chrome.storage.local.get({ closedGroups: [] }).then((r) => ({ ok: true, groups: r.closedGroups }))
    : msg.type === "group-reopen" ? reopenGroup(String(msg.id || ""), _sender.tab?.windowId)
    : msg.type === "sleep-now" ? sleepNow(msg.scope, msg.windowId).then((slept) => ({ slept }))
    : msg.type === "downloads-list" ? downloadsList(msg.limit)
    : msg.type === "downloads-action" ? downloadsAction(msg.id, msg.action)
    : msg.type === "downloads-start" ? chrome.downloads.download({ url: msg.url }).then((id) => ({ id }))
    : msg.type === "capture-status" ? captureStatus()
    : msg.type === "capture-start" ? captureStart()
    : msg.type === "capture-stop" ? captureStop()
    : msg.type === "capture-list" ? captureList(msg.filter, msg.limit)
    : msg.type === "capture-get" ? captureGet(msg.id)
    : msg.type === "capture-clear" ? captureClear()
    : msg.type === "native" ? native(msg.request)
    : msg.type === "tab-stats" ? tabStats()
    : msg.type === "awake-get" ? awakeGet(msg.tabId)
    : msg.type === "awake-set" ? awakeSet(msg)
    : msg.type === "bridge-status" ? bridgeWanted().then((wanted) => ({ ok: true, wanted, agentBuild: IS_AGENT_BUILD, ...bridgeInfo }))
    : msg.type === "bridge-set" ? chrome.storage.local.set({ agentBridge: !!msg.on }).then(() => ({ ok: true }))
    : msg.type === "proxy-get" ? proxyGet()
    : msg.type === "proxy-set" ? proxySet(msg.proxy)
    : msg.type === "light-sites-sync" ? syncLightSites()
    : msg.type === "session-list" ? sessionStore().then(summaries)
    : msg.type === "session-save" ? sessionSave(msg)
    : msg.type === "session-restore" ? sessionRestore(msg)
    : msg.type === "session-delete" ? sessionDelete(msg)
    : msg.type === "session-export" ? sessionStore().then((st) => st[msg.name] || null)
    : msg.type === "session-import" ? sessionImport(msg)
    : msg.type === "session-find" ? sessionStore().then((st) => findInSessions(st, msg.query))
    : msg.type === "session-urls" ? sessionStore().then(sessionsByUrl)
    : msg.type === "spaces-list" ? spacesList(msg.windowId)
    : msg.type === "space-switch" ? spaceSwitch(msg.groupId)
    : msg.type === "space-new" ? spaceNew(msg)
    : msg.type === "space-freeze" ? spaceFreeze(msg.groupId)
    : Promise.resolve(null);
  run.then(reply, (e) => reply({ ok: false, error: String(e && e.message ? e.message : e) }));
  return true;
});

// ---- gamblium:// addresses --------------------------------------------------------
// (design session) The browser does not know the gamblium scheme: a tab sent to
// gamblium://gpu just sits on an empty page. This sends it on: our own pages to
// the new tab document, which shows them with a clean address bar
// (newtab/boot.js), the browser's pages to chrome://. The map is routes.js.
import { resolve as resolveRoute } from "./routes.js";

function followRoute(tabId, url) {
  if (!/^gamblium:/i.test(url || "")) return;
  const to = resolveRoute(url);
  if (!to) return;
  chrome.tabs.update(tabId, { url: to.kind === "page" ? "chrome://newtab/#/" + to.route : to.url }).catch(() => {});
}
// Seen in the browser: such a navigation never starts or commits. What does
// arrive is webNavigation.onErrorOccurred (ERR_ABORTED, with the address) and,
// for a new tab, tabs.onCreated with the address still pending.
chrome.webNavigation.onErrorOccurred.addListener((d) => {
  if (d.frameId === 0) followRoute(d.tabId, d.url);
});
chrome.tabs.onCreated.addListener((tab) => followRoute(tab.id, tab.pendingUrl || tab.url));
// One run in three missed both of those (the worker was still starting), so a tab that
// reports any change while it is still waiting on such an address is sent on as well.
chrome.tabs.onUpdated.addListener((tabId, change, tab) => followRoute(tabId, tab.pendingUrl || change.url));

// ---- Spaces (spaces.js) ---------------------------------------------------------------
// A window's tab groups as spaces: one in view, the others folded and frozen. Freezing,
// not sleeping: the pages keep their state and come back at once (backend, Nov 13 2026);
// sleeping stays with the memory rules. Not in agent builds, which have their own rest.

const spacesWindowId = async (windowId) => windowId ?? (await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null))?.id;

async function spacesList(windowId) {
  const w = await spacesWindowId(windowId);
  if (w === undefined || !chrome.tabGroups) return { ok: false, error: "no window" };
  const [tabs, groups] = await Promise.all([chrome.tabs.query({ windowId: w }), chrome.tabGroups.query({ windowId: w })]);
  const spaces = listSpaces(tabs, groups, await frozenByUs());
  return { ok: true, windowId: w, active: spaces.find((x) => x.active)?.id ?? null, spaces };
}

// Freezes these tabs now instead of after the usual delay, with every usual exception
// (sound, kept awake, uploads, the tab in front). Other tabs keep their timing.
async function freezeTheseNow(tabIds) {
  if (IS_AGENT_BUILD || !tabIds.length) return 0;
  const s = await settings();
  const tabs = await allTabs();
  const now = new Set(tabIds);
  for (const t of tabs) if (now.has(t.id)) t.lastAccessed = 0; // as if hidden long ago
  const ctx = { awakeTabs: await awakeTabs(), busyTabs: [...new Set([...busyTabs(), ...(await pageDownloadTabs(tabs))])], domReady: Object.fromEntries(domReady) };
  return freezeCheck(tabs, s, Date.now(), ctx);
}

async function spaceSwitch(groupId) {
  if (IS_AGENT_BUILD) return { ok: false, error: "spaces are for people's windows" };
  const g = await chrome.tabGroups.get(groupId).catch(() => null);
  if (!g) return { ok: false, error: "that space is gone" };
  const [tabs, groups] = await Promise.all([chrome.tabs.query({ windowId: g.windowId }), chrome.tabGroups.query({ windowId: g.windowId })]);
  const plan = switchPlan(tabs, groups, groupId);
  if (!plan) return { ok: false, error: "that space has no tabs" };
  // The tab first: a group holding the tab in front cannot be folded.
  await chrome.tabs.update(plan.activate, { active: true });
  await chrome.tabGroups.update(plan.expand, { collapsed: false });
  for (const id of plan.collapse) await chrome.tabGroups.update(id, { collapsed: true }).catch(() => {});
  const frozen = await freezeTheseNow(plan.freeze);
  return { ok: true, groupId, frozen };
}

// A new space holding the tab in front (or a new tab when that tab is already in a space).
async function spaceNew({ title, color, windowId } = {}) {
  if (IS_AGENT_BUILD) return { ok: false, error: "spaces are for people's windows" };
  const w = await spacesWindowId(windowId);
  if (w === undefined) return { ok: false, error: "no window" };
  const [front] = await chrome.tabs.query({ active: true, windowId: w });
  const tab = front && front.groupId === -1 ? front : await chrome.tabs.create({ windowId: w, active: true });
  const groups = await chrome.tabGroups.query({ windowId: w });
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: w } });
  await chrome.tabGroups.update(groupId, { title: String(title ?? "").slice(0, 40) || `Space ${groups.length + 1}`, color: color || freeColour(groups) });
  return spaceSwitch(groupId);
}

// Moves a tab into a space (or a new one when groupId is null) and goes with it.
async function spaceMoveTab(tab, groupId) {
  if (IS_AGENT_BUILD) return { ok: false, error: "spaces are for people's windows" };
  if (groupId === null) {
    const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
    const id = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(id, { title: `Space ${groups.length + 1}`, color: freeColour(groups) });
    return spaceSwitch(id);
  }
  const g = await chrome.tabGroups.get(Number(groupId)).catch(() => null);
  if (!g || g.windowId !== tab.windowId) return { ok: false, error: "that space is gone" };
  await chrome.tabs.group({ tabIds: [tab.id], groupId: g.id });
  return spaceSwitch(g.id);
}

// "Unload space" the gentle way: fold it and freeze every tab in it.
async function spaceFreeze(groupId) {
  const g = await chrome.tabGroups.get(groupId).catch(() => null);
  if (!g) return { ok: false, error: "that space is gone" };
  const tabs = (await chrome.tabs.query({ windowId: g.windowId })).filter((t) => t.groupId === groupId);
  if (!tabs.some((t) => t.active)) await chrome.tabGroups.update(groupId, { collapsed: true }).catch(() => {});
  return { ok: true, groupId, frozen: await freezeTheseNow(tabs.map((t) => t.id)) };
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "space-next" || IS_AGENT_BUILD) return;
  const r = await spacesList();
  const to = r.ok ? nextSpace(r.spaces) : null;
  if (to !== null) await spaceSwitch(to).catch(() => {});
});

// One list of downloads (critique, Nov 14 2026): the browser's downloads page, opened from its download
// bubble ("Full download history") or Ctrl+J, becomes Gamblium's Downloads page in the same tab.
// Private windows keep the browser's page: our page there would show the normal profile's list.
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!change.url || tab.incognito || !isBrowserDownloadsPage(change.url)) return;
  chrome.tabs.update(tabId, { url: chrome.runtime.getURL("ui/downloads.html") }).catch(() => {});
});

// ---- Tab groups: fold the others (owner, Nov 14 2026: the tab strip runs out of room) ----
// Opening a tab that sits in a group folds every other group of that window down to its name.
// A tab outside any group changes nothing. The browser refuses edits while a tab is being dragged,
// so a refused fold is tried once more a moment later.
async function foldOtherGroups(tabId) {
  const { foldGroups } = await chrome.storage.local.get({ foldGroups: true });
  if (!foldGroups) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return;
  const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
  for (const g of groups) {
    if (g.id === tab.groupId || g.collapsed) continue;
    await chrome.tabGroups.update(g.id, { collapsed: true }).catch(() =>
      new Promise((r) => setTimeout(r, 400)).then(() => chrome.tabGroups.update(g.id, { collapsed: true })).catch(() => {}));
  }
}
chrome.tabs.onActivated.addListener(({ tabId }) => { foldOtherGroups(tabId); });
