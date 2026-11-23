import assert from "node:assert/strict";
import { describeTemp, freezeReason, menuInkOfTheme, schemeOfTheme, tabsToFreeze, tabsToWake, tempOf, tempPlan, isPageTab } from "./rules.js";
import { test } from "node:test";
import { DEFAULTS, effectiveDelaySec, isAllowlisted, keepReason, lightSiteMatches, tabsToSleep } from "./rules.js";

const now = 1_000_000;
const tab = (over = {}) => ({
  id: 1, url: "https://www.youtube.com/", active: false, audible: false, pinned: false,
  discarded: false, autoDiscardable: true, lastAccessed: now - 120_000, ...over,
});
const s = { ...DEFAULTS, delaySec: 60, allowlist: ["google.com"] };

test("a tab hidden longer than the delay may sleep", () => {
  assert.equal(keepReason(tab(), s, now), null);
});

test("each exemption keeps a tab awake", () => {
  assert.equal(keepReason(tab({ active: true }), s, now), "visible");
  assert.equal(keepReason(tab({ audible: true }), s, now), "playing audio");
  assert.equal(keepReason(tab({ id: 7 }), s, now, { pipTabs: [7] }), "video popped out");
  assert.equal(keepReason(tab({ pinned: true }), s, now), "pinned");
  assert.equal(keepReason(tab({ discarded: true }), s, now), "already asleep");
  assert.equal(keepReason(tab({ autoDiscardable: false }), s, now), "marked never sleep");
  assert.equal(keepReason(tab({ url: "brave://settings" }), s, now), "not a web page");
  assert.equal(keepReason(tab({ url: "https://mail.google.com/x" }), s, now), "allowlisted");
  assert.equal(keepReason(tab({ lastAccessed: now - 20_000 }), s, now), "hidden only 20 s");
});

test("allowlist covers subdomains but not look-alike hosts", () => {
  assert.ok(isAllowlisted("https://google.com/", ["google.com"]));
  assert.ok(isAllowlisted("https://docs.google.com/a", ["google.com"]));
  assert.ok(!isAllowlisted("https://notgoogle.com/", ["google.com"]));
  assert.ok(!isAllowlisted("not a url", ["google.com"]));
});

test("nothing sleeps when disabled", () => {
  assert.deepEqual(tabsToSleep([tab()], { ...s, enabled: false }, now), []);
  assert.equal(tabsToSleep([tab(), tab({ id: 2, active: true })], s, now).length, 1);
});

test("low memory shortens the delay, plenty of memory does not", () => {
  const d = { ...DEFAULTS, delaySec: 600, lowMemoryDelaySec: 60, lowMemoryMb: 2048 };
  assert.equal(effectiveDelaySec(d, 8000), 600);
  assert.equal(effectiveDelaySec(d, 1500), 60);
  assert.equal(effectiveDelaySec(d, null), 600);
  assert.equal(effectiveDelaySec({ ...d, delaySec: 30 }, 1500), 30);
  const hidden2min = [tab()];
  assert.equal(tabsToSleep(hidden2min, d, now, 8000).length, 0);
  assert.equal(tabsToSleep(hidden2min, d, now, 1500).length, 1);
});

test("light-site patterns cover the host and its subdomains, and nothing else", () => {
  assert.deepEqual(lightSiteMatches(["News.Ycombinator.com ", "example.org"]), [
    "*://news.ycombinator.com/*", "*://*.news.ycombinator.com/*", "*://example.org/*", "*://*.example.org/*",
  ]);
  // Wildcards, schemes, paths, bare words and duplicates never become patterns.
  assert.deepEqual(lightSiteMatches(["*", "<all_urls>", "https://x.com", "x.com/path", "localhost", "", "a..b.com", "x.com", "x.com"]), [
    "*://x.com/*", "*://*.x.com/*",
  ]);
  assert.deepEqual(lightSiteMatches(undefined), []);
});

test("a launcher theme gives the scheme of our pages", () => {
  assert.equal(schemeOfTheme("burgundy-dark"), "burgundy");
  assert.equal(schemeOfTheme("felt-light"), "felt");
  assert.equal(schemeOfTheme("felt"), "felt");
  assert.equal(schemeOfTheme("../x"), null);
  assert.equal(schemeOfTheme(null), null);
});

