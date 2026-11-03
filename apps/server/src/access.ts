import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const localOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173'];
// Requests from the dev server, from the page this server itself serves (same host), or with no Origin at all.
export function originAllowed(request: FastifyRequest) {
  const origin = request.headers.origin;
  if (!origin || localOrigins.includes(origin)) return true;
  const host = request.headers['x-forwarded-host'] ?? request.headers.host;
  return typeof host === 'string' && (origin === `https://${host}` || origin === `http://${host}`);
}

const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.wasm': 'application/wasm', '.mjs': 'text/javascript', '.onnx': 'application/octet-stream',
  '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.m4a': 'audio/mp4' };
// Video and audio are sent in the byte ranges the browser asks for: Safari plays nothing without them.
const ranged = new Set(['.mp4', '.m4a']);
// Serves the built web app (apps/web/dist): files as they are, any other page path falls back to index.html (the public
// landing page's own paths, under /landing/, fall back to its index instead).
export function registerWeb(app: FastifyInstance, root: string) {
  app.get('/*', async (request, reply) => {
    const route = decodeURIComponent(request.url.split('?')[0]);
    if (route.startsWith('/api/') || route.startsWith('/ws')) return reply.code(404).send({ error: 'Not found.' });
    const file = path.resolve(root, '.' + route);
    let target = route === '/landing' || route.startsWith('/landing/') ? path.join(root, 'landing', 'index.html') : path.join(root, 'index.html');
    if (file.startsWith(root + path.sep)) {
      try { if ((await stat(file)).isFile()) target = file; } catch { /* Page route: fall back to the app. */ }
    }
    const hashed = target.includes(`${path.sep}assets${path.sep}`), voiceModel = target.includes(`${path.sep}vad${path.sep}`);
    // The voice model and its runtime never change between deploys of the same packages: cached for a week, and sent
    // compressed (brotli or gzip copies made at build time) to browsers that accept it.
    reply.header('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : voiceModel ? 'public, max-age=604800' : 'no-cache');
    reply.type(types[path.extname(target).toLowerCase()] ?? 'application/octet-stream');
    if (voiceModel) {
      const accepts = String(request.headers['accept-encoding'] ?? '');
      for (const [encoding, extension] of [['br', '.br'], ['gzip', '.gz']] as const) {
        if (!accepts.includes(encoding)) continue;
        try { const body = await readFile(target + extension); reply.header('Content-Encoding', encoding).header('Vary', 'Accept-Encoding'); return reply.send(body); } catch { /* no compressed copy */ }
      }
    }
    const body = await readFile(target), range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ''));
    if (ranged.has(path.extname(target).toLowerCase())) {
      reply.header('Accept-Ranges', 'bytes');
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2])), end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
        if (start > end || start >= body.length) return reply.code(416).header('Content-Range', `bytes */${body.length}`).send();
        return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${body.length}`).send(body.subarray(start, end + 1));
      }
    }
    return reply.send(body);
  });
}
