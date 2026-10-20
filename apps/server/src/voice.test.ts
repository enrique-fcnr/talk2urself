import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from './app.ts';
import { createVoiceProvider, readVoiceConfig, type Message, type VoiceProvider } from './voice.ts';
import { parseAudioInput } from '../../../shared/protocol.ts';
import { validateLearning, type MemoryContext, type MemoryService } from './memory.ts';
import type { MemoryDiagnosticRecord } from './memory-diagnostics.ts';
import { languageAnalysisPlan, mergeLanguageUpdates, filterLanguageUpdates } from './language.ts';

function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF'); bytes.writeUInt32LE(40, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(4, 40); return bytes;
}

test('abertura e resposta enviam tempos junto do mesmo áudio sem chamar a síntese antiga',async t=>{
  let generations=0;
  const phonemes=[{phoneme:'a',start:0,end:.1}];
  const app=await createApp({voice:provider({opening:async()=>({text:'Qual é meu nome?',inputTokens:0,outputTokens:0,cachedTokens:0}),
    speak:async()=>{throw Error('Síntese antiga não deve ser chamada');},speakTimed:async()=>{generations++;return {audio:wav(),phonemes};}})});
  const address=await app.listen({host:'127.0.0.1',port:0});const channel=new Channel(address);
  t.after(async()=>{await channel.close();await app.close();});await channel.opened;await channel.next();channel.command('start');
  // The audio streams first; the mouth cues follow with the end of the segment.
  const until=async(match:(event:any)=>boolean)=>{for(;;){const event=await channel.next();if(!(event instanceof ArrayBuffer)&&match(event))return event;}};
  const opening=await until(event=>event.type==='audio-done');assert.deepEqual(opening.phonemes,phonemes);
  channel.command('playback-ended');await until(event=>event.state==='listening');channel.audio();
  const output=await until(event=>event.type==='audio-done');
  assert.deepEqual(output.phonemes,phonemes);assert.equal(generations,2);
});

test('repouso descarta áudio sincronizado e seus tempos quando a geração termina atrasada',async t=>{
  let finish!: (speech: {audio:Buffer;phonemes:{phoneme:string;start:number;end:number}[]})=>void;
  let started!: ()=>void;const began=new Promise<void>(resolve=>{started=resolve;});let signal:AbortSignal|undefined;
  const app=await createApp({voice:provider({opening:async()=>({text:'Qual é meu nome?',inputTokens:0,outputTokens:0,cachedTokens:0}),
    speakTimed:async(_text,active)=>{signal=active;started();return new Promise(resolve=>{finish=resolve;});}})});
  const address=await app.listen({host:'127.0.0.1',port:0});const channel=new Channel(address);
  t.after(async()=>{await channel.close();await app.close();});await channel.opened;await channel.next();channel.command('start');await channel.next();await began;
  channel.command('reset');assert.equal((await channel.next()).state,'idle');assert.equal(signal?.aborted,true);
  const count=channel.packets.length;finish({audio:wav(),phonemes:[{phoneme:'a',start:0,end:.1}]});await delay(25);
  assert.equal(channel.packets.length,count);
});

test('observador separado aprende linguagem e a resposta não espera nem dispara essa análise', async () => {
  const messages: Message[] = [{ role: 'user', content: 'Pô, eu quero comparar as opções, tá ligado?' },
    { role: 'assistant', content: 'Expressão do personagem não serve como prova.' },
    { role: 'user', content: 'Pô, bora pensar com calma, tá ligado?' },
    { role: 'user', content: 'Pô, quero entender melhor, tá ligado?' }];
  const context: MemoryContext = { summary: '', profile: [], relevant: [], recent: [], version: 17, gaps: [] };
  const examples = messages.filter((item) => item.role === 'user').map((item) => item.content);
  const update = { slot: 'memory.expressao_po', category: 'expressions', categoryDescription: 'Expressões e contexto de uso',
    value: 'Usa pô em conversa informal para introduzir um pedido; hipótese revisável.', evidence: examples[2],
    supportingEvidence: examples, basis: 'observed', status: 'known' };
  const bodies: Record<string, any>[] = [];
  const events: MemoryDiagnosticRecord[] = [];
  const voice = createVoiceProvider({ openaiKey: 'test', cartesiaKey: 'test', voiceId: 'test', model: 'test' }, async (_url, options) => {
    const body = JSON.parse(String(options?.body)); bodies.push(body);
    const observation = body.text.format.name === 'language_observation';
    if (!observation) {
      const recovered = JSON.parse(body.input[0].content.slice(body.input[0].content.indexOf('{')));
      assert.equal(recovered.profile.length, 0, 'A resposta usa apenas o perfil já disponível.');
      assert.match(body.instructions, /referências concretas para formular a fala/);
    }
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text',
      text: JSON.stringify(observation ? { updates: [update] } : { reply: 'Pô, vamos comparar com calma.', summary: 'Discussão atual.', updates: [] }) }] }],
      usage: { input_tokens: observation ? 120 : 200, output_tokens: observation ? 40 : 50, input_tokens_details: { cached_tokens: 10 } } });
  });
  const answer = await voice.reply(messages, AbortSignal.timeout(2000), context, (event) => { events.push({ ...event, turnId: 'test' }); });
  assert.equal(bodies.length, 1, 'Responder não chama o observador.');
  const learned = await voice.observeLanguage!(messages, AbortSignal.timeout(2000), context, (event) => { events.push({ ...event, turnId: 'test' }); });
  assert.equal(bodies.length, 2);
  const analyzed = JSON.parse(bodies[1].input[0].content);
  assert.equal(analyzed.utterances.length, 3); assert.equal(JSON.stringify(analyzed).includes('Expressão do personagem'), false);
  assert.equal(answer.learning?.updates.length, 0); assert.equal(learned.updates.length, 1); assert.match(learned.updates[0].value, /Exemplos observados/);
  assert.equal(context.profile.length, 0, 'Análise não modifica a memória antes do commit.');
  assert.equal(answer.inputTokens, 200); assert.equal(learned.inputTokens, 120); assert.equal(answer.outputTokens + learned.outputTokens, 90); assert.equal(answer.cachedTokens + learned.cachedTokens, 20);
  assert.ok(events.some((event) => event.source === 'conversation' && event.stage === 'proposal' && event.count === 0));
  assert.ok(events.some((event) => event.source === 'language' && event.stage === 'validation' && event.outcome === 'accepted'));
  assert.equal(events.some((event) => event.stage === 'commit'), false, 'O provedor só analisa; o servidor confirma a gravação.');
});