test("a hidden tab freezes after the delay, with the exceptions the owner asked for", () => {
  const now = 1_000_000;
  const s = { ...DEFAULTS, awakeHosts: ["grafana.example.com"] };
  const hidden = (more) => ({ id: 1, url: "https://example.com/", lastAccessed: now - 60_000, status: "complete", ...more });
  assert.equal(freezeReason(hidden({}), s, now), null);
  assert.equal(freezeReason(hidden({ lastAccessed: now - 5000 }), s, now), "hidden only 5 s");
  assert.equal(freezeReason(hidden({ active: true }), s, now), "visible");
  assert.equal(freezeReason(hidden({ audible: true }), s, now), "playing audio");
  assert.equal(freezeReason(hidden({}), s, now, { pipTabs: [1] }), "video popped out");
  assert.equal(freezeReason(hidden({ frozen: true }), s, now), "already frozen");
  assert.equal(freezeReason(hidden({ discarded: true }), s, now), "asleep");
  assert.equal(freezeReason(hidden({ status: "loading", lastAccessed: now - 40_000 }), s, now), "still loading");
  assert.equal(freezeReason(hidden({ url: "brave://settings" }), s, now), "not a web page");
  assert.equal(freezeReason(hidden({ url: "https://grafana.example.com/d/1" }), s, now), "kept awake");
  assert.equal(freezeReason(hidden({ id: 7 }), s, now, { awakeTabs: [7] }), "kept awake");
  assert.equal(freezeReason(hidden({ id: 8 }), s, now, { busyTabs: [8] }), "uploading");
  // A pinned tab is not put to sleep, but it is frozen like any other.
  assert.equal(freezeReason(hidden({ pinned: true }), s, now), null);
  assert.equal(tabsToFreeze([hidden({})], { ...s, freezeEnabled: false }, now).length, 0);
  assert.equal(tabsToFreeze([hidden({}), hidden({ id: 2, audible: true })], s, now).length, 1);
});

test("a tab kept awake is not put to sleep either", () => {
  const now = 10_000_000; // past the 30-minute sleep delay
  const t = { id: 3, url: "https://example.com/", lastAccessed: 0 };
  assert.equal(keepReason(t, DEFAULTS, now, { awakeTabs: [3] }), "kept awake");
  assert.equal(keepReason(t, { ...DEFAULTS, awakeHosts: ["example.com"] }, now), "kept awake");
  assert.equal(tabsToSleep([t], DEFAULTS, now, null, { awakeTabs: [3] }).length, 0);
  assert.equal(tabsToSleep([t], DEFAULTS, now).length, 1);
});

test("frozen mail and chat tabs are woken on a schedule", () => {
  const now = 10_000_000;
  const s = { ...DEFAULTS, wakeHosts: ["slack.com"], wakeEveryMin: 5 };
  const tab = (more) => ({ id: 1, url: "https://app.slack.com/client", frozen: true, ...more });
  assert.equal(tabsToWake([tab({})], s, now, { 1: now - 6 * 60000 }).length, 1);
  assert.equal(tabsToWake([tab({})], s, now, { 1: now - 60000 }).length, 0);
  assert.equal(tabsToWake([tab({ frozen: false })], s, now, {}).length, 0);
  assert.equal(tabsToWake([tab({ url: "https://example.com/" })], s, now, {}).length, 0);
});

test("the background level runs from 0 K (frozen solid) to 273 K (never frozen)", () => {
  assert.deepEqual(tempPlan(0), { freeze: true, wakeEveryMin: null });
  assert.deepEqual(tempPlan(273), { freeze: false });
  assert.deepEqual(tempPlan(999), { freeze: false });
  assert.deepEqual(tempPlan(137), { freeze: true, wakeEveryMin: 15, wakeForSec: 7 });
  // Warmer means woken more often and for longer.
  const cold = tempPlan(39), warm = tempPlan(234);
  assert.ok(warm.wakeEveryMin < cold.wakeEveryMin && warm.wakeForSec > cold.wakeForSec);
  assert.match(describeTemp(0), /^Frozen while hidden · 0 K$/);
  assert.match(describeTemp(273), /^Always awake, never frozen · 273 K$/);
  assert.match(describeTemp(137), /^Frozen, wakes for 7 s every 15 min · 137 K$/);
});

