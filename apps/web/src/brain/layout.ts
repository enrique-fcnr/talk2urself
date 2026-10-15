import type { VectorMemory } from '../../../../shared/vector-memory';
import { cosineSimilarity, type ProjectedPoint } from '../vectors/projection';

export type Vec3 = [number, number, number];
export type BrainPoint = { id: string; position: Vec3; memory: VectorMemory };
export type Synapse = [number, number, number]; // indices of two points in the layout, and their cosine similarity
export type BrainLayout = { points: BrainPoint[]; synapses: Synapse[] };

// How far each region sits from the centre, how tightly its memories gather around it,
// the closest two regions may come, and the edge points stay inside of (all in unit-ball units).
const regionDistance = .6, spread = .6, regionGap = .42, edge = .9;
const length = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const scale = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
// Deterministic jitter from the id, so two identical embeddings never sit on the same pixel and nothing shuffles between loads.
function jitter(id: string): Vec3 {
  let h = 2166136261;
  for (const char of id) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  const next = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0) / 4294967296 - .5) * .06;
  return [next(), next(), next()];
}
// Evenly spread fallback directions (golden spiral) for regions whose memories average out at the centre.
function spiral(index: number, count: number): Vec3 {
  const y = 1 - (index + .5) / count * 2, radius = Math.sqrt(1 - y * y), angle = index * Math.PI * (3 - Math.sqrt(5));
  return [Math.cos(angle) * radius, y, Math.sin(angle) * radius];
}

// Places memories in a unit ball: each subject (category) gets its own region, in the direction its memories point
// in the 3D projection of the embeddings, and its memories keep their relative layout around that region's centre.
export function layoutBrain(projected: ProjectedPoint[]): BrainPoint[] {
  if (!projected.length) return [];
  const raw = projected.map(({ x, y, z }): Vec3 => [x, y, z]);
  // Normalise by the 90th percentile radius, so one outlier cannot squeeze everything else into the middle.
  const radii = raw.map(length).sort((a, b) => a - b), reach = radii[Math.floor((radii.length - 1) * .9)] || 1;
  const unit = raw.map((v) => scale(v, 1 / reach));
  const keyOf = (point: ProjectedPoint) => point.document.category?.key ?? point.document.slot;
  const groups = new Map<string, number[]>();
  projected.forEach((point, i) => groups.set(keyOf(point), [...(groups.get(keyOf(point)) ?? []), i]));
  const keys = [...groups.keys()].sort();
  const centroids = new Map(keys.map((key) => {
    const members = groups.get(key)!;
    return [key, scale(members.reduce((sum, i) => add(sum, unit[i]), [0, 0, 0] as Vec3), 1 / members.length)] as const;
  }));
  // A single subject sits in the middle; several spread out along their own directions.
  const anchors = new Map(keys.map((key, index) => {
    const centroid = centroids.get(key)!, size = length(centroid);
    const direction = size > 1e-6 ? scale(centroid, 1 / size) : spiral(index, keys.length);
    return [key, keys.length === 1 ? [0, 0, 0] as Vec3 : scale(direction, regionDistance)] as const;
  }));
  // Push regions apart until no two overlap, keeping them inside the ball.
  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    for (let a = 0; a < keys.length; a++) for (let b = a + 1; b < keys.length; b++) {
      const pa = anchors.get(keys[a])!, pb = anchors.get(keys[b])!, gap = sub(pb, pa);
      let distance = length(gap);
      if (distance >= regionGap) continue;
      const away = distance > 1e-6 ? scale(gap, 1 / distance) : spiral(b, keys.length);
      distance = Math.max(distance, 1e-6);
      const push = scale(away, (regionGap - distance) / 2);
      anchors.set(keys[a], sub(pa, push)); anchors.set(keys[b], add(pb, push)); moved = true;
    }
    for (const key of keys) { const p = anchors.get(key)!, r = length(p); if (r > regionDistance + .1) anchors.set(key, scale(p, (regionDistance + .1) / r)); }
    if (!moved) break;
  }
  return projected.map((point, i) => {
    const key = keyOf(point);
    let position = add(add(anchors.get(key)!, scale(sub(unit[i], centroids.get(key)!), spread)), jitter(point.id));
    const r = length(position);
    if (r > edge) position = scale(position, edge / r);
    return { id: point.id, position, memory: point.document };
  });
}

// Each memory links to its closest neighbours by meaning (cosine similarity on the full embeddings),
// above a floor so unrelated facts stay unlinked. Pairs are listed once.
export function findSynapses(memories: VectorMemory[], neighbours = 2, floor = .3): Synapse[] {
  const seen = new Set<string>(), links: Synapse[] = [];
  memories.forEach((memory, i) => {
    memories.map((other, j) => [j, i === j ? -Infinity : cosineSimilarity(memory.embedding, other.embedding)] as const)
      .filter(([, similarity]) => similarity >= floor).sort((a, b) => b[1] - a[1]).slice(0, neighbours)
      .forEach(([j, similarity]) => {
        const key = i < j ? `${i}:${j}` : `${j}:${i}`;
        if (!seen.has(key)) { seen.add(key); links.push([Math.min(i, j), Math.max(i, j), similarity]); }
      });
  });
  return links;
}

// The memories the server used for the latest answer, matched to points by their subject slot and text.
export type Recall = { keys: Set<string>; at: number };
export const recallKey = (slot: string, value: string) => `${slot}\u0000${value.trim()}`;
