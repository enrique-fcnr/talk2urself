// Automatic voice cloning (Cartesia instant clone), off unless VOICE_CLONING=1 and the voice is not paused.
// Clean takes of the user's own speech are kept in a private Supabase Storage bucket. After about 2.5, 10 and 20 minutes
// of accepted speech the best takes (up to 60 s, one speaker) become a new clone; after the third the voice is frozen:
// the raw takes are deleted and only the clip used for the final clone is kept.

export type VoiceCloneConfig = { cartesiaKey: string; storageUrl: string; secret: string; userId: string };
export function readVoiceCloneConfig(env: NodeJS.ProcessEnv = process.env): VoiceCloneConfig | null {
  if (env.VOICE_CLONING?.trim() !== '1' || env.CARTESIA_PAUSED?.trim() === '1') return null;
  const cartesiaKey = env.CARTESIA_API_KEY?.trim(), storageUrl = env.SUPABASE_URL?.trim(), secret = env.SUPABASE_SECRET_KEY?.trim(), userId = env.LOCAL_USER_ID?.trim();
  if (!cartesiaKey || !storageUrl || !secret || !userId) return null;
  return { cartesiaKey, storageUrl, secret, userId };
}

// Seconds of accepted speech that trigger the first clone and the two re-clones.
export const cloneThresholds = [150, 600, 1200] as const;
export const maxClipSeconds = 60, minClipSeconds = 10;
// Raw takes kept between clones: a little more than one clip, so later clones can still pick the best ones.
const poolSeconds = 90;
const sampleRate = 16_000;

export type Take = { path: string; seconds: number; score: number };
export type CloneState = { voiceId?: string; collectedSeconds: number; clones: number; frozen: boolean; takes: Take[]; updatedAt?: string };
export const emptyState = (): CloneState => ({ collectedSeconds: 0, clones: 0, frozen: false, takes: [] });
export type CloneStatus = { enabled: boolean; collecting: boolean; cloned: boolean; frozen: boolean; clones: number; collectedSeconds: number; nextAt: number | null };

// --- WAV (16-bit mono PCM) ---------------------------------------------------------------------------------------------
export function readWav(buffer: Buffer): { samples: Int16Array; rate: number } | null {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12, rate = 0, channels = 0, bits = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === 'fmt ' && size >= 16) {
      if (buffer.readUInt16LE(body) !== 1) return null;
      channels = buffer.readUInt16LE(body + 2); rate = buffer.readUInt32LE(body + 4); bits = buffer.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (channels !== 1 || bits !== 16 || !rate) return null;
      const end = Math.min(buffer.length, body + size), data = buffer.subarray(body, end - ((end - body) % 2));
      const samples = new Int16Array(data.length / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
      return { samples, rate };
    }
    offset = body + size + (size % 2);
  }
  return null;
}
export function writeWav(samples: Int16Array, rate = sampleRate): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0, 'ascii'); out.writeUInt32LE(36 + samples.length * 2, 4); out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii'); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii'); out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i], 44 + i * 2);
  return out;
}

// --- Take quality ----------------------------------------------------------------------------------------------------
// A good take for cloning: long enough, loud but not clipped, mostly speech, and quiet background between words.
export type TakeQuality = { seconds: number; peak: number; clipped: number; speech: number; snr: number; score: number; accepted: boolean };
export function takeQuality(samples: Int16Array, rate: number): TakeQuality {
  const seconds = samples.length / rate, frame = Math.round(rate * 0.03);
  let peak = 0, clippedCount = 0;
  const energies: number[] = [];
  for (let start = 0; start + frame <= samples.length; start += frame) {
    let sum = 0;
    for (let i = start; i < start + frame; i++) {
      const value = Math.abs(samples[i]) / 32768;
      if (value > peak) peak = value;
      if (value >= 0.99) clippedCount++;
      sum += value * value;
    }
    energies.push(Math.sqrt(sum / frame));
  }
  const sorted = [...energies].sort((a, b) => a - b), at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const floor = Math.max(at(0.1), 1e-4), loud = at(0.9);
  const speech = energies.length ? energies.filter((energy) => energy > floor * 4).length / energies.length : 0;
  const snr = loud / floor, clipped = samples.length ? clippedCount / samples.length : 0;
  const accepted = seconds >= 3 && seconds <= 30 && peak >= 0.1 && clipped < 0.001 && speech >= 0.45 && snr >= 8;
  // Higher signal-to-noise and more continuous speech make a better reference.
  const score = accepted ? Math.round(Math.min(snr, 60) * speech * 100) / 100 : 0;
  return { seconds, peak, clipped, speech, snr, score, accepted };
}
export function resample(samples: Int16Array, from: number, to = sampleRate): Int16Array {
  if (from === to) return samples;
  const out = new Int16Array(Math.floor(samples.length * to / from));
  for (let i = 0; i < out.length; i++) {
    const position = i * from / to, left = Math.floor(position), right = Math.min(samples.length - 1, left + 1), mix = position - left;
    out[i] = Math.round(samples[left] * (1 - mix) + samples[right] * mix);
  }
  return out;
}