test('análise separada rejeita prova de duas falas e sinaliza falha externa e cancelamento', async () => {
  const context: MemoryContext = { summary: '', profile: [], relevant: [], recent: [], version: 0, gaps: [] };
  const messages: Message[] = [{ role: 'user', content: 'tá ligado' }, { role: 'user', content: 'outro assunto' }, { role: 'user', content: 'tá ligado' }];
  for (const mode of ['invalid_evidence', 'failure', 'cancel'] as const) {
    const active = new AbortController();
    const events: any[] = [];
    let calls = 0;
    const voice = createVoiceProvider({ openaiKey: 'test', cartesiaKey: 'test', voiceId: 'test', model: 'test' }, async (_url, options) => {
      calls++;
      const body = JSON.parse(String(options?.body));
      const observer = body.text.format.name === 'language_observation';
      if (observer && mode === 'failure') return new Response('private upstream body', { status: 500 });
      if (observer && mode === 'cancel') { active.abort(); throw new Error('private upstream body'); }
      const update = { slot: 'memory.giria', category: 'expressions', categoryDescription: 'Expressões', value: 'Usa tá ligado.', evidence: 'tá ligado',
        basis: 'observed', status: 'known', supportingEvidence: ['tá ligado', 'tá ligado', 'tá ligado'] };
      return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text',
        text: JSON.stringify(observer ? { updates: [update] } : { reply: 'Vamos conversar.', summary: '', updates: [] }) }] }] });
    });
    const analyze = () => voice.observeLanguage!(messages, active.signal, context, (event) => { events.push(event); });
    if (mode === 'cancel' || mode === 'failure') await assert.rejects(analyze);
    else assert.equal((await analyze()).updates.length, 0);
    assert.equal(calls, 1);
    if (mode === 'invalid_evidence') assert.ok(events.some((event) => event.reason === 'insufficient_user_utterances'));

    assert.equal(JSON.stringify(events).includes('private upstream body'), false);
  }
});

test('cadência usa usuário real, perfil salvo e recusas; correção explícita vence observação', () => {
  const messages: Message[] = Array.from({ length: 3 }, () => ({ role: 'user', content: 'Texto real' }));
  const base: MemoryContext = { summary: '', profile: [], relevant: [], recent: [], gaps: [], version: 0 };
  assert.equal(languageAnalysisPlan([{ role: 'user', content: 'Texto' }, { role: 'assistant', content: 'Texto' }, { role: 'assistant', content: 'Texto' }], base), 'insufficient_user_utterances');
  const observation = { slot: 'memory.frases', category: 'expressions', categoryDescription: 'Forma da fala', value: 'Prefere frases curtas.', evidence: 'Texto real', basis: 'observed' as const, status: 'known' as const };
  const stored = { ...base, version: 1, profile: [observation] };
  assert.equal(languageAnalysisPlan(messages, stored), 'periodic_interval');
  assert.equal(languageAnalysisPlan(messages, { ...stored, version: 3 }), 'ready');
  assert.deepEqual(filterLanguageUpdates([observation], stored), []);
  const declined = { ...base, profile: ['expressions', 'speaking_preferences', 'reasoning_style'].map((category) => ({ ...observation,
    slot: `memory.declined_${category}`, category, value: '', status: 'declined' as const })) };
  assert.equal(languageAnalysisPlan(messages, declined), 'language_declined');
  assert.deepEqual(filterLanguageUpdates([observation], declined), []);
  const correction = { ...observation, value: 'Prefere explicações completas.', basis: 'stated' as const };
  assert.deepEqual(mergeLanguageUpdates([correction], [observation]), [correction]);
  assert.deepEqual(mergeLanguageUpdates([{ ...observation, slot: 'memory.declined_expressions', status: 'declined' }], [observation]).length, 1);
});
class Channel {
  socket: WebSocket;
  packets: (Record<string, any> | ArrayBuffer)[] = [];
  private pending: (Record<string, any> | ArrayBuffer)[] = [];
  private waiter?: (packet: Record<string, any> | ArrayBuffer) => void;
  opened: Promise<void>;
  constructor(address: string) {
    this.socket = new WebSocket(address.replace('http:', 'ws:') + '/ws');
    this.socket.binaryType = 'arraybuffer';
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const packet = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      this.packets.push(packet);
      if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(packet); }
      else this.pending.push(packet);
    });
  }
  async next(): Promise<any> {
    const packet = this.pending.shift();
    if (packet) return packet;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.waiter = undefined; reject(new Error('Sem resposta do servidor.')); }, 2000);
      this.waiter = (packet) => { clearTimeout(timeout); resolve(packet); };
    });
  }
  command(command: string) { this.socket.send(JSON.stringify({ type: 'command', command })); }
  audio() { this.socket.send(JSON.stringify({ type: 'audio-input', mime: 'audio/webm;codecs=opus', seconds: 2 })); this.socket.send(new Uint8Array([1, 2, 3])); }
  async close() { if (this.socket.readyState === WebSocket.CLOSED) return; await new Promise<void>((resolve) => { this.socket.addEventListener('close', () => resolve(), { once: true }); this.socket.close(); }); }
}
function provider(overrides: Partial<VoiceProvider> = {}): VoiceProvider {
  return { model: 'test-model', transcribe: async () => ({ text: 'Como validar minha ideia?', seconds: 2 }),
    reply: async () => ({ text: 'Qual hipótese você quer testar primeiro?', inputTokens: 100, outputTokens: 20, cachedTokens: 0 }),
    speak: async () => wav(), ...overrides };
}

