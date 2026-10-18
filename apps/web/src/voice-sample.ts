// Voice cloning (server flag VOICE_CLONING=1): a recorded turn becomes a 16 kHz mono 16-bit WAV take for the server,
// which keeps only clean takes and builds the user's voice from them.
export type VoiceCloneStatus = { enabled: boolean; ownVoice: boolean; collecting: boolean; cloned: boolean; frozen: boolean; clones: number; collectedSeconds: number; nextAt: number | null };

export function parseCloneStatus(value: unknown): VoiceCloneStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const status = value as Record<string, unknown>;
  if (status.enabled !== true || typeof status.collecting !== 'boolean' || typeof status.collectedSeconds !== 'number') return null;
  return { enabled: true, ownVoice: status.ownVoice === true, collecting: status.collecting, cloned: status.cloned === true, frozen: status.frozen === true,
    clones: typeof status.clones === 'number' ? status.clones : 0, collectedSeconds: status.collectedSeconds,
    nextAt: typeof status.nextAt === 'number' ? status.nextAt : null };
}

export function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) out.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); out.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true); out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); text(36, 'data'); out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) out.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return out.buffer;
}

// Decodes the browser recording and mixes it down to 16 kHz mono.
export async function recordingToWav(blob: Blob, rate = 16_000): Promise<ArrayBuffer> {
  const context = new OfflineAudioContext(1, 1, rate);
  const decoded = await context.decodeAudioData(await blob.arrayBuffer());
  const render = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const source = render.createBufferSource(); source.buffer = decoded; source.connect(render.destination); source.start();
  return encodeWav((await render.startRendering()).getChannelData(0), rate);
}

export async function sendVoiceSample(blob: Blob): Promise<VoiceCloneStatus | null> {
  const response = await fetch('/api/voice/sample', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: await recordingToWav(blob) });
  if (!response.ok) return null;
  const body = await response.json() as { status?: unknown };
  return parseCloneStatus(body.status);
}

const minutes = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
// One line for the settings panel: where the voice is in its collect → clone → freeze cycle.
export function voiceStatus(status: VoiceCloneStatus): string {
  if (status.frozen) return 'Seu clone fala com a sua voz.';
  if (!status.cloned) return `Aprendendo sua voz: ${minutes(status.collectedSeconds)} de ${minutes(status.nextAt ?? 150)}. Até lá, seu clone usa a voz original.`;
  return `Seu clone já fala com a sua voz e continua refinando (${minutes(status.collectedSeconds)} de ${minutes(status.nextAt ?? 1200)}).`;
}
