// Commands for AI agents and scripts, sent with `gamblium ctl <op> key=value ...`.
// They arrive through the native host, so no debugger is attached and tabs
// still freeze and sleep as usual. The full reference is docs/agent-cli.md;
// a test checks that every command here is documented there.
//
// Page commands (text, click, type...) need permission to look at the page:
// the agent profile has it; elsewhere the user grants it in the popup.

// name: [group, arguments, what it does]
export const OPS = {
  help: ["browser", "", "this list"],
  info: ["browser", "", "versions, profile, what this profile lets an agent do"],

  tabs: ["tabs", "[q=<text>]", "every tab (or those whose title or address contains q); state is awake, frozen or asleep"],
  open: ["tabs", "url=<address> [background=true] [wait=true] [window=<id>]", "open a tab"],
  close: ["tabs", "tab=<id> | tabs=<id,id,...>", "close tabs"],
  activate: ["tabs", "tab=<id>", "show a tab and bring its window forward"],
  navigate: ["tabs", "[tab=<id>] url=<address> [wait=true]", "go to an address in a tab"],
  reload: ["tabs", "[tab=<id>] [wait=true]", "reload; also wakes a sleeping tab"],
  "full-reload": ["tabs", "[tab=<id>]", "load the page again as a person would get it: pictures on, left running until the next command (an agent's page is bare and stopped by default)"],
  lean: ["browser", "[on=false]", "pictures off for every page of this profile (set by hidden named sessions)"],
  back: ["tabs", "[tab=<id>]", "history back"],
  forward: ["tabs", "[tab=<id>]", "history forward"],
  duplicate: ["tabs", "[tab=<id>]", "open a copy of a tab"],
  pin: ["tabs", "[tab=<id>] [on=false]", "pin or unpin"],
  mute: ["tabs", "[tab=<id>] [on=false]", "mute or unmute"],
  move: ["tabs", "tab=<id> [index=<n>] [window=<id>]", "move a tab"],
  zoom: ["tabs", "[tab=<id>] [factor=<1.25>]", "read or set the zoom"],
  group: ["tabs", "tabs=<id,id,...> [title=<name>] [color=<blue>]", "put tabs in a group"],
  ungroup: ["tabs", "tabs=<id,id,...>", "take tabs out of their group"],
  sleep: ["tabs", "tab=<id> | tabs=<id,id,...>", "put tabs to sleep (frees their memory)"],
  "sleep-others": ["tabs", "", "put every hidden tab to sleep now"],
  "tab-ids-adopt": ["tabs", "pairs=<old:new,...>", "after a restart, tabs answer to the ids they had before (gamblium-cli does this by itself)"],

  windows: ["windows", "", "every window with position, size and state"],
  "window-open": ["windows", "[url=<address>] [left= top= width= height=]", "open a window"],
  "window-close": ["windows", "window=<id>", "close a window"],
  "window-focus": ["windows", "window=<id>", "bring a window forward"],
  "window-set": ["windows", "window=<id> [left= top= width= height=] [state=normal|maximized|minimized|fullscreen]", "move, resize or change state"],

  page: ["read", "[tab=<id>]", "address, title, load state, scroll position, counts of links and forms"],
  text: ["read", "[tab=<id>] [selector=<css>] [max=<chars>]", "visible text of the page or of one element"],
  html: ["read", "[tab=<id>] [selector=<css>] [max=<chars>]", "HTML of the page or of one element"],
  links: ["read", "[tab=<id>] [max=<count>]", "links on the page"],
  elements: ["read", "[tab=<id>] selector=<css> [max=<count>]", "matching elements with text, attributes and a selector for each"],
  forms: ["read", "[tab=<id>]", "every form field with its label, type, value and a selector"],
  find: ["read", "[tab=<id>] text=<text> [max=<count>]", "elements whose own text contains the text"],
  attr: ["read", "[tab=<id>] selector=<css> name=<attribute>", "one attribute of one element"],
  storage: ["read", "[tab=<id>] [kind=local|session]", "the page's localStorage or sessionStorage"],
  screenshot: ["read", "[tab=<id>] [full=true] [out=<file.png>]", "picture of the visible part of the page, or of all of it; in the agent profile the tab need not be showing"],

  click: ["act", "[tab=<id>] selector=<css> | text=<visible text> | x=<px> y=<px> [real=true]", "click an element or a point of the page"],
  mouse: ["act", "[tab=<id>] x=<px> y=<px> [action=click|double|right|move|down|up]", "real mouse input at a point of the page (agent profile)"],
  type: ["act", "[tab=<id>] selector=<css> text=<what to type> [submit=true] [real=true]", "fill a field"],
  press: ["act", "[tab=<id>] key=<Enter|Tab|Escape|ArrowDown|a...> [selector=<css>] [real=true]", "send a key to an element or the focused one"],
  select: ["act", "[tab=<id>] selector=<css> value=<option value or label>", "choose an option in a select"],
  check: ["act", "[tab=<id>] selector=<css> [on=false]", "tick or untick a checkbox or radio"],
  hover: ["act", "[tab=<id>] selector=<css>", "move the pointer over an element"],
  focus: ["act", "[tab=<id>] selector=<css>", "focus an element"],
  submit: ["act", "[tab=<id>] selector=<css>", "submit the form the element belongs to"],
  scroll: ["act", "[tab=<id>] y=<pixels> | by=<pixels> | selector=<css> | to=bottom|top", "scroll the page"],
  wait: ["act", "[tab=<id>] selector=<css> | text=<text> [gone=true] [ms=<timeout>]", "wait until something appears (or is gone)"],
  "wait-load": ["act", "[tab=<id>] [ms=<timeout>]", "wait until the tab has finished loading"],
  eval: ["act", "[tab=<id>] code=<javascript> [real=true]", "run code in the page and return its value; in the agent profile it also works on sites that forbid eval and waits for promises"],

  downloads: ["downloads", "[limit=<n>] [state=in_progress|complete|interrupted]", "the download list"],
  download: ["downloads", "url=<address> [filename=<relative path>] [wait=true]", "start a download"],
  "download-wait": ["downloads", "id=<download id> [ms=<timeout>]", "wait until a download finishes"],
  "download-pause": ["downloads", "id=<download id>", "pause"],
  "download-resume": ["downloads", "id=<download id>", "resume"],
  "download-cancel": ["downloads", "id=<download id>", "cancel"],
  "download-erase": ["downloads", "id=<download id>", "remove from the list (the file stays)"],
  "download-delete": ["downloads", "id=<download id>", "delete the downloaded file from disk and from the list"],
  "download-rules": ["downloads", "[enabled=true|false]", "read the folder rules, or switch them on or off"],

  "capture-start": ["network", "", "start recording requests (address, method, headers, status, timing)"],
  "capture-stop": ["network", "", "stop recording"],
  "capture-status": ["network", "", "is it recording, how many requests are kept"],
  "capture-list": ["network", "[q=<text>] [method=GET] [status=4] [errors=true] [tab=<id>] [limit=<n>]", "recorded requests, newest first"],
  "capture-get": ["network", "id=<request id>", "one request in full, with headers and a curl command"],
  "capture-clear": ["network", "", "forget the recorded requests"],

  "scope-list": ["security", "", "what the user has authorised for testing"],
  "scope-check": ["security", "host=<host>", "is this host in scope (own machine, own network, or listed)"],
  audit: ["security", "url=<address> [cve=true]", "passive check of a page's security headers, cookies and CORS"],
  scan: ["security", "target=<host> [ports=80,443,8000-8100]", "TCP port scan"],
  cve: ["security", "product=<name> version=<version>", "known vulnerabilities for a software version"],

  settings: ["settings", "", "Gamblium's settings in this profile"],
  "settings-set": ["settings", "<key>=<value> ...", "change settings: enabled, delaySec, lowMemoryDelaySec, lowMemoryMb, allowlist, lightSites, routingEnabled, profileLabel"],
  proxy: ["settings", "", "the profile's proxy setting"],
  "proxy-set": ["settings", "mode=direct|system|fixed [scheme=http|https|socks4|socks5 host= port=] [bypass=<host,host>]", "change the proxy"],

  stats: ["memory", "", "memory and CPU per tab and per process type"],
  freeze: ["memory", "pids=<pid,pid,...>", "suspend page processes (experiment)"],
  thaw: ["memory", "pids=<pid,pid,...>", "resume suspended page processes"],
  trim: ["memory", "pids=<pid,pid,...>", "move page processes' memory out of RAM (experiment)"],

  "session-list": ["sessions", "", "saved checkpoints"],
  "session-save": ["sessions", "name=<name> [closeAfter=true] [withPages=false]", "save every window as a checkpoint"],
  "session-restore": ["sessions", "name=<name> [withSettings=true]", "reopen a checkpoint"],
  "session-delete": ["sessions", "name=<name>", "delete a checkpoint"],
  "session-export": ["sessions", "name=<name> [out=<file.json>]", "the checkpoint as JSON"],
  "session-import": ["sessions", "file=<file.json>", "add a checkpoint from a file"],

  cookies: ["cookies", "url=<address> | domain=<domain>", "cookies for a site (agent profile only)"],
  "cookie-set": ["cookies", "url=<address> name=<name> value=<value> [path= secure=true httpOnly=true]", "set a cookie (agent profile only)"],
  "cookie-remove": ["cookies", "url=<address> name=<name>", "remove a cookie (agent profile only)"],
};

