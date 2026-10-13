import { parsePhonemeCues, type PhonemeCue } from '../../../shared/lip-sync.ts';
import { wordVisemes, type Envelope, type WordTiming } from './visemes-pt.ts';
export type TimedSpeech = { audio: Buffer; phonemes: PhonemeCue[] };
const sampleRate = 24000, maxBytes = 8_000_000;
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function pcmToWav(pcm: Buffer): Buffer {
  if (!pcm.length || pcm.length % 2 || pcm.length + 44 > maxBytes) throw new Error('A voz retornou um áudio inválido.');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
// Loudness per 10 ms, lightly smoothed: syllable peaks and consonant dips for aligning mouth shapes to the voice.
function envelope(pcm: Buffer): Envelope {
  const hop = sampleRate / 100, count = Math.floor(pcm.length / 2 / hop), raw = new Float32Array(count);
  for (let frame = 0; frame < count; frame++) {
    let power = 0;
    for (let i = frame * hop; i < (frame + 1) * hop; i++) power += (pcm.readInt16LE(i * 2) / 32768) ** 2;
    raw[frame] = Math.sqrt(power / hop);
  }
  const frames = raw.map((value, i) => .25 * (raw[i - 1] ?? value) + .5 * value + .25 * (raw[i + 1] ?? value));
  return { frames, frameSeconds: .01 };
}
// Coarse audio-driven fallback: detect volume and pauses without another API call.
// These cues cannot identify the vowels or consonants that were pronounced.
function amplitudeCues(pcm: Buffer): PhonemeCue[] {
  const samplesPerFrame = Math.round(sampleRate * .04);
  const levels: { start: number; end: number; rms: number }[] = [];
  for (let offset = 0; offset < pcm.length; offset += samplesPerFrame * 2) {
    const stop = Math.min(pcm.length, offset + samplesPerFrame * 2);
    let power = 0;
    for (let i = offset; i < stop; i += 2) power += (pcm.readInt16LE(i) / 32768) ** 2;
    levels.push({ start: offset / (sampleRate * 2), end: stop / (sampleRate * 2), rms: Math.sqrt(power / ((stop - offset) / 2)) });
  }
  const peak = levels.reduce((max, frame) => Math.max(max, frame.rms), 0);
  const threshold = Math.max(.006, peak * .04);
  const result: PhonemeCue[] = [];
  for (const frame of levels) {
    if (frame.rms < threshold) continue;
    const relative = frame.rms / peak;
    const phoneme = relative < .25 ? 'audio-soft' : relative < .6 ? 'audio-medium' : 'audio-loud';
    const previous = result.at(-1);
    if (previous?.phoneme === phoneme && previous.end === frame.start) previous.end = frame.end;
    else result.push({ phoneme, start: frame.start, end: frame.end });
  }
  return result;
}
export async function readTimedSpeech(response: Response, signal: AbortSignal): Promise<TimedSpeech> {
  if (!response.body) throw new Error('A voz retornou um áudio inválido.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', done = false, bytes = 0, received = 0;
  const chunks: Buffer[] = [], cues: PhonemeCue[] = [], words: WordTiming[] = [];
  let invalidTimings = false, invalidWords = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  function event(frame: string) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    const value: unknown = JSON.parse(data);
    if (!record(value)) throw new Error('A voz retornou dados inválidos.');
    if (value.type === 'error' || typeof value.status_code === 'number' && value.status_code >= 400) throw new Error('Voz Cartesia: Não foi possível gerar a fala sincronizada.');
    if (value.type === 'chunk') {
      if (typeof value.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) throw new Error('A voz retornou um áudio inválido.');
      const chunk = Buffer.from(value.data, 'base64'); bytes += chunk.length;
      if (bytes + 44 > maxBytes) throw new Error('A voz excedeu o limite de áudio.');
      chunks.push(chunk);
    } else if (value.type === 'phoneme_timestamps') {
      const timing = value.phoneme_timestamps;
      if (!record(timing) || !Array.isArray(timing.phonemes) || !Array.isArray(timing.start) || !Array.isArray(timing.end) ||
        timing.phonemes.length !== timing.start.length || timing.phonemes.length !== timing.end.length) { invalidTimings = true; return; }
      const batch = parsePhonemeCues(timing.phonemes.map((phoneme, i) => ({ phoneme, start: (timing.start as unknown[])[i], end: (timing.end as unknown[])[i] })));
      if (!batch || cues.length + batch.length > 5000) { invalidTimings = true; return; }
      cues.push(...batch);
    } else if (value.type === 'timestamps') {
      const timing = value.word_timestamps;
      if (!record(timing) || !Array.isArray(timing.words) || !Array.isArray(timing.start) || !Array.isArray(timing.end) ||
        timing.words.length !== timing.start.length || timing.words.length !== timing.end.length || words.length + timing.words.length > 2000) { invalidWords = true; return; }
      timing.words.forEach((word, i) => {
        const start = (timing.start as unknown[])[i], end = (timing.end as unknown[])[i];
        if (typeof word !== 'string' || word.length > 64 || typeof start !== 'number' || typeof end !== 'number' ||
          !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) { invalidWords = true; return; }
        words.push({ word, start, end });
      });
    } else if (value.type === 'done') done = true;
  }
  try {
    signal.throwIfAborted();
    while (!done) {
      const next = await reader.read(); signal.throwIfAborted();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > 14_000_000) throw new Error('A voz excedeu o limite de dados.');
      pending += decoder.decode(next.value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length); event(frame);
      }
      if (pending.length > 12_000_000) throw new Error('A voz excedeu o limite de dados.');
    }
    if (!done) { pending += decoder.decode(); if (pending.trim()) event(pending); }
    if (!done) throw new Error('Voz Cartesia: A geração foi interrompida antes de terminar.');
    const pcm = Buffer.concat(chunks), audio = pcmToWav(pcm), duration = bytes / (sampleRate * 2);
    cues.sort((a, b) => a.start - b.start);
    // Bad metadata must not break valid speech or trigger another paid generation.
    const validCues = !invalidTimings && cues.every(cue => cue.end <= duration + .1) ? parsePhonemeCues(cues) ?? [] : [];
    // Portuguese has no phoneme timestamps, but word timestamps place mouth shapes read from the spelling.
    words.sort((a, b) => a.start - b.start);
    const fromWords = !validCues.length && !invalidWords && words.length && words.every(word => word.end <= duration + .1) ? parsePhonemeCues(wordVisemes(words, envelope(pcm))) ?? [] : [];
    const phonemes = validCues.length ? validCues : fromWords.length ? fromWords : amplitudeCues(pcm);
    return { audio, phonemes };
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
