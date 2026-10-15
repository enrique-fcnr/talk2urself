import { projectMemories } from '../vectors/projection';
import { findSynapses, layoutBrain, type BrainLayout } from './layout';
import type { VectorMemory } from '../../../../shared/vector-memory';
// Projection and similarity read every dimension of every embedding; doing it here keeps the brain animating smoothly.
self.onmessage = (event: MessageEvent<{ items: VectorMemory[] }>) => {
  try {
    const { items } = event.data, projection = projectMemories(items);
    const layout: BrainLayout = { points: layoutBrain(projection.points), synapses: findSynapses(items) };
    // Embeddings stay in the worker; the view only needs positions and text.
    for (const point of layout.points) point.memory = { ...point.memory, embedding: [] };
    self.postMessage({ layout });
  } catch { self.postMessage({ error: true }); }
};
