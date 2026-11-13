import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PX, PART_PX, partsForScroller, planParts } from "./shot.js";

test("a tall region is taken in parts no taller than the limit, covering it exactly", () => {
  const { parts, truncated } = planParts({ x: 0, y: 100, width: 1200, height: 10000 }, 2);
  assert.equal(truncated, false);
  assert.ok(parts.every((p) => p.height * 2 <= PART_PX));
  assert.equal(parts.reduce((h, p) => h + p.height, 0), 10000);
  assert.deepEqual(parts.map((p) => p.at), [0, 4000, 8000]);
  assert.equal(parts[1].y, 4100);
});

test("a region taller than the picture limit is cut and says so", () => {
  const { parts, truncated } = planParts({ x: 0, y: 0, width: 800, height: 50000 }, 1);
  assert.equal(truncated, true);
  assert.equal(parts.reduce((h, p) => h + p.height, 0), MAX_PX);
});

test("an inner box is scrolled by its visible height and each step adds the next rows", () => {
  const steps = partsForScroller(0, 2500, 1000, 4000);
  assert.deepEqual(steps.map((s) => [s.scroll, s.start, s.end]), [[0, 0, 1000], [1000, 1000, 2000], [2000, 2000, 2500]]);
  // Near the end the box cannot scroll further: the last rows come from lower in the view.
  const end = partsForScroller(0, 1800, 1000, 500);
  assert.deepEqual(end.map((s) => [s.scroll, s.start, s.end, s.offset]), [[0, 0, 1000, 0], [500, 1000, 1800, 500]]);
});
