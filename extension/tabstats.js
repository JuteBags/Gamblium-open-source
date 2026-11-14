// Per-tab memory and CPU, and the proxy setting. Pure logic, no chrome.* calls.

const MB = 1024 * 1024;

// Works out memory and CPU per tab.
//   tabs:        chrome.tabs.query({}) results
//   framesByTab: { tabId: [processId, ...] } from chrome.webNavigation.getAllFrames
//   reading:     { at_ms, processes: [{ pid, kind, client_id, cpu_ms, private_ws, commit }] } from the helper
//   previous:    the reading before this one, or null (then CPU is unknown)
// A page process is matched to a tab by Chromium's own process number, which
// the extension sees as a frame's processId and the helper as client_id.
export function attribute(tabs, framesByTab, reading, previous) {
  const byClient = new Map();
  for (const p of reading.processes) if (p.client_id !== null && p.client_id !== undefined) byClient.set(p.client_id, p);
  const before = new Map((previous ? previous.processes : []).map((p) => [p.pid, p.cpu_ms]));
  const seconds = previous ? (reading.at_ms - previous.at_ms) / 1000 : 0;
  // Percent of one core since the previous reading, or null if we cannot tell.
  const cpuOf = (p) => (seconds > 0 && before.has(p.pid) ? Math.max(0, ((p.cpu_ms - before.get(p.pid)) / 1000 / seconds) * 100) : null);

  // How many tabs each process serves: a shared process is not one tab's fault.
  const users = new Map();
  const procsOf = new Map();
  for (const t of tabs) {
    const procs = [...new Set(framesByTab[t.id] || [])].map((id) => byClient.get(id)).filter(Boolean);
    procsOf.set(t.id, procs);
    for (const p of procs) users.set(p.pid, (users.get(p.pid) || 0) + 1);
  }

  const rows = tabs.map((t) => {
    const procs = procsOf.get(t.id);
    const state = t.discarded ? "asleep" : t.frozen ? "frozen" : "awake";
    if (!procs.length) {
      return { tabId: t.id, windowId: t.windowId, groupId: t.groupId ?? -1, title: t.title || "", url: t.url || "", state, active: !!t.active, audible: !!t.audible, memoryMb: null, cpuPct: null, shared: false, pids: [] };
    }
    let memory = 0;
    let cpu = 0;
    let cpuKnown = true;
    for (const p of procs) {
      const share = users.get(p.pid);
      memory += p.private_ws / share;
      const c = cpuOf(p);
      if (c === null) cpuKnown = false;
      else cpu += c / share;
    }
    return {
      tabId: t.id, windowId: t.windowId, groupId: t.groupId ?? -1, title: t.title || "", url: t.url || "", state, active: !!t.active, audible: !!t.audible,
      memoryMb: Math.round(memory / MB), cpuPct: cpuKnown ? Math.round(cpu * 10) / 10 : null,
      shared: procs.some((p) => users.get(p.pid) > 1), pids: procs.map((p) => p.pid),
    };
  });

  // Everything, by process type, so the dashboard can show what is not a tab.
  const kinds = {};
  let totalMemory = 0;
  let totalCpu = 0;
  let cpuKnown = seconds > 0;
  for (const p of reading.processes) {
    const k = (kinds[p.kind] ||= { processes: 0, memoryMb: 0, cpuPct: seconds > 0 ? 0 : null });
    k.processes++;
    k.memoryMb += p.private_ws / MB;
    totalMemory += p.private_ws / MB;
    const c = cpuOf(p);
    if (c !== null && k.cpuPct !== null) {
      k.cpuPct += c;
      totalCpu += c;
    }
  }
  for (const k of Object.values(kinds)) {
    k.memoryMb = Math.round(k.memoryMb);
    if (k.cpuPct !== null) k.cpuPct = Math.round(k.cpuPct * 10) / 10;
  }
  if (!previous) cpuKnown = false;
  return {
    tabs: rows,
    kinds,
    total: { processes: reading.processes.length, memoryMb: Math.round(totalMemory), cpuPct: cpuKnown ? Math.round(totalCpu * 10) / 10 : null },
  };
}

// Memory and processor per tab group (owner, Nov 14 2026).
//   rows:   attribute(...).tabs
//   groups: chrome.tabGroups.query({}) results ({ id, title, color, collapsed })
// -> [{ groupId, title, color, tabs, awake, memoryMb, cpuPct }], heaviest first. A group's CPU is
// null when no awake tab of it has a known figure yet.
export function groupTotals(rows, groups) {
  return groups
    .map((g) => {
      const mine = rows.filter((r) => r.groupId === g.id);
      const known = mine.filter((r) => r.cpuPct !== null && r.cpuPct !== undefined);
      return {
        groupId: g.id, title: g.title || "", color: g.color || "grey", tabs: mine.length, awake: mine.filter((r) => r.state === "awake").length,
        memoryMb: mine.reduce((sum, r) => sum + (r.memoryMb || 0), 0),
        cpuPct: known.length ? Math.round(known.reduce((sum, r) => sum + r.cpuPct, 0) * 10) / 10 : null,
      };
    })
    .sort((a, b) => b.memoryMb - a.memoryMb);
}