// ---- Settings an agent may change ------------------------------------------------

const list = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

// Returns { ok, value } or { ok: false, error } for one setting.
export function validateSetting(key, raw) {
  const bool = (v) => (v === true || v === "true" ? true : v === false || v === "false" ? false : null);
  const int = (v, min, max) => (Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : null);
  switch (key) {
    case "enabled":
    case "routingEnabled": {
      const b = bool(raw);
      return b === null ? { ok: false, error: key + " must be true or false" } : { ok: true, value: b };
    }
    case "delaySec":
    case "lowMemoryDelaySec": {
      const n = int(raw, 30, 86400);
      return n === null ? { ok: false, error: key + " must be a whole number of seconds from 30 to 86400" } : { ok: true, value: n };
    }
    case "lowMemoryMb": {
      const n = int(raw, 0, 65536);
      return n === null ? { ok: false, error: "lowMemoryMb must be a whole number from 0 to 65536" } : { ok: true, value: n };
    }
    case "allowlist":
    case "lightSites": {
      const hosts = list(raw).map((h) => h.toLowerCase());
      const bad = hosts.find((h) => !HOST.test(h));
      return bad ? { ok: false, error: "'" + bad + "' is not a host name" } : { ok: true, value: hosts };
    }
    case "profileLabel":
      return { ok: true, value: String(raw).trim().slice(0, 40) };
    default:
      return { ok: false, error: "'" + key + "' is not a setting an agent can change" };
  }
}

// ---- Functions that run inside the page (self-contained) -----------------------

function pageInfo() {
  return {
    ok: true, url: location.href, title: document.title, readyState: document.readyState,
    scrollY: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight, viewHeight: innerHeight,
    links: document.links.length, forms: document.forms.length, lang: document.documentElement.lang || null,
  };
}

function pageText(selector, max) {
  const el = selector ? document.querySelector(selector) : document.body;
  if (!el) return { ok: false, error: "nothing matches " + selector };
  const text = el.innerText || el.textContent || "";
  return { ok: true, title: document.title, url: location.href, text: text.slice(0, max), truncated: text.length > max, length: text.length };
}

function pageHtml(selector, max) {
  const el = selector ? document.querySelector(selector) : document.documentElement;
  if (!el) return { ok: false, error: "nothing matches " + selector };
  const html = el.outerHTML;
  return { ok: true, url: location.href, html: html.slice(0, max), truncated: html.length > max, length: html.length };
}

function pageLinks(max) {
  const links = [];
  for (const a of document.querySelectorAll("a[href]")) {
    if (links.length >= max) break;
    const text = (a.innerText || a.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 120);
    links.push({ text, href: a.href });
  }
  return { ok: true, url: location.href, links };
}

// mode: "selector" (query is CSS), "text" (query is text an element itself contains), "forms" (every field)
function pageElements(mode, query, max) {
  const cssPath = (el) => {
    if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) return "#" + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 10) {
      let i = 1;
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === node.tagName) i++;
      parts.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + i + ")");
      node = node.parentElement;
    }
    return parts.join(" > ");
  };
  const labelOf = (el) => {
    if (el.labels && el.labels[0]) return el.labels[0].innerText.trim().slice(0, 80);
    return el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || "";
  };
  let found;
  try {
    if (mode === "forms") found = [...document.querySelectorAll("input, textarea, select, button")];
    else if (mode === "text") {
      const want = query.toLowerCase();
      found = [...document.querySelectorAll("body *")].filter((el) =>
        [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.toLowerCase().includes(want)));
    } else found = [...document.querySelectorAll(query)];
  } catch (e) {
    return { ok: false, error: "bad selector: " + e.message };
  }
  const rows = found.slice(0, max).map((el) => {
    const r = el.getBoundingClientRect();
    const row = {
      tag: el.tagName.toLowerCase(), selector: cssPath(el), text: (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 120),
      visible: r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden",
    };
    for (const a of ["id", "name", "type", "href", "role", "placeholder", "aria-label"]) {
      const v = el.getAttribute(a);
      if (v) row[a] = v.slice(0, 200);
    }
    if (mode === "forms") {
      row.label = labelOf(el);
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "checkbox" || type === "radio") row.checked = el.checked;
      else if (type !== "password" && "value" in el) row.value = String(el.value).slice(0, 200);
      if (el.tagName === "SELECT") row.options = [...el.options].slice(0, 50).map((o) => ({ value: o.value, label: o.label }));
      if (el.disabled) row.disabled = true;
    }
    return row;
  });
  return { ok: true, url: location.href, count: found.length, elements: rows };
}

function pageAttr(selector, name) {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, error: "nothing matches " + selector };
  return { ok: true, value: name in el && typeof el[name] !== "function" && typeof el[name] !== "object" ? el[name] : el.getAttribute(name) };
}

function pageStorage(kind) {
  try {
    const store = kind === "session" ? sessionStorage : localStorage;
    const items = {};
    let size = 0;
    for (let i = 0; i < store.length && i < 300; i++) {
      const k = store.key(i);
      const v = store.getItem(k);
      size += k.length + v.length;
      if (size > 400000) break;
      items[k] = v;
    }
    return { ok: true, kind: kind === "session" ? "session" : "local", count: store.length, items };
  } catch (e) {
    return { ok: false, error: "storage is not available on this page: " + e.message };
  }
}

// pointOnly: do not click, answer with the element's centre (for real input).
// x, y: click whatever is at that point of the visible page.
function pageClick(selector, text, pointOnly, x, y) {
  let el = null;
  if (typeof x === "number" && typeof y === "number") {
    el = document.elementFromPoint(x, y);
    if (!el && !innerWidth) return { ok: false, error: "the page has no visible area because its window is minimised. In the agent profile add real=true, or start it with no window: gamblium launch --agent --hidden" };
    if (!el) return { ok: false, error: "nothing is at " + x + "," + y + " (the visible page is " + innerWidth + " x " + innerHeight + ")" };
    const at = { clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...at, buttons: 1 }));
    if (el.focus) el.focus();
    el.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseup", at));
    el.dispatchEvent(new MouseEvent("click", at));
    return { ok: true, clicked: el.tagName.toLowerCase(), text: (el.innerText || el.value || "").trim().slice(0, 80), x, y };
  }
  if (selector) el = document.querySelector(selector);
  else if (text) {
    const want = text.trim().toLowerCase();
    const candidates = document.querySelectorAll("a, button, [role=button], [role=link], [role=tab], [role=menuitem], input[type=submit], input[type=button], summary, label");
    for (const c of candidates) {
      const t = (c.innerText || c.value || c.getAttribute("aria-label") || "").trim().toLowerCase();
      if (t === want) { el = c; break; }
      if (!el && t.includes(want)) el = c;
    }
  }
  if (!el) return { ok: false, error: "nothing to click matches " + (selector || text) };
  el.scrollIntoView({ block: "center" });
  if (pointOnly) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { ok: false, error: (selector || text) + " has no size on the page, so a real click cannot reach it" };
    return { ok: true, clicked: el.tagName.toLowerCase(), text: (el.innerText || el.value || "").trim().slice(0, 80), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }
  el.click();
  return { ok: true, clicked: el.tagName.toLowerCase(), text: (el.innerText || el.value || "").trim().slice(0, 80) };
}

