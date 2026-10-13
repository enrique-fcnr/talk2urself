import test from 'node:test';
import assert from 'node:assert/strict';
import { createLanguageWorker } from './language-worker.ts';
import { createMemoryService, validateLearning, type MemoryContext, type MemoryService, type MemoryUpdate } from './memory.ts';
import type { VoiceProvider } from './voice.ts';
import { languageAnalysisInput, bindLanguageEvidence, languagePhraseSample, groundCandidateEvidence } from './language.ts';
import { createVoiceProvider } from './voice.ts';

test('provas persistidas fora das seis falas recentes são validadas por origem sem contar duas vezes a mesma fala', async () => {
  const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
  const sources=ids.map((turnId,index)=>({turnId,text:`Pô, minha frase ${index}, tá ligado?`}));
  const candidateId='44444444-4444-4444-8444-444444444444';
  const snapshot=context(13); snapshot.language={sources:[{turnId:'55555555-5555-4555-8555-555555555555',text:'Um assunto diferente.'},sources[2]],
    candidates:[{id:candidateId,expression:'tá ligado',sources}],atLimit:false};
  const messages=snapshot.language.sources.map(source=>({role:'user' as const,content:source.text}));
  const input=languageAnalysisInput(messages,snapshot);
  const hint=input.recurringCandidates.find(item=>item.phrase==='tá ligado'); assert.ok(hint); assert.equal(hint.samples.length,3);
  assert.deepEqual(bindLanguageEvidence(sources.map(source=>source.text),snapshot)?.map(source=>source.turnId),ids);
  const repeated={...snapshot,language:{...snapshot.language,candidates:[{id:candidateId,expression:'tá ligado',sources:[sources[2],sources[2],sources[2]]}]}};
  assert.equal(bindLanguageEvidence([sources[2].text,sources[2].text,sources[2].text],repeated),null);
  const voice=createVoiceProvider({openaiKey:'test',cartesiaKey:'test',voiceId:'test',model:'test'},async(_url,init)=>{
    const body=JSON.parse(String(init?.body)); const sent=JSON.parse(body.input[0].content);
    assert.equal(sent.utterances.length,2); assert.equal(sent.recurringCandidates[0].id,candidateId);
    return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({updates:[{
      ...update,evidence:sources[2].text,supportingEvidence:sources.map(source=>source.text),candidateIds:[candidateId]}],rejectedCandidates:[]})}]}]});
  });
  const learned=await voice.observeLanguage!(messages,AbortSignal.timeout(2000),snapshot);
  assert.equal(learned.updates.length,1); assert.deepEqual(learned.updates[0].languageEvidence?.map(source=>source.turnId),ids);
  assert.deepEqual(learned.updates[0].candidateIds,[candidateId]);
  const unrelated=sources.map(source=>({...source,text:'Um trecho sem a expressão. '+source.text}));
  snapshot.language.candidates[0].sources=unrelated;
  const misleading=createVoiceProvider({openaiKey:'test',cartesiaKey:'test',voiceId:'test',model:'test'},async()=>Response.json({status:'completed',
    output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({updates:[{...update,value:'Usa outra expressão para concordar.',evidence:sources[2].text,
      supportingEvidence:['Um trecho sem a expressão.','Um trecho sem a expressão.',sources[2].text],candidateIds:[candidateId]}],rejectedCandidates:[]})}]}]}));
  assert.equal((await misleading.observeLanguage!(messages,AbortSignal.timeout(2000),snapshot)).updates.length,0);
});

