// O mesmo contrato é usado pela interface e pelo servidor.
import { parsePhonemeCues, type PhonemeCue } from './lip-sync';
import { parseGestureCues, type GestureCue } from './gestures';
export const conversationStates = ['idle', 'listening', 'thinking', 'speaking'] as const;
export type ConversationState = (typeof conversationStates)[number];
export type ClientCommand = 'start' | 'submit-demo' | 'reset' | 'playback-ended';
export const maxRecordingSeconds = 30;
export const maxRecordingBytes = 2_000_000;
export const audioMimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'] as const;
export type AudioInput = { type: 'audio-input'; mime: string; seconds: number };
export type Usage = { turns: number; sttSeconds: number; ttsCharacters: number; inputTokens: number; outputTokens: number; cachedTokens: number };
export type Health = { ok: true; mode: 'demo' | 'voice'; model: string | null };
export type ServerEvent =
  | { type: 'state'; state: ConversationState; text: string }
  | { type: 'transcript'; text: string }
  | { type: 'audio-output'; mime: 'audio/wav'; phonemes?: PhonemeCue[]; gestures?: GestureCue[] }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseClientCommand(raw: string): ClientCommand | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.type !== 'command') return null;
    return value.command === 'start' || value.command === 'submit-demo' || value.command === 'reset' || value.command === 'playback-ended'
      ? value.command
      : null;
  } catch {
    return null;
  }
}

export function parseAudioInput(raw: string): AudioInput | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.type !== 'audio-input' || typeof value.mime !== 'string' || !audioMimeTypes.some((mime) => mime === value.mime) ||
      typeof value.seconds !== 'number' || !Number.isFinite(value.seconds) || value.seconds <= 0 || value.seconds > maxRecordingSeconds + 1) return null;
    return { type: 'audio-input', mime: value.mime, seconds: value.seconds };
  } catch { return null; }
}

export function parseServerEvent(raw: string): ServerEvent | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    if (value.type === 'transcript' && typeof value.text === 'string') return { type: 'transcript', text: value.text };
    if (value.type === 'audio-output' && value.mime === 'audio/wav') {
      const phonemes = value.phonemes === undefined ? undefined : parsePhonemeCues(value.phonemes);
      const gestures = value.gestures === undefined ? undefined : parseGestureCues(value.gestures);
      if (phonemes === null || gestures === null) return null;
      return { type: 'audio-output', mime: 'audio/wav', ...(phonemes ? { phonemes } : {}), ...(gestures ? { gestures } : {}) };
    }
    if (value.type === 'usage' && isRecord(value.usage)) {
      const usage = value.usage;
      if (['turns', 'sttSeconds', 'ttsCharacters', 'inputTokens', 'outputTokens', 'cachedTokens']
        .every((key) => typeof usage[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0)) {
        return { type: 'usage', usage: usage as Usage };
      }
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