function pageType(selector, text, submit) {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, error: "nothing matches " + selector };
  el.scrollIntoView({ block: "center" });
  el.focus();
  if (el.isContentEditable) {
    el.textContent = text;
  } else {
    // Frameworks watch the native setter, not the property on the element.
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, text);
    else el.value = text;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  if (submit) {
    const form = el.form;
    if (form && form.requestSubmit) form.requestSubmit();
    else {
      for (const type of ["keydown", "keypress", "keyup"]) {
        el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      }
    }
  }
  return { ok: true, typed: text.length, submitted: !!submit };
}

// action: press | select | check | hover | focus | submit
function pageAct(action, selector, value) {
  const el = selector ? document.querySelector(selector) : document.activeElement || document.body;
  if (!el) return { ok: false, error: "nothing matches " + selector };
  if (selector) el.scrollIntoView({ block: "center" });
  if (action === "press") {
    const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, " ": 32, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
    const key = value === "Space" ? " " : value;
    const keyCode = codes[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    if (selector) el.focus();
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, { key, code: key.length === 1 ? "Key" + key.toUpperCase() : key, keyCode, which: keyCode, bubbles: true, cancelable: true }));
    }
    // Synthetic keys do not submit forms by themselves; do what Enter would.
    if (key === "Enter" && el.form && el.tagName !== "TEXTAREA") {
      if (el.form.requestSubmit) el.form.requestSubmit();
    }
    return { ok: true, pressed: key, on: el.tagName.toLowerCase() };
  }
  if (action === "select") {
    if (el.tagName !== "SELECT") return { ok: false, error: selector + " is not a select" };
    const want = String(value).toLowerCase();
    const opt = [...el.options].find((o) => o.value === String(value)) || [...el.options].find((o) => o.label.trim().toLowerCase() === want);
    if (!opt) return { ok: false, error: "no option '" + value + "'", options: [...el.options].slice(0, 50).map((o) => o.label) };
    el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, selected: opt.label, value: opt.value };
  }
  if (action === "check") {
    if (el.checked !== value) el.click();
    return { ok: true, checked: el.checked };
  }
  if (action === "hover") {
    const r = el.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true };
    for (const type of ["pointerover", "mouseover", "pointerenter", "mouseenter", "pointermove", "mousemove"]) el.dispatchEvent(new MouseEvent(type, at));
    return { ok: true, hovered: el.tagName.toLowerCase() };
  }
  if (action === "focus") {
    el.focus();
    return { ok: true, focused: document.activeElement === el };
  }
  if (action === "submit") {
    const form = el.tagName === "FORM" ? el : el.form || el.closest("form");
    if (!form) return { ok: false, error: selector + " is not in a form" };
    if (form.requestSubmit) form.requestSubmit();
    else form.submit();
    return { ok: true, submitted: true };
  }
  return { ok: false, error: "unknown action" };
}

function pageScroll(y, by, selector, to) {
  if (selector) {
    const el = document.querySelector(selector);
    if (!el) return { ok: false, error: "nothing matches " + selector };
    el.scrollIntoView({ block: "center" });
  } else if (to === "bottom") window.scrollTo(0, document.documentElement.scrollHeight);
  else if (to === "top") window.scrollTo(0, 0);
  else if (typeof by === "number") window.scrollBy(0, by);
  else window.scrollTo(0, typeof y === "number" ? y : 0);
  return { ok: true, scrollY: Math.round(window.scrollY), pageHeight: document.documentElement.scrollHeight, viewHeight: window.innerHeight };
}

function pageHas(selector, text) {
  if (selector) {
    try {
      return !!document.querySelector(selector);
    } catch {
      return false;
    }
  }
  return (document.body.innerText || "").toLowerCase().includes(String(text).toLowerCase());
}

function pageEval(code) {
  try {
    // eslint-disable-next-line no-eval
    const value = (0, eval)(code);
    return { ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// ---- Real input (agent profile) --------------------------------------------------
// A click made by script is marked as not coming from a person, and some pages
// ignore it. The agent profile's copy of the extension may attach a debugger
// to one tab for the length of one command and send real mouse and keyboard
// input through it. This works on a tab that is not showing, in a minimised
// window, and with no window at all. The debugger is detached straight away,
// because an attached debugger stops tabs from sleeping.

const KEY_CODES = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32,
};

// What to send for one key: a named key ("Enter") or one character ("a").
export function keyEvent(raw) {
  const key = raw === " " ? "Space" : String(raw);
  if (KEY_CODES[key]) {
    const text = key === "Enter" ? "\r" : key === "Space" ? " " : key === "Tab" ? "\t" : undefined;
    return { ok: true, event: { key: key === "Space" ? " " : key, code: key, windowsVirtualKeyCode: KEY_CODES[key], ...(text ? { text } : {}) } };
  }
  if ([...key].length !== 1) return { ok: false, error: "unknown key '" + raw + "'. Use one character or: " + Object.keys(KEY_CODES).join(", ") };
  const upper = key.toUpperCase();
  const code = /^[a-z]$/i.test(key) ? "Key" + upper : /^[0-9]$/.test(key) ? "Digit" + key : "";
  return { ok: true, event: { key, code, windowsVirtualKeyCode: /^[a-z0-9]$/i.test(key) ? upper.charCodeAt(0) : 0, text: key } };
}

async function withDebugger(tabId, fn) {
  if (!chrome.debugger) {
    return { ok: false, needsAgentProfile: true, error: "real input needs the agent profile: gamblium launch --agent" };
  }
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (e) {
    return { ok: false, error: "could not reach the tab for real input: " + errText(e) };
  }
  const send = (method, params) =>
    Promise.race([
      chrome.debugger.sendCommand(target, method, params || {}),
      new Promise((_, reject) => setTimeout(() => reject(new Error(method + " got no answer from the tab within 8 s")), 8000)),
    ]);
  try {
    return await fn(send);
  } catch (e) {
    return { ok: false, error: errText(e) };
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

// A minimised window gives its page no area at all (0 x 0), so nothing can be
// pointed at or photographed. For the length of one command the page is lent
// a size; it is taken back when the debugger detaches.
const LENT = { width: 1280, height: 800 };
async function lendViewport(send) {
  const m = await send("Page.getLayoutMetrics");
  const v = m.cssLayoutViewport || m.layoutViewport;
  if (v && v.clientWidth > 0 && v.clientHeight > 0) return null;
  await send("Emulation.setDeviceMetricsOverride", { ...LENT, deviceScaleFactor: 1, mobile: false });
  return LENT.width + " x " + LENT.height + ", lent because the window is minimised";
}

async function mouseSequence(send, x, y, action) {
  const button = action === "right" ? "right" : "left";
  const buttons = button === "right" ? 2 : 1;
  const mouse = (type, more) => send("Input.dispatchMouseEvent", { type, x, y, pointerType: "mouse", ...more });
  await mouse("mouseMoved", { button: "none" });
  if (["down", "click", "right", "double"].includes(action)) await mouse("mousePressed", { button, buttons, clickCount: 1 });
  if (["up", "click", "right", "double"].includes(action)) await mouse("mouseReleased", { button, clickCount: 1 });
  if (action === "double") {
    await mouse("mousePressed", { button, buttons, clickCount: 2 });
    await mouse("mouseReleased", { button, clickCount: 2 });
  }
}

// action: click | double | right | move | down | up
function realMouse(tabId, x, y, action = "click") {
  if (!["click", "double", "right", "move", "down", "up"].includes(action)) {
    return Promise.resolve({ ok: false, error: "action must be click, double, right, move, down or up" });
  }
  return withDebugger(tabId, async (send) => {
    const viewport = await lendViewport(send);
    await mouseSequence(send, x, y, action);
    return { ok: true, real: true, action, x, y, ...(viewport ? { viewport } : {}) };
  });
}

// Finds the element, scrolls it into view and clicks its centre for real.
function realClickElement(tabId, selector, text) {
  return withDebugger(tabId, async (send) => {
    const viewport = await lendViewport(send);
    const expression = "(" + pageClick.toString() + ")(" + JSON.stringify(selector) + "," + JSON.stringify(text) + ",true,null,null)";
    const r = await send("Runtime.evaluate", { expression, returnByValue: true });
    const found = r.result && r.result.value;
    if (!found) return { ok: false, error: "the page gave no answer" };
    if (found.ok === false) return found;
    await mouseSequence(send, found.x, found.y, "click");
    return { ok: true, real: true, action: "click", clicked: found.clicked, text: found.text, x: found.x, y: found.y, ...(viewport ? { viewport } : {}) };
  });
}

function realKey(tabId, key) {
  const k = keyEvent(key);
  if (!k.ok) return Promise.resolve(k);
  return withDebugger(tabId, async (send) => {
    await send("Input.dispatchKeyEvent", { type: k.event.text ? "keyDown" : "rawKeyDown", ...k.event });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...k.event, text: undefined });
    return { ok: true, real: true, pressed: k.event.key };
  });
}

function realText(tabId, text, submit) {
  return withDebugger(tabId, async (send) => {
    await send("Input.insertText", { text });
    if (submit) {
      const enter = keyEvent("Enter").event;
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...enter });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...enter, text: undefined });
    }
    return { ok: true, real: true, typed: text.length, submitted: !!submit };
  });
}

