import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { OPS, adoptIds, idPairs, wallHint, answerIds, emptyIdMaps, firstId, followId, keyEvent, makeCtl, noteReplaced, openableUrl, sessionNameError, validateSetting } from "./agent.js";

test("an agent may open web pages only, never files or browser pages", async () => {
  assert.deepEqual(openableUrl("https://example.com/a?b=1"), { ok: true, url: "https://example.com/a?b=1" });
  assert.equal(openableUrl("about:blank").ok, true);
  for (const bad of ["file:///C:/Windows/win.ini", "not a url", "javascript:alert(1)", "chrome://settings", "brave://settings", "data:text/html,x", ""]) {
    assert.equal(openableUrl(bad).ok, false, bad);
  }
  const ctl = makeCtl({});
  assert.match((await ctl({ op: "open", url: "file:///C:/Windows/win.ini" })).error, /only http and https/);
  assert.match((await ctl({ op: "navigate", url: "not a url" })).error, /not an address/);
  assert.equal((await ctl({ op: "window-open", url: "file:///C:/x" })).ok, false);
});

test("a session name from an agent is short and has no path characters", async () => {
  assert.equal(sessionNameError("Morning work 2026-11-12"), null);
  for (const bad of ["", "   ", "../../evil", "a/b", "a\\b", "x".repeat(65), "tab\there", "what?"]) {
    assert.notEqual(sessionNameError(bad), null, JSON.stringify(bad));
  }
  const ctl = makeCtl({ sessionSave: async () => ({ ok: true }) });
  assert.equal((await ctl({ op: "session-save", name: "../../evil" })).ok, false);
  assert.equal((await ctl({ op: "session-save", name: "fine" })).ok, true);
});

test("a key name becomes what the browser needs for a real key press", () => {
  assert.deepEqual(keyEvent("Enter"), { ok: true, event: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" } });
  assert.deepEqual(keyEvent("ArrowDown"), { ok: true, event: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 } });
  assert.deepEqual(keyEvent("a"), { ok: true, event: { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, text: "a" } });
  assert.deepEqual(keyEvent("7").event.code, "Digit7");
  assert.equal(keyEvent(" ").event.windowsVirtualKeyCode, 32);
  assert.equal(keyEvent("?").event.text, "?");
  assert.equal(keyEvent("NoSuchKey").ok, false);
});

test("real input says it needs the agent profile when it is not there", async () => {
  const ctl = makeCtl({});
  globalThis.chrome = { tabs: { get: async (id) => ({ id, windowId: 1 }) } };
  try {
    const r = await ctl({ op: "mouse", tab: 5, x: 10, y: 10 });
    assert.equal(r.ok, false);
    assert.equal(r.needsAgentProfile, true);
    assert.match((await ctl({ op: "mouse", tab: 5 })).error, /mouse needs x=/);
  } finally {
    delete globalThis.chrome;
  }
});

test("every listed command has a handler and every handler is listed", () => {
  const ctl = makeCtl({});
  assert.deepEqual([...ctl.ops].sort(), Object.keys(OPS).sort());
});

test("every command is documented in docs/agent-cli.md and in the agent skill", () => {
  for (const rel of ["../docs/agent-cli.md", "../skills/gamblium-cli/references/commands.md"]) {
    const doc = fs.readFileSync(new URL(rel, import.meta.url), "utf8");
    const missing = Object.keys(OPS).filter((op) => !doc.includes("`" + op + "`"));
    assert.deepEqual(missing, [], rel);
  }
});

test("the agent skill is well formed: name matches its folder, every linked file exists", () => {
  const dir = new URL("../skills/gamblium-cli/", import.meta.url);
  const skill = fs.readFileSync(new URL("SKILL.md", dir), "utf8");
  const front = skill.match(/^---\r?\nname: ([a-z0-9-]+)\r?\ndescription: (.+)\r?\n---/);
  assert.ok(front, "front matter with name and description");
  assert.equal(front[1], "gamblium-cli");
  assert.ok(front[2].length <= 1024, "description at most 1024 characters");
  const links = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 5);
  for (const l of links) assert.ok(fs.existsSync(new URL(l, dir)), l);
});

test("an agent cannot add to the scope or switch itself on elsewhere", () => {
  assert.ok(!("scope-add" in OPS));
  assert.ok(!("bridge-set" in OPS));
  assert.equal(validateSetting("agentBridge", true).ok, false);
  assert.equal(validateSetting("sessions", {}).ok, false);
});

test("unknown commands and missing arguments are errors, not crashes", async () => {
  const ctl = makeCtl({});
  assert.equal((await ctl({ op: "nope" })).ok, false);
  assert.equal((await ctl({ op: "constructor" })).ok, false);
  assert.match((await ctl({ op: "open" })).error, /open needs url=/);
  assert.match((await ctl({ op: "cve", product: "nginx" })).error, /cve needs version=/);
  const help = await ctl({ op: "help" });
  assert.equal(help.ops.audit.group, "security");
});

test("settings are validated before they are stored", () => {
  assert.deepEqual(validateSetting("enabled", "false"), { ok: true, value: false });
  assert.deepEqual(validateSetting("delaySec", 120), { ok: true, value: 120 });
  assert.equal(validateSetting("delaySec", 5).ok, false);
  assert.equal(validateSetting("delaySec", "soon").ok, false);
  assert.deepEqual(validateSetting("lowMemoryMb", 0), { ok: true, value: 0 });
  assert.deepEqual(validateSetting("allowlist", "Mail.Google.com, github.com"), { ok: true, value: ["mail.google.com", "github.com"] });
  assert.equal(validateSetting("allowlist", "*").ok, false);
  assert.equal(validateSetting("lightSites", "https://x.com").ok, false);
  assert.deepEqual(validateSetting("allowlist", ""), { ok: true, value: [] });
  assert.equal(validateSetting("profileLabel", "  work  ").value, "work");
});

