import type { PhonemeCue } from '../../../shared/lip-sync.ts';

// Brazilian Portuguese spelling is regular enough to recover the mouth shapes of each word from its letters.
// Cartesia gives the start and end of every word; the shapes are spread inside that span by typical length.
// Labels are the sounds phonemePose (shared/lip-sync.ts) understands.
type Sound = { label: string; length: number };
export type WordTiming = { word: string; start: number; end: number };

const vowels: Record<string, string> = { a: 'a', á: 'a', à: 'a', â: 'a', ã: 'a', e: 'e', é: 'e', ê: 'e', i: 'i', í: 'i', o: 'o', ó: 'o', ô: 'o', õ: 'o', u: 'u', ú: 'u', ü: 'u', y: 'i' };
// Relative durations: vowels carry the syllable, taps and plosives are brief.
const lengths: Record<string, number> = { a: 1, e: 1, i: .9, o: 1, u: .9, p: .7, f: .8, s: .9, 'ʃ': .9, n: .55, 'ɾ': .45, r: .6, k: .6 };
const isVowel = (char: string | undefined) => !!char && char in vowels;

export function wordSounds(word: string): Sound[] {
  const w = word.toLowerCase().replace(/[^a-zà-úçüñ]/g, '');
  const out: string[] = [];
  for (let i = 0; i < w.length; i++) {
    const c = w[i], next = w[i + 1], after = w[i + 2], prev = w[i - 1];
    const atEnd = i === w.length - 1, closesSyllable = atEnd || (!isVowel(next) && next !== 'h');
    if (isVowel(c)) {
      // Unstressed final e/o sound like i/u in Brazil ("noite", "falo"); "ão" glides to u.
      const finalE = (c === 'e' && (atEnd || (next === 's' && i === w.length - 2)));
      const finalO = (c === 'o' && (atEnd || (next === 's' && i === w.length - 2)) && prev !== undefined);
      out.push(finalE ? 'i' : finalO ? 'u' : vowels[c]);
      if (c === 'ã' && next === 'o') { out.push('u'); i++; }
      continue;
    }
    const pair = c + (next ?? '');
    const softSc = pair === 'sc' && (after === 'e' || after === 'i');
    if (['ch', 'lh', 'nh', 'rr', 'ss'].includes(pair) || softSc) {
      out.push(pair === 'ch' ? 'ʃ' : pair === 'rr' ? 'r' : pair === 'ss' || softSc ? 's' : 'n'); i++; continue;
    }
    // The u in "que", "qui", "gue", "gui" is silent.
    if ((c === 'q' || c === 'g') && next === 'u' && (after === 'e' || after === 'i')) { out.push('k'); i++; continue; }
    switch (c) {
      case 'p': case 'b': out.push('p'); break;
      // Final or pre-consonant m/n only nasalise the vowel ("também", "canto"): no lip closure.
      case 'm': if (!(isVowel(prev) && closesSyllable)) out.push('p'); break;
      case 'n': if (!(isVowel(prev) && closesSyllable)) out.push('n'); break;
      case 'f': case 'v': out.push('f'); break;
      case 's': case 'z': case 'ç': out.push('s'); break;
      case 'c': out.push(next === 'e' || next === 'i' ? 's' : 'k'); break;
      case 'g': out.push(next === 'e' || next === 'i' ? 'ʃ' : 'k'); break;
      case 'j': case 'x': out.push('ʃ'); break;
      // Before an i sound, t and d become "tchi"/"dji" in Brazil ("tia", "noite", "dia").
      case 't': case 'd': out.push(next === 'i' || (next === 'e' && (i + 1 === w.length - 1 || (after === 's' && i + 2 === w.length - 1))) ? 'ʃ' : 'n'); break;
      // Syllable-final l is vocalised to u in Brazil ("Brasil", "alto").
      case 'l': out.push(isVowel(prev) && closesSyllable ? 'u' : 'n'); break;
      case 'r': out.push(i === 0 || !isVowel(prev) || atEnd ? 'r' : isVowel(next) ? 'ɾ' : 'r'); break;
      case 'k': case 'q': out.push('k'); break;
      case 'w': out.push('u'); break;
      // h is silent.
    }
  }
  return out.map(label => ({ label, length: lengths[label] ?? .6 }));
}

// Loudness envelope of the speech: RMS per frame of `frameSeconds`.
export type Envelope = { frames: Float32Array; frameSeconds: number };
// How loud each sound typically is: vowels carry the energy, stops are near silence. Used to align sounds to the audio.
const expectedLoudness: Record<string, number> = { a: 1, e: .95, i: .85, o: .95, u: .85, n: .55, 'ɾ': .6, r: .5, s: .25, 'ʃ': .25, f: .2, p: .05, k: .05 };
const isVowelSound = (label: string) => 'aeiou'.includes(label);

