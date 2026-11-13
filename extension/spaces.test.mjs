import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freeColour, listSpaces, nextSpace, switchPlan } from './spaces.js';

const tabs = [
  { id: 1, index: 0, groupId: -1, active: false, lastAccessed: 10 },
  { id: 2, index: 1, groupId: 20, active: true, lastAccessed: 50 },
  { id: 3, index: 2, groupId: 20, active: false, lastAccessed: 40, discarded: true },
  { id: 4, index: 3, groupId: 30, active: false, lastAccessed: 30 },
  { id: 5, index: 4, groupId: 30, active: false, lastAccessed: 45 },
  { id: 6, index: 5, groupId: 40, active: false, lastAccessed: 5 },
];
const groups = [
  { id: 30, title: 'Work', color: 'blue', collapsed: false },
  { id: 20, title: 'Reading', color: 'grey', collapsed: false },
  { id: 40, title: '', color: 'green', collapsed: true },
  { id: 50, title: 'Empty', color: 'red', collapsed: false },
];

test('spaces come in strip order, empty groups left out, with what their tabs do', () => {
  const s = listSpaces(tabs, groups, { 4: 1 });
  assert.deepEqual(s.map((x) => x.id), [20, 30, 40]);
  assert.deepEqual(s[0], { id: 20, title: 'Reading', color: 'grey', collapsed: false, active: true, tabs: 2, asleep: 1, frozen: 0, awake: 1 });
  assert.equal(s[1].frozen, 1);
  assert.equal(s[1].awake, 1);
});

test('with the front tab in no space, the one space left open is the current one', () => {
  const loose = tabs.map((t) => ({ ...t, active: t.id === 1 }));
  const folded = groups.map((g) => ({ ...g, collapsed: g.id !== 30 }));
  assert.deepEqual(listSpaces(loose, folded).filter((s) => s.active).map((s) => s.id), [30]);
  assert.deepEqual(listSpaces(loose, groups).filter((s) => s.active), []); // two open: no guess
});

test('switching folds the open spaces, fronts the last-used tab and freezes the rest', () => {
  assert.deepEqual(switchPlan(tabs, groups, 30), { expand: 30, collapse: [20], activate: 5, freeze: [2, 6] });
});

test('switching to a space that is not here does nothing', () => {
  assert.equal(switchPlan(tabs, groups, 50), null);
  assert.equal(switchPlan(tabs, groups, 99), null);
});

test('next space goes round, and starts at the first when none is in front', () => {
  const s = listSpaces(tabs, groups);
  assert.equal(nextSpace(s), 30);
  assert.equal(nextSpace(s, -1), 40);
  assert.equal(nextSpace(s.map((x) => ({ ...x, active: x.id === 40 }))), 20);
  assert.equal(nextSpace(s.map((x) => ({ ...x, active: false }))), 20);
  assert.equal(nextSpace([]), null);
});

test('a new space gets a colour nobody wears yet', () => {
  assert.equal(freeColour(groups), 'yellow');
  assert.equal(freeColour([]), 'grey');
});
