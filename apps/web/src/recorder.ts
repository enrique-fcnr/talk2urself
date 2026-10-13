import { audioMimeTypes, maxRecordingBytes, maxRecordingSeconds } from '../../../shared/protocol';

export type Recording = { finish(): void; cancel(): void };
// Speech peaks well above this; a muted or nearly silent input stays below it.
export const quietPeak = 0.01;

// Peak input level (0 to 1) during the recording, or undefined when the browser cannot measure it.
function levelMeter(stream: MediaStream) {
  if (typeof AudioContext === 'undefined') return undefined;
  try {
    const context = new AudioContext(), analyser = context.createAnalyser();
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let peak = 0, stopped = false;
    const timer = setInterval(() => { analyser.getFloatTimeDomainData(samples); for (const value of samples) peak = Math.max(peak, Math.abs(value)); }, 50);
    return { peak: () => peak, stop() { if (stopped) return; stopped = true; clearInterval(timer); void context.close().catch(() => {}); } };
  } catch { return undefined; }
}

export async function recordMicrophone(onComplete: (blob: Blob, seconds: number, peak?: number) => void, onError: (message: string) => void): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Este navegador não oferece gravação de áudio. Abra em um navegador atualizado.');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  let recorder: MediaRecorder;
  try {
    const mimeType = audioMimeTypes.find((mime) => MediaRecorder.isTypeSupported(mime));
    if (!mimeType) throw new Error('Não encontramos um formato de áudio compatível neste navegador.');
    recorder = new MediaRecorder(stream, { mimeType });
  } catch (error) { stream.getTracks().forEach((track) => track.stop()); throw error; }
  const meter = levelMeter(stream);
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
  return { finish: stop, cancel: () => { cancelled = true; stop(); } };
}