// Cartesia reports some short words ("a", "e") with zero length at the start of the next word; speak them with it.
function joinInstantWords(input: WordTiming[]): WordTiming[] {
  const words = input.map(word => ({ ...word })), out: WordTiming[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i], next = words[i + 1];
    if (word.end - word.start >= .02) { out.push({ ...word }); continue; }
    if (next && next.start - word.start < .05) next.start = Math.min(next.start, word.start), next.word = `${word.word} ${next.word}`;
    else out.push({ ...word, end: word.start + .06 });
  }
  return out;
}

// Monotonic alignment of a word's sounds to its loudness frames (each sound at least 20 ms), so vowels sit on the
// syllable peaks and stops on the dips, instead of being spread evenly by spelling.
function alignToEnvelope(sounds: Sound[], start: number, end: number, envelope: Envelope): number[] | null {
  const first = Math.floor(start / envelope.frameSeconds), last = Math.min(envelope.frames.length, Math.ceil(end / envelope.frameSeconds));
  const minFrames = 2, n = sounds.length, f = last - first;
  if (f < n * minFrames) return null;
  const segment = envelope.frames.subarray(first, last);
  const loudest = Math.max(...segment);
  // A silent span has nothing to align to; keep the spelling-based spread.
  if (!(loudest > 1e-4)) return null;
  const cost = (sound: number, frame: number) => (segment[frame] / loudest - (expectedLoudness[sounds[sound].label] ?? .5)) ** 2;
  // best[s][t]: lowest cost with sound s ending at frame t (exclusive end), each sound spanning >= minFrames.
  const best = Array.from({ length: n + 1 }, () => new Float64Array(f + 1).fill(Infinity)), from = Array.from({ length: n + 1 }, () => new Int32Array(f + 1));
  best[0][0] = 0;
  for (let s = 1; s <= n; s++) for (let t = s * minFrames; t <= f - (n - s) * minFrames; t++) {
    let run = 0;
    for (let k = 1; k <= t - (s - 1) * minFrames; k++) {
      run += cost(s - 1, t - k);
      if (k < minFrames) continue;
      const total = best[s - 1][t - k] + run;
      if (total < best[s][t]) { best[s][t] = total; from[s][t] = t - k; }
    }
  }
  if (!Number.isFinite(best[n][f])) return null;
  const bounds = new Array<number>(n + 1); bounds[n] = f;
  for (let s = n; s > 0; s--) bounds[s - 1] = from[s][bounds[s]];
  return bounds.map(frame => Math.min(end, Math.max(start, (first + frame) * envelope.frameSeconds)));
}

export function wordVisemes(words: WordTiming[], envelope?: Envelope): PhonemeCue[] {
  const cues: PhonemeCue[] = [];
  // Typical loud vowel level of this speech, so stressed syllables open more and reduced ones less.
  const sorted = envelope ? [...envelope.frames].sort((a, b) => a - b) : [];
  const loud = sorted.length ? sorted[Math.floor(sorted.length * .9)] : 0, reference = loud > 1e-4 ? loud : 0;
  for (const { word, start, end } of joinInstantWords(words)) {
    const sounds = wordSounds(word);
    // Numbers or symbols the voice expanded: open the mouth for the span instead of guessing.
    if (!sounds.length) { cues.push({ phoneme: 'audio-medium', start, end }); continue; }
    let bounds = envelope ? alignToEnvelope(sounds, start, end, envelope) : null;
    if (!bounds) {
      const total = sounds.reduce((sum, sound) => sum + sound.length, 0);
      bounds = [start]; for (const sound of sounds) bounds.push(bounds.at(-1)! + (end - start) * sound.length / total);
    }
    sounds.forEach((sound, i) => {
      const from = bounds[i], to = Math.max(bounds[i + 1], from + .001);
      const cue: PhonemeCue = { phoneme: sound.label, start: from, end: to };
      if (envelope && reference && isVowelSound(sound.label)) {
        const a = Math.floor(from / envelope.frameSeconds), b = Math.max(a + 1, Math.ceil(to / envelope.frameSeconds));
        const peak = Math.max(...envelope.frames.subarray(a, Math.min(b, envelope.frames.length)), 0);
        cue.level = Math.round(Math.min(1.15, Math.max(.55, peak / reference)) * 100) / 100;
      }
      cues.push(cue);
    });
  }
  return cues;
}
