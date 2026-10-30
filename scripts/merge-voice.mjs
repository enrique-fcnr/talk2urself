// Puts the clone's voice back under a screen recording of the iPhone (which records the screen but not the voice).
// The server keeps every segment of the voice and when the page played it (apps/server/src/voice-log.ts). This script
// rebuilds that voice on the video's timeline. Where the video starts comes from the big changes on screen the page
// noted (waking, falling asleep, opening the memories), found again in the picture; so start the screen recording
// before waking the clone.
//
//   node scripts/merge-voice.mjs <video> [--log .local/voice-log] [--start 2026-10-30T21:07:50Z] [--offset 1.25] [--out file]
//
// --start: about when the video started (otherwise the file's own creation time, then its modified time).
// --offset: nudge the voice later (+) or earlier (-) by seconds, after the automatic match.
// Needs ffmpeg and ffprobe. Fetch the server's log first:
//   ssh -i .local/lightsail-key.pem ubuntu@35.175.84.219 "sudo tar czf - -C /opt/talk2urself/.local voice-log" | tar xzf - -C .local/server
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

const rate = 24_000;
const args = process.argv.slice(2), option = (name) => { const at = args.indexOf(name); return at >= 0 ? args.splice(at, 2)[1] : undefined; };
const logDir = option('--log') ?? '.local/voice-log', startOption = option('--start'), nudge = Number(option('--offset') ?? 0), outOption = option('--out');
const video = args[0];
if (!video || !existsSync(video)) { console.error('Uso: node scripts/merge-voice.mjs <vídeo> [--log pasta] [--start ISO] [--offset s] [--out arquivo]'); process.exit(1); }

// The video: length and about when it started.
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', video], { encoding: 'utf8' }));
const duration = Number(probe.format.duration), tags = probe.format.tags ?? {};
// The iPhone writes its local time with an offset like -0300, which Date.parse wants as -03:00.
const created = (tags['com.apple.quicktime.creationdate'] ?? tags.creation_time)?.replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
const createdAt = created ? Date.parse(created) : NaN;
const anchors = startOption ? [Date.parse(startOption)]
  : Number.isFinite(createdAt) ? [createdAt, createdAt - duration * 1000]
  : [statSync(video).mtimeMs - duration * 1000];
console.log(`Vídeo: ${duration.toFixed(1)} s, ${created ? `criado ${created}` : 'sem data de criação'}.`);

