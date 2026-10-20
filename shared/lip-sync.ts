import type { GestureCue } from './gestures';
// level scales how far the mouth opens for this sound (stressed syllables above 1, reduced ones below).
export type PhonemeCue = { phoneme: string; start: number; end: number; level?: number };
export const mouthMorphs = ['AA', 'EE', 'IH', 'OH', 'OU', 'CH', 'TH', 'ff', 'kk', 'nn', 'pp', 'rr', 'ss', 'JawOpen',
  'LipsPucker', 'LipsFunnel', 'LipsStretch_L', 'LipsStretch_R', 'LipsUpperClose', 'LipsLowerClose'] as const;
// Lip shapes the viseme alone barely moves: pressing, rounding and spreading.
const lipShapes: readonly MouthMorph[] = ['LipsPucker', 'LipsFunnel', 'LipsStretch_L', 'LipsStretch_R'];
const vowelShapes: readonly MouthMorph[] = ['AA', 'EE', 'IH', 'OH', 'OU'];
// What a tongue consonant inherits from neighbouring vowels: their jaw opening and lip shape.
const vowelCarry: readonly MouthMorph[] = [...vowelShapes, ...lipShapes];
export type MouthMorph = typeof mouthMorphs[number];
export type MouthPose = Partial<Record<MouthMorph, number>>;
export function parsePhonemeCues(value: unknown): PhonemeCue[] | null {
  if (!Array.isArray(value) || value.length > 5000) return null;
  let previous = -1;
  for (const cue of value) {
    if (!cue || typeof cue !== 'object' || typeof cue.phoneme !== 'string' || cue.phoneme.length > 32 ||
      typeof cue.start !== 'number' || typeof cue.end !== 'number' || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) ||
      cue.start < 0 || cue.end <= cue.start || cue.end > 180 || cue.start < previous ||
      (cue.level !== undefined && (typeof cue.level !== 'number' || !Number.isFinite(cue.level) || cue.level < 0 || cue.level > 2))) return null;
    previous = cue.start;
  }
  return value.map(cue => ({ phoneme: cue.phoneme, start: cue.start, end: cue.end, ...(cue.level !== undefined ? { level: cue.level } : {}) }));
}
export function phonemePose(sound: string): MouthPose {
  // Local amplitude cues are mouth opening levels, not inferred phonemes.
  if (sound === 'audio-soft') return { JawOpen: .18 };
  if (sound === 'audio-medium') return { JawOpen: .38 };
  if (sound === 'audio-loud') return { JawOpen: .6 };
  const p = sound.toLowerCase().normalize('NFD').replace(/[\u0300-\u036fˈˌːˑ0-9]/g, '').trim();
  if (['', 'sil', 'sp', 'pau', '<pad>', '_', ' '].includes(p)) return {};
  // The model's visemes move the jaw and tongue; the extra lip shapes press, round and spread the lips as real speech does.
  if (['p', 'b', 'm'].includes(p)) return { pp: .85, LipsUpperClose: .45, LipsLowerClose: .45 };
  if (['f', 'v'].includes(p)) return { ff: .8 };
  if (['θ', 'ð', 'th', 'dh'].includes(p)) return { TH: .75 };
  if (['tʃ', 'dʒ', 'ʃ', 'ʒ', 'ch', 'jh', 'sh', 'zh'].includes(p)) return { CH: .7, LipsFunnel: .45 };
  if (['s', 'z'].includes(p)) return { ss: .65, LipsStretch_L: .2, LipsStretch_R: .2 };
  if (['t', 'd', 'n', 'l', 'ɲ', 'ɴ', 'ɾ'].includes(p)) return { nn: .6 };
  if (['r', 'ɹ', 'ʁ', 'ʀ', 'rr'].includes(p)) return { rr: .65 };
  if (['k', 'g', 'ɡ', 'ŋ', 'kk'].includes(p)) return { kk: .65 };
  if (['i', 'j', 'y', 'iy', 'ee'].includes(p)) return { EE: .7, LipsStretch_L: .35, LipsStretch_R: .35 };
  if (['e', 'ɛ', 'ɪ', 'eh', 'ih', 'ey'].includes(p)) return { IH: .7, LipsStretch_L: .2, LipsStretch_R: .2 };
  if (['o', 'ɔ', 'oh', 'ao', 'ow'].includes(p)) return { OH: .75, LipsFunnel: .35 };
  if (['u', 'ʊ', 'w', 'uw', 'uh', 'ou'].includes(p)) return { OU: .75, LipsPucker: .55 };
  if (['a', 'ɑ', 'ɐ', 'æ', 'ə', 'ʌ', 'aa', 'ah', 'ae', 'aw', 'ay'].includes(p)) return { AA: .7 };
  // Combined English sounds (ʊɹ, aɪ, oʊ, ɝ…): shape the mouth for the first one.
  if ([...p].length > 1) return phonemePose([...p][0]);
  if (['ɝ', 'ɚ'].includes(p)) return { rr: .65 };
  return { JawOpen: .18 };
}
// Use the player's clock, so pauses, retries and tab throttling cannot drift.
export function mouthPoseAt(cues: PhonemeCue[], seconds: number, playing: boolean): MouthPose {
  if (!playing || !Number.isFinite(seconds) || seconds < 0) return {};
  const pose: MouthPose = {};
  let total = 0;
  for (let index = 0; index < cues.length; index++) {
    const cue = cues[index];
    if (cue.start > seconds + .03) break;
    if (cue.end < seconds - .03) continue;
    const weight = Math.max(0, Math.min(1, (seconds - cue.start + .03) / .06, (cue.end - seconds + .03) / .06));
    const shape = phonemePose(cue.phoneme);
    const add = (from: MouthPose, keys: readonly MouthMorph[], scale: number) => {
      for (const key of keys) if (from[key]) pose[key] = (pose[key] ?? 0) + from[key]! * scale * weight;
    };
    add(shape, mouthMorphs, cue.level ?? 1);
    // Coarticulation. Tongue consonants (t, n, s, r, k, ch) barely move the jaw in real speech: they keep the opening
    // and lip shape of the vowels around them, so syllables flow instead of snapping shut. Every consonant also
    // anticipates the rounding or spreading of the next vowel ("tu", "si", "pu").
    const previous = cues[index - 1], next = cues[index + 1];
    const adjacent = (cue2: PhonemeCue | undefined, gap: number) => !!cue2 && gap < .05 && vowelShapes.some(key => phonemePose(cue2.phoneme)[key]);
    const tongueOnly = !shape.pp && !shape.ff && !vowelShapes.some(key => shape[key]);
    if (tongueOnly && adjacent(previous, cue.start - (previous?.end ?? 0))) add(phonemePose(previous!.phoneme), vowelCarry, .25 * (previous!.level ?? 1));
    if (adjacent(next, (next?.start ?? 0) - cue.end)) {
      const following = phonemePose(next!.phoneme);
      if (tongueOnly) add(following, vowelCarry, .4 * (next!.level ?? 1));
      else if (!vowelShapes.some(key => shape[key])) add(following, lipShapes, .5);
    }
    total += weight;
  }
  if (total > 1) for (const key of mouthMorphs) if (pose[key] !== undefined) pose[key]! /= total;
  return pose;
}
// The playback clock of a reply (an audio element satisfies it, and so does a streamed segment).
export type PlaybackClock = { readonly currentTime: number; readonly duration: number; readonly paused: boolean; readonly ended: boolean };
// from/to/total: where this audio's words sit in the whole reply (characters), when a reply plays in segments.
export type AvatarPlayback = { audio: PlaybackClock; cues: PhonemeCue[]; gestures: GestureCue[]; from?: number; to?: number; total?: number };
