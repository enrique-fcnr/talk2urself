import type { VectorMemory } from '../../../../shared/vector-memory.ts';
export type ProjectedPoint = { id: string; x: number; y: number; z: number; originalIndex: number; document: VectorMemory };
export type Projection = { points: ProjectedPoint[]; retainedVariance: number };
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] ** 2; normB += b[i] ** 2; }
  return normA && normB ? Math.max(-1, Math.min(1, dot / Math.sqrt(normA * normB))) : 0;
}
// PCA aproximada por iteração de potência, calculada sobre todas as dimensões em um worker.
export function projectMemories(items: VectorMemory[]): Projection {
  if (!items.length) return { points: [], retainedVariance: 0 };
  const dimensions = items[0].embedding.length;
  const normalized = items.map(({ embedding }) => {
    if (embedding.length !== dimensions || embedding.some((v) => !Number.isFinite(v))) throw new Error('Invalid vector.');
    const norm = Math.hypot(...embedding);
    return embedding.map((v) => norm ? v / norm : 0);
  });
  const mean = Array.from({ length: dimensions }, (_, d) => normalized.reduce((sum, row) => sum + row[d], 0) / items.length);
  const centered = normalized.map((row) => row.map((v, d) => v - mean[d]));
  const total = centered.reduce((sum, row) => sum + row.reduce((energy, v) => energy + v * v, 0), 0);
  const components: number[][] = [], scores: number[][] = [];
  for (let axis = 0; axis < 3; axis++) {
    let direction = Array.from({ length: dimensions }, (_, d) => Math.sin((d + 1) * (axis + 1) * 1.618));
    for (let iteration = 0; iteration < 80; iteration++) {
      const next = Array<number>(dimensions).fill(0);
      for (const row of centered) {
        const dot = row.reduce((sum, v, d) => sum + v * direction[d], 0);
        for (let d = 0; d < dimensions; d++) next[d] += row[d] * dot;
      }
      for (const previous of components) {
        const dot = next.reduce((sum, v, d) => sum + v * previous[d], 0);
        for (let d = 0; d < dimensions; d++) next[d] -= dot * previous[d];
      }
      const norm = Math.hypot(...next);
      if (norm < 1e-12) { direction = Array<number>(dimensions).fill(0); break; }
      const unit = next.map((v) => v / norm);
      const difference = unit.reduce((sum, v, d) => sum + (v - direction[d]) ** 2, 0);
      direction = unit;
      if (difference < 1e-14) break;
    }
    components.push(direction);
    scores.push(centered.map((row) => row.reduce((sum, v, d) => sum + v * direction[d], 0)));
  }
  const retained = scores.reduce((sum, axis) => sum + axis.reduce((energy, v) => energy + v * v, 0), 0);
  return { points: items.map((document, i) => ({ id: document.id, x: scores[0][i], y: scores[1][i], z: scores[2][i], originalIndex: i, document })),
    retainedVariance: total > 1e-12 ? Math.min(1, retained / total) : 0 };
}
