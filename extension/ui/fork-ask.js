// `gamblium-cli fork <name>` asks the owner here before their sign-ins go anywhere.
// The question must be waiting at the helper (fork-ask.json, under 3 minutes old) and name the
// same session as this page's address; Allow makes the fork from this browser, Not now ends it.
const $ = (id) => document.getElementById(id);
const native = (request) => chrome.runtime.sendMessage({ type: "native", request });
const wanted = new URLSearchParams(location.search).get("name") || "";
let ask = null;

function done(text) {
  $("now").textContent = text;
  $("choose").hidden = true;
}

async function load() {
  const r = await native({ type: "fork-ask" }).catch(() => null);
  ask = r && r.ask && r.ask.name === wanted ? r.ask : null;
  if (!ask) return done("Nothing is waiting for an answer: the question was answered or ran out.");
  const li = document.createElement("li");
  const code = Object.assign(document.createElement("code"), { className: "pcmd", textContent: `fork ${ask.name}` });
  const who = Object.assign(document.createElement("span"), { className: "pwho", textContent: ask.hidden ? "a session with no window" : "a session in a window" });
  li.append(code, who);
  $("asks").replaceChildren(li);
}

$("yes").addEventListener("click", async () => {
  if (!ask) return;
  $("yes").disabled = $("no").disabled = true;
  $("now").textContent = "Making the session…";
  const r = await chrome.runtime.sendMessage({ type: "session-fork", name: ask.name, hidden: !!ask.hidden }).catch((e) => ({ ok: false, error: String(e) }));
  if (r && r.ok) {
    done(`Made '${ask.name}' with ${r.cookies} sign-in cookies. You can close this tab.`);
  } else {
    await native({ type: "fork-ask-done" });
    done(`Not made: ${(r && r.error) || "unknown error"}`);
  }
});

$("no").addEventListener("click", async () => {
  await native({ type: "fork-ask-done" });
  done("Turned down. Nothing was copied.");
});

load();
