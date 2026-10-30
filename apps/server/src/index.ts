import { createApp } from './app.ts';
import { createVoiceProvider, readVoiceConfig } from './voice.ts';
import { createVoiceCloner, readVoiceCloneConfig } from './voice-clone.ts';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMemoryService, readMemoryConfig } from './memory.ts';
import { serializeDiagnostic, type MemoryDiagnosticRecord } from './memory-diagnostics.ts';
import { readAccessCode } from './gate.ts';
import { createVoiceLog } from './voice-log.ts';

const config = readVoiceConfig();
const memoryConfig = config ? readMemoryConfig() : null;
// Voice cloning is off unless VOICE_CLONING=1 (and the Cartesia voice is not paused); it needs Supabase Storage.
const cloneConfig = config && memoryConfig ? readVoiceCloneConfig() : null;
const cloner = cloneConfig ? createVoiceCloner(cloneConfig) : undefined;
if (config && cloner) { config.currentVoice = cloner.voiceId; void cloner.ready(); }
const logUsage = (record: Record<string, string | number>) => {
  try {
    mkdirSync('.local', { recursive: true });
    appendFileSync('.local/usage.jsonl', JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
  } catch { console.warn('Não foi possível salvar o contador de uso local.'); }
};
// The built web app, when present (production): this one server then serves both the page and the API.
const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
const accessCode = readAccessCode();
const app = await createApp({
  webRoot: existsSync(webRoot + '/index.html') ? webRoot : undefined,
  accessCode,
  // TRUST_PROXY=loopback when a proxy on this machine (Caddy) is the only one in front.
  trustProxy: process.env.TRUST_PROXY?.trim() || undefined,
  voice: config ? createVoiceProvider(config) : undefined,
  memory: memoryConfig ? createMemoryService(memoryConfig, fetch, logUsage) : undefined,
  cloner,
  // The clone's voice as heard, kept two weeks for putting it back under screen recordings of the iPhone.
  voiceLog: config ? createVoiceLog('.local/voice-log') : undefined,
  onUsage: logUsage,
  // WS_DEBUG=1 (set by npm run dev): a log of the conversation protocol, to diagnose turn-taking.
  onDebug: process.env.WS_DEBUG === '1' ? (record) => {
    try { mkdirSync('.local', { recursive: true }); appendFileSync('.local/ws-debug.jsonl', JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n'); } catch { /* best effort */ }
  } : undefined,
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
if (cloner) console.log('Clonagem de voz ligada (VOICE_CLONING=1): falas limpas viram sua voz após ~2,5, 10 e 20 minutos.');
if (accessCode) console.log('Acesso restrito (ACCESS_CODE): só entra quem abrir o site com ?k=<código> uma vez.');
console.log(memoryConfig ?'Memória configurada; o primeiro uso verifica o acesso ao banco.' : 'Memória persistente pendente: configure o Supabase no servidor.');

async function shutdown() {
  await app.close();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