// The voice: every stretch that played, on the wall clock, cut where the page stopped it.
const stretches = [], said = new Map(), marks = [];
for (const day of existsSync(logDir) ? readdirSync(logDir).filter((name) => /^\d{8}$/.test(name)) : []) {
  const folder = join(logDir, day), lines = (file) => existsSync(join(folder, file)) ? readFileSync(join(folder, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  for (const clip of lines('clips.jsonl')) said.set(clip.clip, clip.text);
  marks.push(...lines('marks.jsonl'));
  for (const report of lines('played.jsonl')) {
    const file = join(folder, `${report.clip}.pcm`);
    if (!existsSync(file)) continue;
    const raw = readFileSync(file), pcm = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
    report.pieces.forEach(([sample, at], i) => {
      let end = report.pieces[i + 1]?.[0] ?? pcm.length;
      if (report.stopped !== undefined) end = Math.min(end, sample + Math.max(0, Math.round((report.stopped - at) / 1000 * rate)));
      if (end > sample) stretches.push({ clip: report.clip, at, samples: pcm.subarray(sample, end) });
    });
  }
}
if (!stretches.length) { console.error(`Nenhuma fala encontrada em ${logDir}.`); process.exit(1); }
stretches.sort((a, b) => a.at - b.at);

// The picture's change from frame to frame, at the video's own rate (up to 60 a second).
const [num, den] = (probe.streams.find((stream) => stream.codec_type === 'video')?.avg_frame_rate || '30/1').split('/').map(Number);
const fps = Math.min(60, Math.round(num / (den || 1)) || 30), step = 1000 / fps;
const motion = [];
const run = spawnSync('ffmpeg', ['-v', 'error', '-i', video, '-an', '-vf', `fps=${fps},scale=180:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
for (const match of run.stdout.matchAll(/YAVG=([\d.]+)/g)) motion.push(Number(match[1]));
if (!motion.length) { console.error('Não foi possível ler o movimento do vídeo.', run.stderr); process.exit(1); }
const window = startOption || Number.isFinite(createdAt) ? 30_000 : 120_000;

// Where the video starts. First choice: the big changes on screen the page noted (waking, sleeping, the memories),
// found again as the first frame of a sudden change. Each pairing of a mark with such a frame proposes a start; the one
// that lines up the most marks wins.
const sorted = [...motion].sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
const sharp = Math.max(6, median * 8), onsets = [];
for (let k = 1; k < motion.length; k++) if (motion[k] >= sharp && motion[k - 1] < sharp / 2) onsets.push(k * step);
let best;
for (const anchor of anchors) for (const mark of marks) for (const onset of onsets) {
  const start = mark.at - onset;
  if (Math.abs(start - anchor) > window) continue;
  const matched = marks.filter((other) => onsets.some((time) => Math.abs(other.at - start - time) <= 2 * step));
  if (!best || matched.length > best.matched.length) best = { start, matched };
}
let start;
if (best) {
  start = best.start;
  console.log(`Início do vídeo: ${new Date(start).toISOString()}, pelas mudanças de tela (${best.matched.map((mark) => mark.what).join(', ')}).`);
} else {
  // Otherwise: the moment that best lines up "voice playing" with "picture moving", near the anchors (less exact).
  const n = motion.length, mean = motion.reduce((sum, value) => sum + value, 0) / n;
  const spread = Math.sqrt(motion.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n) || 1;
  let found = { start: anchors[0], value: -Infinity };
  for (const anchor of anchors) {
    const from = anchor - window, length = Math.ceil(2 * window / step) + n + 1, voice = new Uint8Array(length);
    for (const stretch of stretches) {
      const first = Math.max(0, Math.ceil((stretch.at - from) / step)), last = Math.min(length, Math.ceil((stretch.at + stretch.samples.length / rate * 1000 - from) / step));
      voice.fill(1, first, Math.max(first, last));
    }
    for (let shift = 0; shift + n <= length && shift * step <= 2 * window; shift++) {
      let on = 0, sum = 0;
      for (let k = 0; k < n; k++) if (voice[shift + k]) { on++; sum += motion[k]; }
      const share = on / n, value = on && on < n ? (sum / on - mean) / spread * Math.sqrt(share / (1 - share)) : 0;
      if (value > found.value) found = { start: from + shift * step, value };
    }
  }
  start = found.start;
  console.warn(`Atenção: nenhuma mudança de tela anotada aparece no vídeo; início estimado pelo movimento (${new Date(start).toISOString()}). Confira e ajuste com --start ou --offset.`);
}
start -= nudge * 1000;

// The voice on the video's timeline, written as WAV and put under the picture.
const total = Math.ceil(duration * rate), mix = new Int32Array(total);
const inside = [];
for (const stretch of stretches) {
  const first = Math.round((stretch.at - start) / 1000 * rate);
  if (first + stretch.samples.length <= 0 || first >= total) continue;
  inside.push(stretch);
  for (let i = Math.max(0, -first); i < stretch.samples.length && first + i < total; i++) mix[first + i] += stretch.samples[i];
}
const wav = Buffer.alloc(44 + total * 2);
wav.write('RIFF'); wav.writeUInt32LE(36 + total * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(total * 2, 40);
for (let i = 0; i < total; i++) wav.writeInt16LE(Math.max(-32768, Math.min(32767, mix[i])), 44 + i * 2);
const track = join(dirname(video), `${basename(video, extname(video))}-voz.wav`);
writeFileSync(track, wav);
const out = outOption ?? join(dirname(video), `${basename(video, extname(video))}-com-voz.mp4`);
const mux = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-i', track, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], { encoding: 'utf8' });
if (mux.status !== 0) { console.error('ffmpeg falhou:', mux.stderr); process.exit(1); }
console.log(`${inside.length} trechos de voz no vídeo. Pronto: ${out}`);
for (const stretch of inside.slice(0, 5)) console.log(`  ${((stretch.at - start) / 1000).toFixed(2)} s: ${said.get(stretch.clip) ?? stretch.clip}`);
