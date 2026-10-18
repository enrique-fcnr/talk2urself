import test from 'node:test';
import assert from 'node:assert/strict';
import { createBargeDetector, createSpeechGate, quietPeak, recordMicrophone } from './recorder.ts';

test('a gravação informa o pico de volume para detectar microfone mudo', async (t) => {
  const descriptors = ['navigator', 'MediaRecorder', 'AudioContext'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  class FakeRecorder {
    static isTypeSupported() { return true; }
    state = 'inactive'; mimeType = 'audio/webm;codecs=opus';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['test audio']) }); this.onstop?.(); }); }
  }
  let level = 0, closed = 0;
  class FakeContext {
    createAnalyser() { return { fftSize: 4, getFloatTimeDomainData: (samples: Float32Array) => samples.set([level, -level, 0, 0]) }; }
    createMediaStreamSource() { return { connect() {} }; }
    async close() { closed++; }
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } } });
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: FakeRecorder });
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeContext });
  t.after(() => { for (const [name, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  async function peakFor(value: number) {
    level = value;
    return new Promise<number | undefined>(async (resolve, reject) => {
      const capture = await recordMicrophone((_blob, _seconds, peak) => resolve(peak), reject);
      setTimeout(() => capture.finish(), 120);
    });
  }
  assert.ok((await peakFor(0.001))! < quietPeak);
  assert.ok((await peakFor(0.3))! > quietPeak);
  assert.equal(closed, 2);
});

test('enviar libera o microfone e cancelar não entrega uma gravação antiga', async (t) => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalRecorder = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
  let stoppedTracks = 0;
  class FakeRecorder {
    static isTypeSupported() { return true; }
    state = 'inactive'; mimeType = 'audio/webm;codecs=opus';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['test audio']) }); this.onstop?.(); }); }
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stoppedTracks++ }] }) } } });
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: FakeRecorder });
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else Reflect.deleteProperty(globalThis, 'navigator');
    if (originalRecorder) Object.defineProperty(globalThis, 'MediaRecorder', originalRecorder); else Reflect.deleteProperty(globalThis, 'MediaRecorder');
  });
  let delivered = 0;
  const completed = new Promise<Blob>(async (resolve, reject) => {
    const capture = await recordMicrophone((blob) => { delivered++; resolve(blob); }, reject);
    capture.finish();
  });
  assert.ok((await completed).size > 0); assert.ok(stoppedTracks > 0);
  const before = stoppedTracks;
  const cancelled = await recordMicrophone(() => { delivered++; }, () => assert.fail('Não deveria falhar.'));
  cancelled.cancel(); await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(delivered, 1); assert.ok(stoppedTracks > before);
});

test('conversa sem toque: envia após uma pausa e desiste se ninguém falar', () => {
  const step = .05, feed = (gate: ReturnType<typeof createSpeechGate>, rms: number, seconds: number) => {
    let state = gate.state;
    for (let t = 0; t < seconds - 1e-9; t += step) state = gate.update(rms, step);
    return state;
  };
  const talk = createSpeechGate();
  assert.equal(feed(talk, .004, .5), 'waiting', 'room noise is not speech');
  assert.equal(feed(talk, .08, 1.2), 'speaking');
  assert.equal(feed(talk, .004, .8), 'speaking', 'a short breath does not end the turn');
  assert.equal(feed(talk, .08, .5), 'speaking');
  assert.equal(feed(talk, .004, 1.4), 'done', 'a real pause ends the turn');

  const click = createSpeechGate();
  feed(click, .004, .5);
  assert.equal(feed(click, .08, .1), 'waiting', 'a click is too short to count as speech');
  assert.equal(feed(click, .004, 8), 'silent', 'nobody spoke: give up');

  const noisy = createSpeechGate();
  assert.equal(feed(noisy, .03, 3), 'waiting', 'a steady noisy room never counts as speech');
});

test('barge-in: o eco baixo da fala do clone não interrompe; a voz do usuário por um instante interrompe', () => {
  const step = .05, run = (detector: ReturnType<typeof createBargeDetector>, rms: number, seconds: number) => {
    let fired = false; for (let t = 0; t < seconds; t += step) fired = detector.update(rms, step) || fired; return fired;
  };
  const echo = createBargeDetector();
  assert.equal(run(echo, .012, .6), false, 'calibra com o eco que sobra');
  assert.equal(run(echo, .015, 3), false, 'eco parecido com o da calibração não conta');
  const cough = createBargeDetector(); run(cough, .01, .6);
  assert.equal(run(cough, .2, .15) || run(cough, .01, .5), false, 'um ruído curto decai antes de somar');
  const voice = createBargeDetector(); run(voice, .01, .6);
  assert.equal(run(voice, .12, .4), true, 'fala clara por ~0,3 s interrompe');
});

test('gravação que assume a interrupção já começa falando e termina na pausa', () => {
  const gate = createSpeechGate({ speaking: true, floor: .01 });
  assert.equal(gate.state, 'speaking');
  let state = gate.update(.1, .5);
  for (let t = 0; t < 1.4; t += .1) state = gate.update(.005, .1);
  assert.equal(state, 'done');
});
