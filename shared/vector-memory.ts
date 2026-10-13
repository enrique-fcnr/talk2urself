export type VectorMemory = {
  id: string; slot: string; value: string; evidence: string; basis: string;
  createdAt: string; embedding: number[];
  category?: { key: string; label: string; color: string };
};
export type VectorSnapshot = { items: VectorMemory[]; truncated: boolean; limit: number };
