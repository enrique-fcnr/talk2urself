import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMemories, cosineSimilarity } from './projection.ts';
import type { VectorMemory } from '../../../../shared/vector-memory.ts';
const memory = (embedding: number[], i = 0): VectorMemory => ({ id: String(i), embedding, slot: 'interests', value: 'Texto', evidence: 'Origem', basis: 'stated', createdAt: '2026-10-08' });
test('projeção trata vazio, ponto isolado e vetores iguais sem inventar separação', () => {
  assert.deepEqual(projectMemories([]).points, []);
  for (const items of [[memory([1, 2, 3])], [memory([1, 2, 3]), memory([1, 2, 3], 1)]]) {
    const result = projectMemories(items);
    assert.ok(result.points.every(({ x, y, z }) => Math.abs(x) + Math.abs(y) + Math.abs(z) < 1e-9));
    assert.equal(result.retainedVariance, 0);
  }
});
test('PCA usa dimensões além das três primeiras, é determinística e preserva conjunto de posto baixo', () => {
  const items = [memory([0, 0, 0, 1, 0]), memory([0, 0, 0, 0, 1], 1), memory([0, 0, 0, -1, 0], 2)];
  const result = projectMemories(items);
  assert.deepEqual(result, projectMemories(items));
  assert.ok(result.points.some(({ x }) => Math.abs(x) > 0.5));
  assert.ok(result.retainedVariance > 0.999);
  const a = result.points[0], b = result.points[1];
  assert.ok(Math.abs(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) - Math.sqrt(2)) < 1e-5);
  assert.equal(cosineSimilarity([1, 0], [2, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.throws(() => projectMemories([memory([NaN])]));
});
