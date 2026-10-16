import { spawn } from 'node:child_process';
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
run([...(existsSync(envPath) ? [`--env-file=${envPath}`] : []), '--import', 'tsx', 'apps/server/src/index.ts'], root, { ...process.env, HOST: '127.0.0.1', PORT: '3001' });
run([path.join(root, 'node_modules/vite/bin/vite.js')], path.join(root, 'apps/web'));
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
