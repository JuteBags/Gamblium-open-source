import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitGroupIcon, withGroupIcon, GROUP_ICONS } from './tabstats.js';

test('a group icon is the emoji in front of its name', () => {
  assert.deepEqual(splitGroupIcon('🎵 Music'), { icon: '🎵', name: 'Music' });
  assert.deepEqual(splitGroupIcon('🛠️ Tools'), { icon: '🛠️', name: 'Tools' });
  assert.deepEqual(splitGroupIcon('Work'), { icon: '', name: 'Work' });
  assert.deepEqual(splitGroupIcon(''), { icon: '', name: '' });
  assert.deepEqual(splitGroupIcon('3 tabs'), { icon: '', name: '3 tabs' });
  assert.equal(withGroupIcon('Work', '💼'), '💼 Work');
  assert.equal(withGroupIcon('🎵 Work', '💼'), '💼 Work');
  assert.equal(withGroupIcon('🎵 Work', ''), 'Work');
  assert.equal(withGroupIcon('', '🎵'), '🎵');
  for (const i of GROUP_ICONS) assert.equal(splitGroupIcon(`${i} x`).icon, i, i);
});
