import assert from "node:assert/strict";
import { test } from "node:test";
import { attribute, proxyConfig, proxySummary } from "./tabstats.js";

const MB = 1024 * 1024;
const proc = (pid, kind, client_id, cpu_ms, mb) => ({ pid, kind, client_id, cpu_ms, private_ws: mb * MB, commit: mb * MB });
const tabs = [
  { id: 1, windowId: 1, title: "YouTube", url: "https://www.youtube.com/", active: true, audible: true, discarded: false },
  { id: 2, windowId: 1, title: "Docs", url: "https://docs.example/", active: false, discarded: false },
  { id: 3, windowId: 1, title: "Docs 2", url: "https://docs.example/b", active: false, discarded: false },
  { id: 4, windowId: 1, title: "Asleep", url: "https://x.example/", active: false, discarded: true },
];
const frames = { 1: [11, 11, 12], 2: [20], 3: [20], 4: [] };
const before = { at_ms: 0, processes: [proc(100, "browser", null, 1000, 90), proc(111, "renderer", 11, 500, 300), proc(112, "renderer", 12, 0, 40), proc(120, "renderer", 20, 100, 200), proc(130, "gpu", null, 50, 110)] };
const now = { at_ms: 10_000, processes: [proc(100, "browser", null, 1100, 100), proc(111, "renderer", 11, 1500, 320), proc(112, "renderer", 12, 0, 40), proc(120, "renderer", 20, 300, 200), proc(130, "gpu", null, 60, 110)] };

test("a tab gets the memory and CPU of its page processes", () => {
  const r = attribute(tabs, frames, now, before);
  const yt = r.tabs[0];
  assert.equal(yt.memoryMb, 360); // 320 + 40 (an embedded frame in its own process)
  assert.equal(yt.cpuPct, 10); // 1000 ms of CPU in 10 s
  assert.deepEqual(yt.pids, [111, 112]);
  assert.equal(yt.shared, false);
  assert.equal(yt.state, "awake");
});

test("a process shared by two tabs is split between them and marked", () => {
  const r = attribute(tabs, frames, now, before);
  assert.equal(r.tabs[1].memoryMb, 100);
  assert.equal(r.tabs[2].memoryMb, 100);
  assert.equal(r.tabs[1].cpuPct, 1); // 200 ms over 10 s = 2%, halved
  assert.equal(r.tabs[1].shared, true);
});

test("a sleeping tab has no process and no numbers", () => {
  const asleep = attribute(tabs, frames, now, before).tabs[3];
  assert.equal(asleep.state, "asleep");
  assert.equal(asleep.memoryMb, null);
  assert.equal(asleep.cpuPct, null);
});

test("the first reading has memory but no CPU", () => {
  const r = attribute(tabs, frames, now, null);
  assert.equal(r.tabs[0].memoryMb, 360);
  assert.equal(r.tabs[0].cpuPct, null);
  assert.equal(r.total.cpuPct, null);
  assert.equal(r.kinds.renderer.cpuPct, null);
});

test("totals by process type add up", () => {
  const r = attribute(tabs, frames, now, before);
  assert.equal(r.total.memoryMb, 770);
  assert.equal(r.total.processes, 5);
  assert.equal(r.kinds.renderer.processes, 3);
  assert.equal(r.kinds.renderer.memoryMb, 560);
  assert.equal(r.kinds.browser.cpuPct, 1);
  assert.equal(r.total.cpuPct, 13.1); // 1 + 10 + 0 + 2 + 0.1
});

test("a process that started after the previous reading does not fake a CPU figure", () => {
  const later = { at_ms: 10_000, processes: [...now.processes, proc(140, "renderer", 30, 5000, 50)] };
  const r = attribute([{ id: 9, windowId: 1, title: "new", url: "https://n.example/" }], { 9: [30] }, later, before);
  assert.equal(r.tabs[0].cpuPct, null);
  assert.equal(r.tabs[0].memoryMb, 50);
});

test("proxy settings are validated and round-trip", () => {
  assert.deepEqual(proxyConfig({ mode: "direct" }), { ok: true, config: { mode: "direct" } });
  const fixed = proxyConfig({ mode: "fixed", scheme: "SOCKS5", host: " 127.0.0.1 ", port: "9050", bypass: ["localhost", " "] });
  assert.deepEqual(fixed.config, { mode: "fixed_servers", rules: { singleProxy: { scheme: "socks5", host: "127.0.0.1", port: 9050 }, bypassList: ["localhost"] } });
  assert.deepEqual(proxySummary(fixed.config), { mode: "fixed", scheme: "socks5", host: "127.0.0.1", port: 9050, bypass: ["localhost"] });
  assert.deepEqual(proxySummary({ mode: "system" }), { mode: "system" });
  for (const bad of [{ mode: "fixed", host: "", port: 80 }, { mode: "fixed", host: "x.y", port: 0 }, { mode: "fixed", host: "x.y", port: 70000 },
    { mode: "fixed", host: "x y", port: 80 }, { mode: "fixed", scheme: "ftp", host: "x.y", port: 80 }, { mode: "nope" }, null]) {
    assert.equal(proxyConfig(bad).ok, false, JSON.stringify(bad));
  }
});
