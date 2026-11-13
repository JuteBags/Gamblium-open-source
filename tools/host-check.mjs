// End-to-end check of the native-messaging host without a browser: starts
// `gamblium native-host`, speaks the browser's wire format to it, and runs an
// audit and a scan against the weak local test server.
//
//   node tools/host-check.mjs

import { spawn } from "node:child_process";
import path from "node:path";

const GAMBLIUM = path.resolve("target/release/gamblium.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ["tools/vuln-server.mjs", "8098"], { stdio: "ignore" });
await sleep(800);

const host = spawn(GAMBLIUM, ["native-host", "chrome-extension://test/", "--parent-window=0"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = Buffer.alloc(0);
const waiting = [];
host.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
    buf = buf.subarray(4 + len);
    waiting.shift()?.(msg);
  }
});

let nextId = 1;
function ask(msg) {
  const body = Buffer.from(JSON.stringify({ ...msg, id: nextId++ }), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  host.stdin.write(Buffer.concat([head, body]));
  return new Promise((res) => waiting.push(res));
}

const checks = [];
const check = (name, ok, detail) => {
  checks.push(ok);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
};

try {
  const ping = await ask({ type: "ping" });
  check("ping answers with a version and echoes the id", ping.ok && ping.version && ping.id === 1, `v${ping.version}`);

  const local = await ask({ type: "scope-check", host: "127.0.0.1" });
  check("this machine is in scope", local.ok && local.inScope && local.local);

  const pub = await ask({ type: "scope-check", host: "93.184.216.34" });
  check("a public address is not in scope by default", pub.ok && pub.inScope === false);

  const refused = await ask({ type: "audit", url: "http://93.184.216.34/" });
  check("audit of a public address is refused", refused.ok === false && /scope/.test(refused.error));

  const audit = await ask({ type: "audit", url: "http://127.0.0.1:8098/" });
  const ids = (audit.findings || []).map((f) => f.id);
  check("audit of the weak page finds the cross-origin flaw", audit.ok && ids.includes("cors-reflect-credentials"), `${ids.length} findings`);
  check("audit reports the disclosed software", (audit.software || []).some(([p, v]) => p === "apache" && v === "2.4.49"));

  const good = await ask({ type: "audit", url: "http://127.0.0.1:8098/secure" });
  check("audit of the good page is clean", good.ok && good.findings.length === 0);

  const scan = await ask({ type: "scan", target: "127.0.0.1", ports: "8090-8100" });
  check("scan finds the test server's port", scan.ok && scan.open.some((p) => p.port === 8098));

  const stats = await ask({ type: "stats" });
  check("stats answers with a process list", stats.ok && Array.isArray(stats.processes), `${stats.processes?.length} processes`);

  const bad = await ask({ type: "scope-add", entry: "*.com" });
  check("a scope entry that covers too much is refused", bad.ok === false);

  const unknown = await ask({ type: "definitely-not-a-command" });
  check("an unknown request is an error, not a crash", unknown.ok === false);
} finally {
  host.stdin.end();
  server.kill();
}
await sleep(300);
const ok = checks.length > 0 && checks.every(Boolean);
console.log(ok ? "HOST CHECK OK" : "HOST CHECK FAILED");
process.exit(ok ? 0 : 1);