test('áudio e próximo turno chegam enquanto a análise de linguagem continua em segundo plano', async (t) => {
  let stored: MemoryContext = { summary: '', profile: [], relevant: [], gaps: [], version: 2,
    recent: [{ role: 'user', content: 'Primeira fala, tá ligado?' }, { role: 'user', content: 'Segunda fala, tá ligado?' }] };
  let busy = false; let observed = 0; let saves = 0; let completed = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sources: string[] = [];
  const diagnostics: any[] = [];
  const memory: MemoryService = {
    acquire: () => { if (busy) return null; busy = true; return () => { busy = false; }; },
    inspect: async () => structuredClone(stored), load: async () => structuredClone(stored),
    vectors: async () => ({ items: [], limit: 200, truncated: false }),
    save: async (id, user, assistant, snapshot) => {
      assert.equal(snapshot.version, stored.version); sources.push(id); saves++;
      stored = { ...stored, version: stored.version + 1, recent: [...stored.recent, { role: 'user', content: user }, { role: 'assistant', content: assistant }] };
    },
    saveLanguage: async (id, snapshot) => { assert.ok(sources.includes(id));
      return { applied: 0, stale: snapshot.version !== stored.version }; },
  };
  const app = await createApp({ memory, onMemoryDiagnostic: event => diagnostics.push(event), voice: provider({
    reply: async () => ({ text: 'Uma resposta concreta.', inputTokens: 10, outputTokens: 5, cachedTokens: 0, learning: { summary: '', updates: [] } }),
    observeLanguage: async (_messages, signal) => {
      observed++; if (observed === 1) await Promise.race([gate, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]);
      completed = true;
      return { updates: [{ slot: 'memory.giria', category: 'expressions', categoryDescription: 'Expressões',
        value: 'Usa uma expressão familiar.', evidence: 'Como validar minha ideia?', status: 'known', basis: 'stated' }], inputTokens: 10, outputTokens: 5, cachedTokens: 0 };
    },
  }) });
  const address = await app.listen({ host: '127.0.0.1', port: 0 }); const channel = new Channel(address);
  t.after(async () => { release(); await channel.close(); await app.close(); });
  const until = async (predicate: (packet: any) => boolean) => { for (;;) { const packet = await channel.next(); assert.notEqual(packet.type, 'error'); if (predicate(packet)) return packet; } };
  await channel.opened; await channel.next(); channel.command('start'); await until(packet => packet.state === 'listening');
  channel.audio(); await until(packet => packet instanceof ArrayBuffer);
  assert.equal(completed, false, 'Não precisa concluir a análise para enviar áudio.');
  channel.command('playback-ended'); await until(packet => packet.state === 'listening');
  channel.audio(); await until(packet => packet instanceof ArrayBuffer);
  // The memory of the turn is written in the background, right after its voice starts.
  await until(packet => packet.type === 'audio-done'); await delay(20);
  assert.equal(saves, 2); assert.equal(observed, 1); assert.equal(completed, false);
  release();
  await until(packet => packet.type === 'usage');
  assert.ok(diagnostics.some(event => event.source === 'language' && event.stage === 'language_analysis' && event.outcome === 'completed'));
});

test('despertar fala primeiro, preserva contexto no turno real e não grava usuário fictício', async (t) => {
  const context: MemoryContext = { summary: '', profile: [], relevant: [], recent: [], version: 0, gaps: ['name'] };
  let saves = 0; let openings = 0; let answerHistory: Message[] = [];
  const memory: MemoryService = { acquire: () => () => {}, load: async () => context, inspect: async () => context,
    vectors: async () => ({ items: [], truncated: false, limit: 200 }), save: async (_id, user) => { assert.equal(user, 'Meu nome é Henrique.'); saves++; } };
  const app = await createApp({ memory, voice: provider({
    opening: async () => { openings++; return { text: 'Qual é meu nome?', inputTokens: 0, outputTokens: 0, cachedTokens: 0 }; },
    transcribe: async () => ({ text: 'Meu nome é Henrique.', seconds: 2 }),
    reply: async (messages) => { answerHistory = messages; return { text: 'Henrique. Quem faz parte da minha família?', inputTokens: 50, outputTokens: 20, cachedTokens: 0,
      learning: { summary: 'Nome informado.', updates: [] } }; },
  }) });
  const address = await app.listen({ host: '127.0.0.1', port: 0 }); const channel = new Channel(address);
  t.after(async () => { await channel.close(); await app.close(); });
  const until = async (match: (event: any) => boolean) => { for (;;) { const event = await channel.next(); if (!(event instanceof ArrayBuffer) && match(event)) return event; } };
  await channel.opened; await channel.next(); channel.command('start');
  assert.equal((await channel.next()).state, 'thinking');
  assert.equal((await until((event) => event.state === 'speaking')).text, 'Qual é meu nome?');
  assert.equal((await until((event) => event.type === 'usage')).usage.turns, 0, 'A abertura conta TTS, sem simular um turno do usuário.');
  await until((event) => event.type === 'audio-done');
  assert.equal(saves, 0);
  channel.command('playback-ended'); assert.equal((await until((event) => event.type === 'state')).text, 'Qual é meu nome?');
  channel.audio(); await until((event) => event.type === 'audio-done'); await delay(20);
  assert.deepEqual(answerHistory, [{ role: 'assistant', content: 'Qual é meu nome?' }, { role: 'user', content: 'Meu nome é Henrique.' }]);
  assert.equal(saves, 1);
  channel.command('reset'); assert.equal((await channel.next()).state, 'idle');
  channel.command('start'); assert.equal((await channel.next()).state, 'listening'); assert.equal(openings, 1);
});

