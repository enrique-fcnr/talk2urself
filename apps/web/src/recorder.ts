import { audioMimeTypes, maxRecordingBytes, maxRecordingSeconds } from '../../../shared/protocol';
import type { VoiceDetector } from './vad';

// level(): current loudness, 0 to about .3 for normal speech (0 when it cannot be measured).
// speaking(): whether the user has started talking in this recording.
export type Recording = { finish(): void; cancel(): void; level(): number; speaking(): boolean };
// Speech peaks well above this; a muted or nearly silent input stays below it.
export const quietPeak = 0.01;

// Hands-free turn taking. Learns the room's noise floor in the first moments, counts as speech anything clearly
// above it, and once the user has spoken, ends the turn after a pause. If nobody speaks at all, it gives up.
export type GateState = 'waiting' | 'speaking' | 'done' | 'silent';
// speaking + floor: the user already started talking (they cut in while the clone spoke), so there is nothing to calibrate.
export function createSpeechGate({ pauseSeconds = .8, minSpeechSeconds = .35, giveUpSeconds = 8, calibrationSeconds = .3, speaking = false, floor: knownFloor = 0 } = {}) {
  let elapsed = speaking ? calibrationSeconds : 0, floor = knownFloor, floorSamples = speaking ? 1 : 0, speech = 0, quiet = 0, state: GateState = speaking ? 'speaking' : 'waiting';
  return {
    get state() { return state; },
    // rms: loudness of the last slice (0 to 1); seconds: how long that slice lasted. voice: the voice model's
    // probability that the slice is speech, when it is running: it then decides alone (noise and echo do not count,
    // and a softly spoken word still does), with a lower bar to keep speaking than to start.
    update(rms: number, seconds: number, voice?: number): GateState {
      if (state === 'done' || state === 'silent') return state;
      elapsed += seconds;
      if (voice === undefined && elapsed <= calibrationSeconds) { floor = (floor * floorSamples + rms) / ++floorSamples; return state; }
      const speaking = voice !== undefined ? voice > (state === 'speaking' ? .35 : .55) : rms > Math.max(.012, floor * 2.6);
      if (speaking) { speech += seconds; quiet = 0; if (speech >= minSpeechSeconds) state = 'speaking'; }
      else { quiet += seconds; if (voice === undefined && state === 'waiting' && rms < floor * 1.2) floor = floor * .97 + rms * .03; }
      if (state === 'speaking' && quiet >= pauseSeconds) state = 'done';
      else if (state === 'waiting' && elapsed >= giveUpSeconds) state = 'silent';
      return state;
    },
  };
}

// Input level during the recording: the peak so far, and a smoothed current loudness for visuals and turn taking.
// Undefined when the browser cannot measure it.
// One analyser per open microphone, shared by every meter on it (opening audio contexts over and over is slow on phones).
const analysers = new WeakMap<MediaStream, { context: AudioContext; analyser: AnalyserNode; source: MediaStreamAudioSourceNode }>();
function graphFor(stream: MediaStream) {
  let entry = analysers.get(stream);
  if (!entry) {
    const context = new AudioContext(), analyser = context.createAnalyser(), source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    entry = { context, analyser, source }; analysers.set(stream, entry);
  }
  return entry;
}
const analyserFor = (stream: MediaStream) => graphFor(stream).analyser;
// Runs the voice model on the stream once it has loaded; onFrame gets each frame's speech probability and length.
// Resolves to undefined where it cannot run (the loudness-based turn taking then simply goes on).
function voiceOn(stream: MediaStream, onFrame: (probability: number, seconds: number) => void): Promise<VoiceDetector | undefined> {
  if (typeof AudioWorkletNode === 'undefined') return Promise.resolve(undefined);
  try { const { context, source } = graphFor(stream); return import('./vad').then(({ detectVoice }) => detectVoice(context, source, onFrame)).catch(() => undefined); }
  catch { return Promise.resolve(undefined); }
}
// Closes a microphone opened with openMicrophone, and its analyser.
export function closeMicrophone(stream: MediaStream) {
  stream.getTracks().forEach((track) => track.stop());
  const entry = analysers.get(stream);
  if (entry) { analysers.delete(stream); void entry.context.close().catch(() => {}); }
}
function levelMeter(stream: MediaStream, onLevel: (rms: number, seconds: number) => void) {
  if (typeof AudioContext === 'undefined') return undefined;
  try {
    const analyser = analyserFor(stream);
    const samples = new Float32Array(analyser.fftSize);
    let peak = 0, level = 0, stopped = false;
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let power = 0;
      for (const value of samples) { peak = Math.max(peak, Math.abs(value)); power += value * value; }
      const rms = Math.sqrt(power / samples.length);
      level = level * .6 + rms * .4;
      onLevel(rms, .05);
    }, 50);
    return { peak: () => peak, level: () => level, stop() { if (stopped) return; stopped = true; clearInterval(timer); } };
  } catch { return undefined; }
}

