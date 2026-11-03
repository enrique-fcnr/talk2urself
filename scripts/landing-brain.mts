// Builds the brain shown on the public landing page: a made-up person's memories (no real data), embedded the same way
// the server embeds real ones and laid out the same way the app lays them out. Only positions, text and links are
// written; the embeddings stay here.
//   node --env-file=.env --import tsx scripts/landing-brain.mts
import { writeFileSync } from 'node:fs';
import { initialCategories, initialColor } from '../apps/server/src/categories.ts';
import { projectMemories } from '../apps/web/src/vectors/projection.ts';
import { findSynapses, layoutBrain } from '../apps/web/src/brain/layout.ts';
import type { VectorMemory } from '../shared/vector-memory.ts';

const memories: [category: string, value: string][] = [
  ['identity', 'My name is Maya, I am 29 and I live in Lisbon.'],
  ['identity', 'I grew up in a small coastal town in Brazil.'],
  ['work', 'I work as a product designer at a health startup.'],
  ['work', 'I lead the redesign of the patient booking app.'],
  ['work', 'I want to move into a design leadership role within two years.'],
  ['studies', 'I am taking an evening course on data visualisation.'],
  ['studies', 'I learn best by building small side projects.'],
  ['goals', 'I want to run a half marathon before I turn 30.'],
  ['goals', 'I am saving to spend three months working from Japan.'],
  ['goals', 'I want to launch a tiny app of my own this year.'],
  ['routine', 'I run three mornings a week before work.'],
  ['routine', 'I keep Sunday evenings free to plan the week.'],
  ['family', 'My younger brother is studying medicine in São Paulo.'],
  ['family', 'I call my mother every Sunday.'],
  ['friends', 'My closest friend, Ana, is the person I go to for honest feedback.'],
  ['interests', 'I play the guitar, mostly old bossa nova songs.'],
  ['interests', 'I love film photography and develop my own rolls.'],
  ['preferences', 'My favourite colour is a deep green.'],
  ['preferences', 'I prefer quiet cafés to busy bars.'],
  ['principles', 'Honesty matters more to me than being liked.'],
  ['principles', 'I would rather do fewer things well than many things badly.'],
  ['finances', 'I keep six months of expenses saved before any big change.'],
  ['constraints', 'Evenings are my only free time on weekdays.'],
  ['health', 'Running is how I clear my head when I am anxious.'],
  ['assistant_role', 'I want my clone to push back when I overcommit.'],
  ['speaking_preferences', 'I like direct answers, without too much cushioning.'],
  ['reasoning_style', 'I make big decisions by writing pros and cons, then sleeping on it.'],
  ['life_events', 'Moving to Lisbon alone at 25 changed how I see myself.'],
];

const key = process.env.OPENAI_API_KEY?.trim();
if (!key) throw new Error('OPENAI_API_KEY is missing (run with --env-file=.env).');
const response = await fetch('https://api.openai.com/v1/embeddings', {
  method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'text-embedding-3-small', input: memories.map(([, value]) => value), dimensions: 1536 }),
});
if (!response.ok) throw new Error(`Embeddings failed: ${response.status}`);
const vectors: number[][] = (await response.json()).data.map((row: { embedding: number[] }) => row.embedding);

const labels = new Map(initialCategories.map(([category, label]) => [category, label as string]));
const start = Date.parse('2026-09-01T10:00:00Z');
const items: VectorMemory[] = memories.map(([category, value], index) => ({
  id: `demo-${index + 1}`, slot: category, value, evidence: '', basis: 'stated',
  // Spread over two months, as if learned across many conversations.
  createdAt: new Date(start + index * 2.2 * 86_400_000).toISOString(), embedding: vectors[index],
  category: { key: category, label: labels.get(category) ?? category, color: initialColor(category) },
}));
const layout = { points: layoutBrain(projectMemories(items).points), synapses: findSynapses(items) };
for (const point of layout.points) point.memory = { ...point.memory, embedding: [] };
writeFileSync('apps/web/landing/brain-demo.json', JSON.stringify(layout));
console.log(`${layout.points.length} memories, ${layout.synapses.length} links.`);
