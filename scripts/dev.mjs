import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
function run(args, cwd = root, env = process.env) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  children.push(child);
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code) => stop(code ?? 1));
}

const envPath = path.join(root, '.env');
// The API stays on 127.0.0.1:3001 (Vite proxies to it), even when the launcher sets PORT for the web server.
run([...(existsSync(envPath) ? [`--env-file=${envPath}`] : []), '--import', 'tsx', 'apps/server/src/index.ts'], root, { ...process.env, HOST: '127.0.0.1', PORT: '3001', WS_DEBUG: '1' });
// --lan: the web server also listens on the local network, over HTTPS (see apps/web/vite.config.ts).
// --preview: the optimized build instead of the development server, to judge how smooth the app really is.
const web = path.join(root, 'apps/web'), vite = path.join(root, 'node_modules/vite/bin/vite.js');
const webEnv = { ...process.env, ...(process.argv.includes('--lan') ? { LAN: '1' } : {}) };
if (process.argv.includes('--preview')) {
  const built = spawnSync(process.execPath, [vite, 'build'], { cwd: web, env: webEnv, stdio: 'inherit', windowsHide: true });
  if (built.status !== 0) stop(built.status ?? 1);
  else run([vite, 'preview'], web, webEnv);
} else run([vite], web, webEnv);
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
