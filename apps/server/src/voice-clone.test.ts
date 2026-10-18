import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloneThresholds, createVoiceCloner, joinTakes, pickTakes, readVoiceCloneConfig, readWav, takeQuality, writeWav } from './voice-clone.ts';

const rate = 16_000;
// Speech-like take: bursts of a loud tone over a very quiet floor.
function speech(seconds: number, amplitude = 0.5) {
  const samples = new Int16Array(Math.round(seconds * rate));
  for (let i = 0; i < samples.length; i++) {
    const talking = Math.floor(i / (rate * 0.4)) % 5 !== 4;
    samples[i] = Math.round((talking ? amplitude * Math.sin(i * 0.12) : 0.002 * Math.sin(i * 1.7)) * 32767);
  }
  return samples;
}

test('readVoiceCloneConfig stays off unless VOICE_CLONING=1 with the voice unpaused', () => {
  const env = { CARTESIA_API_KEY: 'k', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 's', LOCAL_USER_ID: 'u' };
  assert.equal(readVoiceCloneConfig(env), null);
  assert.equal(readVoiceCloneConfig({ ...env, VOICE_CLONING: '1', CARTESIA_PAUSED: '1' }), null);
  assert.ok(readVoiceCloneConfig({ ...env, VOICE_CLONING: '1', CARTESIA_PAUSED: '0' }));
});

test('WAV round trip and take quality', () => {
  const samples = speech(6);
  const read = readWav(writeWav(samples));
  assert.equal(read?.rate, rate);
  assert.deepEqual(read?.samples.slice(0, 50), samples.slice(0, 50));
  assert.equal(takeQuality(samples, rate).accepted, true);
  assert.equal(takeQuality(speech(2), rate).accepted, false, 'too short');
  assert.equal(takeQuality(speech(6, 0.02), rate).accepted, false, 'too quiet');
  assert.equal(takeQuality(speech(6, 1.2), rate).accepted, false, 'clipped');
  const noisy = speech(6).map((value, i) => value + Math.round(Math.sin(i * 3.1) * 6000));
  assert.equal(takeQuality(noisy, rate).accepted, false, 'noisy background');
});

test('pickTakes keeps the best takes within the limit, in spoken order', () => {
  const takes = [{ path: 'a', seconds: 25, score: 1 }, { path: 'b', seconds: 25, score: 9 }, { path: 'c', seconds: 25, score: 5 }, { path: 'd', seconds: 9, score: 2 }];
  assert.deepEqual(pickTakes(takes, 60).map((take) => take.path), ['b', 'c', 'd']);
  assert.equal(joinTakes([new Int16Array(10), new Int16Array(10)]).length, 20 + Math.round(rate * 0.35));
});

function fakeServices() {
  const files = new Map<string, Buffer>(), clones: string[] = [], deletedVoices: string[] = [];
  let cloneCount = 0;
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input), method = init.method ?? 'GET';
    if (url.endsWith('/storage/v1/bucket')) return new Response('{}', { status: 409 });
    if (url === 'https://api.cartesia.ai/voices/clone') {
      const form = init.body as FormData;
      assert.equal(form.get('language'), 'pt');
      clones.push(String((form.get('clip') as Blob).size));
      return Response.json({ id: `voice-${++cloneCount}` });
    }
    if (url.startsWith('https://api.cartesia.ai/voices/')) { deletedVoices.push(url.split('/').pop()!); return new Response(null, { status: 204 }); }
    const object = url.match(/\/storage\/v1\/object\/(?:authenticated\/)?talk-voice\/(.+)$/);
    if (object && method === 'POST') { files.set(object[1], Buffer.from(init.body as Uint8Array)); return Response.json({}); }
    if (object && method === 'GET') return files.has(object[1]) ? new Response(new Uint8Array(files.get(object[1])!)) : new Response('{}', { status: 400 });
    if (url.endsWith('/object/talk-voice') && method === 'DELETE') {
      for (const path of JSON.parse(String(init.body)).prefixes as string[]) files.delete(path);
      return Response.json([]);
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  return { files, clones, deletedVoices, fetcher };
}

test('clones at the thresholds, re-clones twice, then freezes keeping only the final clip', async () => {
  const services = fakeServices();
  const cloner = createVoiceCloner({ cartesiaKey: 'k', storageUrl: 'https://x.supabase.co', secret: 's', userId: 'user' }, services.fetcher, () => {});
  const take = writeWav(speech(20));
  assert.equal(cloner.voiceId(), undefined);
  // Nothing is collected until the user picks "Minha voz".
  assert.equal((await cloner.addTake(take, AbortSignal.timeout(5000))).accepted, false);
  await cloner.choose(true, AbortSignal.timeout(5000));
  let clonedAt: number[] = [];
  for (let i = 0; i < 70 && !cloner.status().frozen; i++) {
    const result = await cloner.addTake(take, AbortSignal.timeout(5000));
    assert.equal(result.accepted, true);
    if (result.cloned) clonedAt.push(result.status.collectedSeconds);
  }
  assert.deepEqual(clonedAt, cloneThresholds.map((threshold) => Math.ceil(threshold / 20) * 20));
  assert.equal(cloner.voiceId(), 'voice-3');
  await cloner.choose(false, AbortSignal.timeout(5000));
  assert.equal(cloner.voiceId(), undefined, 'own voice off: Kelly speaks with hers');
  await cloner.choose(true, AbortSignal.timeout(5000));
  assert.deepEqual(services.deletedVoices, ['voice-1', 'voice-2']);
  assert.equal(cloner.status().frozen, true);
  const stored = [...services.files.keys()].sort();
  assert.deepEqual(stored, ['user/final.wav', 'user/state.json'], 'raw takes deleted after freezing');
  // Frozen: new takes are ignored.
  assert.equal((await cloner.addTake(take, AbortSignal.timeout(5000))).accepted, false);
  // Between clones at most the 90 s pool of takes was ever kept.
  assert.ok(services.clones.every((size) => Number(size) <= 44 + (60 + 3) * rate * 2));

  const status = await cloner.reset(AbortSignal.timeout(5000));
  assert.equal(status.cloned, false); assert.equal(status.ownVoice, true);
  assert.equal(status.collecting, true);
  assert.deepEqual([...services.files.keys()], ['user/state.json']);
  assert.deepEqual(services.deletedVoices, ['voice-1', 'voice-2', 'voice-3']);
});

test('rejected takes are not stored or counted', async () => {
  const services = fakeServices();
  const cloner = createVoiceCloner({ cartesiaKey: 'k', storageUrl: 'https://x.supabase.co', secret: 's', userId: 'user' }, services.fetcher, () => {});
  await cloner.choose(true, AbortSignal.timeout(5000));
  const result = await cloner.addTake(writeWav(speech(6, 0.02)), AbortSignal.timeout(5000));
  assert.equal(result.accepted, false);
  assert.equal(result.status.collectedSeconds, 0);
  assert.deepEqual([...services.files.keys()], ['user/state.json']);
});