test('repouso durante abertura descarta a fala atrasada e permite novo despertar', async (t) => {
  let resolveOpening!: (answer: { text: string; inputTokens: number; outputTokens: number; cachedTokens: number }) => void;
  let active!: AbortSignal; let synthesized = false;
  const app = await createApp({ voice: provider({
    opening: async (_context, signal) => { active = signal; return new Promise((resolve) => { resolveOpening = resolve; }); },
    speak: async () => { synthesized = true; return wav(); },
  }) });
  const address = await app.listen({ host: '127.0.0.1', port: 0 }); const channel = new Channel(address);
  t.after(async () => { await channel.close(); await app.close(); });
  await channel.opened; await channel.next(); channel.command('start'); await channel.next();
  channel.command('reset'); assert.equal((await channel.next()).state, 'idle'); assert.equal(active.aborted, true);
  resolveOpening({ text: 'Abertura atrasada.', inputTokens: 0, outputTokens: 0, cachedTokens: 0 }); await delay(20);
  assert.equal(synthesized, false);
  assert.equal(channel.packets.some((packet) => packet instanceof ArrayBuffer), false);
  channel.command('start'); assert.equal((await channel.next()).state, 'thinking');
  channel.command('reset'); await channel.next();
  resolveOpening({ text: 'Outra abertura atrasada.', inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
});

test('abertura vazia não chama LLM e retorno mantém dados pessoais fora das instruções', async () => {
  let body: Record<string, any> | undefined;
  const voice = createVoiceProvider({ openaiKey: 'test', cartesiaKey: 'test', voiceId: 'test', model: 'test' }, async (_url, options) => {
    body = JSON.parse(String(options?.body));
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Podemos continuar nossa conversa.' }] }], usage: {} });
  });
  const signal = new AbortController().signal;
  const empty: MemoryContext = { summary: '', profile: [], relevant: [], recent: [], gaps: ['name'], version: 3 };
  const first = (await voice.opening!(empty, signal)).text;
  assert.match(first, /qual é meu nome\?$/i); assert.match(first, /direto ao que te trouxe/); assert.equal(body, undefined);
  const known = { ...empty, summary: 'Canary pessoal: pretend-code-override', recent: [{ role: 'user' as const, content: 'Meu nome é Henrique.' }] };
  assert.equal((await voice.opening!(known, signal)).text, 'Podemos continuar nossa conversa.');
  assert.equal(body!.instructions.includes('Canary pessoal'), false);
  assert.equal(JSON.stringify(body!.input).includes('Canary pessoal'), true);
  assert.equal(body!.store, false); assert.equal(body!.text, undefined, 'Retorno não extrai nem grava memórias de uma fala sintética.');
  body = undefined;
  await voice.opening!({ ...empty, profile: [{ slot: 'memory.nome', category: 'identity', value: '', evidence: 'Não quero dizer meu nome.', basis: 'stated', status: 'declined' }] }, signal);
  assert.ok(body, 'Uma recusa não deve ser tratada como perfil vazio e receber a abertura fixa.');
});

test('memória atravessa reconexão e é confirmada antes de enviar áudio', async (t) => {
  const diagnostics: MemoryDiagnosticRecord[] = [];
  const turnIds: string[] = [];
  let stored: MemoryContext = { summary: 'Quero preservar renda.', profile: [], relevant: [], version: 1, gaps: ['goals'],
    recent: [{ role: 'user', content: 'Tenho pouco tempo.' }, { role: 'assistant', content: 'Vamos começar pequeno.' }] };
  const calls: string[] = [];
  const histories: Message[][] = [];
  let locked = false;
  const memory: MemoryService = {
    acquire: () => { if (locked) return null; locked = true; return () => { locked = false; }; },
    load: async () => { calls.push('load'); return structuredClone(stored); },
    inspect: async () => structuredClone(stored),
    vectors: async () => ({ items: [], truncated: false, limit: 200 }),
    save: async (id, user, assistant, context, learning, _signal, diagnostic) => {
      turnIds.push(id);
      calls.push('save'); assert.equal(context.version, stored.version);
      stored = { ...stored, version: stored.version + 1, summary: learning.summary,
        recent: [...stored.recent, { role: 'user', content: user }, { role: 'assistant', content: assistant }] };
      diagnostic?.({ stage: 'commit', outcome: 'completed', count: 0 });
    },
  };
  const app = await createApp({ memory, voice: provider({
    reply: async (messages, _signal, context, diagnostic) => {
      calls.push('reply'); assert.equal(context?.summary, 'Quero preservar renda.'); histories.push(messages);
      return { text: 'Vamos preservar a renda enquanto validamos.', inputTokens: 50, outputTokens: 30, cachedTokens: 0,
        learning: validateLearning({ summary: 'Quero preservar renda.', updates: [] }, messages.at(-1)!.content, messages.slice(0, -1), diagnostic) };
    },
    speak: async () => { calls.push('tts'); return wav(); },
  }), onMemoryDiagnostic: (record) => { diagnostics.push(record); } });
  const address = await app.listen({ host: '127.0.0.1', port: 0 }); const channels: Channel[] = [];
  const observer = new WebSocket(address.replace('http:', 'ws:') + '/ws/memories');
  const notifications: string[] = [];
  observer.addEventListener('message', (event) => notifications.push(String(event.data)));
  await new Promise<void>((resolve) => observer.addEventListener('open', () => resolve(), { once: true }));
  t.after(() => observer.close());
  t.after(async () => { for (const channel of channels) await channel.close(); await app.close(); });
  for (let turn = 0; turn < 2; turn++) {
    const channel = new Channel(address); channels.push(channel);
    await channel.opened; await channel.next(); channel.command('start'); await channel.next(); channel.audio();
    // The memory is written in the background while the reply plays.
    for (;;) { const packet = await channel.next(); if (!(packet instanceof ArrayBuffer) && packet.type === 'audio-done') break; }
    await delay(20);
    assert.equal(calls.at(-1), 'save'); assert.equal(locked, false);
    await channel.close();
  }
  assert.equal(histories[0].length, 3); assert.equal(histories[1].length, 5);
  assert.deepEqual(calls, ['load', 'reply', 'tts', 'save', 'load', 'reply', 'tts', 'save']);
  assert.equal(new Set(turnIds).size, 2);
  assert.deepEqual([...new Set(diagnostics.map((event) => event.turnId))], turnIds);
  for (const id of turnIds) {
    assert.deepEqual(diagnostics.filter((event) => event.turnId === id).map(({ stage, outcome }) => [stage, outcome]),
      [['turn', 'started'], ['proposal', 'completed'], ['validation', 'completed'], ['commit', 'completed'], ['turn', 'completed']]);
  }
  assert.equal(JSON.stringify(diagnostics).includes('preservar renda'), false);
  await delay(20);
  assert.deepEqual(notifications, Array(3).fill('{"type":"memory-sync"}'), 'A conexão inicia sincronizando e cada commit confirmado avisa o mapa.');
  const vectors = await app.inject('/api/memory/vectors');
  assert.equal(vectors.json().enabled, true); assert.deepEqual(vectors.json().items, []);
  assert.equal(vectors.headers['cache-control'], 'no-store');
  for (const url of ['/api/memory/vectors', '/ws/memories']) {
    assert.equal((await app.inject({ method: 'GET', url, headers: { origin: 'https://untrusted.example' } })).statusCode, 403);
  }
  const snapshot = await app.inject('/api/memory'); assert.equal(snapshot.json().version, 3);
  const denied = await app.inject({ method: 'GET', url: '/api/memory', headers: { origin: 'https://untrusted.example' } });
  assert.equal(denied.statusCode, 403);
});

test('falha de gravação da memória não segura a fala, avisa o erro e libera a memória', async (t) => {
  let released = false;
  const context: MemoryContext = { summary: '', profile: [], relevant: [], recent: [], version: 0, gaps: [] };
  const memory: MemoryService = { acquire: () => () => { released = true; }, load: async () => context, inspect: async () => context,
    vectors: async () => ({ items: [], truncated: false, limit: 200 }),
    save: async () => { throw new Error('Memória: não foi possível acessar o serviço.'); } };
  const app = await createApp({ memory, voice: provider({ reply: async () => ({ text: 'Vamos pensar.', inputTokens: 10, outputTokens: 20, cachedTokens: 0,
    learning: { summary: '', updates: [] } }) }) });
  const address = await app.listen({ host: '127.0.0.1', port: 0 }); const channel = new Channel(address);
  const observer = new WebSocket(address.replace('http:', 'ws:') + '/ws/memories');
  const notifications: string[] = [];
  observer.addEventListener('message', (event) => notifications.push(String(event.data)));
  await new Promise<void>((resolve) => observer.addEventListener('open', () => resolve(), { once: true }));
  t.after(() => observer.close());
  t.after(async () => { await channel.close(); await app.close(); });
  await channel.opened; await channel.next(); channel.command('start'); await channel.next(); channel.audio();
  // The memory is written while the clone already speaks; its failure is reported, never a new state.
  let error: any;
  for (;;) { const event = await channel.next(); if (!(event instanceof ArrayBuffer) && event.type === 'error') { error = event; break; } }
  assert.match(error.message, /^Memória:/);
  assert.equal(released, true);
  await delay(20);
  assert.deepEqual(notifications, ['{"type":"memory-sync"}'], 'Uma gravação recusada não avisa que houve atualização.');
  assert.equal(channel.packets.some((packet) => !(packet instanceof ArrayBuffer) && packet.type === 'audio-output'), true);
});

test('voz percorre as três etapas, transmite WAV e espera a reprodução terminar', async (t) => {
  const histories: Message[][] = [];
  const calls: string[] = [];
  const records: Record<string, string | number>[] = [];
  const app = await createApp({ voice: provider({
    transcribe: async () => { calls.push('stt'); return { text: 'Como validar minha ideia?', seconds: 2 }; },
    reply: async (messages) => { calls.push('llm'); histories.push(messages); return { text: 'Qual hipótese você quer testar primeiro?', inputTokens: 100, outputTokens: 20, cachedTokens: 4 }; },
    speak: async () => { calls.push('tts'); return wav(); },
  }), onUsage: (record) => records.push(record) });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const channel = new Channel(address);
  t.after(async () => { await channel.close(); await app.close(); });
  await channel.opened; await channel.next(); channel.command('start'); await channel.next(); channel.audio();
  assert.equal((await channel.next()).state, 'thinking');
  assert.equal((await channel.next()).usage.sttSeconds, 2);
  assert.equal((await channel.next()).type, 'transcript');
  assert.equal((await channel.next()).usage.inputTokens, 100);
  // The voice streams: speaking starts with the first piece of raw audio; usage and mouth cues follow.
  assert.equal((await channel.next()).state, 'speaking');
  assert.equal((await channel.next()).type, 'audio-output');
  assert.deepEqual(Buffer.from(await channel.next()), wav().subarray(44));
  assert.equal((await channel.next()).usage.turns, 1);
  assert.equal((await channel.next()).type, 'audio-done');
  channel.audio(); assert.equal((await channel.next()).type, 'error'); assert.equal((await channel.next()).type, 'error');
  assert.deepEqual(calls, ['stt', 'llm', 'tts']);
  channel.command('playback-ended'); assert.equal((await channel.next()).state, 'listening');
  channel.audio();
  for (;;) { const packet = await channel.next(); if (!(packet instanceof ArrayBuffer) && packet.type === 'audio-done') break; }
  assert.equal(histories[1].length, 3, 'O segundo turno inclui a pergunta e a resposta anteriores.');
  assert.equal(records.length, 6);
  assert.equal(records.some((entry) => 'text' in entry || 'audio' in entry), false);
  const health = await app.inject('/api/health'); assert.equal(health.json().mode, 'voice');
});

test('repouso aborta a chamada e impede áudio e resposta de reaparecerem', async (t) => {
  let release!: (value: { text: string; seconds: number }) => void;
  let signal!: AbortSignal;
  let generated = false;
  const app = await createApp({ voice: provider({ transcribe: async (_audio, _mime, active) => { signal = active; return new Promise((resolve) => { release = resolve; }); },
    reply: async () => { generated = true; throw new Error('Não deveria executar.'); } }) });
  const address = await app.listen({ host: '127.0.0.1', port: 0 }); const channel = new Channel(address);
  t.after(async () => { await channel.close(); await app.close(); });
  await channel.opened; await channel.next(); channel.command('start'); await channel.next(); channel.audio(); await channel.next();
  channel.command('reset'); assert.equal((await channel.next()).state, 'idle'); assert.equal(signal.aborted, true);
  release({ text: 'Resposta atrasada.', seconds: 2 }); await delay(30);
  assert.equal(generated, false);
  assert.equal(channel.packets.some((packet) => !(packet instanceof ArrayBuffer) && (packet.type === 'audio-output' || packet.state === 'speaking')), false);
});

test('falha de IA preserva consumo parcial, libera o turno e não chama TTS', async (t) => {
  let synthesized = false;
  const app = await createApp({ voice: provider({ reply: async () => { throw new Error('OpenAI: Confira créditos e limites da conta antes de tentar novamente.'); },
    speak: async () => { synthesized = true; return wav(); } }) });
  const address = await app.listen({ host: '127.0.0.1', port: 0 }); const channel = new Channel(address);
  t.after(async () => { await channel.close(); await app.close(); });
  await channel.opened; await channel.next(); channel.command('start'); await channel.next();
  channel.socket.send(new Uint8Array([1])); assert.equal((await channel.next()).type, 'error');
  channel.audio(); assert.equal((await channel.next()).state, 'thinking'); assert.equal((await channel.next()).usage.sttSeconds, 2);
  await channel.next(); assert.equal((await channel.next()).type, 'error'); assert.equal((await channel.next()).state, 'listening');
  assert.equal(synthesized, false);
});

test('contratos HTTP usam áudio multipart, texto de saída correto e chave só no servidor', async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    calls.push({ url: String(url), options: options! });
    if (String(url).endsWith('/audio/transcriptions')) return Response.json({ text: 'Quero refletir.', usage: { type: 'duration', seconds: 2 } });
    if (String(url).endsWith('/responses')) return Response.json({ status: 'completed', output: [
      { type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'O que motiva essa escolha?' }] },
    ], usage: { input_tokens: 150, output_tokens: 30, input_tokens_details: { cached_tokens: 50 } } });
    return new Response(new Uint8Array(wav()), { headers: { 'Content-Type': 'audio/wav' } });
  };
  const voice = createVoiceProvider({ openaiKey: 'test-openai-key', cartesiaKey: 'test-cartesia-key', voiceId: 'test-voice', model: 'gpt-6-luna' }, fetcher);
  const active = new AbortController();
  assert.equal((await voice.transcribe(Buffer.from([1, 2]), 'audio/webm', active.signal)).text, 'Quero refletir.');
  const answer = await voice.reply([{ role: 'user', content: 'Quero refletir.' }], active.signal);
  assert.equal(answer.text, 'O que motiva essa escolha?'); assert.equal(answer.cachedTokens, 50);
  assert.deepEqual(await voice.speak(answer.text, active.signal), wav());
  const multipart = calls[0].options.body as FormData;
  assert.equal(multipart.get('language'), null); assert.deepEqual(multipart.getAll('languages[]'), ['pt', 'en']);
  assert.equal(multipart.get('model'), 'gpt-transcribe'); assert.ok(multipart.get('file') instanceof Blob);
  assert.deepEqual(multipart.getAll('keywords[]'), ['véi', 'velho', 'pô', 'tá ligado']);
  assert.match(String(multipart.get('prompt')), /sem formalizar/);
  assert.equal((calls[0].options.headers as any).Authorization, 'Bearer test-openai-key');
  assert.equal(calls.filter(call => call.url.includes('cartesia')).length, 1, 'Cartesia só recebe a síntese de voz.');
  const responseBody = JSON.parse(calls[1].options.body as string); assert.equal(responseBody.store, false); assert.equal(responseBody.model, 'gpt-6-luna');
  const voiceBody = JSON.parse(calls[2].options.body as string); assert.equal(voiceBody.voice, 'test-voice'); assert.equal(voiceBody.output_format.container, 'wav'); assert.equal(voiceBody.language, 'pt-BR');
  assert.match(responseBody.input[0].content, /replyLanguage: português/);
  await voice.reply([{ role: 'user', content: 'What do you think?' }], active.signal, undefined, undefined, 'en');
  assert.match(JSON.parse(calls[3].options.body as string).input[0].content, /replyLanguage: inglês/);
  await voice.speak('Sure.', active.signal, 'en');
  assert.equal(JSON.parse(calls[4].options.body as string).language, 'en');
});

