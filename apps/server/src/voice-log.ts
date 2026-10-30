// Keeps the clone's voice as it was heard, so a screen recording of the iPhone (which cannot capture it while the
// microphone is open) can get it back afterwards. Each segment's audio is saved exactly as it went to the page, and the
// page reports when it played it (and where it was cut off), by its own clock.
// .local/voice-log/<day>/<clip>.pcm (16-bit mono 24 kHz), clips.jsonl (what was said), played.jsonl (when it played) and
// marks.jsonl (big changes on screen, by the same clock, to find where a recording sits in time).
// Writing never holds up the conversation; days older than two weeks are removed.
import { appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScreenMark, VoicePlayed } from '../../../shared/protocol.ts';

export type VoiceLog = { start(text: string, language: string): string; chunk(clip: string, pcm: Buffer): void; played(report: VoicePlayed): void; mark(mark: ScreenMark): void };
const keepDays = 14;

export function createVoiceLog(dir: string, now = () => new Date()): VoiceLog {
  let count = 0, warned = false;
  const queues = new Map<string, Promise<void>>(), made = new Set<string>();
  const fail = () => { if (!warned) { warned = true; console.warn('Não foi possível salvar a voz para os vídeos (.local/voice-log).'); } };
  // Appends to one file at a time, in order.
  function write(day: string, file: string, data: string | Buffer) {
    const path = join(dir, day, file), previous = queues.get(path) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (!made.has(day)) { await mkdir(join(dir, day), { recursive: true }); made.add(day); }
      await appendFile(path, data);
    }).catch(fail);
    queues.set(path, next);
    void next.finally(() => { if (queues.get(path) === next) queues.delete(path); });
  }
  void (async () => {
    const oldest = stamp(new Date(now().getTime() - keepDays * 86_400_000)).slice(0, 8);
    for (const day of await readdir(dir).catch(() => [])) if (/^\d{8}$/.test(day) && day < oldest) await rm(join(dir, day), { recursive: true, force: true }).catch(() => {});
  })();
  return {
    // A new clip (one segment of a reply); its id carries its day, so its files stay together across midnight.
    start(text, language) {
      const at = now(), clip = `${stamp(at)}-${++count}`;
      write(clip.slice(0, 8), 'clips.jsonl', JSON.stringify({ clip, at: at.toISOString(), language, text }) + '\n');
      return clip;
    },
    chunk(clip, pcm) { write(clip.slice(0, 8), `${clip}.pcm`, pcm); },
    played(report) { write(report.clip.slice(0, 8), 'played.jsonl', JSON.stringify({ ...report, received: now().toISOString() }) + '\n'); },
    mark(mark) { write(stamp(now()).slice(0, 8), 'marks.jsonl', JSON.stringify({ what: mark.what, at: mark.at }) + '\n'); },
  };
}
// UTC, as yyyymmdd-hhmmssmmm.
function stamp(date: Date) { return date.toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 18); }