test('candidato aprovado usa três provas reais mesmo se o modelo copiar trechos longos ou vazios',async()=>{
  const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
  const candidateId='44444444-4444-4444-8444-444444444444';
  const sources=ids.map((turnId,index)=>({turnId,text:`Minha fala ${index}: tá ligado? `+'Contexto extenso da fala. '.repeat(8)}));
  const snapshot=context(13); snapshot.language={sources:[sources[2]],candidates:[{id:candidateId,expression:'tá ligado',sources}],atLimit:false};
  const proposal={...update,evidence:'tá ligado',candidateIds:[candidateId],supportingEvidence:sources.map(source=>source.text)};
  const before:MemoryDiagnostic[]=[];
  assert.equal(validateLearning({summary:'',updates:[proposal]},sources[2].text,sources.slice(0,2).map(source=>({role:'user',content:source.text})),event=>before.push(event)).updates.length,0);
  assert.ok(before.some(event=>event.field==='supportingEvidence' && event.detail==='too_long'));
  const grounded=groundCandidateEvidence(proposal,snapshot); assert.ok(grounded);
  assert.equal(grounded.slot,proposal.slot);
  const repairedSlot=groundCandidateEvidence({...proposal,slot:'memory.tá ligado'},snapshot);
  assert.equal(repairedSlot?.slot,`memory.lang_${candidateId.replaceAll('-','')}`);
  assert.ok((grounded.supportingEvidence as string[]).every(sample=>sample.length<=90));
  assert.equal(groundCandidateEvidence({...proposal,candidateIds:['not-provided']},snapshot),null);
  assert.equal(groundCandidateEvidence({...proposal,value:'Usa uma expressão não relacionada.'},snapshot),null);
  const repeated={...snapshot,language:{...snapshot.language,candidates:[{id:candidateId,expression:'tá ligado',sources:[sources[2],sources[2],sources[2]]}]}};
  assert.equal(groundCandidateEvidence(proposal,repeated),null);
  for(const supportingEvidence of [proposal.supportingEvidence,[]]) {
    const events:MemoryDiagnostic[]=[];
    const provider=createVoiceProvider({openaiKey:'test',cartesiaKey:'test',voiceId:'test',model:'test'},async()=>Response.json({status:'completed',output:[{
      type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({updates:[{...proposal,slot:'memory.tá ligado',supportingEvidence}],rejectedCandidates:[]})}]}]}));
    const learned=await provider.observeLanguage!([{role:'user',content:sources[2].text}],AbortSignal.timeout(2000),snapshot,event=>events.push(event));
    assert.equal(learned.updates.length,1); assert.deepEqual(learned.updates[0].languageEvidence?.map(proof=>proof.turnId),ids);
    assert.equal(learned.updates[0].slot,`memory.lang_${candidateId.replaceAll('-','')}`);
    assert.ok(events.some(event=>event.stage==='preparation' && event.count===3 && event.candidateIds?.[0]===candidateId));
    assert.ok(events.some(event=>event.correctedFields?.includes('slot') && event.correctedFields.includes('supportingEvidence')));
  }
});

test('trecho de evidência inclui a expressão completa ou recusa expressões separadas demais',()=>{
  const text='Contexto anterior. tá'+'.'.repeat(70)+'ligado?';
  const sample=languagePhraseSample(text,'tá ligado'); assert.ok(sample); assert.ok(sample.length<=90); assert.ok(sample.includes('ligado'));
  assert.equal(languagePhraseSample('tá'+'.'.repeat(100)+'ligado','tá ligado'),null);
});

test('rejeição associa apenas candidato fornecido e informa a regra específica sem copiar exemplos',async()=>{
  const candidateId='44444444-4444-4444-8444-444444444444';
  const sources=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333']
    .map((turnId,index)=>({turnId,text:`Fala ${index}, tá ligado?`}));
  const snapshot=context(3); snapshot.language={sources,candidates:[{id:candidateId,expression:'tá ligado',sources}],atLimit:false};
  const events:MemoryDiagnostic[]=[];
  const provider=createVoiceProvider({openaiKey:'test',cartesiaKey:'test',voiceId:'test',model:'test'},async()=>Response.json({status:'completed',output:[{
    type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({updates:[{...update,value:'Um padrão diferente.',evidence:sources[2].text,
      supportingEvidence:[sources[2].text],candidateIds:[candidateId,'private-conversation']}],rejectedCandidates:[]})}]}]}));
  assert.equal((await provider.observeLanguage!(sources.map(source=>({role:'user',content:source.text})),AbortSignal.timeout(2000),snapshot,event=>events.push(event))).updates.length,0);
  const rejected=events.find(event=>event.outcome==='rejected'); assert.ok(rejected);
  assert.equal(rejected.field,'supportingEvidence'); assert.equal(rejected.detail,'wrong_count'); assert.deepEqual(rejected.candidateIds,[candidateId]);
  assert.equal(JSON.stringify(events).includes('private-conversation'),false); assert.equal(JSON.stringify(events).includes('Fala 2'),false);
});