test('transcrição preserva formas coloquiais e envia os formatos do gravador à OpenAI', async () => {
  for (const mime of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    const bytes = Buffer.from([1, 2, 3]);
    const voice = createVoiceProvider({ openaiKey: 'test', cartesiaKey: 'test', voiceId: 'test', model: 'test' }, async (url, options) => {
      assert.equal(String(url), 'https://api.openai.com/v1/audio/transcriptions');
      const file = (options!.body as FormData).get('file') as File;
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
      assert.match(file.name, mime.includes('mp4') ? /\.mp4$/ : mime.includes('ogg') ? /\.ogg$/ : /\.webm$/);
      return Response.json({ text: '  Véi, esse rádio é velho.  ' });
    });
    assert.deepEqual(await voice.transcribe(bytes, mime, AbortSignal.timeout(2000)), { text: 'Véi, esse rádio é velho.', seconds: 0 });
  }
});

test('transcrição sem duração usa o tempo da gravação e o painel removido não chama serviços', async t => {
  const records: Record<string, string | number>[] = [];
  const app = await createApp({ voice: provider({ transcribe: async () => ({ text: 'Véi, vamos pensar.', seconds: 0 }) }), onUsage: record => records.push(record) });
  const address = await app.listen({ host: '127.0.0.1', port: 0 }); const channel = new Channel(address);
  t.after(async () => { await channel.close(); await app.close(); });
  const removed = await app.inject({ method: 'POST', url: '/api/transcription/compare' });
  assert.equal(removed.statusCode, 404); assert.equal(records.length, 0);
  await channel.opened; await channel.next(); channel.command('start'); await channel.next(); channel.audio();
  assert.equal((await channel.next()).state, 'thinking');
  assert.equal((await channel.next()).usage.sttSeconds, 2);
  assert.equal((await channel.next()).text, 'Véi, vamos pensar.');
  assert.equal(records[0].model, 'gpt-transcribe'); assert.equal(records[0].secondsSource, 'recording');
});

