import * as ort from 'onnxruntime-web/wasm';

// Voice activity detection with Silero VAD (MIT), run in the browser: it tells human speech from noise, echo and
// breathing, which loudness alone cannot. The model (~2 MB) and its runtime (~14 MB, ~2.3 MB compressed) are fetched
// once in the background from /vad/ and then cached. Each 32 ms frame takes about a millisecond to analyse.
const frameSize = 512, contextSize = 64, rate = 16_000;
let session: Promise<ort.InferenceSession> | undefined;
export function loadVoiceModel(): Promise<ort.InferenceSession> {
  ort.env.wasm.wasmPaths = '/vad/';
  // One thread: more would need cross-origin isolation headers, and one is plenty for this model.
  ort.env.wasm.numThreads = 1;
  session ??= ort.InferenceSession.create('/vad/silero_vad_v5.onnx', { executionProviders: ['wasm'] });
  session.catch(() => { session = undefined; });
  return session;
}

// Downsamples the microphone to 16 kHz (averaging the samples between two outputs) and posts 512-sample frames.
const processor = `class Frames extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / ${rate}; this.step = 0; this.sum = 0; this.count = 0; this.frame = new Float32Array(${frameSize}); this.filled = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.sum += channel[i]; this.count++; this.step++;
      if (this.step >= this.ratio) {
        this.step -= this.ratio; this.frame[this.filled++] = this.sum / this.count; this.sum = 0; this.count = 0;
        if (this.filled === ${frameSize}) { this.port.postMessage(this.frame.slice()); this.filled = 0; }
      }
    }
    return true;
  }
}
registerProcessor('voice-frames', Frames);`;
const registered = new WeakMap<AudioContext, Promise<void>>();

export type VoiceDetector = { stop(): void };
// Calls onFrame with the probability (0..1) that each 32 ms of the stream is speech, until stopped.
export async function detectVoice(context: AudioContext, source: AudioNode, onFrame: (probability: number, seconds: number) => void): Promise<VoiceDetector> {
  const model = await loadVoiceModel();
  let ready = registered.get(context);
  if (!ready) {
    const url = URL.createObjectURL(new Blob([processor], { type: 'text/javascript' }));
    ready = context.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    registered.set(context, ready);
  }
  await ready;
  const node = new AudioWorkletNode(context, 'voice-frames'), mute = context.createGain();
  // Silent route to the output: the browser only runs a processor that is part of what it renders.
  mute.gain.value = 0; source.connect(node); node.connect(mute).connect(context.destination);
  void context.resume().catch(() => {});
  let state: ort.Tensor = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]), previous = new Float32Array(contextSize), stopped = false, busy = false;
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(rate)]), [1]);
  node.port.onmessage = async (event: MessageEvent<Float32Array>) => {
    // A frame that arrives while the last one is still being analysed is skipped (it never queues up).
    if (stopped || busy) return;
    busy = true;
    try {
      const input = new Float32Array(contextSize + frameSize);
      input.set(previous, 0); input.set(event.data, contextSize); previous = event.data.slice(-contextSize);
      const out = await model.run({ input: new ort.Tensor('float32', input, [1, input.length]), state, sr });
      state = out.stateN as ort.Tensor;
      if (!stopped) onFrame(Number((out.output as ort.Tensor).data[0]), frameSize / rate);
    } catch { /* A failed frame is simply not counted. */ } finally { busy = false; }
  };
  return { stop() { stopped = true; node.port.onmessage = null; try { source.disconnect(node); } catch { /* already gone */ } node.disconnect(); mute.disconnect(); } };
}
