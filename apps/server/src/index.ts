import { createApp } from './app.ts';
import { createVoiceProvider, readVoiceConfig } from './voice.ts';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMemoryService, readMemoryConfig } from './memory.ts';
import { serializeDiagnostic, type MemoryDiagnosticRecord } from './memory-diagnostics.ts';

const config = readVoiceConfig();
const memoryConfig = config ? readMemoryConfig() : null;
const logUsage = (record: Record<string, string | number>) => {
  try {
    mkdirSync('.local', { recursive: true });
    appendFileSync('.local/usage.jsonl', JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
  } catch { console.warn('Não foi possível salvar o contador de uso local.'); }
};
// The built web app, when present (production): this one server then serves both the page and the API.
const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
const app = await createApp({
  webRoot: existsSync(webRoot + '/index.html') ? webRoot : undefined,
  voice: config ? createVoiceProvider(config) : undefined,
  memory: memoryConfig ? createMemoryService(memoryConfig, fetch, logUsage) : undefined,
  onUsage: logUsage,
  onMemoryDiagnostic: (record: MemoryDiagnosticRecord) => {
    try {
      mkdirSync('.local', { recursive: true });
      appendFileSync('.local/memory-diagnostics.jsonl', serializeDiagnostic(record));
    } catch { console.warn('Não foi possível salvar o diagnóstico local de memória.'); }
  },
});
// Local by default; hosting sets HOST=0.0.0.0 and PORT.
const host = process.env.HOST?.trim() || '127.0.0.1', port = Number(process.env.PORT) || 3001;
await app.listen({ host, port });
console.log(`Talk2urself: servidor em http://${host}:${port}`);
console.log(config ? 'Conversa por voz configurada.' : 'Prévia demonstrativa: preencha as chaves e a voz no arquivo .env para ativar as APIs.');
if (config?.voicePaused) console.log('Voz Cartesia pausada (CARTESIA_PAUSED=1): as respostas são faladas em silêncio, sem chamar a Cartesia.');
console.log(memoryConfig ? 'Memória configurada; o primeiro uso verifica o acesso ao banco.' : 'Memória persistente pendente: configure o Supabase no servidor.');

async function shutdown() {
  await app.close();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