test("a tab's level comes from its own mark, then its site, then the default", () => {
  const s = { ...DEFAULTS, defaultTemp: 0, siteTemps: { "example.com": 100, "mail.example.com": 200 }, awakeHosts: ["grafana.test"] };
  const tab = (url, id = 1) => ({ id, url });
  assert.equal(tempOf(tab("https://other.org/"), s), 0);
  assert.equal(tempOf(tab("https://www.example.com/"), s), 100);
  assert.equal(tempOf(tab("https://mail.example.com/"), s), 200); // the closer entry wins
  assert.equal(tempOf(tab("https://grafana.test/"), s), 273);
  assert.equal(tempOf(tab("https://other.org/", 9), s, { awakeTabs: [9] }), 273);
  assert.equal(tempOf(tab("https://other.org/"), { ...s, defaultTemp: 50 }), 50);
  const now = 100 * 60000;
  const hidden = (url) => ({ id: 1, url, lastAccessed: 0, status: "complete" });
  assert.equal(freezeReason(hidden("https://x.test/"), { ...s, siteTemps: { "x.test": 273 } }, now), "kept awake");
  assert.equal(freezeReason(hidden("https://www.example.com/"), s, now), null); // 100 K still freezes
  const frozen = { id: 1, url: "https://www.example.com/", frozen: true };
  const plan = tempPlan(100);
  assert.equal(tabsToWake([frozen], s, now, { 1: now - (plan.wakeEveryMin + 1) * 60000 })[0].wakeForSec, plan.wakeForSec);
  assert.equal(tabsToWake([frozen], s, now, { 1: now - 30000 }).length, 0);
  assert.equal(tabsToWake([{ ...frozen, url: "https://other.org/" }], s, now, {}).length, 0); // 0 K never wakes
});

test("a background tab with no last-shown time, or one that never finishes loading, still freezes", () => {
  const now = 10 * 60000;
  const t = { id: 4, url: "https://example.com/", status: "complete" }; // no lastAccessed
  assert.equal(freezeReason(t, DEFAULTS, now, { firstSeen: { 4: now - 5000 } }), "hidden only 5 s");
  assert.equal(freezeReason(t, DEFAULTS, now, { firstSeen: { 4: now - 40000 } }), null);
  const loading = { id: 5, url: "https://example.com/", status: "loading", lastAccessed: now - 40000 };
  assert.equal(freezeReason(loading, DEFAULTS, now), "still loading");
  assert.equal(freezeReason({ ...loading, lastAccessed: now - 90000 }, DEFAULTS, now), null);
});

test("freeze engine level 2: a tab frozen long enough has its page process trimmed, once per freeze", async () => {
  const { trimPlan, trimWaiting } = await import("./rules.js");
  const s = { trimEnabled: true, trimDelaySec: 60 };
  const processes = [{ pid: 100, client_id: 5 }, { pid: 200, client_id: 6 }, { pid: 300, client_id: 7 }, { pid: 400, client_id: null }];
  const frames = { 1: [5], 2: [6, 7], 3: [7], 4: [5] };
  const t0 = 1_000_000;
  // Tab 1 and 2 frozen 61 s ago, tab 4 only 10 s ago, tab 3 not frozen.
  const frozen = { 1: t0 - 61_000, 2: t0 - 61_000, 4: t0 - 10_000 };
  const plan = trimPlan(frozen, {}, frames, processes, t0, s);
  assert.deepEqual(plan.tabs, [1, 2]);
  // 300 also serves tab 3, which is awake: left alone. 100 serves only frozen tabs.
  assert.deepEqual(plan.pids.sort(), [100, 200]);
  assert.equal(trimWaiting(frozen, {}, t0, s), true);
  // Trimmed for this freeze: not again...
  const trimmed = { 1: frozen[1], 2: frozen[2] };
  assert.deepEqual(trimPlan(frozen, trimmed, frames, processes, t0, s), { tabs: [], pids: [] });
  assert.equal(trimWaiting(frozen, trimmed, t0, s), false);
  // ...until a short wake-up gives the tab a new freeze time and the wait has passed again.
  const woken = { ...frozen, 1: t0 };
  assert.deepEqual(trimPlan(woken, trimmed, frames, processes, t0 + 30_000, s).tabs, []);
  assert.deepEqual(trimPlan(woken, trimmed, frames, processes, t0 + 60_000, s).tabs, [1, 4]);
  // Switched off, or a tab whose frames are unknown (asleep): nothing.
  assert.deepEqual(trimPlan(frozen, {}, frames, processes, t0, { ...s, trimEnabled: false }), { tabs: [], pids: [] });
  assert.deepEqual(trimPlan({ 9: t0 - 99_000 }, {}, frames, processes, t0, s), { tabs: [], pids: [] });
});

