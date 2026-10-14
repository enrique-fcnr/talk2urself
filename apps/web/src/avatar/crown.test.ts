import test from 'node:test';
import assert from 'node:assert/strict';
import { brainLevel, fullBrainMemories } from './crown.ts';

test('brilho do cérebro cresce rápido no início e chega ao máximo em 100 memórias', () => {
  assert.equal(brainLevel(0), 0);
  assert.equal(brainLevel(fullBrainMemories), 1);
  assert.equal(brainLevel(500), 1);
  assert.ok(brainLevel(10) > .45 && brainLevel(10) < .6, 'dez memórias já acendem cerca de metade');
  let previous = -1;
  for (let count = 0; count <= fullBrainMemories; count++) { assert.ok(brainLevel(count) > previous); previous = brainLevel(count); }
});