// Best takes first, until the clip is full; they keep their spoken order so the clip sounds natural.
export function pickTakes(takes: Take[], limit = maxClipSeconds): Take[] {
  const chosen: Take[] = []; let total = 0;
  for (const take of [...takes].sort((a, b) => b.score - a.score)) {
    if (total + take.seconds > limit) continue;
    chosen.push(take); total += take.seconds;
  }
  return takes.filter((take) => chosen.includes(take));
}
export function joinTakes(parts: Int16Array[], rate = sampleRate): Int16Array {
  const gap = Math.round(rate * 0.35), length = parts.reduce((size, part) => size + part.length, 0) + gap * Math.max(0, parts.length - 1);
  const out = new Int16Array(length); let offset = 0;
  parts.forEach((part, index) => { out.set(part, offset); offset += part.length + (index < parts.length - 1 ? gap : 0); });
  return out;
}
export function cloneStatus(state: CloneState, enabled: boolean): CloneStatus {
  const nextAt = state.frozen ? null : cloneThresholds[state.clones] ?? null;
  return { enabled, collecting: enabled && !state.frozen, cloned: Boolean(state.voiceId), frozen: state.frozen, clones: state.clones,
    collectedSeconds: Math.round(state.collectedSeconds), nextAt };
}

// --- Service ---------------------------------------------------------------------------------------------------------
export interface VoiceCloner {
  voiceId(): string | undefined;
  status(): CloneStatus;
  ready(): Promise<void>;
  addTake(wav: Buffer, signal: AbortSignal): Promise<{ accepted: boolean; cloned: boolean; status: CloneStatus }>;
  reset(signal: AbortSignal): Promise<CloneStatus>;
}