test("short on memory: the biggest and stalest hidden tabs sleep first, and only as many as needed", async () => {
  const { sleepPlan, DEFAULTS } = await import("./rules.js");
  const s = { ...DEFAULTS, delaySec: 600, lowMemoryDelaySec: 60, lowMemoryMb: 2048, allowlist: [] };
  const now = 10_000_000;
  const min = (m) => now - m * 60_000;
  const tab = (id, minutesHidden, extra = {}) => ({ id, url: `https://site${id}.example/`, active: false, audible: false, discarded: false, pinned: false, lastAccessed: min(minutesHidden), status: "complete", ...extra });
  const tabs = [tab(1, 2), tab(2, 8), tab(3, 3), tab(4, 0.5), tab(5, 12), tab(6, 4, { audible: true }), tab(7, 0, { active: true })];
  const memory = { 1: 600, 2: 100, 3: 300, 4: 900, 5: 50, 6: 800, 7: 700 };
  const ids = (list) => list.map((t) => t.id);

  // Enough memory: only the timer counts. Tab 5 has been hidden 12 minutes.
  assert.deepEqual(ids(sleepPlan(tabs, s, now, 6000, {}, memory)), [5]);

  // 300 MB under the line: 300 + 256 margin = 556 MB to get back. Tab 1 (600 MB x 2 min = 1200)
  // ranks above tab 3 (900) and tab 2 (800), and is enough by itself. Tab 4 is big but was
  // shown 30 s ago; tab 6 plays sound; tab 7 is showing.
  assert.deepEqual(ids(sleepPlan(tabs, s, now, 1748, {}, memory)), [5, 1]);

  // Much shorter: more follow, in rank order, never the protected ones.
  assert.deepEqual(ids(sleepPlan(tabs, s, now, 1100, {}, memory)), [5, 1, 3, 2]);

  // The helper did not answer: the stalest first, three at most.
  assert.deepEqual(ids(sleepPlan(tabs, s, now, 1100, {}, null)), [5, 2, 3, 1]);

  // Switched off: nothing.
  assert.deepEqual(sleepPlan(tabs, { ...s, enabled: false }, now, 100, {}, memory), []);
});

test("work the user is waiting for is never put to sleep, even when memory is short", async () => {
  const { sleepPlan, keepReason, DEFAULTS } = await import("./rules.js");
  const s = { ...DEFAULTS, delaySec: 600, lowMemoryDelaySec: 60, lowMemoryMb: 2048, allowlist: [], wakeHosts: ["mail.example"], siteTemps: { "chat.example": 137 } };
  const now = 10_000_000;
  const tab = (id, url) => ({ id, url, active: false, audible: false, discarded: false, pinned: false, lastAccessed: now - 30 * 60_000, status: "complete" });
  const tabs = [tab(1, "https://drive.example/upload"), tab(2, "https://mega.example/file"), tab(3, "https://mail.example/inbox"), tab(4, "https://chat.example/"), tab(5, "https://news.example/")];
  const ctx = { busyTabs: [1, 2] };
  assert.equal(keepReason(tabs[0], s, now, ctx), "uploading or downloading");
  assert.equal(keepReason(tabs[2], s, now, ctx), "works in the background");
  assert.equal(keepReason(tabs[3], s, now, ctx), "works in the background");
  // Thirty minutes hidden and almost no memory left: only the news tab goes.
  assert.deepEqual(sleepPlan(tabs, s, now, 200, ctx, { 1: 900, 2: 900, 3: 900, 4: 900, 5: 50 }).map((t) => t.id), [5]);
});

