// background.js must run to its end at the top level. A name used before it is defined (a
// `const` further down) stops the whole worker in the browser, and nothing else catches it:
// it happened once (mirrorSoon() before IS_AGENT_BUILD, Nov 15 2026). Loaded here against a
// chrome object that answers everything.
import test from "node:test";
import assert from "node:assert/strict";

test("background.js runs to its end at the top level", async () => {
  const make = () => new Proxy(function () {}, handler);
  const handler = {
    get: (t, k) => (k === "then" ? undefined : k === Symbol.toPrimitive ? () => "x" : (t[k] ??= make())),
    apply: () => {
      const p = Promise.resolve({});
      return new Proxy(p, { get: (t, k) => (k in t ? (typeof t[k] === "function" ? t[k].bind(t) : t[k]) : make()) });
    },
  };
  const saved = globalThis.chrome;
  globalThis.chrome = new Proxy({}, handler);
  chrome.runtime.getManifest = () => ({ host_permissions: [], version: "1" });
  chrome.runtime.getURL = (p) => "chrome-extension://x/" + p;
  const swallow = () => {};
  process.on("unhandledRejection", swallow);
  try {
    await assert.doesNotReject(import(new URL("./background.js?load-test", import.meta.url)));
  } finally {
    globalThis.chrome = saved;
  }
  // The worker keeps timers and listeners; this test only cares about the first run.
  setTimeout(() => process.exit(0), 50).unref?.();
});
