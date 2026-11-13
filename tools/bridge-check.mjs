// End-to-end check of `gamblium ctl` without a browser. This script plays the
// extension: it starts the native host, asks for the bridge, and answers the
// commands that `gamblium ctl` sends through it.
//
//   node tools/bridge-check.mjs

import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GAMBLIUM = path.resolve("target/release/gamblium.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const host = spawn(GAMBLIUM, ["native-host", "chrome-extension://test/"], { stdio: ["pipe", "pipe", "inherit"] });
const write = (msg) => {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  host.stdin.write(Buffer.concat([head, body]));
};

// Our stand-in for the extension's command runner.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
function fakeExtension(cmd) {
  if (cmd.op === "tabs") return { ok: true, tabs: [{ id: 7, title: "Example", url: "https://example.com/" }] };
  if (cmd.op === "open") return { ok: true, tab: { id: 8, url: cmd.url }, echoed: cmd };
  if (cmd.op === "screenshot") return { ok: true, tab: 7, dataUrl: "data:image/png;base64," + PNG.toString("base64") };
  if (cmd.op === "slow") return null; // never answers
  return { ok: false, error: "unknown command '" + cmd.op + "'" };
}

let started = null;
let buf = Buffer.alloc(0);
host.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
    buf = buf.subarray(4 + len);
    if (msg.type === "bridge-started") started = msg;
    if (msg.type === "ctl") {
      const result = fakeExtension(msg.cmd);
      if (result) write({ type: "ctl-reply", id: msg.id, result });
    }
  }
});

function ctl(args) {
  return new Promise((res) => {
    execFile(GAMBLIUM, ["ctl", ...args], { encoding: "utf8" }, (err, stdout) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = { parseError: stdout };
      }
      res({ code: err ? err.code : 0, json });
    });
  });
}

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(!!ok);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
};

try {
  write({ type: "bridge-start" });
  for (let i = 0; i < 40 && !started; i++) await sleep(100);
  check("the helper starts the bridge on a loopback port", started && started.ok && started.port > 0, started ? `port ${started.port}` : "");

  const list = await ctl(["list"]);
  check("ctl list shows one running Gamblium", list.code === 0 && list.json.running.length === 1);

  const tabs = await ctl(["tabs"]);
  check("ctl tabs reaches the extension and prints its answer", tabs.code === 0 && tabs.json.tabs[0].id === 7);

  const open = await ctl(["open", "url=https://example.com/?a=1", "wait=true"]);
  check("arguments arrive typed", open.json.echoed && open.json.echoed.url === "https://example.com/?a=1" && open.json.echoed.wait === true);

  const out = path.join(os.tmpdir(), `gamblium-shot-${Date.now()}.png`);
  const shot = await ctl(["screenshot", `out=${out}`]);
  const saved = fs.existsSync(out) ? fs.readFileSync(out) : Buffer.alloc(0);
  check("a screenshot is saved to the file, not printed", shot.code === 0 && shot.json.saved === out && saved.equals(PNG), `${saved.length} bytes`);
  fs.rmSync(out, { force: true });

  const bad = await ctl(["nonsense"]);
  check("an unknown command fails with exit code 1", bad.code === 1 && bad.json.ok === false);

  const slow = await ctl(["slow", "--timeout", "2"]);
  check("a command the browser never answers times out cleanly", slow.code === 1 && /did not answer/.test(slow.json.error || ""));

  // A client with the wrong token gets nothing done.
  const net = await import("node:net");
  const wrong = await new Promise((res) => {
    const s = net.connect(started.port, "127.0.0.1", () => s.write(JSON.stringify({ token: "0".repeat(64), cmd: { op: "tabs" } }) + "\n"));
    let data = "";
    s.on("data", (d) => (data += d));
    s.on("end", () => res(JSON.parse(data)));
    s.on("error", () => res({ ok: false, error: "socket error" }));
  });
  check("a wrong token is refused", wrong.ok === false && /token/.test(wrong.error));
} finally {
  host.stdin.end();
}
await sleep(400);
const after = await ctl(["tabs"]);
check("after the browser is gone, ctl says so", after.code === 1 && /no Gamblium is accepting commands/.test(after.json.error || ""));

const ok = checks.every(Boolean);
console.log(ok ? "BRIDGE CHECK OK" : "BRIDGE CHECK FAILED");
process.exit(ok ? 0 : 1);
