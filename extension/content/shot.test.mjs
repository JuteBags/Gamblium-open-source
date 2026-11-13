import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// shot.js is a classic script; its pure part hands itself over when this object is there.
globalThis.__gambliumShotTest = {};
new Function(fs.readFileSync(new URL('./shot.js', import.meta.url), 'utf8'))();
const { boxOf, edgeSpeed, sizeLabel, nudge, fileName } = globalThis.__gambliumShotTest;

test('the box is the same whichever way it was dragged', () => {
  assert.deepEqual(boxOf({ x: 10, y: 20 }, { x: 110, y: 220 }), { x: 10, y: 20, w: 100, h: 200 });
  assert.deepEqual(boxOf({ x: 110, y: 220 }, { x: 10, y: 20 }), { x: 10, y: 20, w: 100, h: 200 });
});

test('near the bottom edge the page scrolls down, faster the closer; near the top, up; elsewhere not', () => {
  assert.equal(edgeSpeed(400, 800), 0);
  assert.ok(edgeSpeed(790, 800) > edgeSpeed(760, 800) && edgeSpeed(760, 800) > 0);
  assert.ok(edgeSpeed(5, 800) < 0);
  assert.equal(edgeSpeed(2000, 800), 24); // past the edge: full speed, never more
});

test('the size label counts real pixels', () => {
  assert.equal(sizeLabel(640, 2700, 2), '1280 × 5400 px');
  assert.equal(sizeLabel(100.4, 50.6), '100 × 51 px');
});

test('arrows move the box by 10 px; Shift+arrows resize by 10, Alt+arrows by 1; never below 4 px or off the page', () => {
  const b = { x: 100, y: 100, w: 200, h: 50 };
  assert.deepEqual(nudge(b, 'ArrowDown'), { x: 100, y: 110, w: 200, h: 50 });
  assert.deepEqual(nudge(b, 'ArrowRight', { shift: true }), { x: 100, y: 100, w: 210, h: 50 });
  assert.deepEqual(nudge(b, 'ArrowUp', { alt: true }), { x: 100, y: 100, w: 200, h: 49 });
  assert.equal(nudge({ x: 0, y: 3, w: 5, h: 5 }, 'ArrowUp').y, 0);
  assert.equal(nudge({ x: 0, y: 0, w: 5, h: 5 }, 'ArrowLeft', { shift: true }).w, 4);
  assert.equal(nudge(b, 'Enter'), b);
});

test('the file is named by site and minute', () => {
  assert.equal(fileName('www.example.com', new Date(2026, 10, 13, 21, 4)), 'example.com 2026-11-13 21.04.png');
  assert.equal(fileName('', new Date(2026, 0, 2, 3, 4)), 'page 2026-01-02 03.04.png');
});
