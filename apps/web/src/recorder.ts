import { audioMimeTypes, maxRecordingBytes, maxRecordingSeconds } from '../../../shared/protocol';

// level(): current loudness, 0 to about .3 for normal speech (0 when it cannot be measured).
export type Recording = { finish(): void; cancel(): void; level(): number };
// Speech peaks well above this; a muted or nearly silent input stays below it.
export const quietPeak = 0.01;

// Hands-free turn taking. Learns the room's noise floor in the first moments, counts as speech anything clearly
// above it, and once the user has spoken, ends the turn after a pause. If nobody speaks at all, it gives up.
export type GateState = 'waiting' | 'speaking' | 'done' | 'silent';
// speaking + floor: the user already started talking (they cut in while the clone spoke), so there is nothing to calibrate.
export function createSpeechGate({ pauseSeconds = 1.3, minSpeechSeconds = .35, giveUpSeconds = 8, calibrationSeconds = .3, speaking = false, floor: knownFloor = 0 } = {}) {
  let elapsed = speaking ? calibrationSeconds : 0, floor = knownFloor, floorSamples = speaking ? 1 : 0, speech = 0, quiet = 0, state: GateState = speaking ? 'speaking' : 'waiting';
  return {
    get state() { return state; },
    // rms: loudness of the last slice (0 to 1); seconds: how long that slice lasted.
    update(rms: number, seconds: number): GateState {
      if (state === 'done' || state === 'silent') return state;
      elapsed += seconds;
      if (elapsed <= calibrationSeconds) { floor = (floor * floorSamples + rms) / ++floorSamples; return state; }
      const threshold = Math.max(.012, floor * 2.6);
      if (rms > threshold) { speech += seconds; quiet = 0; if (speech >= minSpeechSeconds) state = 'speaking'; }
      else { quiet += seconds; if (state === 'waiting' && rms < floor * 1.2) floor = floor * .97 + rms * .03; }
      if (state === 'speaking' && quiet >= pauseSeconds) state = 'done';
      else if (state === 'waiting' && elapsed >= giveUpSeconds) state = 'silent';
      return state;
    },
  };
}

// Input level during the recording: the peak so far, and a smoothed current loudness for visuals and turn taking.
// Undefined when the browser cannot measure it.
function levelMeter(stream: MediaStream, onLevel: (rms: number, seconds: number) => void) {
  if (typeof AudioContext === 'undefined') return undefined;
  try {
    const context = new AudioContext(), analyser = context.createAnalyser();
    context.createMediaStreamSource(stream).connect(analyser);
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
    return { peak: () => peak, level: () => level, stop() { if (stopped) return; stopped = true; clearInterval(timer); void context.close().catch(() => {}); } };
  } catch { return undefined; }
}

// Barge-in: while the clone speaks, the microphone listens (with echo cancellation, so its own voice is not taken for the
// user's). The first moments learn how loud the room and the leftover echo are; speech clearly above that, lasting a
// moment, counts as the user cutting in. Short noises (a cough, an "uhum") decay away before they add up.
export function createBargeDetector({ calibrationSeconds = .6, minSpeechSeconds = .3, minThreshold = .03, ratio = 3 } = {}) {
  let elapsed = 0, floor = 0, samples = 0, speech = 0;
  return {
    get floor() { return floor; },
    update(rms: number, seconds: number): boolean {
      elapsed += seconds;
      if (elapsed <= calibrationSeconds) { floor = (floor * samples + rms) / ++samples; return false; }
      if (rms > Math.max(minThreshold, floor * ratio)) speech += seconds;
      else { speech = Math.max(0, speech - seconds * 1.5); if (rms < floor * 1.5) floor = floor * .98 + rms * .02; }
      return speech >= minSpeechSeconds;
    },
  };
}
const microphone = () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });

// Listens while the clone speaks; onSpeech hands over the open microphone (and its noise floor) to record the user.
export async function watchForBargeIn(onSpeech: (stream: MediaStream, floor: number) => void): Promise<{ stop(): void }> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microfone indisponível.');
  const stream = await microphone(), detector = createBargeDetector();
  let done = false;
  const meter = levelMeter(stream, (rms, seconds) => {
    if (done || !detector.update(rms, seconds)) return;
    done = true; meter?.stop(); onSpeech(stream, detector.floor);
  });
  if (!meter) { stream.getTracks().forEach((track) => track.stop()); throw new Error('Não foi possível medir o microfone.'); }
  return { stop() { if (done) return; done = true; meter.stop(); stream.getTracks().forEach((track) => track.stop()); } };
}

// handsFree: send by itself after the user pauses, and stop without sending if they never speak (onSilent).
// stream + floor: continue on a microphone already open (the user cut in), counting them as already speaking.
export async function recordMicrophone(onComplete: (blob: Blob, seconds: number, peak?: number) => void, onError: (message: string) => void,
  options: { handsFree?: boolean; onSilent?: () => void; stream?: MediaStream; floor?: number } = {}): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Este navegador não oferece gravação de áudio. Abra em um navegador atualizado.');
  const stream = options.stream ?? await microphone();
  let recorder: MediaRecorder;
  try {
    const mimeType = audioMimeTypes.find((mime) => MediaRecorder.isTypeSupported(mime));
    if (!mimeType) throw new Error('Não encontramos um formato de áudio compatível neste navegador.');
    recorder = new MediaRecorder(stream, { mimeType });
  } catch (error) { stream.getTracks().forEach((track) => track.stop()); throw error; }
  const gate = options.handsFree ? createSpeechGate(options.stream ? { speaking: true, floor: options.floor ?? 0 } : {}) : undefined;
  const meter = levelMeter(stream, (rms, seconds) => {
    const state = gate?.update(rms, seconds);
    if (state === 'done') stop();
    else if (state === 'silent') { cancelled = true; stop(); options.onSilent?.(); }
  });
  const started = performance.now();
  const chunks: Blob[] = [];
  let cancelled = false;
  let finished = false;
  let size = 0;
  let timeout: ReturnType<typeof setTimeout>;
  function release() { clearTimeout(timeout); meter?.stop(); stream.getTracks().forEach((track) => track.stop()); }
  function stop() {
    if (finished) return;
    finished = true;
    if (recorder.state !== 'inactive') recorder.stop();
    release();
  }
  recorder.ondataavailable = (event) => {
    if (cancelled || !event.data.size) return;
    size += event.data.size;
    if (size > maxRecordingBytes) { cancelled = true; stop(); onError('A gravação excedeu o limite. Tente uma pergunta mais curta.'); return; }
    chunks.push(event.data);
  };
  recorder.onerror = () => { cancelled = true; stop(); onError('Não foi possível gravar. Confira o microfone e tente novamente.'); };
  recorder.onstop = () => {
    release();
    if (!cancelled) onComplete(new Blob(chunks, { type: recorder.mimeType }), Math.min((performance.now() - started) / 1000, maxRecordingSeconds), meter?.peak());
  };
  try { recorder.start(250); }
  catch (error) { release(); throw error; }
  timeout = setTimeout(stop, maxRecordingSeconds * 1000);
  return { finish: stop, cancel: () => { cancelled = true; stop(); }, level: () => meter?.level() ?? 0 };
}