test("the tab list says which tabs are frozen", async () => {
  const ctl = makeCtl({ frozenTabs: async () => ({ 2: Date.now(), 3: Date.now(), 4: Date.now() }) });
  const tab = (id, more = {}) => ({ id, windowId: 1, index: id, title: "t" + id, url: "https://example.com/" + id, ...more });
  globalThis.chrome = { tabs: { query: async () => [tab(1, { active: true }), tab(2), tab(3, { discarded: true }), tab(4, { active: true }), tab(5)] } };
  try {
    const r = await ctl({ op: "tabs" });
    assert.deepEqual(r.tabs.map((t) => t.state), ["awake", "frozen", "asleep", "awake", "awake"]);
  } finally {
    delete globalThis.chrome;
  }
});

test("a page that is a check for people is recognised by title or address", async () => {
  const { wallOf } = await import("./agent.js");
  assert.equal(wallOf("Just a moment...", "https://stackoverflow.com/questions"), "cloudflare");
  assert.equal(wallOf("Attention Required! | Cloudflare", "https://x.example/"), "cloudflare");
  assert.equal(wallOf("x", "https://x.example/cdn-cgi/challenge-platform/h/b/orchestrate"), "cloudflare");
  assert.equal(wallOf("Verify you are human", "https://x.example/"), "check");
  assert.equal(wallOf("Are you a robot?", "https://x.example/"), "check");
  for (const title of ["Newest Questions - Stack Overflow", "Just a moment with the author", "", undefined]) assert.equal(wallOf(title, "https://x.example/"), null);
});

test("a tab keeps one id for life: commands take any id it had, answers give the first", async () => {
  let m = noteReplaced(emptyIdMaps(), 20, 10);
  m = noteReplaced(m, 30, 20);
  assert.equal(followId(m, 10), 30);
  assert.equal(followId(m, 20), 30);
  assert.equal(followId(m, 30), 30);
  assert.equal(followId(m, 99), 99);
  assert.equal(firstId(m, 30), 10);
  assert.equal(firstId(m, 99), 99);
  assert.deepEqual(m.fwd, { 10: 30, 20: 30 });
  assert.deepEqual(m.origin, { 30: 10 });
  assert.deepEqual(answerIds({ ok: true, tab: { id: 30, url: "x" }, slept: [30, 5], tabs: [{ id: 30 }, { id: 7 }] }, m),
    { ok: true, tab: { id: 10, url: "x" }, slept: [10, 5], tabs: [{ id: 10 }, { id: 7 }] });
  const seen = [];
  const ctl = makeCtl({ idMaps: async () => m, touch: async (t) => { seen.push(t); return t; } });
  await ctl({ op: "help", tab: 10 });
  assert.deepEqual(seen, [30]);
});

test("after a restart, reopened tabs take over the ids they had", () => {
  assert.deepEqual(idPairs("10:500, 11:501,bad,12:x"), [[10, 500], [11, 501]]);
  const m = adoptIds(emptyIdMaps(), [[10, 500], [11, 501], [7, 7]]);
  assert.equal(followId(m, 10), 500);
  assert.equal(firstId(m, 500), 10);
  assert.equal(followId(m, 7), 7);
  // A later sleep of the reopened tab still leads back to the first id.
  const m2 = noteReplaced(m, 900, 500);
  assert.equal(followId(m2, 10), 900);
  assert.equal(firstId(m2, 900), 10);
});

test("an automatic check is not disguised: hidden is told to use a real window, a window waits", () => {
  assert.match(wallHint("cloudflare", true), /window=on/);
  assert.match(wallHint("cloudflare", false), /passes by itself/);
  assert.match(wallHint("check", true), /check for people/);
});

test('screenshot options: area, element, scroll box, scroll, page size, scale, format, checked first', async () => {
  const { shotOptions } = await import('./agent.js');
  assert.deepEqual(shotOptions({}), { full: false, mobile: false, scale: 1, format: 'png', delay: 0 });
  assert.deepEqual(shotOptions({ x: 0, y: 100, width: 800, height: 400 }).area, { x: 0, y: 100, width: 800, height: 400 });
  assert.equal(shotOptions({ full: true, format: 'jpg', quality: 70, scale: 0.5 }).format, 'jpeg');
  assert.equal(shotOptions({ selector: '#main', scroll: 'bottom' }).scrollY, 'bottom');
  assert.deepEqual(shotOptions({ viewport: '390x844', mobile: true }).viewport, { width: 390, height: 844 });
  assert.deepEqual(shotOptions({ scroller: '.chat', y: 200 }), { full: false, mobile: false, scroller: '.chat', from: 200, rows: null, scale: 1, format: 'png', delay: 0 });
  for (const bad of [{ x: 0, y: 1 }, { viewport: 'big' }, { viewport: '100x100' }, { full: true, selector: 'a' }, { format: 'png', quality: 50 }, { format: 'gif' }, { scale: 9 }, { delay: 20000 }, { scroll: 'top' }]) {
    assert.throws(() => shotOptions(bad), undefined, JSON.stringify(bad));
  }
});
