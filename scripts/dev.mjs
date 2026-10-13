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
function run(args, cwd = root) {
  const child = spawn(process.execPath, args, { cwd, stdio: 'inherit', windowsHide: true });
  children.push(child);
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code) => stop(code ?? 1));
}

const envPath = path.join(root, '.env');
run([...(existsSync(envPath) ? [`--env-file=${envPath}`] : []), '--import', 'tsx', 'apps/server/src/index.ts']);
run([path.join(root, 'node_modules/vite/bin/vite.js')], path.join(root, 'apps/web'));
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
