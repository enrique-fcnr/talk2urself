import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The public landing page, built on its own under /landing/: visitors without the access cookie may load it, so it
// carries nothing of the app beyond the avatar and brain it shows (and their licences). Everything else stays gated.
const shared = ['kelly.glb', 'brain.glb', 'KELLY-LICENSE.md', 'BRAIN-LICENSE.md', 'THREE-LICENSE.txt'];
const avatarPath = (name: string) => fileURLToPath(new URL(`./public/avatars/${name}`, import.meta.url));
function avatarFiles(): Plugin {
  return {
    name: 'talk2urself-landing-avatars',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = request.url?.split('?')[0].replace(/^\/landing\/avatars\//, '');
        if (!request.url?.startsWith('/landing/avatars/') || !name || !shared.includes(name)) return next();
        response.end(readFileSync(avatarPath(name)));
      });
    },
    generateBundle() {
      for (const name of shared) this.emitFile({ type: 'asset', fileName: `avatars/${name}`, source: readFileSync(avatarPath(name)) });
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('./landing', import.meta.url)),
  base: '/landing/',
  publicDir: false,
  plugins: [react(), avatarFiles()],
  build: { outDir: fileURLToPath(new URL('./dist/landing', import.meta.url)), emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
});