function realEval(tabId, code) {
  return withDebugger(tabId, async (send) => {
    const r = await send("Runtime.evaluate", { expression: code, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception;
      return { ok: false, error: (ex && (ex.description || ex.value)) || r.exceptionDetails.text || "the code threw" };
    }
    return { ok: true, real: true, value: r.result.value === undefined ? null : r.result.value };
  });
}

// A picture without showing the tab. full: the whole page, not only what is visible.
function realScreenshot(tabId, full) {
  return withDebugger(tabId, async (send) => {
    const params = { format: "png" };
    await lendViewport(send);
    if (full) {
      // Make the page as tall as its content for this one picture.
      const m = await send("Page.getLayoutMetrics");
      const size = m.cssContentSize || m.contentSize;
      const view = m.cssLayoutViewport || m.layoutViewport;
      await send("Emulation.setDeviceMetricsOverride", {
        width: Math.max(1, Math.round(view.clientWidth || LENT.width)),
        height: Math.max(1, Math.min(Math.ceil(size.height), 16000)),
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
    const shot = await send("Page.captureScreenshot", params);
    return { ok: true, real: true, tab: tabId, dataUrl: "data:image/png;base64," + shot.data };
  });
}

// An address an agent may open: a web page, or a blank tab. Files on this
// computer and the browser's own pages are refused: an agent that could open
// file:///C:/... could read any file the user can.
export function openableUrl(raw) {
  const text = String(raw ?? "").trim();
  if (text === "about:blank") return { ok: true, url: text };
  let u;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, error: "'" + text.slice(0, 80) + "' is not an address. Give a full one, such as https://example.com/" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: "only http and https addresses can be opened, not " + u.protocol + " (files on this computer and browser pages are off limits to agents)" };
  }
  return { ok: true, url: u.href };
}

// A checkpoint name an agent may use: short, printable, no path characters.
export function sessionNameError(raw) {
  const name = String(raw ?? "");
  if (!name.trim()) return "give the session a name";
  if (name.length > 64) return "a session name can be at most 64 characters";
  if (/[\\/:*?"<>|\x00-\x1f]/.test(name) || name.includes("..")) return "a session name cannot contain / \\ : * ? \" < > | or ..";
  return null;
}

// ---- The command runner ----------------------------------------------------------

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const ids = (v) => list(v).map(Number).filter(Number.isInteger);
const errText = (e) => String(e && e.message ? e.message : e);

const tabRow = (t) => ({
  id: t.id, window: t.windowId, index: t.index, title: t.title || "", url: t.pendingUrl || t.url || "",
  active: !!t.active, pinned: !!t.pinned, audible: !!t.audible, muted: !!(t.mutedInfo && t.mutedInfo.muted),
  group: t.groupId === undefined || t.groupId === -1 ? null : t.groupId, state: t.discarded ? "asleep" : "awake", loading: t.status === "loading",
});

const windowRow = (w) => ({
  id: w.id, focused: w.focused, state: w.state, left: w.left, top: w.top, width: w.width, height: w.height, tabs: w.tabs ? w.tabs.length : undefined,
});

// One id per tab for its whole life (owner, Nov 13 2026). The browser gives
// a tab a NEW id when it is put to sleep (chrome.tabs.discard) and on some
// wakes, so an agent holding the id `open` returned would lose its tab.
// `fwd` maps every id a tab had to the one it has now (chains collapsed);
// `origin` maps the id it has now to the first one. Commands take any of
// them; every answer names the tab by its first id.
const ALIAS_LIMIT = 4000;

function trim(o) {
  const keys = Object.keys(o);
  for (const k of keys.slice(0, Math.max(0, keys.length - ALIAS_LIMIT))) delete o[k];
  return o;
}

export function emptyIdMaps() {
  return { fwd: {}, origin: {} };
}

export function noteReplaced(maps, added, removed) {
  const fwd = {};
  for (const [k, v] of Object.entries((maps && maps.fwd) || {})) fwd[k] = v === removed ? added : v;
  fwd[removed] = added;
  delete fwd[added];
  const origin = { ...((maps && maps.origin) || {}) };
  const first = origin[removed] ?? removed;
  delete origin[removed];
  origin[added] = first;
  return { fwd: trim(fwd), origin: trim(origin) };
}

export function followId(maps, id) {
  let i = id;
  const fwd = (maps && maps.fwd) || {};
  for (let n = 0; n < 20 && fwd[i] !== undefined; n++) i = fwd[i];
  return i;
}

export function firstId(maps, id) {
  const origin = (maps && maps.origin) || {};
  return typeof id === "number" && origin[id] !== undefined ? origin[id] : id;
}

// An answer with every tab named by its first id.
export function answerIds(answer, maps) {
  if (!answer || typeof answer !== "object" || !maps) return answer;
  const one = (x) => (x && typeof x === "object" && typeof x.id === "number" ? { ...x, id: firstId(maps, x.id) } : firstId(maps, x));
  const out = { ...answer };
  for (const key of ["tab", "tabs", "slept", "closed"]) {
    if (Array.isArray(out[key])) out[key] = out[key].map(one);
    else if (out[key] !== undefined && key === "tab") out[key] = one(out[key]);
  }
  if (typeof out.tabId === "number") out.tabId = firstId(maps, out.tabId);
  return out;
}

// After a restart (a session shown or hidden, stopped and started) every tab
// is new. The tabs it had are opened again, and each takes over the id it had.
export function adoptIds(maps, pairs) {
  const fwd = { ...((maps && maps.fwd) || {}) };
  const origin = { ...((maps && maps.origin) || {}) };
  for (const [old, now] of pairs) {
    if (!Number.isInteger(old) || !Number.isInteger(now) || old === now) continue;
    delete fwd[now];
    fwd[old] = now;
    origin[now] = old;
  }
  return { fwd: trim(fwd), origin: trim(origin) };
}

export function idPairs(text) {
  return list(text).map((p) => p.split(":").map(Number)).filter((p) => p.length === 2 && p.every(Number.isInteger));
}

// Set by makeCtl: the tab's id now, and the last address it was on.
let idNow = async (id) => id;
let lastUrlOf = async () => null;

async function resolveTab(tab) {
  if (typeof tab === "number") return chrome.tabs.get(tab);
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) throw new Error("there is no active tab; pass tab=<id>");
  return active;
}

function tabIds(cmd) {
  const many = ids(cmd.tabs);
  if (many.length) return many;
  if (typeof cmd.tab === "number") return [cmd.tab];
  throw new Error("pass tab=<id> or tabs=<id,id,...>");
}

// Follows the tab if the browser gives it a new id meanwhile (a wake can).
async function tabNow(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (e) {
    const id = await idNow(tabId);
    if (id === tabId) throw e;
    return chrome.tabs.get(id);
  }
}

async function waitLoaded(tabId, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = await tabNow(tabId);
    if (t.status === "complete") return t;
    tabId = t.id;
    await sleepMs(150);
  }
  return tabNow(tabId);
}

// A sleeping tab holds no page. A command for it wakes that one tab (and
// only that one) and waits for its page, so a session can keep every tab
// asleep until it is worked on.
// It wakes on the page it was last on: a sleeping tab can hold an earlier
// address than the one the agent had moved it to (tester, Nov 13 2026).
async function wake(tab) {
  if (!tab.discarded) return tab;
  const last = await lastUrlOf(tab.id);
  if (last && last !== tab.url && /^https?:/.test(last)) await chrome.tabs.update(tab.id, { url: last });
  else await chrome.tabs.reload(tab.id);
  return waitLoaded(tab.id, 15000);
}

async function inPage(tab, func, args, world) {
  tab = await wake(tab);
  const run = chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args, ...(world ? { world } : {}) });
  const timeout = new Promise((r) => setTimeout(() => r("timeout"), 10000));
  let result;
  try {
    result = await Promise.race([run, timeout]);
  } catch (e) {
    const msg = errText(e);
    if (/permission|Cannot access/i.test(msg)) {
      return { ok: false, needsPageAccess: true, error: "Gamblium may not look at this page. Use a named session (gamblium-cli), or ask the person to switch on Settings > Agents > \"Let command-line agents control this profile\". (" + msg + ")" };
    }
    return { ok: false, error: msg };
  }
  if (result === "timeout") return { ok: false, error: "the page did not answer; it may be frozen in the background. Use activate first." };
  return result && result[0] ? result[0].result : { ok: false, error: "the page gave no answer" };
}