// Barge-in: while the clone speaks, the microphone listens (with echo cancellation, so its own voice is not taken for the
// user's). The first moments learn how loud the room and the leftover echo are; speech clearly above that, lasting a
// moment, counts as the user cutting in. Short noises (a cough, an "uhum") decay away before they add up.
export function createBargeDetector({ calibrationSeconds = .6, minSpeechSeconds = .3, minThreshold = .03, ratio = 3 } = {}) {
  let elapsed = 0, floor = 0, samples = 0, speech = 0;
  return {
    get floor() { return floor; },
    // voice: with the voice model running, a slice counts only if it is speech and also louder than the leftover
    // echo (the clone's own voice can survive echo cancellation faintly, and is speech too).
    update(rms: number, seconds: number, voice?: number): boolean {
      elapsed += seconds;
      if (elapsed <= calibrationSeconds) { floor = (floor * samples + rms) / ++samples; return false; }
      if (voice !== undefined ? voice > .6 && rms > Math.max(.02, floor * 2) : rms > Math.max(minThreshold, floor * ratio)) speech += seconds;
      else { speech = Math.max(0, speech - seconds * 1.5); if (rms < floor * 1.5) floor = floor * .98 + rms * .02; }
      return speech >= minSpeechSeconds;
    },
  };
}
// The conversation opens the microphone once and keeps it for every turn: reopening it on each turn is slow, and on
// phones it switches the audio mode back and forth.
export function openMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error('This browser cannot record audio. Open it in an up-to-date browser.'));
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
}

// Listens on the conversation's microphone while the clone speaks; onSpeech fires when the user cuts in (with the noise floor).
export function watchForBargeIn(stream: MediaStream, onSpeech: (floor: number) => void): { stop(): void } {
  const detector = createBargeDetector();
  let done = false;
  // Loudness alone until the voice model is running; then the model's frames decide, with the latest loudness.
  let rmsNow = 0, voice: VoiceDetector | undefined, voiced = false;
  const fire = () => { done = true; meter?.stop(); voice?.stop(); onSpeech(detector.floor); };
  const meter = levelMeter(stream, (rms, seconds) => {
    rmsNow = rms;
    if (done || voiced || !detector.update(rms, seconds)) return;
    fire();
  });
  if (!meter) throw new Error('Could not measure the microphone.');
  void voiceOn(stream, (probability, seconds) => { voiced = true; if (!done && detector.update(rmsNow, seconds, probability)) fire(); })
    .then((detector) => { if (done) detector?.stop(); else voice = detector; });
  return { stop() { if (done) return; done = true; meter.stop(); voice?.stop(); } };
}

// handsFree: send by itself after the user pauses, and stop without sending if they never speak (onSilent).
// stream: the conversation's open microphone (kept open afterwards). floor: the user already started talking (they cut
// in while the clone spoke), so the turn counts them as speaking from the start.
export async function recordMicrophone(onComplete: (blob: Blob, seconds: number, peak?: number) => void, onError: (message: string) => void,
  options: { handsFree?: boolean; onSilent?: () => void; onVoice?: (probability: number) => void; onSpeaking?: () => void; stream?: MediaStream; floor?: number } = {}): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('This browser cannot record audio. Open it in an up-to-date browser.');
  const owned = !options.stream, stream = options.stream ?? await openMicrophone();
  let recorder: MediaRecorder;
  try {
    const mimeType = audioMimeTypes.find((mime) => MediaRecorder.isTypeSupported(mime));
    if (!mimeType) throw new Error('This browser has no compatible audio format.');
    recorder = new MediaRecorder(stream, { mimeType });
  } catch (error) { if (owned) closeMicrophone(stream); throw error; }
  const gate = options.handsFree ? createSpeechGate(options.floor !== undefined ? { speaking: true, floor: options.floor } : {}) : undefined;
  // The turn ends by the voice model once it is running (by loudness until then, or where it cannot run).
  let voice: VoiceDetector | undefined, voiced = false, rmsNow = 0;
  let lastState = gate?.state;
  const judge = (state: GateState | undefined) => {
    if (state === 'speaking' && lastState !== 'speaking') options.onSpeaking?.();
    lastState = state;
    if (state === 'done') stop();
    else if (state === 'silent') { cancelled = true; stop(); options.onSilent?.(); }
  };
  const meter = levelMeter(stream, (rms, seconds) => { rmsNow = rms; if (!voiced) judge(gate?.update(rms, seconds)); });
  if (gate) void voiceOn(stream, (probability, seconds) => { voiced = true; if (!finished) { judge(gate.update(rmsNow, seconds, probability)); options.onVoice?.(probability); } })
    .then((detector) => { if (finished) detector?.stop(); else voice = detector; });
  const started = performance.now();
  const chunks: Blob[] = [];
  let cancelled = false;
  let finished = false;
  let size = 0;
  let timeout: ReturnType<typeof setTimeout>;
  function release() { clearTimeout(timeout); meter?.stop(); voice?.stop(); if (owned) closeMicrophone(stream); }
  function stop() {
    if (finished) return;
    finished = true;
    if (recorder.state !== 'inactive') recorder.stop();
    release();
  }
  recorder.ondataavailable = (event) => {
    if (cancelled || !event.data.size) return;
    size += event.data.size;
    if (size > maxRecordingBytes) { cancelled = true; stop(); onError('The recording is too long. Try a shorter question.'); return; }
    chunks.push(event.data);
  };
  recorder.onerror = () => { cancelled = true; stop(); onError('Could not record. Check the microphone and try again.'); };
  recorder.onstop = () => {
    release();
    if (!cancelled) onComplete(new Blob(chunks, { type: recorder.mimeType }), Math.min((performance.now() - started) / 1000, maxRecordingSeconds), meter?.peak());
  };
  try { recorder.start(250); }
  catch (error) { release(); throw error; }
  timeout = setTimeout(stop, maxRecordingSeconds * 1000);
  return { finish: stop, cancel: () => { cancelled = true; stop(); }, level: () => meter?.level() ?? 0, speaking: () => gate?.state === 'speaking' || gate?.state === 'done' };
}
