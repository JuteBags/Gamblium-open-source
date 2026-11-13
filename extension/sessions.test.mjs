import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanName, isValidSession, placement, snapshot, summaries, topHosts, withSession, withoutSession, shapeOf, SHAPE_TABS, urlKey, findInSessions, sessionsByUrl } from "./sessions.js";

const tab = (over) => ({ windowId: 1, index: 0, url: "https://a.example/", title: "A", pinned: false, active: false, groupId: -1, ...over });

const TABS = [
  tab({ index: 1, url: "https://mail.google.com/x", title: "Mail", groupId: 7 }),
  tab({ index: 0, url: "https://github.com/a/b", title: "Repo", pinned: true, active: true }),
  tab({ index: 2, url: "https://docs.google.com/y", title: "Doc", groupId: 7 }),
  tab({ index: 3, url: "brave://settings", title: "Settings" }),
  tab({ windowId: 2, index: 0, url: "about:blank", pendingUrl: "https://www.youtube.com/watch?v=1", title: "" }),
  tab({ windowId: 2, index: 1, url: "https://github.com/c/d", title: "Other", groupId: 9 }),
];
const GROUPS = [{ id: 7, title: "Work", color: "blue", collapsed: true }, { id: 9, title: "", color: "red", collapsed: false }];

test("snapshot keeps order, pins, the showing tab and groups per window", () => {
  const { session, skipped } = snapshot("  Work   stuff ", TABS, GROUPS, 1000);
  assert.equal(session.name, "Work stuff");
  assert.equal(skipped, 1); // brave://settings cannot be reopened by an extension
  assert.equal(session.windows.length, 2);
  const [w1, w2] = session.windows;
  assert.deepEqual(w1.tabs.map((t) => t.title), ["Repo", "Mail", "Doc"]);
  assert.deepEqual(w1.tabs.map((t) => t.group), [null, 0, 0]);
  assert.deepEqual(w1.groups, [{ title: "Work", color: "blue", collapsed: true }]);
  assert.equal(w1.tabs[0].pinned, true);
  assert.equal(w1.tabs[0].active, true);
  // A tab that was still loading is saved by the address it was going to.
  assert.equal(w2.tabs[0].url, "https://www.youtube.com/watch?v=1");
  // No tab was showing in window 2, so the first one is chosen.
  assert.equal(w2.tabs[0].active, true);
  assert.deepEqual(w2.groups, [{ title: "", color: "red", collapsed: false }]);
  assert.ok(isValidSession(session));
});

test("a window with nothing reopenable is left out", () => {
  const { session, skipped } = snapshot("x", [tab({ url: "brave://newtab" }), tab({ windowId: 3, url: "chrome-extension://abc/p.html" })], [], 1);
  assert.equal(session.windows.length, 0);
  assert.equal(skipped, 2);
  assert.ok(!isValidSession(session));
});

test("names are trimmed, capped, and empty ones rejected", () => {
  assert.equal(cleanName("  a  b "), "a b");
  assert.equal(cleanName(""), null);
  assert.equal(cleanName("   "), null);
  assert.equal(cleanName("x".repeat(100)).length, 60);
});

test("store: save replaces by name, delete removes, list is newest first", () => {
  const a = snapshot("a", TABS, GROUPS, 100).session;
  const b = snapshot("b", [tab()], [], 300).session;
  const a2 = snapshot("a", [tab()], [], 200).session;
  let store = withSession(withSession(withSession(null, a), b), a2);
  assert.deepEqual(summaries(store).map((s) => [s.name, s.tabs, s.windows]), [["b", 1, 1], ["a", 1, 1]]);
  store = withoutSession(store, "b");
  assert.deepEqual(Object.keys(store), ["a"]);
});

test("top hosts name a session by its commonest sites", () => {
  const { session } = snapshot("s", TABS, GROUPS, 1);
  assert.deepEqual(topHosts(session, 2), ["github.com", "docs.google.com"]);
});

