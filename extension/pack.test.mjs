import test from "node:test";
import assert from "node:assert/strict";
import { pack, unpack, toBase64, fromBase64 } from "./pack.js";

test("a packed value comes back exactly, whatever it holds", async () => {
  const value = { "work": { name: "work", windows: [{ tabs: [{ url: "https://example.com/?q=ünïcödé&x=1", title: "Ünïcödé ✓ 日本語" }] }] }, empty: {}, list: [1, null, true] };
  assert.deepEqual(await unpack(await pack(value)), value);
  assert.deepEqual(await unpack(await pack({})), {});
});

test("a store of saved sessions packs to a fraction of its size", async () => {
  const tabs = Array.from({ length: 400 }, (_, i) => ({ url: `https://docs.example.com/guide/section-${i % 37}/page-${i}?ref=sidebar`, title: `Guide, section ${i % 37}, page ${i}`, pinned: false, group: null }));
  const store = { big: { name: "big", version: 2, windows: [{ tabs }] } };
  const plain = JSON.stringify(store).length;
  const packed = (await pack(store)).length;
  assert.ok(packed < plain / 5, `${plain} -> ${packed}`);
  assert.deepEqual(await unpack(await pack(store)), store);
});

test("base64 survives every byte value and sizes past one chunk", () => {
  const bytes = new Uint8Array(100_000).map((_, i) => (i * 31 + 7) & 255);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  assert.equal(toBase64(new Uint8Array(0)), "");
});

test("text that is not a packed value is refused, not read as empty", async () => {
  await assert.rejects(unpack("bm90IGd6aXA="));
});