test('erro na transcrição OpenAI orienta sobre saldo sem chamar resposta ou voz', async t => {
  let downstream = 0;
  const app = await createApp({ voice: provider({
    transcribe: async () => { throw new Error('Transcrição OpenAI: Confira créditos e limites da conta antes de tentar novamente.'); },
    reply: async () => { downstream++; throw new Error('Should not reply'); },
    speak: async () => { downstream++; return wav(); },
  }) });
  const address = await app.listen({ host: '127.0.0.1', port: 0 }); const channel = new Channel(address);
  t.after(async () => { await channel.close(); await app.close(); });
  await channel.opened; await channel.next(); channel.command('start'); await channel.next(); channel.audio();
  await channel.next(); assert.match((await channel.next()).message, /Transcrição OpenAI: Confira créditos/);
  assert.equal((await channel.next()).state, 'listening'); assert.equal(downstream, 0);
});

test('chaves ausentes mantêm demonstração e dados de gravação inválidos são rejeitados', async () => {
  assert.equal(readVoiceConfig({}), null);
  assert.equal(readVoiceConfig({ OPENAI_API_KEY: 'test' }), null);
  for (const input of [{ type: 'audio-input', mime: 'text/html', seconds: 1 }, { type: 'audio-input', mime: 'audio/webm', seconds: 90 }, { type: 'audio-input', mime: 'audio/webm', seconds: -1 }]) assert.equal(parseAudioInput(JSON.stringify(input)), null);
  const voice = createVoiceProvider({ openaiKey: 'test', cartesiaKey: 'test', voiceId: 'test', model: 'test' }, async () => new Response('private upstream detail', { status: 429 }));
  await assert.rejects(() => voice.reply([], new AbortController().signal), /Confira créditos/);
});

test('marcas de gesto viram sinais de animação e não chegam à voz nem à tela', async (t) => {
  let spokenText = '';
  const app = await createApp({ voice: provider({
    reply: async () => ({ text: '[inclina] Depende do prazo, [concorda] mas faz sentido.', inputTokens: 10, outputTokens: 5, cachedTokens: 0 }),
    speak: async (text) => { spokenText = text; return wav(); },
  }) });
  const address = await app.listen({ host: '127.0.0.1', port: 0 }); const channel = new Channel(address);
  t.after(async () => { await channel.close(); await app.close(); });
  const until = async (predicate: (packet: any) => boolean) => { for (;;) { const packet = await channel.next(); assert.notEqual(packet.type, 'error'); if (predicate(packet)) return packet; } };
  await channel.opened; await channel.next(); channel.command('start'); await until(packet => packet.state === 'listening');
  channel.audio();
  const speaking = await until(packet => packet.state === 'speaking');
  const output = await until(packet => packet.type === 'audio-output');
  assert.equal(spokenText, 'Depende do prazo, mas faz sentido.');
  assert.equal(speaking.text, spokenText);
  assert.deepEqual(output.gestures.map((cue: { gesture: string }) => cue.gesture), ['tilt', 'nod']);
  assert.equal(spokenText.slice(Math.round(output.gestures[1].at * spokenText.length)), 'mas faz sentido.');
});