test("an imported session with a bad address or group is rejected", () => {
  const good = snapshot("s", TABS, GROUPS, 1).session;
  assert.ok(isValidSession(good));
  const badUrl = structuredClone(good);
  badUrl.windows[0].tabs[0].url = "javascript:alert(1)";
  assert.ok(!isValidSession(badUrl));
  const badGroup = structuredClone(good);
  badGroup.windows[0].tabs[1].group = 5;
  assert.ok(!isValidSession(badGroup));
  assert.ok(!isValidSession({ ...good, version: 99 }));
  assert.ok(!isValidSession(null));
});

test("a checkpoint records where it came from, window placement and per-tab state", () => {
  const tabs = [
    tab({ id: 11, index: 0, active: true, url: "https://a.example/", mutedInfo: { muted: true }, lastAccessed: 5000 }),
    tab({ id: 12, index: 1, url: "https://b.example/", discarded: true }),
  ];
  const { session } = snapshot("cp", tabs, [], 9000, {
    windows: [{ id: 1, left: 100, top: 50, width: 1280, height: 800, state: "maximized", focused: true }],
    pages: { 11: { scrollX: 0, scrollY: 640, fields: [{ sel: "#q", value: "draft text" }], sessionStorage: { k: "v" } } },
    zooms: { 11: 1.25 },
    profile: { id: "p-123", label: "work", userDataDir: "C:/x/User Data", browser: "Brave 1.99" },
    settings: { delaySec: 600, allowlist: ["mail.example"] },
    ui: { dashboardView: "tabs" },
  });
  assert.equal(session.version, 2);
  assert.deepEqual(session.profile, { id: "p-123", label: "work", userDataDir: "C:/x/User Data", browser: "Brave 1.99" });
  assert.deepEqual(session.settings.allowlist, ["mail.example"]);
  assert.deepEqual(session.ui, { dashboardView: "tabs" });
  const w = session.windows[0];
  assert.deepEqual(w.bounds, { left: 100, top: 50, width: 1280, height: 800 });
  assert.equal(w.state, "maximized");
  assert.equal(w.focused, true);
  const [a, b] = w.tabs;
  assert.equal(a.muted, true);
  assert.equal(a.zoom, 1.25);
  assert.equal(a.lastAccessed, 5000);
  assert.equal(a.page.scrollY, 640);
  assert.equal(a.page.fields[0].value, "draft text");
  assert.equal(b.asleep, true);
  assert.equal(b.page, null);
  assert.equal(b.zoom, null);
  assert.deepEqual(session.notes, { tabs: 2, skipped: 0, pagesCaptured: 1, pagesNotCaptured: 1 });
  assert.ok(isValidSession(session));
  const [sum] = summaries(withSession(null, session));
  assert.equal(sum.profile, "work");
  assert.equal(sum.pagesCaptured, 1);
  assert.equal(sum.hasSettings, true);
});

test("without the extra information a checkpoint still saves, with defaults", () => {
  const { session } = snapshot("plain", [tab()], [], 1);
  const w = session.windows[0];
  assert.equal(w.bounds, null);
  assert.equal(w.state, "normal");
  assert.equal(session.profile, null);
  assert.equal(session.settings, null);
  assert.ok(isValidSession(session));
});

test("older sessions (version 1) are still accepted", () => {
  const v1 = { version: 1, name: "old", savedAt: 5, windows: [{ tabs: [{ url: "https://a.example/", title: "", pinned: false, active: true, group: null }], groups: [] }] };
  assert.ok(isValidSession(v1));
  assert.equal(summaries({ old: v1 })[0].tabs, 1);
});

test("window placement is used only when it is sane", () => {
  assert.deepEqual(placement({ bounds: { left: 10.4, top: 20, width: 1200, height: 700 } }), { left: 10, top: 20, width: 1200, height: 700 });
  assert.deepEqual(placement({ bounds: null }), {});
  assert.deepEqual(placement({}), {});
  assert.deepEqual(placement({ bounds: { left: 0, top: 0, width: 50, height: 700 } }), {});
  assert.deepEqual(placement({ bounds: { left: -99999, top: 0, width: 1200, height: 700 } }), {});
  // A window on a monitor to the left has a negative position, which is fine.
  assert.deepEqual(placement({ bounds: { left: -1920, top: 0, width: 1200, height: 700 } }), { left: -1920, top: 0, width: 1200, height: 700 });
});

