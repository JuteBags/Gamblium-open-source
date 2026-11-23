// The download card (owner, Nov 14 2026, "like Edge"): for about 8 seconds after a download
// starts, a small card at the top right of the page shows the file, its progress and its speed,
// with Pause / Show in folder / All downloads. It stands where Brave's own download bubble
// would have appeared; Brave's copy is cancelled before it shows anything.
//
// `showDownloadCard` is injected into the page with chrome.scripting, so it must not use
// anything from outside its own body. It lives in a closed shadow root and styles itself with
// a constructed style sheet (a page's Content-Security-Policy does not apply to those).
// ui/dl-card.html runs the same function where a page cannot be written into (browser pages,
// the new tab page), inside a small window of its own.

export function showDownloadCard(info) {
  const HOLD_MS = 8000;
  const old = document.getElementById("gamblium-download-card");
  if (old) old.remove();
  const host = document.createElement("div");
  host.id = "gamblium-download-card";
  host.style.cssText = "all: initial; position: fixed; top: 12px; right: 12px; z-index: 2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all: initial; }
    .card { --bg: #f7f8fa; --ink: #1d2230; --soft: #5c6475; --line: #dde1e8; --bar: #3b6fd8; --track: #e3e7ef; --btn: #ffffff;
      font: 13px/1.35 "Segoe UI", system-ui, sans-serif; color: var(--ink); background: var(--bg);
      width: 340px; box-sizing: border-box; padding: 12px 14px 10px; border: 1px solid var(--line); border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,.22); opacity: 0; transform: translateY(-6px); transition: opacity .16s, transform .16s; }
    .card.in { opacity: 1; transform: none; }
    @media (prefers-color-scheme: dark) {
      .card { --bg: #23262e; --ink: #e8eaf0; --soft: #a3a9b7; --line: #3a3f4b; --bar: #7aa2ff; --track: #3a3f4b; --btn: #2d313b; }
    }
    .top { display: flex; align-items: center; gap: 10px; }
    .icon { width: 28px; height: 28px; flex: none; border-radius: 6px; background: var(--track); display: grid; place-items: center; color: var(--bar); font-weight: 600; }
    .text { min-width: 0; flex: 1; }
    .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .note { color: var(--soft); font-size: 12px; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .x { all: unset; cursor: pointer; color: var(--soft); width: 22px; height: 22px; display: grid; place-items: center; border-radius: 5px; font-size: 15px; }
    .x:hover { background: var(--track); color: var(--ink); }
    .track { height: 4px; border-radius: 2px; background: var(--track); margin: 10px 0 9px; overflow: hidden; }
    .fill { height: 100%; width: 0; background: var(--bar); transition: width .3s; }
    .row { display: flex; gap: 6px; }
    button.b { all: unset; cursor: pointer; white-space: nowrap; font-size: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--btn); color: var(--ink); }
    button.b:hover { border-color: var(--bar); }
    button.b.main { background: var(--bar); border-color: var(--bar); color: #fff; }
.spacer { flex: 1; }
    [hidden] { display: none !important; }
  `);
  root.adoptedStyleSheets = [sheet];
  const card = document.createElement("div");
  card.className = "card";
  card.setAttribute("role", "status");
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const top = el("div", "top");
  const ext = (String(info.name || "").split(".").pop() || "").slice(0, 4).toUpperCase();
  const icon = el("div", "icon", ext && ext !== String(info.name).toUpperCase() ? ext.slice(0, 3) : "↓");
  icon.style.fontSize = "10px";
  const text = el("div", "text");
  const name = el("div", "name", info.name || "Download");
  name.title = info.name || "";
  const note = el("div", "note", "Starting…");
  text.append(name, note);
  const close = el("button", "x", "×");
  close.setAttribute("aria-label", "Close");
  top.append(icon, text, close);
  const track = el("div", "track");
  const fill = el("div", "fill");
  track.append(fill);
  const row = el("div", "row");
  const pause = el("button", "b", "Pause");
  const show = el("button", "b", "Show in folder");
  const open = el("button", "b main", "Open");
  open.hidden = true;
  const all = el("button", "b", "All downloads");
  all.title = "Open the Downloads page";
  row.append(open, pause, show, el("span", "spacer"), all);
  card.append(top, track, row);
  root.append(card);
  (document.body || document.documentElement).append(host);
  requestAnimationFrame(() => card.classList.add("in"));

  const send = (msg) => new Promise((r) => {
    try {
      chrome.runtime.sendMessage(msg, (a) => r(chrome.runtime.lastError ? null : a));
    } catch {
      r(null);
    }
  });
  const size = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(2) + " GB" : b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(0, Math.round(b / 1024)) + " KB");
  let hovering = false;
  let shownAt = Date.now();
  let gone = false;
  let state = "running";
  let failedAt = 0;
  const leave = () => {
    if (gone) return;
    gone = true;
    card.classList.remove("in");
    setTimeout(() => {
      host.remove();
      if (info.closeWindow) window.close();
    }, 200);
  };
  card.addEventListener("mouseenter", () => (hovering = true));
  card.addEventListener("mouseleave", () => {
    hovering = false;
    shownAt = Date.now() - HOLD_MS + 2500; // a little longer after the pointer leaves
  });
  close.addEventListener("click", leave);
  const act = (action) => send({ type: "dl-card-do", id: info.id, action });
  pause.addEventListener("click", () => act(state === "running" ? "pause" : "resume"));
  show.addEventListener("click", () => act("show"));
  open.addEventListener("click", () => act("open").then(leave));
  all.addEventListener("click", () => act("page").then(leave));

  const tick = async () => {
    if (gone) return;
    const r = await send({ type: "dl-card", id: info.id });
    const d = r && r.download;
    if (d) {
      state = d.state === "done" ? "done" : d.state === "error" ? "error" : d.state === "stopped" ? "stopped" : "running";
      // A new failure after Retry is held its full time too (review 9, G22).
      if (state !== "error") failedAt = 0;
      const done = d.done || 0;
      const total = d.total || 0;
      fill.style.width = total ? Math.min(100, (done * 100) / total).toFixed(1) + "%" : "0";
      if (state === "done") {
        note.textContent = size(total || done) + " · Done";
        fill.style.width = "100%";
        open.hidden = false;
        pause.hidden = true;
      } else if (state === "error") {
        // Held its full time from the failure, and said plainly in a private window, where the
        // job is then removed and nothing takes it over (review 4, B8).
        if (!failedAt) { failedAt = Date.now(); shownAt = failedAt; }
        note.textContent = (d.error ? String(d.error).slice(0, 120) : "Failed") + (info.incognito ? " (private windows keep no copy to try again)" : "");
        // In a private window the job is removed: nothing would take a retry over.
        if (info.incognito) pause.hidden = true;
        pause.textContent = "Retry";
      } else if (state === "stopped") {
        note.textContent = size(done) + (total ? " of " + size(total) : "") + " · Paused";
        pause.textContent = "Resume";
      } else {
        const speed = d.speed || 0;
        const left = speed > 0 && total ? Math.round((total - done) / speed) : null;
        const eta = left == null ? "" : left >= 3600 ? " · " + Math.round(left / 3600) + " h left" : left >= 60 ? " · " + Math.round(left / 60) + " min left" : " · " + left + " s left";
        note.textContent = size(done) + (total ? " of " + size(total) : "") + (speed ? " · " + size(speed) + "/s" : "") + eta;
        pause.textContent = "Pause";
      }
    }
    if (!hovering && Date.now() - shownAt > HOLD_MS) return leave();
    setTimeout(tick, 500);
  };
  tick();
}