test('instruções orientam o papel e a descoberta guiada sem dados pessoais', async () => {
  const { characterInstructions, openingInstructions } = await import('./character.ts');
  assert.match(characterInstructions, /PAPEL\. O fato da categoria assistant_role/);
  assert.match(characterInstructions, /Cobrar: retome compromissos/);
  assert.match(characterInstructions, /DESCOBERTA GUIADA\. .*uma pergunta por fala/);
  assert.match(characterInstructions, /Nunca abra saúde, fé, dinheiro pessoal, família ou experiências difíceis/);
  assert.match(openingInstructions(), /papel conhecido \(assistant_role\)/);
});

test('o personagem é conciso sem teto fixo de palavras', async () => {
  const { characterInstructions } = await import('./character.ts');
  assert.match(characterInstructions, /CONCISÃO: diga o essencial primeiro/);
  assert.equal(characterInstructions.includes('220 palavras'), false);
});

test('resposta sai frase por frase, só gera a próxima quando a anterior toca e para na interrupção', async (t) => {
  const voiced: string[] = [], histories: Message[][] = [];
  const reply = 'Pô, entendi o que você sente agora. Eu começaria vendo o que te puxa pra fora do emprego, com calma. Depois a gente compara as opções com números. O que pesa mais?';
  const app = await createApp({ voice: provider({
    reply: async (messages) => { histories.push(messages); return { text: reply, inputTokens: 1, outputTokens: 1, cachedTokens: 0 }; },
    speakTimed: async (text) => { voiced.push(text); return { audio: wav(), phonemes: [] }; },
  }) });
  const address = await app.listen({ host: '127.0.0.1', port: 0 }); const channel = new Channel(address);
  t.after(async () => { await channel.close(); await app.close(); });
  const until = async (match: (event: any) => boolean) => { for (;;) { const event = await channel.next(); if (match(event)) return event; } };
  await channel.opened; await channel.next(); channel.command('start'); await channel.next(); channel.audio();
  assert.equal((await until((event) => event.type === 'state' && event.state === 'speaking')).text, reply);
  const first = await until((event) => event.type === 'audio-output');
  assert.deepEqual([first.segment, first.last, first.from], [0, false, 0]);
  await channel.next(); await delay(30);
  assert.equal(voiced.length, 1, 'Só a primeira frase é gerada antes de tocar.');
  channel.socket.send(JSON.stringify({ type: 'playing', segment: 0 }));
  const second = await until((event) => event.type === 'audio-output');
  assert.equal(second.segment, 1); assert.equal(voiced.length, 2);
  await channel.next();
  // The user cuts in a few words into the second segment: nothing else is voiced, and the history keeps only what was heard.
  channel.socket.send(JSON.stringify({ type: 'interrupt', heard: second.from + 12 }));
  assert.equal((await until((event) => event.type === 'state')).state, 'listening');
  channel.socket.send(JSON.stringify({ type: 'playing', segment: 1 })); await delay(30);
  assert.equal(voiced.length, 2, 'Nada é gerado depois da interrupção.');
  channel.audio(); await until((event) => event.type === 'state' && event.state === 'speaking');
  const said = histories[1].find((message) => message.role === 'assistant')!.content;
  assert.ok(said.endsWith('…') && said.startsWith('Pô, entendi') && !said.includes('números'), said);
});

test('o anúncio da gravação aceita o tipo com detalhes do codec que os celulares enviam', () => {
  assert.equal(parseAudioInput(JSON.stringify({ type: 'audio-input', mime: 'audio/mp4;codecs=mp4a.40.2', seconds: 3 }))?.mime, 'audio/mp4');
  assert.equal(parseAudioInput(JSON.stringify({ type: 'audio-input', mime: 'audio/webm;codecs=opus', seconds: 3 }))?.mime, 'audio/webm;codecs=opus');
  assert.equal(parseAudioInput(JSON.stringify({ type: 'audio-input', mime: 'video/mp4', seconds: 3 })), null);
});

test('uma despedida com [dormir] faz o clone adormecer depois de ser ouvida', async (t) => {
  const app = await createApp({ voice: provider({
    reply: async () => ({ text: 'Até amanhã, Enrique. [dormir]', inputTokens: 1, outputTokens: 1, cachedTokens: 0 }),
    speakTimed: async (text) => { assert.doesNotMatch(text, /dormir/); return { audio: wav(), phonemes: [] }; },
  }) });
  const address = await app.listen({ host: '127.0.0.1', port: 0 }); const channel = new Channel(address);
  t.after(async () => { await channel.close(); await app.close(); });
  const until = async (match: (event: any) => boolean) => { for (;;) { const event = await channel.next(); if (match(event)) return event; } };
  await channel.opened; await channel.next(); channel.command('start'); await channel.next(); channel.audio();
  await until((event) => event.type === 'audio-output'); await channel.next();
  channel.command('playback-ended');
  assert.equal((await until((event) => event.type === 'state')).state, 'idle');
});

