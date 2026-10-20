// O mesmo contrato é usado pela interface e pelo servidor.
import { parsePhonemeCues, type PhonemeCue } from './lip-sync';
import { parseGestureCues, type GestureCue } from './gestures';
export const conversationStates = ['idle', 'listening', 'thinking', 'speaking'] as const;
export type ConversationState = (typeof conversationStates)[number];
// listen: wake the clone straight into listening (the user speaks first); start: wake with a greeting.
export type ClientCommand = 'start' | 'listen' | 'submit-demo' | 'reset' | 'playback-ended';
// A turn may run a full minute: longer thoughts are not cut mid-sentence (2 MB covers it at the browser's bitrates).
export const maxRecordingSeconds = 60;
export const maxRecordingBytes = 2_000_000;
export const audioMimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'] as const;
export type AudioInput = { type: 'audio-input'; mime: string; seconds: number };
export type Usage = { turns: number; sttSeconds: number; ttsCharacters: number; inputTokens: number; outputTokens: number; cachedTokens: number };
export type Health = { ok: true; mode: 'demo' | 'voice'; model: string | null };
// Saved facts the server pulled in to answer the current question; the brain view lights them up.
export type RecalledMemory = { slot: string; value: string };
export const maxRecalled = 20;
export type ServerEvent =
  | { type: 'state'; state: ConversationState; text: string }
  // language: the language the user spoke in (their take then feeds that language's voice clone).
  | { type: 'transcript'; text: string; language?: 'pt' | 'en' }
  // A reply arrives sentence by sentence: segment counts from 0, last marks the final one, from/to place it in the spoken text.
  // audio/pcm: the segment streams as raw 16-bit mono 24 kHz pieces (binary messages) until its audio-done, which brings the mouth cues.
  | { type: 'audio-output'; mime: 'audio/wav' | 'audio/pcm'; phonemes?: PhonemeCue[]; gestures?: GestureCue[]; segment?: number; last?: boolean; from?: number; to?: number }
  | { type: 'audio-done'; segment: number; phonemes: PhonemeCue[] }
  // The reply has no more segments than these (sent when the last one went out before that was known).
  | { type: 'speech-end'; segments: number }
  | { type: 'recall'; memories: RecalledMemory[] }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseClientCommand(raw: string): ClientCommand | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.type !== 'command') return null;
    return value.command === 'start' || value.command === 'listen' || value.command === 'submit-demo' || value.command === 'reset' || value.command === 'playback-ended'
      ? value.command
      : null;
  } catch {
    return null;
  }
}

// While a reply plays, the page reports each segment it starts (so the next one is voiced) and an interruption,
// with how many characters of the reply the user heard.
// user-speaking: the user started talking (a turn held as unfinished then waits for the rest).
export type SpeechProgress = { type: 'playing'; segment: number } | { type: 'interrupt'; heard: number } | { type: 'user-speaking' };
export function parseSpeechProgress(raw: string): SpeechProgress | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    if (value.type === 'playing' && Number.isSafeInteger(value.segment) && Number(value.segment) >= 0 && Number(value.segment) < 200) return { type: 'playing', segment: Number(value.segment) };
    if (value.type === 'user-speaking') return { type: 'user-speaking' };
    if (value.type === 'interrupt' && typeof value.heard === 'number' && Number.isFinite(value.heard) && value.heard >= 0 && value.heard <= 4000) return { type: 'interrupt', heard: value.heard };
    return null;
  } catch { return null; }
}

export function parseAudioInput(raw: string): AudioInput | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.type !== 'audio-input' || typeof value.mime !== 'string' || value.mime.length > 100 ||
      typeof value.seconds !== 'number' || !Number.isFinite(value.seconds) || value.seconds <= 0 || value.seconds > maxRecordingSeconds + 1) return null;
    // Browsers may add codec details to the type ("audio/mp4;codecs=mp4a.40.2"): the container decides.
    const mime = audioMimeTypes.find((known) => known === value.mime) ?? audioMimeTypes.find((known) => known === String(value.mime).split(';')[0].trim().toLowerCase());
    if (!mime) return null;
    return { type: 'audio-input', mime, seconds: value.seconds };
  } catch { return null; }
}

export function parseServerEvent(raw: string): ServerEvent | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    if (value.type === 'transcript' && typeof value.text === 'string') return { type: 'transcript', text: value.text, ...(value.language === 'en' || value.language === 'pt' ? { language: value.language } : {}) };
    if (value.type === 'speech-end' && Number.isSafeInteger(value.segments) && Number(value.segments) > 0) return { type: 'speech-end', segments: Number(value.segments) };
    if (value.type === 'audio-done' && Number.isSafeInteger(value.segment) && Number(value.segment) >= 0) {
      const phonemes = parsePhonemeCues(value.phonemes);
      return phonemes ? { type: 'audio-done', segment: Number(value.segment), phonemes } : null;
    }
    if (value.type === 'audio-output' && (value.mime === 'audio/wav' || value.mime === 'audio/pcm')) {
      const phonemes = value.phonemes === undefined ? undefined : parsePhonemeCues(value.phonemes);
      const gestures = value.gestures === undefined ? undefined : parseGestureCues(value.gestures);
      if (phonemes === null || gestures === null) return null;
      const count = (key: string) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0 ? Number(value[key]) : undefined;
      const segment = count('segment'), from = count('from'), to = count('to');
      return { type: 'audio-output', mime: value.mime, ...(phonemes ? { phonemes } : {}), ...(gestures ? { gestures } : {}),
        ...(segment !== undefined ? { segment, last: value.last === true } : {}), ...(from !== undefined && to !== undefined && to >= from ? { from, to } : {}) };
    }
    if (value.type === 'usage' && isRecord(value.usage)) {
      const usage = value.usage;
      if (['turns', 'sttSeconds', 'ttsCharacters', 'inputTokens', 'outputTokens', 'cachedTokens']
        .every((key) => typeof usage[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0)) {
        return { type: 'usage', usage: usage as Usage };
      }
    }
    if (value.type === 'recall' && Array.isArray(value.memories) && value.memories.length <= maxRecalled &&
      value.memories.every((item) => isRecord(item) && typeof item.slot === 'string' && item.slot.length <= 60 && typeof item.value === 'string' && item.value.length <= 600)) {
      return { type: 'recall', memories: value.memories.map((item) => ({ slot: String(item.slot), value: String(item.value) })) };
    }
    if (value.type === 'error' && typeof value.message === 'string') {
      return { type: 'error', message: value.message };
    }
    if (value.type === 'state' && typeof value.text === 'string' &&
      conversationStates.some((state) => state === value.state)) {
      return { type: 'state', state: value.state as ConversationState, text: value.text };
    }
    return null;
  } catch {
    return null;
  }
}
