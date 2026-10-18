// A reply is voiced sentence by sentence: the first one quickly, each next one only once the previous starts playing.
// The user hears the answer sooner, and an interruption leaves at most one unplayed sentence paid for.
import type { GestureCue } from '../../../shared/gestures.ts';

// from/to: the segment's place in the whole spoken text, in characters.
export type SpeechSegment = { text: string; from: number; to: number };
// A short first segment starts the voice sooner; later ones are longer so the voice keeps its flow.
const firstMin = 18, firstMax = 140, laterMin = 70, laterMax = 260;

export function splitSpeech(text: string): SpeechSegment[] {
  // Sentences end at . ! ? … (with closing quotes or brackets), followed by space or the end.
  const sentences: SpeechSegment[] = [];
  const pattern = /[^.!?…]*(?:[.!?…]+["'”’)\]]*(?=\s|$)|$)/gu;
  for (const match of text.matchAll(pattern)) {
    if (!match[0].trim()) continue;
    const from = match.index! + (match[0].length - match[0].trimStart().length), to = match.index! + match[0].trimEnd().length;
    sentences.push({ text: text.slice(from, to), from, to });
  }
  const segments: SpeechSegment[] = [];
  for (const sentence of sentences) {
    const last = segments.at(-1), first = segments.length === 1;
    const min = first ? firstMin : laterMin, max = first ? firstMax : laterMax;
    // Join a sentence to the previous segment while that one is still too short and the result not too long.
    if (last && last.to - last.from < min && sentence.to - last.from <= max) segments[segments.length - 1] = { text: text.slice(last.from, sentence.to), from: last.from, to: sentence.to };
    else segments.push(sentence);
  }
  // A long sentence with no stop is still one segment; the voice handles it.
  return segments.length ? segments : [{ text, from: 0, to: text.length }];
}

// Gesture marks are fractions of the whole reply; each goes to the segment it falls in, as a fraction of that segment.
export function segmentGestures(gestures: GestureCue[], segment: SpeechSegment, total: number): GestureCue[] {
  return gestures.flatMap(({ gesture, at }) => {
    const offset = at * total;
    if (offset < segment.from || offset >= segment.to + (segment.to >= total ? 1 : 0)) return [];
    return [{ gesture, at: Math.min(1, Math.max(0, (offset - segment.from) / Math.max(1, segment.to - segment.from))) }];
  });
}

// What the user heard before interrupting: the text up to `heard` characters, cut back to a whole word.
export function heardPart(text: string, heard: number): string {
  if (heard >= text.length) return text;
  const cut = text.slice(0, Math.max(0, Math.floor(heard)));
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : '').replace(/[\s,;:—-]+$/u, '');
}
