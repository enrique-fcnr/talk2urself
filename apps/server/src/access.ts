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
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.wasm': 'application/wasm' };
// Serves the built web app (apps/web/dist): files as they are, any other page path falls back to index.html.
export function registerWeb(app: FastifyInstance, root: string) {
  app.get('/*', async (request, reply) => {
    const route = decodeURIComponent(request.url.split('?')[0]);
    if (route.startsWith('/api/') || route.startsWith('/ws')) return reply.code(404).send({ error: 'Não encontrado.' });
    const file = path.resolve(root, '.' + route);
    let target = path.join(root, 'index.html');
    if (file.startsWith(root + path.sep)) {
      try { if ((await stat(file)).isFile()) target = file; } catch { /* Page route: fall back to the app. */ }
    }
    const hashed = target.includes(`${path.sep}assets${path.sep}`);
    reply.header('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    return reply.type(types[path.extname(target).toLowerCase()] ?? 'application/octet-stream').send(await readFile(target));
  });
}