const bucket = 'talk-voice';
export function createVoiceCloner(config: VoiceCloneConfig, fetcher: typeof fetch = fetch, log: (message: string) => void = console.warn): VoiceCloner {
  const storage = `${config.storageUrl}/storage/v1`, folder = config.userId;
  const storageHeaders = { apikey: config.secret };
  const cartesiaHeaders = { Authorization: `Bearer ${config.cartesiaKey}`, 'Cartesia-Version': '2026-08-14' };
  let state = emptyState(), loaded: Promise<void> | undefined, queue: Promise<unknown> = Promise.resolve();
  const timeout = (signal: AbortSignal, ms = 30_000) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);
  // One change at a time: takes arrive turn by turn, and a clone must not race a reset.
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.catch(() => undefined); return next; };

  async function check(response: Response, what: string) {
    if (response.ok) return response;
    await response.body?.cancel();
    throw new Error(`Clonagem de voz: falha ao ${what} (${response.status}).`);
  }
  async function ensureBucket(signal: AbortSignal) {
    const response = await fetcher(`${storage}/bucket`, { method: 'POST', headers: { ...storageHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bucket, name: bucket, public: false }), signal: timeout(signal) });
    // Already there is fine (409, or 400 with "already exists" on older Storage versions).
    if (!response.ok && response.status !== 409 && response.status !== 400) await check(response, 'criar o armazenamento');
    else await response.body?.cancel();
  }
  async function upload(path: string, body: Buffer, type: string, signal: AbortSignal) {
    await check(await fetcher(`${storage}/object/${bucket}/${folder}/${path}`, { method: 'POST',
      headers: { ...storageHeaders, 'Content-Type': type, 'x-upsert': 'true' }, body: new Uint8Array(body), signal: timeout(signal) }), 'salvar a amostra');
  }
  async function download(path: string, signal: AbortSignal): Promise<Buffer | null> {
    const response = await fetcher(`${storage}/object/authenticated/${bucket}/${folder}/${path}`, { headers: storageHeaders, signal: timeout(signal) });
    if (response.status === 404 || response.status === 400) { await response.body?.cancel(); return null; }
    return Buffer.from(await (await check(response, 'ler a amostra')).arrayBuffer());
  }
  async function remove(paths: string[], signal: AbortSignal) {
    if (!paths.length) return;
    await check(await fetcher(`${storage}/object/${bucket}`, { method: 'DELETE', headers: { ...storageHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: paths.map((path) => `${folder}/${path}`) }), signal: timeout(signal) }), 'apagar amostras');
  }
  async function saveState(signal: AbortSignal) {
    state.updatedAt = new Date().toISOString();
    await upload('state.json', Buffer.from(JSON.stringify(state)), 'application/json', signal);
  }
  async function deleteVoice(id: string, signal: AbortSignal) {
    const response = await fetcher(`https://api.cartesia.ai/voices/${encodeURIComponent(id)}`, { method: 'DELETE', headers: cartesiaHeaders, signal: timeout(signal) });
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) log('Clonagem de voz: não foi possível apagar a voz anterior na Cartesia.');
  }
  async function clone(clip: Buffer, signal: AbortSignal): Promise<string> {
    const form = new FormData();
    form.set('clip', new Blob([new Uint8Array(clip)], { type: 'audio/wav' }), 'minha-voz.wav');
    form.set('name', 'Talk2urself — minha voz');
    form.set('description', 'Clonada automaticamente das falas do usuário no Talk2urself.');
    form.set('language', 'pt');
    const response = await check(await fetcher('https://api.cartesia.ai/voices/clone', { method: 'POST', headers: cartesiaHeaders, body: form, signal: timeout(signal, 60_000) }), 'clonar a voz');
    const body = await response.json() as { id?: unknown };
    if (typeof body.id !== 'string' || !body.id) throw new Error('Clonagem de voz: a Cartesia não devolveu a voz.');
    return body.id;
  }

  function load() {
    loaded ??= (async () => {
      try {
        await ensureBucket(AbortSignal.timeout(20_000));
        const saved = await download('state.json', AbortSignal.timeout(20_000));
        if (saved) {
          const parsed = JSON.parse(saved.toString('utf8')) as Partial<CloneState>;
          state = { ...emptyState(), ...parsed, takes: Array.isArray(parsed.takes) ? parsed.takes.filter((take) =>
            typeof take?.path === 'string' && typeof take.seconds === 'number' && typeof take.score === 'number') : [] };
        }
      } catch { loaded = undefined; log('Clonagem de voz: não foi possível ler o estado salvo; nova tentativa no próximo uso.'); throw new Error('Clonagem de voz: armazenamento indisponível.'); }
    })();
    return loaded;
  }

  async function addTake(wav: Buffer, signal: AbortSignal) {
    await load();
    return serial(async () => {
      if (state.frozen) return { accepted: false, cloned: false, status: cloneStatus(state, true) };
      const parsed = readWav(wav);
      if (!parsed) return { accepted: false, cloned: false, status: cloneStatus(state, true) };
      const samples = resample(parsed.samples, parsed.rate), quality = takeQuality(samples, sampleRate);
      if (!quality.accepted) return { accepted: false, cloned: false, status: cloneStatus(state, true) };
      const take: Take = { path: `takes/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`, seconds: Math.round(quality.seconds * 100) / 100, score: quality.score };
      await upload(take.path, writeWav(samples), 'audio/wav', signal);
      state.takes.push(take); state.collectedSeconds += take.seconds;
      // Keep only the best takes between clones; the rest of the raw audio is deleted right away.
      const kept = pickTakes(state.takes, poolSeconds), dropped = state.takes.filter((item) => !kept.includes(item));
      state.takes = kept;
      await remove(dropped.map((item) => item.path), signal);
      let cloned = false;
      const threshold = cloneThresholds[state.clones];
      const clipTakes = pickTakes(state.takes);
      if (threshold !== undefined && state.collectedSeconds >= threshold && clipTakes.reduce((size, item) => size + item.seconds, 0) >= minClipSeconds) {
        const parts: Int16Array[] = [];
        for (const item of clipTakes) { const audio = await download(item.path, signal), read = audio && readWav(audio); if (read) parts.push(read.samples); }
        const clip = writeWav(joinTakes(parts));
        const voiceId = await clone(clip, signal), previous = state.voiceId;
        state.voiceId = voiceId; state.clones++; cloned = true;
        if (previous && previous !== voiceId) await deleteVoice(previous, signal);
        if (state.clones >= cloneThresholds.length) {
          // Frozen: keep only the clip behind the final voice, delete every raw take.
          await upload('final.wav', clip, 'audio/wav', signal);
          await remove(state.takes.map((item) => item.path), signal);
          state.takes = []; state.frozen = true;
        }
      }
      await saveState(signal);
      return { accepted: true, cloned, status: cloneStatus(state, true) };
    });
  }

  async function reset(signal: AbortSignal) {
    await load();
    return serial(async () => {
      if (state.voiceId) await deleteVoice(state.voiceId, signal);
      await remove([...state.takes.map((item) => item.path), 'final.wav'], signal);
      state = emptyState();
      await saveState(signal);
      return cloneStatus(state, true);
    });
  }

  return { voiceId: () => state.voiceId, status: () => cloneStatus(state, true), ready: () => load().catch(() => undefined), addTake, reset };
}
