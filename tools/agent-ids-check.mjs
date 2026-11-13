// A tab keeps one id for its whole life, through sleep and wake, and wakes on
// the page the agent left it on (owner, Nov 13 2026; tester found 0 of 9
// tasks done when ids changed). Runs a hidden named session through the
// installed gamblium-cli (or GAMBLIUM_CLI), with no window.
//
//   node tools/agent-ids-check.mjs
//
// Needs the network (example.com, example.org, example.net, iana.org).
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const CLI = process.env.GAMBLIUM_CLI || path.join(process.env.LOCALAPPDATA || os.homedir(), "Gamblium", "app", "gamblium-cli.exe");
const NAME = "ids-check-" + process.pid;
let pass = 0, fail = 0;

function cli(...args) {
  let out;
  try {
    out = execFileSync(CLI, args, { encoding: "utf8", timeout: 90000 });
  } catch (e) {
    out = String(e.stdout || "");
  }
  try {
    return JSON.parse(out);
  } catch {
    return { ok: false, error: "not JSON: " + out.slice(0, 200) };
  }
}

function check(what, ok, detail) {
  if (ok) pass++;
  else fail++;
  console.log((ok ? "ok   " : "FAIL ") + what + (ok || detail === undefined ? "" : "  " + JSON.stringify(detail).slice(0, 300)));
}

const host = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
};

try {
  check("create a hidden session", cli("create", NAME).ok !== false);
  const a = cli(NAME, "open", "url=https://example.com/", "wait=true");
  const A = a.tab && a.tab.id;
  check("open A", typeof A === "number", a);
  const b = cli(NAME, "open", "url=https://example.org/", "wait=true");
  const B = b.tab && b.tab.id;
  check("open B (A is put to sleep)", typeof B === "number", b);

  let tabs = cli(NAME, "tabs");
  let rowA = (tabs.tabs || []).find((t) => t.id === A);
  check("tabs lists A under the id open gave", !!rowA, tabs);
  check("A is asleep", rowA && rowA.state === "asleep", rowA);

  const nav = cli(NAME, "navigate", "tab=" + A, "url=https://www.iana.org/help/example-domains", "wait=true");
  check("navigate A by its first id (wakes it)", nav.ok === true && nav.tab && nav.tab.id === A, nav);

  const c = cli(NAME, "open", "url=https://example.net/", "wait=true");
  check("open C (A sleeps again)", c.ok === true, c);
  tabs = cli(NAME, "tabs");
  rowA = (tabs.tabs || []).find((t) => t.id === A);
  check("A still listed under its first id", !!rowA, tabs);

  const page = cli(NAME, "page", "tab=" + A);
  check("page of A wakes it on the page it was left on (iana.org)", page.ok !== false && host(page.url) === "www.iana.org", page);
  const text = cli(NAME, "text", "tab=" + A, "max=200");
  check("text of A works by its first id", text.ok !== false && /example/i.test(JSON.stringify(text)), text);
  const again = cli(NAME, "text", "tab=" + B, "max=200");
  check("B (asleep) answers by its first id", again.ok !== false, again);

  // A restart (hidden -> window -> hidden) opens every tab anew: the ids hold.
  const w = cli("set", NAME, "window=on");
  check("set window=on restarts as a minimised window", w.ok === true && w.session && w.session.state === "window", w);
  const pw = cli(NAME, "page", "tab=" + A);
  check("after the restart A answers by its first id, on its page", pw.ok !== false && host(pw.url) === "www.iana.org", pw);
  const h = cli("set", NAME, "window=off");
  check("set window=off goes back to hidden", h.ok === true && h.session && h.session.state === "hidden", h);
  const ph = cli(NAME, "text", "tab=" + B, "max=200");
  check("after the second restart B answers by its first id", ph.ok !== false, ph);
  const listed = cli(NAME, "tabs");
  check("tabs lists A and B under their first ids", [A, B].every((id) => (listed.tabs || []).some((t) => t.id === id)), listed);
} finally {
  cli("delete", NAME);
  console.log(`\n${pass} of ${pass + fail} passed`);
  process.exitCode = fail ? 1 : 0;
}
