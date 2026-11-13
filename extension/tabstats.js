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
      return { tabId: t.id, windowId: t.windowId, title: t.title || "", url: t.url || "", state, active: !!t.active, audible: !!t.audible, memoryMb: null, cpuPct: null, shared: false, pids: [] };
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
      tabId: t.id, windowId: t.windowId, title: t.title || "", url: t.url || "", state, active: !!t.active, audible: !!t.audible,
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
