import { projectMemories } from './projection';
import type { VectorMemory } from '../../../../shared/vector-memory';
self.onmessage = (event: MessageEvent<{ items: VectorMemory[] }>) => {
  try { self.postMessage({ projection: projectMemories(event.data.items) }); }
  catch { self.postMessage({ error: 'Could not project the embeddings.' }); }
};
