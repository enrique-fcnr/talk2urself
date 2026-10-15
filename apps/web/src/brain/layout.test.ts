import assert from 'node:assert/strict';
import test from 'node:test';
import { findSynapses, layoutBrain, recallKey } from './layout.ts';
import { projectMemories } from '../vectors/projection.ts';
import { parseServerEvent } from '../../../../shared/protocol.ts';
import type { VectorMemory } from '../../../../shared/vector-memory.ts';

const memory = (id: string, key: string, embedding: number[]): VectorMemory => ({ id, slot: 'interests', value: `fato ${id}`, evidence: 'Eu disse.',
  basis: 'stated', createdAt: '2026-10-01T12:00:00Z', embedding, category: { key, label: key, color: '#abcdef' } });
const distance = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const centre = (points: { position: number[] }[]) => [0, 1, 2].map((axis) => points.reduce((sum, p) => sum + p.position[axis], 0) / points.length);

test('memórias do mesmo assunto ficam na mesma região, dentro do cérebro e sempre no mesmo lugar', () => {
  const items = [
    memory('a1', 'work', [1, .1, 0, 0]), memory('a2', 'work', [1, 0, .1, 0]), memory('a3', 'work', [.9, .1, .1, 0]),
    memory('b1', 'family', [0, 0, 1, .1]), memory('b2', 'family', [0, .1, 1, 0]), memory('b3', 'family', [.1, 0, .9, .1]),
  ];
  const first = layoutBrain(projectMemories(items).points), again = layoutBrain(projectMemories(items).points);
  assert.deepEqual(first, again);
  for (const point of first) assert.ok(Math.hypot(...point.position) <= .9 + 1e-9);
  const work = first.filter((p) => p.memory.category?.key === 'work'), family = first.filter((p) => p.memory.category?.key === 'family');
  const spreadWithin = Math.max(...work.map((p) => distance(p.position, centre(work))), ...family.map((p) => distance(p.position, centre(family))));
  assert.ok(distance(centre(work), centre(family)) > 2 * spreadWithin, 'regions should be farther apart than their own spread');
});

test('cérebro com uma só memória não quebra e a coloca no centro', () => {
  assert.deepEqual(layoutBrain([]), []);
  const [only] = layoutBrain(projectMemories([memory('x', 'work', [1, 0, 0])]).points);
  assert.ok(Math.hypot(...only.position) < .1);
});

test('sinapses ligam só memórias parecidas, uma vez por par', () => {
  const links = findSynapses([memory('a', 'w', [1, 0, 0]), memory('b', 'w', [.9, .1, 0]), memory('c', 'w', [0, 0, 1])]);
  assert.deepEqual(links.map(([a, b]) => [a, b]), [[0, 1]]);
  assert.ok(links[0][2] > .9);
});

test('evento de memórias usadas é validado e casa com os pontos pelo texto', () => {
  const event = parseServerEvent(JSON.stringify({ type: 'recall', memories: [{ slot: 'work', value: 'Trabalha com design ' }] }));
  assert.deepEqual(event, { type: 'recall', memories: [{ slot: 'work', value: 'Trabalha com design ' }] });
  assert.equal(recallKey('work', 'Trabalha com design '), recallKey('work', 'Trabalha com design'));
  assert.equal(parseServerEvent(JSON.stringify({ type: 'recall', memories: [{ slot: 'work' }] })), null);
  assert.equal(parseServerEvent(JSON.stringify({ type: 'recall', memories: Array(21).fill({ slot: 'a', value: 'b' }) })), null);
});