test('cliente consulta candidatos sem embeddings e grava prova e decisões sem criar turno ou resumo', async()=>{
  const id='11111111-1111-4111-8111-111111111111'; const bodies:any[]=[]; const urls:string[]=[];
  const service=createMemoryService({url:'https://example.supabase.co',secret:'sb_secret_test',userId:id,openaiKey:'test'},async(url,init)=>{
    urls.push(String(url)); const body=JSON.parse(String(init?.body)); bodies.push(body);
    if(String(url).endsWith('talk_load_language_candidates')) return Response.json({sources:[{turnId:id,text:'Minha fala.'}],candidates:[],atLimit:false});
    return Response.json({stale:false,applied:0});
  });
  const language=await service.languageContext!(id,AbortSignal.timeout(2000));
  assert.equal(language.sources.length,1); assert.ok(urls[0].endsWith('talk_load_language_candidates'));
  await service.saveLanguage!(id,{...context(3),language},[],AbortSignal.timeout(2000),undefined,[id]);
  assert.equal(urls.length,2); assert.ok(urls[1].endsWith('talk_apply_language_v2'));
  assert.deepEqual(bodies[1].p_rejected_ids,[id]); assert.equal('p_summary' in bodies[1],false);
});
import type { MemoryDiagnostic } from './memory-diagnostics.ts';

test('pistas não confundem parte de uma palavra com uma expressão', () => {
  const snapshot = context(3);
  const input = languageAnalysisInput([{ role: 'user', content: 'Um polo novo.' },
    { role: 'user', content: 'Um polo antigo.' }, { role: 'user', content: 'po, vamos pensar.' }], snapshot);
  assert.equal(input.recurringCandidates.some(item => item.phrase === 'po'), false);
});

const update: MemoryUpdate = { slot: 'memory.marcador', category: 'expressions', categoryDescription: 'Marcadores',
  value: 'Usa tá ligado para buscar confirmação.', evidence: 'tá ligado', basis: 'observed', status: 'known' };
const context = (version: number): MemoryContext => ({ version, summary: 'Resumo preservado', profile: [], relevant: [], gaps: [],
  recent: Array.from({ length: 3 }, (_, index) => ({ role: 'user' as const, content: `Frase ${index}, tá ligado?` })) });
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const voice = (observeLanguage: VoiceProvider['observeLanguage']): VoiceProvider => ({ model: 'test', observeLanguage,
  transcribe: async () => ({ text: '', seconds: 0 }), reply: async () => ({ text: '', inputTokens: 0, outputTokens: 0, cachedTokens: 0 }), speak: async () => Buffer.alloc(0) });

test('uma análise ativa, pendências agrupadas e contexto desatualizado nunca sobrescreve a correção', async () => {
  let stored = context(3); let calls = 0; let concurrent = 0; let maximum = 0; let notified = 0;
  const started = gate<void>(); const first = gate<void>(); const sources: string[] = []; const events: MemoryDiagnostic[] = []; const usage: number[] = [];
  const memory: MemoryService = { acquire: () => { throw new Error('Worker must not acquire the foreground lock'); },
    inspect: async () => structuredClone(stored), load: async () => stored, save: async () => { throw new Error('No synthetic turn'); },
    vectors: async () => ({ items: [], limit: 200, truncated: false }),
    saveLanguage: async (id, snapshot) => {
      if (snapshot.version !== stored.version) return { stale: true, applied: 0 };
      sources.push(id); return { stale: false, applied: 1 };
    } };
  const worker = createLanguageWorker(voice(async () => {
    calls++; concurrent++; maximum = Math.max(maximum, concurrent);
    if (calls === 1) { started.resolve(); await first.promise; }
    concurrent--;
    return { updates: [update], inputTokens: 10, outputTokens: 5, cachedTokens: 0 };
  }), memory, () => { notified++; });
  const schedule = (id: string, snapshot: MemoryContext) => worker.schedule({ turnId: id, context: snapshot,
    diagnostic: event => events.push(event), onUsage: metrics => usage.push(metrics.inputTokens) });
  schedule('first-source', stored); await started.promise;
  stored = context(4); schedule('second-source', stored);
  stored = context(5); schedule('latest-source', stored);
  first.resolve(); await worker.idle();
  assert.equal(calls, 2); assert.equal(maximum, 1); assert.deepEqual(sources, ['latest-source']);
  assert.equal(notified, 1); assert.deepEqual(usage, [10, 10]);
  assert.equal(events.filter(event => event.stage === 'language_analysis' && event.outcome === 'started').length, 2);
  await worker.close();
});

