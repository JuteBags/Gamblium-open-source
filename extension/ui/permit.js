// The question an agent's settings command raises: allow, and for how long?
// The answer goes to the helper, which keeps it for this Windows user.
// Read on load, after a choice, and when the tab is shown again; no timer.
// permit.html?demo shows a made-up question, to look at the page.
import { permitStatus, permitShort, permitParts } from "./pages-logic.js";

const demo = new URLSearchParams(location.search).has("demo");
// settings: agents changing settings; logins: agents using the owner's saved logins.
// person: agents working in a person's own session window (Work) (review 6, D2).
const asked = new URLSearchParams(location.search).get("what");
// logins:<site>|<profile>: one site's saved logins for one browser (review 2, 1.6).
const what = asked === "logins" || asked === "person" || /^logins:.{1,300}$/.test(asked || "") ? asked : "settings";
const [loginSite, loginWho] = what.startsWith("logins:") ? what.slice(7).split("|") : ["", ""];
const WORDS = what === "person"
  ? { ask: "Allow agents to work in your own session windows?", always: "Agents work in your session windows without asking", allowed: "Agents may work in your session windows for now", rule: "Agents ask before working in your session windows",
      why: "A program working through Gamblium's command line wants to read or act on the pages of one of your own session windows (such as Work), where you are signed in." }
  : loginSite
  ? { ask: `Allow agents to log in to ${loginSite} with your saved login?`, always: `Agents use your ${loginSite} login without asking`, allowed: `Agents may use your ${loginSite} login for now`, rule: `Agents ask before using your ${loginSite} login`,
      why: `An agent in ${loginWho || "a browser"} wants Gamblium to type your saved login for ${loginSite} into its sign-in page. The agent never sees the password. Other sites and other browsers still ask.` }
  : what === "logins"
  ? { ask: "Allow agents to log in with your saved logins?", always: "Agents use your saved logins without asking", allowed: "Agents may use your saved logins for now", rule: "Agents ask before using your saved logins",
      why: "An agent wants Gamblium to type one of your saved logins into a sign-in page. The agent never sees the password." }
  : { ask: "Allow agents to change settings?", always: "Agents change settings without asking", allowed: "Agents may change settings for now", rule: "Agents ask before changing settings",
      why: "A program working through Gamblium's command line wants to change browser or Gamblium settings." };
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...[].concat(children));
  return e;
};
let demoView = { ok: true, what: "settings", allowed: false, neverAsk: false, until: null, choices: [0, 30, 60, 120, 360, -1], asks: [
  { what: "settings", command: "proxy-set mode=fixed host=127.0.0.1 port=9050 scheme=socks5", profile: "the session 'research'", at: Date.now() / 1000 - 40 },
  { what: "settings", command: "settings-set freezeSec=20", profile: "the agent profile", at: Date.now() / 1000 - 400 },
] };
const native = async (request) => {
  if (!demo) return chrome.runtime.sendMessage({ type: "native", request });
  if (request.type === "permit-set") demoView = { ...demoView, allowed: request.minutes !== 0, neverAsk: request.minutes === -1, until: request.minutes > 0 ? Math.round(Date.now() / 1000) + request.minutes * 60 : null, asks: request.minutes === 0 ? [] : demoView.asks };
  return demoView;
};

function draw(view) {
  const now = Date.now();
  const p = permitParts(view, now);
  document.body.dataset.state = p.state;
  $("asks").hidden = p.asks.length === 0;
  $("asks").replaceChildren(...p.asks.map((a) => el("li", {}, [
    el("code", { className: "pcmd", textContent: a.command }),
    el("span", { className: "pwho", textContent: `${a.who} · ${a.when}` }),
  ])));
  const asking = p.asks.length > 0;
  // A question only while something asks; otherwise the title is the rule in force and
  // there is no main button, only ways to change that rule.
  $("permit-title").textContent = asking ? WORDS.ask
    : p.state === "always" ? WORDS.always
    : p.state === "allowed" ? WORDS.allowed
    : WORDS.rule;
  $("why").textContent = asking
    ? WORDS.why
    : "Nothing is waiting for an answer. Change the rule here, or leave it.";
  $("notNow").hidden = !asking && p.state !== "allowed" && p.state !== "always";
  $("notNow").classList.toggle("primary", asking);
  $("for-label").textContent = asking ? "Allow for" : "Let them, for";
  $("foot").hidden = !asking;
  // With nothing asked and no permission running, the title already says it all.
  $("now").hidden = !asking && p.state !== "allowed" && p.state !== "always";
  const thing = what === "person" ? "work in your own session windows" : what.startsWith("logins") ? (loginSite ? `use your ${loginSite} login` : "use your saved logins") : "change settings";
  $("now").textContent = p.state === "allowed" ? `${permitStatus(view, now, thing)} Until ${p.until}.` : permitStatus(view, now, thing);
  $("times").replaceChildren(...p.times.map((minutes) => {
    const b = el("button", { type: "button", textContent: permitShort(minutes) });
    b.addEventListener("click", () => choose(minutes));
    return b;
  }));
  $("notNow").textContent = p.state === "allowed" || p.state === "always" ? "Take it back" : "Not now";
  $("always").setAttribute("aria-pressed", String(p.state === "always"));
}

async function choose(minutes) {
  const r = await native({ type: "permit-set", what, minutes });
  document.activeElement?.blur();
  if (r && r.ok) draw(r);
  else fail(r);
}
function fail(r) {
  document.body.dataset.state = "failed";
  $("now").textContent = (r && r.error) || "The helper did not answer. Is Gamblium installed?";
}
async function read() {
  const r = await native({ type: "permit-get", what });
  if (r && r.ok) draw(r);
  else fail(r);
}

$("notNow").addEventListener("click", () => choose(0));
$("always").addEventListener("click", () => choose(-1));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) read();
});
read();