test("the menu button's ink follows the theme's toolbar", () => {
  assert.deepEqual(["moon-dark", "felt-light", "burgundy-auto", "", undefined, "odd"].map(menuInkOfTheme), ["light", "dark", "mid", "mid", "mid", "mid"]);
});

test("the freezer runs when the next hidden tab is due, and a loaded document is not waited for", async () => {
  const { nextFreezeDue, freezeReason, DEFAULTS } = await import("./rules.js");
  const now = 1_000_000;
  const s = { ...DEFAULTS, freezeDelaySec: 30, defaultTemp: 0, siteTemps: {} };
  const tab = (id, hiddenSec, extra = {}) => ({ id, url: `https://s${id}.example/`, active: false, audible: false, discarded: false, status: "complete", lastAccessed: now - hiddenSec * 1000, ...extra });
  // Hidden 10 s and 20 s: the first is due in 10 s.
  assert.equal(nextFreezeDue([tab(1, 20), tab(2, 10)], s, now, {}), now + 10_000);
  // Frozen, showing, asleep or not a web page: not counted.
  assert.equal(nextFreezeDue([tab(1, 20, { active: true }), tab(2, 20, { discarded: true }), { ...tab(3, 20), url: "chrome://newtab/" }, tab(4, 20)], s, now, { frozen: { 4: 1 } }), null);
  // Still loading: a minute, unless the document is in.
  assert.equal(nextFreezeDue([tab(1, 20, { status: "loading" })], s, now, {}), now + 40_000);
  assert.equal(nextFreezeDue([tab(1, 20, { status: "loading" })], s, now, { domReady: { 1: now - 5000 } }), now + 10_000);
  assert.equal(freezeReason(tab(1, 35, { status: "loading" }), s, now, {}), "still loading");
  assert.equal(freezeReason(tab(1, 35, { status: "loading" }), s, now, { domReady: { 1: now } }), null);
  assert.equal(nextFreezeDue([tab(1, 20)], { ...s, freezeEnabled: false }, now, {}), null);
  // Overdue but still not frozen (kept for another reason): no timer for it.
  assert.equal(nextFreezeDue([tab(1, 45), tab(2, 25)], s, now, {}), now + 5_000);
  assert.equal(nextFreezeDue([tab(1, 45)], s, now, {}), null);
});

test("a hidden tab waits for its turn when enough hidden tabs are loading already", async () => {
  const { holdForLoading, DEFAULTS } = await import("./rules.js");
  const s = { ...DEFAULTS, loadAtOnce: 3, awakeHosts: ["dash.example"] };
  const tab = (extra = {}) => ({ id: 1, url: "https://a.example/", active: false, pinned: false, audible: false, discarded: false, ...extra });
  assert.equal(holdForLoading(tab(), s, 2), false);
  assert.equal(holdForLoading(tab(), s, 3), true);
  // Never: the tab in front, pinned, playing, asleep already, not a web page, always-awake site, let go already, no limit.
  for (const t of [tab({ active: true }), tab({ pinned: true }), tab({ audible: true }), tab({ discarded: true }), tab({ url: "chrome://newtab/" }), tab({ url: "https://dash.example/x" })]) assert.equal(holdForLoading(t, s, 9), false);
  assert.equal(holdForLoading(tab(), s, 9, true), false);
  assert.equal(holdForLoading(tab(), { ...s, loadAtOnce: 0 }, 9), false);
});

test("PDF tabs are looked after like pages: files, the built-in page, our viewer's tab", () => {
  assert.equal(isPageTab("https://x.org/a.pdf"), true);
  assert.equal(isPageTab("file:///C:/Users/a/Report%20one.PDF"), true);
  assert.equal(isPageTab("file:///C:/Users/a/notes.txt"), false);
  assert.equal(isPageTab("chrome-extension://pbgbdlkcienglhbfadbjolphinilbpia/pdf/viewer.html?file=file%3A%2F%2F%2FC%3A%2Fa.pdf"), true);
  // Opened from the file picker: no address to load it again, so never put to sleep.
  assert.equal(isPageTab("chrome-extension://pbgbdlkcienglhbfadbjolphinilbpia/pdf/viewer.html"), false);
  assert.equal(isPageTab("chrome-extension://pbgbdlkcienglhbfadbjolphinilbpia/ui/settings.html"), false);
  assert.equal(isPageTab("brave://settings"), false);
});
