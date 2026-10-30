import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVoiceLog } from './voice-log.ts';
import { parseVoicePlayed } from '../../../shared/protocol.ts';

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('the voice log keeps each clip as sent and when the page played it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-log-'));
  const log = createVoiceLog(dir, () => new Date('2026-10-30T21:15:07.123Z'));
  const clip = log.start('Olá, tudo bem?', 'pt');
  assert.equal(clip, '20261030-211507123-1');
  log.chunk(clip, Buffer.from([1, 0, 2, 0]));
  log.chunk(clip, Buffer.from([3, 0]));
  log.played({ type: 'voice-played', clip, pieces: [[0, 1793389000000], [2, 1793389000500]], stopped: 1793389001000 });
  await settle();
  const day = join(dir, '20261030');
  assert.deepEqual([...await readFile(join(day, `${clip}.pcm`))], [1, 0, 2, 0, 3, 0]);
  assert.deepEqual(JSON.parse(await readFile(join(day, 'clips.jsonl'), 'utf8')), { clip, at: '2026-10-30T21:15:07.123Z', language: 'pt', text: 'Olá, tudo bem?' });
  const played = JSON.parse(await readFile(join(day, 'played.jsonl'), 'utf8'));
  assert.deepEqual(played.pieces, [[0, 1793389000000], [2, 1793389000500]]);
  assert.equal(played.stopped, 1793389001000);
});

test('the voice log removes days older than two weeks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-log-'));
  await mkdir(join(dir, '20261001')); await mkdir(join(dir, '20261020'));
  createVoiceLog(dir, () => new Date('2026-10-30T12:00:00Z'));
  await settle();
  assert.deepEqual(await readdir(dir), ['20261020']);
});

test('playback reports are checked before they reach the disk', () => {
  const report = { type: 'voice-played', clip: '20261030-211507123-1', pieces: [[0, 1793389000000]] };
  assert.deepEqual(parseVoicePlayed(JSON.stringify(report)), report);
  assert.equal(parseVoicePlayed(JSON.stringify({ ...report, clip: '../../etc/passwd' })), null);
  assert.equal(parseVoicePlayed(JSON.stringify({ ...report, pieces: [] })), null);
  assert.equal(parseVoicePlayed(JSON.stringify({ ...report, pieces: [[-1, 1793389000000]] })), null);
  assert.equal(parseVoicePlayed(JSON.stringify({ ...report, stopped: 'now' })), null);
});