test('a fala começa com a primeira frase enquanto a IA ainda escreve o resto', async (t) => {
  let finish!: () => void; const voiced: string[] = [];
  const app = await createApp({ voice: provider({
    reply: async (_messages, _signal, _context, _diagnostic, _language, onReply) => {
      onReply?.('Boa pergunta, vamos por partes. Pri', false);
      await new Promise<void>((resolve) => { finish = resolve; });
      return { text: 'Boa pergunta, vamos por partes. Primeiro o objetivo. Depois o prazo.', inputTokens: 1, outputTokens: 1, cachedTokens: 0 };
    },
    speakTimed: async (text) => { voiced.push(text); return { audio: wav(), phonemes: [] }; },
  }) });
  const address = await app.listen({ host: '127.0.0.1', port: 0 }); const channel = new Channel(address);
  t.after(async () => { await channel.close(); await app.close(); });
  const until = async (match: (event: any) => boolean) => { for (;;) { const event = await channel.next(); if (match(event)) return event; } };
  await channel.opened; await channel.next(); channel.command('listen'); assert.equal((await channel.next()).state, 'listening'); channel.audio();
  const speaking = await until((event) => event.type === 'state' && event.state === 'speaking');
  assert.equal(speaking.text, 'Boa pergunta, vamos por partes.', 'Fala antes de a IA terminar.');
  assert.equal((await until((event) => event.type === 'audio-output')).last, false);
  finish();
  assert.equal((await until((event) => event.type === 'state')).text, 'Boa pergunta, vamos por partes. Primeiro o objetivo. Depois o prazo.');
  channel.socket.send(JSON.stringify({ type: 'playing', segment: 0 }));
  const second = await until((event) => event.type === 'audio-output');
  assert.deepEqual([second.segment, second.last], [1, true]);
  assert.deepEqual(voiced, ['Boa pergunta, vamos por partes.', 'Primeiro o objetivo. Depois o prazo.']);
});

test('fala que termina no meio espera a continuação e responde às duas partes juntas', async (t) => {
  const heard = ['Eu tô pensando em mudar de emprego e', 'quero saber se é a hora certa.'];
  const asked: string[] = [];
  const app = await createApp({ voice: provider({
    transcribe: async () => ({ text: heard.shift()!, seconds: 2 }),
    reply: async (messages) => { asked.push(messages.at(-1)!.content); return { text: 'Vamos ver isso juntos.', inputTokens: 1, outputTokens: 1, cachedTokens: 0 }; },
  }) });
  const address = await app.listen({ host: '127.0.0.1', port: 0 }); const channel = new Channel(address);
  t.after(async () => { await channel.close(); await app.close(); });
  const until = async (match: (event: any) => boolean) => { for (;;) { const event = await channel.next(); if (!(event instanceof ArrayBuffer) && match(event)) return event; } };
  await channel.opened; await channel.next(); channel.command('listen'); await until((event) => event.state === 'listening');
  channel.audio(); await until((event) => event.state === 'thinking');
  // Unfinished: back to listening without an answer; the user keeps talking and the rest arrives.
  await until((event) => event.state === 'listening'); assert.deepEqual(asked, []);
  channel.socket.send(JSON.stringify({ type: 'user-speaking' })); await delay(1800);
  assert.deepEqual(asked, [], 'Waits while the user is talking.');
  channel.audio(); await until((event) => event.state === 'speaking');
  assert.deepEqual(asked, ['Eu tô pensando em mudar de emprego e quero saber se é a hora certa.']);
});

test('sem continuação, a fala incompleta é respondida depois da espera', async (t) => {
  const asked: string[] = [];
  const app = await createApp({ voice: provider({
    transcribe: async () => ({ text: 'Eu queria falar sobre o meu trabalho e', seconds: 2 }),
    reply: async (messages) => { asked.push(messages.at(-1)!.content); return { text: 'Pode falar.', inputTokens: 1, outputTokens: 1, cachedTokens: 0 }; },
  }) });
  const address = await app.listen({ host: '127.0.0.1', port: 0 }); const channel = new Channel(address);
  t.after(async () => { await channel.close(); await app.close(); });
  const until = async (match: (event: any) => boolean) => { for (;;) { const event = await channel.next(); if (!(event instanceof ArrayBuffer) && match(event)) return event; } };
  await channel.opened; await channel.next(); channel.command('listen'); await until((event) => event.state === 'listening');
  channel.audio(); await until((event) => event.state === 'thinking'); await until((event) => event.state === 'listening');
  await until((event) => event.state === 'speaking');
  assert.deepEqual(asked, ['Eu queria falar sobre o meu trabalho e']);
});

test('cortar o clone na primeira frase faz a nova fala continuar a anterior, sem o turno precipitado', async (t) => {
  const heard = ['Eu tô pensando em mudar de emprego.', 'Mas só depois do fim do ano.'];
  const histories: Message[][] = [];
  const app = await createApp({ voice: provider({
    transcribe: async () => ({ text: heard.shift()!, seconds: 2 }),
    reply: async (messages) => { histories.push(messages); return { text: 'Entendi o que você quer fazer agora. Vamos pensar com calma no prazo e no dinheiro.', inputTokens: 1, outputTokens: 1, cachedTokens: 0 }; },
  }) });
  const address = await app.listen({ host: '127.0.0.1', port: 0 }); const channel = new Channel(address);
  t.after(async () => { await channel.close(); await app.close(); });
  const until = async (match: (event: any) => boolean) => { for (;;) { const event = await channel.next(); if (!(event instanceof ArrayBuffer) && match(event)) return event; } };
  await channel.opened; await channel.next(); channel.command('listen'); await until((event) => event.state === 'listening');
  channel.audio(); await until((event) => event.type === 'audio-output');
  // Cut a few words into the first sentence.
  channel.socket.send(JSON.stringify({ type: 'interrupt', heard: 8 }));
  await until((event) => event.state === 'listening');
  channel.audio(); await until((event) => event.state === 'speaking');
  const second = histories[1];
  assert.equal(second.at(-1)!.content, 'Eu tô pensando em mudar de emprego. Mas só depois do fim do ano.');
  assert.equal(second.some((message) => message.role === 'assistant'), false, 'The early answer is dropped.');
});

test('sem voz clonada, cada idioma usa a sua voz padrão; com clone, o clone', async () => {
  const voices: string[] = [];
  const fetcher: typeof fetch = async (_url, options) => { voices.push(JSON.parse(String(options!.body)).voice); return new Response(new Uint8Array(wav()), { headers: { 'Content-Type': 'audio/wav' } }); };
  let clone: string | undefined;
  const voice = createVoiceProvider({ openaiKey: 'o', cartesiaKey: 'c', voiceId: 'padrao-pt', englishVoiceId: 'padrao-en', model: 'm', currentVoice: () => clone }, fetcher);
  await voice.speak('Oi.', AbortSignal.timeout(2000), 'pt'); await voice.speak('Hi.', AbortSignal.timeout(2000), 'en');
  clone = 'minha-voz'; await voice.speak('Hi.', AbortSignal.timeout(2000), 'en');
  assert.deepEqual(voices, ['padrao-pt', 'padrao-en', 'minha-voz']);
  assert.equal(readVoiceConfig({ OPENAI_API_KEY: 'o', CARTESIA_API_KEY: 'c', CARTESIA_VOICE_ID: 'pt', CARTESIA_VOICE_ID_EN: 'en' })?.englishVoiceId, 'en');
});