function pageHistory(step) {
  history.go(step);
  return { ok: true };
}

// Back or forward. The browser's own Back skips pages that moved on without a
// real click, which is every page an agent drove, so fall back to the page's
// history, which does not skip them.
async function historyStep(tab, step) {
  const before = tab.url;
  try {
    await (step < 0 ? chrome.tabs.goBack(tab.id) : chrome.tabs.goForward(tab.id));
  } catch (e) {
    const r = await inPage(tab, pageHistory, [step]);
    if (!r || r.ok === false) return { ok: false, error: errText(e) };
  }
  for (let i = 0; i < 40; i++) {
    await sleepMs(150);
    const t = await chrome.tabs.get(tab.id);
    if (t.url !== before && t.status === "complete") return { ok: true, tab: tabRow(t) };
  }
  return { ok: false, error: "there is no page to go " + (step < 0 ? "back" : "forward") + " to" };
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => typeof obj[k] === "number").map((k) => [k, obj[k]]));
const need = (cmd, ...keys) => {
  const missing = keys.filter((k) => cmd[k] === undefined || cmd[k] === "");
  if (missing.length) throw new Error(cmd.op + " needs " + missing.map((k) => k + "=...").join(" "));
};

// deps: functions from the background script that commands reuse.
// Commands that change browser or Gamblium settings. An agent may run them
// only while the user's permission is in force (asked in the user's own
// Gamblium: not now, 30 minutes, 1, 2 or 6 hours, or never ask).
export const NEEDS_PERMISSION = new Set(["settings-set", "proxy-set"]);

// A page that is a check for people ("verify you are human"), by its title
// or address. An agent cannot pass one and must not try; left running in a
// session with no window such a page took 10 to 70% of one core and grew by
// about 4 MB a second (tester). The command's answer names it, the tab is
// stopped, and a person can open the session in a window to pass the check.
export function wallOf(title, url) {
  const t = String(title || "").trim().toLowerCase();
  const u = String(url || "").toLowerCase();
  if (u.includes("/cdn-cgi/challenge-platform") || t === "just a moment..." || t.startsWith("attention required")) return "cloudflare";
  if (/^(verify(ing)? (that )?you are (a )?human|are you a robot|human verification|security check)/.test(t)) return "check";
  return null;
}
export const WALL_HINT = "This page is a check for people. Show the session in a window (gamblium-cli open <name>), pass the check there, then hide it again. The tab has been stopped meanwhile.";
// Cloudflare's automatic check ("Just a moment...") passes by itself in an
// ordinary browser window and never in a hidden (headless) one, whose
// clearance also does not carry over (tester, Nov 13 2026). Gamblium does not
// disguise a hidden browser; the session can run as a real window instead.
export const AUTO_CHECK_HINT_HIDDEN = "This site runs an automatic check that a hidden browser does not pass. Run `gamblium-cli set <name> window=on`, then repeat the command with wait=true: the session then runs as an ordinary, minimised browser window, where this check usually passes by itself within 10 s. If the check asks for a click or a picture, a person must do it: `gamblium-cli open <name>`. The tab has been stopped meanwhile.";
export const AUTO_CHECK_HINT_WINDOW = "The site is checking the browser. In a window this usually passes by itself in about 10 s: `wait-load`, or repeat the command shortly. If it asks for a click or a picture, a person must do it in the session's window.";
const CHECK_WAIT_MS = 30000;
async function waitPastCheck(tabId, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await sleepMs(500);
    const t = await tabNow(tabId).catch(() => null);
    if (!t) return null;
    tabId = t.id;
    if (t.status === "complete" && !wallOf(t.title, t.url)) return { ...t, waitedMs: Date.now() - start };
  }
  return null;
}

export function wallHint(wall, noWindow) {
  if (wall === "cloudflare") return noWindow ? AUTO_CHECK_HINT_HIDDEN : AUTO_CHECK_HINT_WINDOW;
  return WALL_HINT;
}

