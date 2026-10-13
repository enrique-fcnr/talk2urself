// Gestures the reply can request while Kelly speaks. Marks are removed before speech synthesis.
export const speechGestures = ['nod', 'shrug', 'tilt'] as const;
export type SpeechGesture = (typeof speechGestures)[number];
// `at` is the mark's position in the spoken text, from 0 (start) to 1 (end).
export type GestureCue = { gesture: SpeechGesture; at: number };
export const maxGestureCues = 2;
const marks: Record<string, SpeechGesture> = { concorda: 'nod', ombros: 'shrug', inclina: 'tilt' };
const markPattern = /\s*\[(\p{L}{2,20})\]\s*/gu;

// Unknown bracketed words such as [risos] are removed too, so the voice never reads them aloud.
export function extractGestures(reply: string): { text: string; gestures: GestureCue[] } {
  let text = '', last = 0;
  const found: { gesture: SpeechGesture; offset: number }[] = [];
  for (const match of reply.matchAll(markPattern)) {
    text += reply.slice(last, match.index);
    last = match.index + match[0].length;
    // Keep one space between the words the mark separated, but none before punctuation.
    if (text && last < reply.length && !/^[.,;:!?…)]/.test(reply.slice(last))) text += ' ';
    const gesture = marks[match[1].toLowerCase()];
    if (gesture && found.length < maxGestureCues) found.push({ gesture, offset: text.length });
  }
  text += reply.slice(last);
  const length = Math.max(text.length, 1);
  return { text: text.trim(), gestures: found.map(({ gesture, offset }) => ({ gesture, at: Math.min(1, offset / length) })) };
}

export function parseGestureCues(value: unknown): GestureCue[] | null {
  if (!Array.isArray(value) || value.length > maxGestureCues) return null;
  const cues: GestureCue[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { gesture, at } = item as Record<string, unknown>;
    if (!speechGestures.some((name) => name === gesture) || typeof at !== 'number' || !Number.isFinite(at) || at < 0 || at > 1) return null;
    cues.push({ gesture: gesture as SpeechGesture, at });
  }
  return cues;
}