test("a summary carries the session's shape: each window's first tabs with pin and group colour", () => {
  const { session } = snapshot("s", TABS, GROUPS, 1);
  const shape = shapeOf(session);
  assert.equal(shape.length, session.windows.length);
  assert.equal(shape.reduce((n, w) => n + w.tabs, 0), session.notes.tabs);
  for (const [i, w] of session.windows.entries()) {
    assert.deepEqual(shape[i].icons.map((t) => t.url), w.tabs.map((t) => t.url));
    assert.deepEqual(shape[i].icons.map((t) => t.color), w.tabs.map((t) => (t.group === null ? null : w.groups[t.group].color)));
  }
  assert.deepEqual(summaries(withSession(null, session))[0].shape, shape);
  const many = { windows: [{ groups: [], tabs: Array.from({ length: 90 }, (_, i) => ({ url: `https://a.example/${i}`, pinned: i < 2, group: null })) }] };
  assert.equal(shapeOf(many)[0].tabs, 90);
  assert.equal(shapeOf(many)[0].icons.length, SHAPE_TABS);
  // a version 1 session has no group list on a tab's window entry worth trusting
  assert.deepEqual(shapeOf({ windows: [{ tabs: [{ url: "https://a.example/", group: 3 }] }] })[0].icons[0].color, null);
});

const FIND = {
  work: { name: "Work", savedAt: 20, windows: [
    { tabs: [{ url: "https://github.com/JuteBags/Gamblium/pull/62", title: "Sessions page rebuilt", pinned: true }, { url: "https://www.example.org/docs/", title: "Docs" }] },
    { tabs: [{ url: "https://github.com/JuteBags/Gamblium/issues", title: "Issues" }] },
  ] },
  trip: { name: "Trip to Goa", savedAt: 10, windows: [{ tabs: [{ url: "https://example.org/docs#stay", title: "Where to stay" }, { url: "https://maps.example/goa", title: "" }] }] },
};

test("one page has one key however its address is written", () => {
  assert.equal(urlKey("https://www.Example.org/docs/"), "example.org/docs");
  assert.equal(urlKey("https://example.org/docs#stay"), "example.org/docs");
  assert.equal(urlKey("http://example.org/docs?a=1"), "example.org/docs?a=1");
  assert.notEqual(urlKey("https://example.org/docs/a"), urlKey("https://example.org/docs"));
  assert.equal(urlKey("not an address"), "not an address");
});

test("saved sessions are searched by a tab's address or title, and by name", () => {
  const byUrl = findInSessions(FIND, "github.com/jutebags");
  assert.deepEqual(byUrl.map((s) => [s.name, s.total]), [["Work", 2]]);
  assert.deepEqual(byUrl[0].tabs.map((t) => [t.window, t.title]), [[0, "Sessions page rebuilt"], [1, "Issues"]]);
  assert.deepEqual(findInSessions(FIND, "docs").map((s) => [s.name, s.total]), [["Work", 1], ["Trip to Goa", 1]]);
  assert.deepEqual(findInSessions(FIND, "where STAY").map((s) => s.name), ["Trip to Goa"]);
  // a name alone finds the session, with no tab pointed at
  assert.deepEqual(findInSessions(FIND, "trip"), [{ name: "Trip to Goa", nameHit: true, total: 0, tabs: [] }]);
  assert.deepEqual(findInSessions(FIND, "   "), []);
  assert.deepEqual(findInSessions(FIND, "nothing here"), []);
  const many = { big: { name: "big", savedAt: 1, windows: [{ tabs: Array.from({ length: 40 }, (_, i) => ({ url: `https://a.example/${i}`, title: "" })) }] } };
  const [big] = findInSessions(many, "a.example", 5);
  assert.deepEqual([big.total, big.tabs.length], [40, 5]);
});

test("every saved page knows the sessions it is in, newest first", () => {
  const map = sessionsByUrl(FIND);
  assert.deepEqual(map["example.org/docs"], ["Work", "Trip to Goa"]);
  assert.deepEqual(map["maps.example/goa"], ["Trip to Goa"]);
  assert.equal(map["github.com"], undefined);
  assert.deepEqual(sessionsByUrl(null), {});
});