export function makeCtl(deps) {
  const idMaps = async () => (deps.idMaps ? deps.idMaps() : null);
  if (deps.idMaps) idNow = async (id) => followId(await deps.idMaps(), id);
  if (deps.lastUrl) lastUrlOf = (id) => deps.lastUrl(id);
  const handlers = {
    // ---- browser
    help: async () => ({ ok: true, ops: Object.fromEntries(Object.entries(OPS).map(([k, [group, args, about]]) => [k, { group, args, about }])) }),
    info: async () => {
      const m = chrome.runtime.getManifest();
      const helper = await deps.native({ type: "ping" });
      return {
        ok: true, extension: m.version_name || m.version, name: m.name, agentProfile: (m.host_permissions || []).includes("<all_urls>"),
        pageAccess: await chrome.permissions.contains({ origins: ["<all_urls>"] }),
        cookies: !!chrome.cookies, realInput: !!chrome.debugger, hidden: /Headless/.test(navigator.userAgent), helper: helper.ok ? helper.version : null, browserPid: helper.browserPid ?? null,
        profile: await deps.profileInfo(), commands: Object.keys(OPS).length,
      };
    },

    // ---- tabs
    tabs: async (c) => {
      // A tab our freezer holds answers no page command until it is shown: say so before an agent tries.
      const frozen = deps.frozenTabs ? await deps.frozenTabs() : {};
      let tabs = (await chrome.tabs.query({})).map((t) => (frozen[t.id] && !t.discarded && (!t.active || deps.noWindow) ? { ...tabRow(t), state: "frozen" } : tabRow(t)));
      if (c.q !== undefined) {
        const q = String(c.q).toLowerCase();
        tabs = tabs.filter((t) => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q));
      }
      return { ok: true, tabs };
    },
    open: async (c) => {
      need(c, "url");
      const addr = openableUrl(c.url);
      if (!addr.ok) return addr;
      c = { ...c, url: addr.url };
      let t = await chrome.tabs.create({ url: c.url, active: !c.background, ...(typeof c.window === "number" ? { windowId: c.window } : {}) });
      if (c.wait) t = await waitLoaded(t.id);
      return { ok: true, tab: tabRow(t) };
    },
    close: async (c) => {
      const list = c.tab === undefined && c.tabs === undefined ? [(await resolveTab()).id] : tabIds(c);
      await chrome.tabs.remove(list);
      return { ok: true, closed: list };
    },
    activate: async (c) => {
      const t = await resolveTab(c.tab);
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      return { ok: true, tab: tabRow(await waitLoaded(t.id, 15000)) };
    },
    navigate: async (c) => {
      need(c, "url");
      const addr = openableUrl(c.url);
      if (!addr.ok) return addr;
      const t = await resolveTab(c.tab);
      await chrome.tabs.update(t.id, { url: addr.url });
      return { ok: true, tab: tabRow(c.wait ? await waitLoaded(t.id) : await chrome.tabs.get(t.id)) };
    },
    reload: async (c) => {
      const t = await resolveTab(c.tab);
      await chrome.tabs.reload(t.id);
      return { ok: true, tab: tabRow(c.wait ? await waitLoaded(t.id) : await chrome.tabs.get(t.id)) };
    },
    "full-reload": async (c) => {
      const t = await resolveTab(c.tab);
      if (!deps.fullReload) return { ok: false, error: "full-reload is for an agent's profile" };
      await deps.fullReload(t);
      return { ok: true, full: true, tab: tabRow(await waitLoaded(t.id)) };
    },
    lean: async (c) => (deps.lean ? deps.lean(c.on !== false) : { ok: false, error: "not available in this profile" }),
    back: async (c) => historyStep(await resolveTab(c.tab), -1),
    forward: async (c) => historyStep(await resolveTab(c.tab), 1),
    duplicate: async (c) => ({ ok: true, tab: tabRow(await chrome.tabs.duplicate((await resolveTab(c.tab)).id)) }),
    pin: async (c) => ({ ok: true, tab: tabRow(await chrome.tabs.update((await resolveTab(c.tab)).id, { pinned: c.on !== false })) }),
    mute: async (c) => ({ ok: true, tab: tabRow(await chrome.tabs.update((await resolveTab(c.tab)).id, { muted: c.on !== false })) }),
    move: async (c) => {
      need(c, "tab");
      const moved = await chrome.tabs.move(c.tab, { index: typeof c.index === "number" ? c.index : -1, ...(typeof c.window === "number" ? { windowId: c.window } : {}) });
      return { ok: true, tab: tabRow(moved) };
    },
    zoom: async (c) => {
      const t = await resolveTab(c.tab);
      const factor = Number(c.factor);
      if (c.factor !== undefined) {
        if (!(factor >= 0.25 && factor <= 5)) return { ok: false, error: "factor must be between 0.25 and 5" };
        await chrome.tabs.setZoom(t.id, factor);
      }
      return { ok: true, tab: t.id, factor: await chrome.tabs.getZoom(t.id) };
    },
    group: async (c) => {
      const groupId = await chrome.tabs.group({ tabIds: tabIds(c) });
      const update = {};
      if (c.title !== undefined) update.title = String(c.title);
      if (c.color !== undefined) update.color = String(c.color);
      if (Object.keys(update).length) await chrome.tabGroups.update(groupId, update);
      return { ok: true, group: groupId };
    },
    ungroup: async (c) => {
      await chrome.tabs.ungroup(tabIds(c));
      return { ok: true };
    },
    sleep: async (c) => {
      const slept = [];
      for (const id of tabIds(c)) {
        try {
          await chrome.tabs.discard(id);
          slept.push(id);
        } catch {
          // The showing tab of a window cannot sleep.
        }
      }
      return { ok: true, slept };
    },
    "tab-ids-adopt": async (c) => {
      const pairs = idPairs(c.pairs);
      if (deps.adoptIds) await deps.adoptIds(pairs);
      return { ok: true, adopted: pairs.length };
    },
    "sleep-others": async () => {
      const tabs = await chrome.tabs.query({ active: false, discarded: false });
      const slept = [];
      for (const t of tabs) {
        if (t.audible || t.pinned) continue;
        try {
          await chrome.tabs.discard(t.id);
          slept.push(t.id);
        } catch {
          // Could not sleep this one.
        }
      }
      return { ok: true, slept };
    },

    // ---- windows
    windows: async () => ({ ok: true, windows: (await chrome.windows.getAll({ populate: true })).map(windowRow) }),
    "window-open": async (c) => {
      if (c.url !== undefined) {
        const addr = openableUrl(c.url);
        if (!addr.ok) return addr;
        c = { ...c, url: addr.url };
      }
      const w = await chrome.windows.create({ ...(c.url ? { url: c.url } : {}), ...pick(c, ["left", "top", "width", "height"]) });
      return { ok: true, window: windowRow(w), tab: w.tabs && w.tabs[0] ? w.tabs[0].id : null };
    },
    "window-close": async (c) => {
      need(c, "window");
      await chrome.windows.remove(c.window);
      return { ok: true };
    },
    "window-focus": async (c) => {
      need(c, "window");
      return { ok: true, window: windowRow(await chrome.windows.update(c.window, { focused: true })) };
    },
    "window-set": async (c) => {
      need(c, "window");
      const bounds = pick(c, ["left", "top", "width", "height"]);
      let w = null;
      // The browser refuses a position together with maximized, minimized or fullscreen.
      if (Object.keys(bounds).length) w = await chrome.windows.update(c.window, { state: "normal", ...bounds });
      if (c.state) w = await chrome.windows.update(c.window, { state: String(c.state) });
      if (!w) return { ok: false, error: "window-set needs left, top, width, height or state" };
      return { ok: true, window: windowRow(w) };
    },

    // ---- read
    page: async (c) => inPage(await resolveTab(c.tab), pageInfo, []),
    text: async (c) => inPage(await resolveTab(c.tab), pageText, [c.selector || null, Number(c.max) || 50000]),
    html: async (c) => inPage(await resolveTab(c.tab), pageHtml, [c.selector || null, Number(c.max) || 200000]),
    links: async (c) => inPage(await resolveTab(c.tab), pageLinks, [Number(c.max) || 300]),
    elements: async (c) => {
      need(c, "selector");
      return inPage(await resolveTab(c.tab), pageElements, ["selector", c.selector, Number(c.max) || 50]);
    },
    forms: async (c) => inPage(await resolveTab(c.tab), pageElements, ["forms", null, Number(c.max) || 200]),
    find: async (c) => {
      need(c, "text");
      return inPage(await resolveTab(c.tab), pageElements, ["text", String(c.text), Number(c.max) || 30]);
    },
    attr: async (c) => {
      need(c, "selector", "name");
      return inPage(await resolveTab(c.tab), pageAttr, [c.selector, String(c.name)]);
    },
    storage: async (c) => inPage(await resolveTab(c.tab), pageStorage, [c.kind === "session" ? "session" : "local"]),
    screenshot: async (c) => {
      const t = await resolveTab(c.tab);
      if (chrome.debugger) {
        // No need to show the tab; works minimised and with no window.
        await wake(t);
        const shot = await realScreenshot(t.id, c.full === true);
        if (shot.ok || c.full === true) return shot;
      } else if (c.full === true) {
        return { ok: false, needsAgentProfile: true, error: "a picture of the whole page needs the agent profile: gamblium launch --agent" };
      }
      if (!t.active) {
        await chrome.tabs.update(t.id, { active: true });
        await waitLoaded(t.id, 15000);
        await sleepMs(300);
      }
      try {
        return { ok: true, tab: t.id, dataUrl: await chrome.tabs.captureVisibleTab(t.windowId, { format: "png" }) };
      } catch (e) {
        return { ok: false, needsPageAccess: true, error: "Gamblium may not take a picture of this page: " + errText(e) };
      }
    },

    // ---- act
    click: async (c) => {
      const at = typeof c.x === "number" && typeof c.y === "number";
      if (!c.selector && c.text === undefined && !at) return { ok: false, error: "click needs selector=<css>, text=<visible text> or x=<px> y=<px>" };
      const t = await resolveTab(c.tab);
      const text = c.text === undefined ? null : String(c.text);
      if (c.real !== true) {
        const r = await inPage(t, pageClick, [c.selector || null, text, false, at ? c.x : null, at ? c.y : null]);
        // A point in a minimised window: only real input can reach it.
        if (at && r && r.ok === false && chrome.debugger && /window is minimised/.test(r.error || "")) return realMouse(t.id, c.x, c.y, "click");
        return r;
      }
      if (at) return realMouse(t.id, c.x, c.y, "click");
      return realClickElement(t.id, c.selector || null, text);
    },
    mouse: async (c) => {
      if (typeof c.x !== "number" || typeof c.y !== "number") return { ok: false, error: "mouse needs x=<px> y=<px>, measured from the top left of the visible page" };
      return realMouse((await resolveTab(c.tab)).id, c.x, c.y, c.action === undefined ? "click" : String(c.action));
    },
    type: async (c) => {
      need(c, "selector", "text");
      const t = await resolveTab(c.tab);
      if (c.real !== true) return inPage(t, pageType, [c.selector, String(c.text), !!c.submit]);
      const focused = await inPage(t, pageAct, ["focus", c.selector, null]);
      if (!focused || focused.ok === false) return focused;
      return realText(t.id, String(c.text), !!c.submit);
    },
    press: async (c) => {
      need(c, "key");
      const t = await resolveTab(c.tab);
      if (c.real !== true) return inPage(t, pageAct, ["press", c.selector || null, String(c.key)]);
      if (c.selector) {
        const focused = await inPage(t, pageAct, ["focus", c.selector, null]);
        if (!focused || focused.ok === false) return focused;
      }
      return realKey(t.id, String(c.key));
    },
    select: async (c) => {
      need(c, "selector", "value");
      return inPage(await resolveTab(c.tab), pageAct, ["select", c.selector, String(c.value)]);
    },
    check: async (c) => {
      need(c, "selector");
      return inPage(await resolveTab(c.tab), pageAct, ["check", c.selector, c.on !== false]);
    },
    hover: async (c) => {
      need(c, "selector");
      return inPage(await resolveTab(c.tab), pageAct, ["hover", c.selector, null]);
    },
    focus: async (c) => {
      need(c, "selector");
      return inPage(await resolveTab(c.tab), pageAct, ["focus", c.selector, null]);
    },
    submit: async (c) => {
      need(c, "selector");
      return inPage(await resolveTab(c.tab), pageAct, ["submit", c.selector, null]);
    },
    scroll: async (c) =>
      inPage(await resolveTab(c.tab), pageScroll, [typeof c.y === "number" ? c.y : null, typeof c.by === "number" ? c.by : null, c.selector || null, c.to || null]),
    wait: async (c) => {
      if (!c.selector && c.text === undefined) return { ok: false, error: "wait needs selector=<css> or text=<text>" };
      const t = await resolveTab(c.tab);
      const end = Date.now() + (Number(c.ms) || 10000);
      const wantGone = c.gone === true;
      for (;;) {
        const found = await inPage(await chrome.tabs.get(t.id), pageHas, [c.selector || null, c.text === undefined ? null : String(c.text)]);
        if (found && found.ok === false && found.needsPageAccess) return found;
        if ((found === true) !== wantGone) return { ok: true, found: found === true };
        if (Date.now() >= end) return { ok: false, found: found === true, error: "timed out waiting for " + (c.selector || c.text) + (wantGone ? " to go away" : "") };
        await sleepMs(250);
      }
    },
    "wait-load": async (c) => {
      const t = await waitLoaded((await resolveTab(c.tab)).id, Number(c.ms) || 20000);
      return { ok: t.status === "complete", tab: tabRow(t), ...(t.status === "complete" ? {} : { error: "still loading" }) };
    },
    eval: async (c) => {
      need(c, "code");
      const t = await resolveTab(c.tab);
      if (c.real === true) return realEval(t.id, String(c.code));
      const r = await inPage(t, pageEval, [String(c.code)], "MAIN");
      // A site that forbids eval: in the agent profile, run it the other way.
      if (r && r.ok === false && chrome.debugger && /unsafe-eval|Content Security Policy|Trusted ?Type|EvalError/i.test(r.error || "")) {
        return realEval(t.id, String(c.code));
      }
      return r;
    },

    // ---- downloads
    downloads: async (c) => {
      let items = await deps.downloadsList(Number(c.limit) || 50);
      if (c.state) items = items.filter((d) => d.state === c.state);
      return { ok: true, downloads: items };
    },
    download: async (c) => {
      need(c, "url");
      const id = await chrome.downloads.download({ url: c.url, ...(c.filename ? { filename: String(c.filename), conflictAction: "uniquify" } : {}) });
      if (c.wait) return handlers["download-wait"]({ id, ms: c.ms });
      return { ok: true, id };
    },
    "download-wait": async (c) => {
      need(c, "id");
      const end = Date.now() + (Number(c.ms) || 25000);
      for (;;) {
        const [d] = await chrome.downloads.search({ id: c.id });
        if (!d) return { ok: false, error: "no download " + c.id };
        const row = { id: d.id, state: d.state, filename: d.filename, bytesReceived: d.bytesReceived, totalBytes: d.totalBytes, error: d.error || null };
        if (d.state === "complete") return { ok: true, download: row };
        if (d.state === "interrupted") return { ok: false, download: row, error: "the download failed: " + (d.error || "interrupted") };
        if (Date.now() >= end) return { ok: false, download: row, error: "still downloading; ask again with download-wait" };
        await sleepMs(300);
      }
    },
    "download-pause": async (c) => (need(c, "id"), deps.downloadsAction(c.id, "pause")),
    "download-resume": async (c) => (need(c, "id"), deps.downloadsAction(c.id, "resume")),
    "download-cancel": async (c) => (need(c, "id"), deps.downloadsAction(c.id, "cancel")),
    "download-erase": async (c) => (need(c, "id"), deps.downloadsAction(c.id, "erase")),
    "download-delete": async (c) => {
      need(c, "id");
      await chrome.downloads.removeFile(c.id).catch(() => {}); // already gone is fine
      await chrome.downloads.erase({ id: c.id });
      return { ok: true };
    },
    "download-rules": async (c) => {
      if (c.enabled !== undefined) await chrome.storage.local.set({ routingEnabled: c.enabled === true });
      const s = await chrome.storage.local.get({ routingEnabled: false, rules: null });
      return { ok: true, enabled: s.routingEnabled, rules: s.rules || deps.defaultDownloadRules };
    },

    // ---- network capture
    "capture-start": async () => deps.capture.start(),
    "capture-stop": async () => deps.capture.stop(),
    "capture-status": async () => ({ ok: true, ...(await deps.capture.status()) }),
    "capture-list": async (c) => {
      const filter = {};
      if (c.q !== undefined) filter.text = String(c.q);
      if (c.method) filter.method = String(c.method).toUpperCase();
      if (c.status !== undefined) filter.statusClass = Number(String(c.status)[0]);
      if (c.errors === true) filter.errorsOnly = true;
      if (typeof c.tab === "number") filter.tabId = c.tab;
      return { ok: true, requests: await deps.capture.list(filter, Number(c.limit) || 100) };
    },
    "capture-get": async (c) => {
      need(c, "id");
      const r = await deps.capture.get(String(c.id));
      return r ? { ok: true, ...r } : { ok: false, error: "no recorded request " + c.id };
    },
    "capture-clear": async () => deps.capture.clear(),

    // ---- security (through the helper; the scope rule applies and an agent cannot widen the scope)
    "scope-list": async () => deps.native({ type: "scope-list" }),
    "scope-check": async (c) => (need(c, "host"), deps.native({ type: "scope-check", host: String(c.host) })),
    audit: async (c) => (need(c, "url"), deps.native({ type: "audit", url: String(c.url), cve: c.cve === true })),
    scan: async (c) => (need(c, "target"), deps.native({ type: "scan", target: String(c.target), ...(c.ports !== undefined ? { ports: String(c.ports) } : {}) })),
    cve: async (c) => (need(c, "product", "version"), deps.native({ type: "cve", product: String(c.product), version: String(c.version) })),

    // ---- settings
    settings: async () => ({ ok: true, settings: await deps.settingsGet() }),
    "settings-set": async (c) => {
      const changes = {};
      for (const [key, raw] of Object.entries(c)) {
        if (key === "op") continue;
        const v = validateSetting(key, raw);
        if (!v.ok) return v;
        changes[key] = v.value;
      }
      if (!Object.keys(changes).length) return { ok: false, error: "settings-set needs at least one <key>=<value>" };
      await chrome.storage.local.set(changes);
      return { ok: true, changed: changes, settings: await deps.settingsGet() };
    },
    proxy: async () => deps.proxyGet(),
    "proxy-set": async (c) => deps.proxySet({ mode: c.mode, scheme: c.scheme, host: c.host, port: c.port, bypass: list(c.bypass) }),

    // ---- memory
    stats: async () => deps.tabStats(),
    freeze: async (c) => deps.native({ type: "freeze", pids: ids(c.pids) }),
    thaw: async (c) => deps.native({ type: "thaw", pids: ids(c.pids) }),
    trim: async (c) => deps.native({ type: "trim", pids: ids(c.pids) }),

    // ---- sessions
    "session-list": async () => ({ ok: true, sessions: await deps.sessionList() }),
    "session-save": async (c) => {
      const bad = sessionNameError(c.name);
      if (bad) return { ok: false, error: bad };
      return deps.sessionSave({ name: c.name, scope: "all", closeAfter: c.closeAfter === true, withPages: c.withPages !== false });
    },
    "session-restore": async (c) => deps.sessionRestore({ name: c.name, withSettings: c.withSettings === true }),
    "session-delete": async (c) => (need(c, "name"), deps.sessionDelete({ name: String(c.name) })),
    "session-export": async (c) => {
      need(c, "name");
      const session = await deps.sessionExport(String(c.name));
      return session ? { ok: true, session } : { ok: false, error: "no session named " + c.name };
    },
    "session-import": async (c) => deps.sessionImport({ session: c.session }),

    // ---- cookies (only where the extension was given the permission: the agent profile)
    cookies: async (c) => {
      if (!chrome.cookies) return { ok: false, error: "cookies are only available in the agent profile" };
      if (!c.url && !c.domain) return { ok: false, error: "cookies needs url=<address> or domain=<domain>" };
      const found = await chrome.cookies.getAll(c.url ? { url: String(c.url) } : { domain: String(c.domain) });
      return { ok: true, cookies: found.map((k) => ({ name: k.name, value: k.value, domain: k.domain, path: k.path, secure: k.secure, httpOnly: k.httpOnly, sameSite: k.sameSite, expires: k.expirationDate || null })) };
    },
    "cookie-set": async (c) => {
      if (!chrome.cookies) return { ok: false, error: "cookies are only available in the agent profile" };
      need(c, "url", "name", "value");
      const set = await chrome.cookies.set({ url: String(c.url), name: String(c.name), value: String(c.value), ...(c.path ? { path: String(c.path) } : {}), ...(c.secure === true ? { secure: true } : {}), ...(c.httpOnly === true ? { httpOnly: true } : {}) });
      return set ? { ok: true, cookie: { name: set.name, domain: set.domain, path: set.path } } : { ok: false, error: "the browser refused that cookie" };
    },
    "cookie-remove": async (c) => {
      if (!chrome.cookies) return { ok: false, error: "cookies are only available in the agent profile" };
      need(c, "url", "name");
      const removed = await chrome.cookies.remove({ url: String(c.url), name: String(c.name) });
      return { ok: !!removed, ...(removed ? {} : { error: "no such cookie" }) };
    },
  };

  async function ctl(cmd) {
    const handler = Object.hasOwn(handlers, cmd.op) ? handlers[cmd.op] : null;
    if (!handler) return { ok: false, error: "unknown command '" + cmd.op + "'. Try: gamblium ctl help" };
    if (NEEDS_PERMISSION.has(cmd.op) && deps.permit) {
      const p = await deps.permit(cmd.op);
      if (!p || p.allowed !== true) {
        const asked = !!(p && p.asked);
        return {
          ok: false, needsPermission: true, asked,
          error: asked
            ? "Changing settings needs the user's permission. They have been asked in Gamblium; run the command again once they have answered."
            : "Changing settings needs the user's permission, and their Gamblium is not open to ask. Ask them to open Gamblium, then run the command again.",
        };
      }
    }
    try {
      // Any id the tab ever had means the tab it is now.
      const before = await idMaps();
      if (before) {
        if (typeof cmd.tab === "number") cmd = { ...cmd, tab: followId(before, cmd.tab) };
        if (cmd.tabs !== undefined) cmd = { ...cmd, tabs: ids(cmd.tabs).map((i) => followId(before, i)) };
      }
      // A tab the freezer stopped is woken before its command, and the tab
      // counts as in use from now.
      const group = OPS[cmd.op] ? OPS[cmd.op][0] : "";
      const touched = deps.touch ? await deps.touch(typeof cmd.tab === "number" ? cmd.tab : null, group, cmd.op) : null;
      const answer = await handler(cmd);
      if (answer && answer.ok && deps.park) {
        const tab = answer.tab && typeof answer.tab === "object" ? answer.tab : null;
        const wall = tab ? wallOf(tab.title, tab.url) : wallOf(answer.title, answer.url);
        const id = tab ? tab.id : touched;
        // In a window an automatic check passes by itself within seconds: a
        // command that asked to wait gets the real page, not the check.
        if (wall === "cloudflare" && !deps.noWindow && cmd.wait && tab && typeof id === "number") {
          const passed = await waitPastCheck(id, CHECK_WAIT_MS);
          if (passed) return answerIds({ ...answer, tab: tabRow(passed), checkPassedAfterMs: passed.waitedMs }, await idMaps());
        }
        if (wall && typeof id === "number") {
          // Hidden: stopped (it will not pass). In a window an automatic
          // check is left to run: freezing it would stop it passing.
          if (deps.noWindow || wall !== "cloudflare") await deps.park(id);
          // Hidden and Cloudflare: its half-done check is dropped so a try in a window starts fresh.
          if (deps.noWindow && wall === "cloudflare" && deps.forgetCheck) await deps.forgetCheck(tab ? tab.url : answer.url);
          return answerIds({ ...answer, wall, hint: wallHint(wall, !!deps.noWindow) }, await idMaps());
        }
      }
      // With no window, a page is stopped again once its command is done
      // (after it has loaded and settled). full-reload leaves it running.
      if (deps.rest && answer && answer.ok && cmd.op !== "full-reload") {
        const id = answer.tab && typeof answer.tab === "object" ? answer.tab.id : touched;
        if (typeof id === "number") deps.rest(id);
      }
      return answerIds(answer, await idMaps());
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  }
  // For the test that keeps the command list, the code and the docs in step.
  ctl.ops = Object.keys(handlers);
  return ctl;
}
