import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';

// The voice model (Silero VAD) and its runtime, served from /vad/: straight from the packages while developing, and
// copied into the build with compressed copies (.br, .gz), which the server sends to browsers that accept them.
const vadFiles: Record<string, string> = {
  'silero_vad_v5.onnx': '../../node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx',
  'ort-wasm-simd-threaded.wasm': '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs': '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
};
const vadPath = (name: string) => fileURLToPath(new URL(vadFiles[name], import.meta.url));
function vadAssets(): Plugin {
  return {
    name: 'talk2urself-vad-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = request.url?.split('?')[0].replace(/^\/vad\//, '');
        if (!request.url?.startsWith('/vad/') || !name || !vadFiles[name]) return next();
        response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream');
        response.end(readFileSync(vadPath(name)));
      });
    },
    generateBundle() {
      for (const name of Object.keys(vadFiles)) {
        const source = readFileSync(vadPath(name));
        this.emitFile({ type: 'asset', fileName: `vad/${name}`, source });
        this.emitFile({ type: 'asset', fileName: `vad/${name}.br`, source: brotliCompressSync(source) });
        this.emitFile({ type: 'asset', fileName: `vad/${name}.gz`, source: gzipSync(source, { level: 9 }) });
      }
    },
  };
}

// LAN=1 (npm run dev:lan): reachable from other devices on the same network, over HTTPS, since browsers only open
// the microphone on a secure origin. The certificate is a local self-signed one in .local/ (never committed).
const lan = process.env.LAN === '1';
const certificate = (name: string) => fileURLToPath(new URL(`../../.local/lan-${name}.pem`, import.meta.url));
const https = lan && existsSync(certificate('key')) && existsSync(certificate('cert'))
  ? { key: readFileSync(certificate('key')), cert: readFileSync(certificate('cert')) } : undefined;

export default defineConfig({
  plugins: [react(), vadAssets()],
  server: {
    host: lan ? '0.0.0.0' : '127.0.0.1',
    port: 5173,
    strictPort: true,
    https,
    proxy: {
      // The page's own host is kept, so the API accepts requests from it (its origin check compares the two).
      '/api': { target: 'http://127.0.0.1:3001' },
      '/ws': { target: 'ws://127.0.0.1:3001', ws: true },
    },
  },
  // npm run preview:lan: the built app, served the same way (HTTPS on the network, API proxied), to test real performance.
  preview: { host: lan ? '0.0.0.0' : '127.0.0.1', port: 5173, strictPort: true, https },
});