test('falha e encerramento não criam gravação tardia; o observador só recebe falas reais do usuário', async () => {
  const snapshot = context(3); snapshot.recent.splice(1, 0, { role: 'assistant', content: 'Não sou evidência de linguagem.' });
  let saves = 0; const started = gate<void>(); const events: MemoryDiagnostic[] = [];
  const memory: MemoryService = { acquire: () => () => {}, inspect: async () => snapshot, load: async () => snapshot,
    save: async () => {}, vectors: async () => ({ items: [], limit: 200, truncated: false }),
    saveLanguage: async () => { saves++; return { applied: 1, stale: false }; } };
  let calls = 0;
  const worker = createLanguageWorker(voice(async (messages, signal) => {
    calls++; assert.equal(messages.some(message => message.role === 'assistant'), false);
    if (calls === 1) throw new Error('private upstream body');
    started.resolve();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    return { updates: [update], inputTokens: 1, outputTokens: 1, cachedTokens: 0 };
  }), memory, () => { throw new Error('Should not notify'); });
  worker.schedule({ turnId: 'first', context: snapshot, diagnostic: event => events.push(event) }); await worker.idle();
  assert.ok(events.some(event => event.outcome === 'failed'));
  worker.schedule({ turnId: 'next', context: snapshot, diagnostic: event => events.push(event) }); await started.promise;
  worker.schedule({ turnId: 'pending', context: snapshot }); await worker.close();
  assert.equal(calls, 2); assert.equal(saves, 0); assert.ok(events.some(event => event.outcome === 'cancelled'));
  assert.equal(JSON.stringify(events).includes('private upstream body'), false);
});

test('gravação de linguagem usa fonte real e RPC próprio, sem alterar resumo ou criar turno', async () => {
  const bodies: Record<string, any>[] = []; const urls: string[] = [];
  const service = createMemoryService({ url: 'https://example.supabase.co', secret: 'sb_secret_test', userId: '11111111-1111-4111-8111-111111111111', openaiKey: 'test' }, async (url, init) => {
    urls.push(String(url)); const body = JSON.parse(String(init?.body)); bodies.push(body);
    if (String(url).endsWith('/embeddings')) return Response.json({ data: [{ index: 0, embedding: Array(1536).fill(.1) }] });
    return Response.json({ stale: false, applied: 1 });
  });
  assert.deepEqual(await service.saveLanguage!('real-source', context(3), [update], AbortSignal.timeout(2000)), { stale: false, applied: 1 });
  assert.equal(urls.length, 2); assert.ok(urls[1].endsWith('/talk_apply_language'));
  assert.equal(bodies[1].p_source_turn_id, 'real-source'); assert.equal(bodies[1].p_expected_version, 3);
  assert.equal('p_user_text' in bodies[1] || 'p_summary' in bodies[1] || 'p_assistant_text' in bodies[1], false);
  assert.equal(bodies[1].p_updates[0].embedding.length, 1536);
});

test('pistas de repetição exigem três falas incluindo a atual e excluem o personagem', () => {
  const samples = [{ role: 'user' as const, content: 'Pô, entendi, tá ligado?' }, { role: 'user' as const, content: 'Pô, bora, tá ligado?' },
    { role: 'assistant' as const, content: 'Palavra exclusiva do personagem' }, { role: 'user' as const, content: 'Pô, vamos, tá ligado?' }];
  const input = languageAnalysisInput(samples, context(3));
  assert.equal(input.utterances.length, 3); assert.ok(input.recurringCandidates.some(candidate => candidate.phrase === 'pô'));
  assert.ok(input.recurringCandidates.some(candidate => candidate.phrase === 'tá ligado'));
  assert.equal(languageAnalysisInput(samples.slice(1), context(3)).recurringCandidates.length, 0);
  assert.equal(JSON.stringify(input).includes('exclusiva'), false);
});
