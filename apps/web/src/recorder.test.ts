import test from 'node:test';
import assert from 'node:assert/strict';
import { quietPeak, recordMicrophone } from './recorder.ts';

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
