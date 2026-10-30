import type { AvatarPlayback, PhonemeCue } from '../../../shared/lip-sync';
import type { GestureCue } from '../../../shared/gestures';

// Plays the clone's reply while it is still being generated. Each segment (sentence) arrives as raw 16-bit mono 24 kHz
// PCM pieces; they are scheduled on the Web Audio clock back to back, so a reply starts within a fraction of a second
// and its sentences join without a gap. Each segment exposes a clock (currentTime, duration, paused, ended) that the
// mouth, the gestures and the captions follow, as they did with an audio element.
const sampleRate = 24_000, lead = .06;

type Segment = { segment: number; from: number; to: number; last: boolean; gestures: GestureCue[]; cues: PhonemeCue[];
  startAt?: number; endAt: number; done: boolean; started: boolean; sources: AudioBufferSourceNode[]; peak: number; samples: number };
export type SegmentInfo = { segment: number; from: number; to: number; last: boolean; gestures: GestureCue[] };
type Events = { onSegmentStart(segment: number): void; onFinished(): void; onBlocked(blocked: boolean): void; onPlayback(playback: AvatarPlayback | null): void };

export function createSpeechPlayer(events: Events) {
  let context: AudioContext | undefined, segments = new Map<number, Segment>(), receiving: Segment | undefined;
  // Every segment plays through one output node, so the clone's voice (and nothing else) can also be recorded.
  let output: GainNode | undefined, capture: MediaStreamAudioDestinationNode | undefined;
  let count: number | undefined, ticker: ReturnType<typeof setInterval> | undefined, showing: Segment | undefined, finished = false;

  // Inside a tap: browsers only let audio start after a gesture. A silent buffer also wakes iOS's audio.
  function unlock() {
    if (!context) { context = new AudioContext({ latencyHint: 'interactive' }); output = context.createGain(); output.connect(context.destination); }
    void context.resume().catch(() => {});
    const silence = context.createBufferSource(); silence.buffer = context.createBuffer(1, 1, sampleRate); silence.connect(context.destination); silence.start();
  }
  function clock(segment: Segment) {
    return {
      get currentTime() { return context && segment.startAt !== undefined ? Math.max(0, Math.min(context.currentTime, segment.endAt) - segment.startAt) : 0; },
      get duration() { return segment.done && segment.startAt !== undefined ? segment.endAt - segment.startAt : NaN; },
      get paused() { return !context || context.state !== 'running' || segment.startAt === undefined || context.currentTime < segment.startAt; },
      get ended() { return !!context && segment.done && context.currentTime >= segment.endAt; },
    };
  }
  // The mouth moves with the loudness of the audio until the precise cues arrive with the end of the segment.
  function loudnessCues(segment: Segment, pcm: Int16Array, offset: number) {
    const frame = Math.round(sampleRate * .04);
    for (let start = 0; start < pcm.length; start += frame) {
      let power = 0; const stop = Math.min(pcm.length, start + frame);
      for (let i = start; i < stop; i++) power += (pcm[i] / 32768) ** 2;
      const rms = Math.sqrt(power / (stop - start)); segment.peak = Math.max(segment.peak, rms, .05);
      if (rms < Math.max(.006, segment.peak * .04)) continue;
      const relative = rms / segment.peak, phoneme = relative < .25 ? 'audio-soft' : relative < .6 ? 'audio-medium' : 'audio-loud';
      const cue = { phoneme, start: offset + start / sampleRate, end: offset + stop / sampleRate }, previous = segment.cues.at(-1);
      if (previous?.phoneme === phoneme && Math.abs(previous.end - cue.start) < 1e-6) previous.end = cue.end; else segment.cues.push(cue);
    }
  }
  function tick() {
    if (!context) return;
    const now = context.currentTime;
    // The segment being heard: the latest one that has started.
    let current: Segment | undefined;
    for (const segment of segments.values()) if (segment.startAt !== undefined && segment.startAt <= now && (!current || segment.segment > current.segment)) current = segment;
    if (current && !current.started) { current.started = true; events.onSegmentStart(current.segment); }
    if (current !== showing) {
      showing = current;
      events.onPlayback(current ? { audio: clock(current), cues: current.cues, gestures: current.gestures, from: current.from, to: current.to } : null);
    }
    events.onBlocked(context.state === 'suspended' && segments.size > 0);
    // The reply is over once its last segment has been heard in full.
    const last = [...segments.values()].find((segment) => segment.last || (count !== undefined && segment.segment === count - 1));
    if (!finished && last?.done && now >= last.endAt) { finished = true; stop(false); events.onFinished(); }
  }

  function begin(info: SegmentInfo) {
    if (info.segment === 0) stop(false);
    finished = false;
    receiving = { ...info, cues: [], endAt: 0, done: false, started: false, sources: [], peak: .05, samples: 0 };
    segments.set(info.segment, receiving);
    ticker ??= setInterval(tick, 30);
  }
  function chunk(data: ArrayBuffer) {
    const segment = receiving;
    if (!segment || !context || data.byteLength < 2) return;
    const pcm = new Int16Array(data.slice(0, data.byteLength - (data.byteLength % 2)));
    const buffer = context.createBuffer(1, pcm.length, sampleRate), channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
    const now = context.currentTime;
    if (segment.startAt === undefined) {
      // Right after the previous segment, or a moment from now if nothing is playing.
      const previous = segments.get(segment.segment - 1);
      segment.startAt = Math.max(now + lead, previous?.startAt !== undefined ? previous.endAt : 0);
      segment.endAt = segment.startAt;
    }
    // Generation fell behind playback: continue from now (a short gap instead of a lost piece).
    if (segment.endAt < now + .01) { segment.startAt += now + .02 - segment.endAt; segment.endAt = now + .02; }
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(output ?? context.destination);
    source.start(segment.endAt); segment.sources.push(source);
    loudnessCues(segment, pcm, segment.endAt - segment.startAt);
    segment.endAt += buffer.duration; segment.samples += pcm.length;
  }
  function done(index: number, cues: PhonemeCue[]) {
    const segment = segments.get(index);
    if (!segment) return;
    segment.done = true;
    if (cues.length) segment.cues.splice(0, segment.cues.length, ...cues);
    if (receiving === segment) receiving = undefined;
  }
  function end(segmentCount: number) { count = segmentCount; }
  // How much of the reply has been heard, in characters (for an interruption).
  function heard() {
    const segment = showing;
    if (!segment || !context || segment.startAt === undefined) return [...segments.values()][0]?.from ?? 0;
    const length = segment.done ? segment.endAt - segment.startAt : Math.max(segment.endAt - segment.startAt, (segment.to - segment.from) / 14);
    const progress = length > 0 ? Math.min(1, Math.max(0, context.currentTime - segment.startAt) / length) : 0;
    return Math.round(segment.from + progress * (segment.to - segment.from));
  }
  // Silences everything at once (an interruption, the end of the conversation).
  function stop(notify = true) {
    for (const segment of segments.values()) for (const source of segment.sources) { try { source.stop(); } catch { /* not started */ } }
    segments = new Map(); receiving = undefined; count = undefined; showing = undefined;
    if (ticker) { clearInterval(ticker); ticker = undefined; }
    if (notify) finished = true;
    events.onPlayback(null); events.onBlocked(false);
  }
  // The clone's voice as a stream, for recording a video of the conversation. Call inside a tap (it may create the audio).
  function voiceStream() {
    unlock();
    if (!capture) { capture = context!.createMediaStreamDestination(); output!.connect(capture); }
    return capture.stream;
  }
  async function resume() { if (context) await context.resume().catch(() => {}); }
  return { unlock, begin, chunk, done, end, heard, stop, resume, voiceStream };
}
