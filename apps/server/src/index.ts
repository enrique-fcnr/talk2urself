import { createApp } from './app.ts';
import { createVoiceProvider, readVoiceConfig } from './voice.ts';
import { appendFileSync, mkdirSync } from 'node:fs';
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
const app = await createApp({
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
await app.listen({ host: '127.0.0.1', port: 3001 });
console.log('Talk2urself: servidor local em http://127.0.0.1:3001');
console.log(config ? 'Conversa por voz configurada.' : 'Prévia demonstrativa: preencha as chaves e a voz no arquivo .env para ativar as APIs.');
if (config?.voicePaused) console.log('Voz Cartesia pausada (CARTESIA_PAUSED=1): as respostas são faladas em silêncio, sem chamar a Cartesia.');
console.log(memoryConfig ? 'Memória configurada; o primeiro uso verifica o acesso ao banco.' : 'Memória persistente pendente: configure o Supabase no servidor.');

async function shutdown() {
  await app.close();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