// What to do when a group goes over the limits set for it (by the group's name, since group ids
// change across restarts). limits: { [title]: { memoryMb?, cpuPct? } }.
// Over its memory: its hidden tabs are put to sleep, biggest first, until it is under.
// Over its processor: its hidden awake tabs are frozen, busiest first, until it is under.
// Tabs on screen, playing sound or kept awake are never touched.
// -> { sleep: [tabId], freeze: [tabId] }
export function groupLimitPlan(rows, groups, limits, keepAwake = new Set()) {
  const plan = { sleep: [], freeze: [] };
  for (const g of groupTotals(rows, groups)) {
    const lim = limits && g.title ? limits[g.title] : null;
    if (!lim) continue;
    const movable = rows.filter((r) => r.groupId === g.groupId && r.state !== "asleep" && !r.active && !r.audible && !keepAwake.has(r.tabId));
    if (lim.memoryMb > 0 && g.memoryMb > lim.memoryMb) {
      let over = g.memoryMb - lim.memoryMb;
      for (const r of [...movable].sort((a, b) => (b.memoryMb || 0) - (a.memoryMb || 0))) {
        if (over <= 0) break;
        plan.sleep.push(r.tabId);
        over -= r.memoryMb || 0;
      }
    }
    if (lim.cpuPct > 0 && g.cpuPct !== null && g.cpuPct > lim.cpuPct) {
      let over = g.cpuPct - lim.cpuPct;
      for (const r of movable.filter((x) => x.state === "awake" && !plan.sleep.includes(x.tabId)).sort((a, b) => (b.cpuPct || 0) - (a.cpuPct || 0))) {
        if (over <= 0) break;
        plan.freeze.push(r.tabId);
        over -= r.cpuPct || 0;
      }
    }
  }
  return plan;
}

// Turns what the user typed into a chrome.proxy setting, or an error.
//   { mode: "direct" | "system" }
//   { mode: "fixed", scheme: "http" | "https" | "socks4" | "socks5", host, port, bypass: ["localhost", ...] }
export function proxyConfig(input) {
  const mode = input && input.mode;
  if (mode === "direct" || mode === "system") return { ok: true, config: { mode } };
  if (mode !== "fixed") return { ok: false, error: "Choose direct, system or a proxy server." };
  const scheme = String(input.scheme || "http").toLowerCase();
  if (!["http", "https", "socks4", "socks5"].includes(scheme)) return { ok: false, error: "Proxy type must be http, https, socks4 or socks5." };
  const host = String(input.host || "").trim();
  if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(host) && !/^\[[0-9a-f:]+\]$/i.test(host)) {
    return { ok: false, error: "Enter the proxy's host name or address." };
  }
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "Port must be between 1 and 65535." };
  const bypassList = (input.bypass || []).map((b) => String(b).trim()).filter(Boolean);
  return { ok: true, config: { mode: "fixed_servers", rules: { singleProxy: { scheme, host, port }, bypassList } } };
}

// The reverse, for showing the current setting.
export function proxySummary(config) {
  if (!config || config.mode === "system" || config.mode === "auto_detect") return { mode: "system" };
  if (config.mode === "direct") return { mode: "direct" };
  const p = config.rules && (config.rules.singleProxy || config.rules.proxyForHttps || config.rules.proxyForHttp);
  if (config.mode === "fixed_servers" && p) {
    return { mode: "fixed", scheme: p.scheme || "http", host: p.host, port: p.port, bypass: config.rules.bypassList || [] };
  }
  return { mode: "other" };
}

// A group's icon (owner, Nov 14 2026: custom group icons): Chromium's groups have only a name
// and a colour, so the icon is an emoji at the start of the name, which the tab strip shows.
const ICON_AT_START = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}️?)*)\s*/u;

/** "🎵 Music" -> { icon: "🎵", name: "Music" }; no icon -> { icon: "", name }. */
export function splitGroupIcon(title) {
  const t = String(title ?? "");
  const m = ICON_AT_START.exec(t);
  return m ? { icon: m[1], name: t.slice(m[0].length) } : { icon: "", name: t };
}

/** The title with `icon` in front (or none): the name itself is kept. */
export function withGroupIcon(title, icon) {
  const { name } = splitGroupIcon(title);
  const i = String(icon ?? "").trim();
  return i ? (name ? `${i} ${name}` : i) : name;
}

/** The icons offered; any emoji works. */
export const GROUP_ICONS = ["💼", "🏠", "🧪", "🛠️", "📚", "🎵", "🎬", "🛒", "💬", "📧", "📰", "💰", "✈️", "🎮", "🧠", "🐞", "🔒", "📊", "🎨", "⭐", "🔥", "🌱", "🤖", "📌"];
