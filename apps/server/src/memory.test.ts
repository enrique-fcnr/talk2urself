import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryService, readMemoryConfig, validateLearning, type MemoryContext } from './memory.ts';
import { createVoiceProvider, type Message } from './voice.ts';
import { categoryKey, initialCategories, initialColor, semanticColor } from './categories.ts';
import { serializeDiagnostic, type MemoryDiagnostic } from './memory-diagnostics.ts';

const userId = '11111111-1111-4111-8111-111111111111';
const empty: MemoryContext = { summary: '', profile: [], relevant: [], recent: [], version: 0, gaps: ['goals'] };

test('campos inválidos são identificados sem registrar valores pessoais e sem relaxar validação',()=>{
  const valid={slot:'memory.giria',category:'expressions',categoryDescription:'Expressões',value:'Preferência privada',evidence:'Fala privada',basis:'stated',status:'known',supportingEvidence:[]};
  const cases:[unknown,string,string][]=[
    [null,'proposal','invalid_type'],[{...valid,slot:'memory.nome-invalido'},'slot','invalid_pattern'],
    [{...valid,category:1},'category','invalid_type'],[{...valid,category:''},'category','empty'],
    [{...valid,category:'a'.repeat(61)},'category','too_long'],[{...valid,categoryDescription:' '},'categoryDescription','empty'],
    [{...valid,categoryDescription:'a'.repeat(201)},'categoryDescription','too_long'],
    [{...valid,value:'a'.repeat(601)},'value','too_long'],[{...valid,evidence:'pô'},'evidence','too_short'],
    [{...valid,evidence:'a'.repeat(501)},'evidence','too_long'],[{...valid,basis:'guess'},'basis','invalid_choice'],
    [{...valid,status:'pending'},'status','invalid_choice'],
  ];
  for(const [proposal,field,detail] of cases) {
    const events:MemoryDiagnostic[]=[];
    assert.equal(validateLearning({summary:'',updates:[proposal]},'Fala privada',[],event=>events.push(event)).updates.length,0);
    const rejected=events.find(event=>event.outcome==='rejected'); assert.ok(rejected);
    assert.equal(rejected.reason,'invalid_fields'); assert.equal(rejected.field,field); assert.equal(rejected.detail,detail);
    const serialized=serializeDiagnostic({...rejected,turnId:userId});
    assert.equal(/Fala privada|Preferência privada|memory.nome-invalido/.test(serialized),false);
    assert.equal(JSON.parse(serialized).field,field); assert.equal(JSON.parse(serialized).detail,detail);
  }
  assert.equal(validateLearning({summary:'',updates:[valid]},'Fala privada',[]).updates.length,1);
});

test('diagnóstico distingue ausência de proposta, rejeição e três falas válidas sem copiar conteúdos', () => {
  const events: MemoryDiagnostic[] = [];
  const report = (event: MemoryDiagnostic) => { events.push(event); };
  validateLearning({ summary: 'Resumo privado', updates: [] }, 'Fala privada', [], report);
  assert.deepEqual(events, [{ stage: 'proposal', outcome: 'completed', count: 0, languageCount: 0 },
    { stage: 'validation', outcome: 'completed', count: 0, languageCount: 0 }]);
  events.length = 0;
  const update = { slot: 'memory.giria', category: 'expressions', categoryDescription: 'Expressões', value: 'Usa tá ligado ao buscar confirmação.',
    evidence: 'tá ligado', basis: 'observed', status: 'known', supportingEvidence: ['tá ligado', 'tá ligado', 'tá ligado'] };
  assert.equal(validateLearning({ summary: '', updates: [update] }, 'Vamos, tá ligado?',
    [{ role: 'user', content: 'tá ligado' }, { role: 'assistant', content: 'tá ligado' }], report).updates.length, 0);
  assert.ok(events.some((event) => event.reason === 'insufficient_user_utterances' && event.language));
  events.length = 0;
  assert.equal(validateLearning({ summary: '', updates: [update] }, 'Vamos, tá ligado?',
    [{ role: 'user', content: 'tá ligado' }, { role: 'user', content: 'tá ligado' }], report).updates.length, 1);
  assert.ok(events.some((event) => event.outcome === 'accepted' && event.candidate === 0));
  const explicit = { ...update, basis: 'stated', supportingEvidence: [], category: 'speaking_preferences' };
  assert.equal(validateLearning({ summary: '', updates: [explicit] }, 'Costumo dizer tá ligado.', [], report).updates.length, 1);
  events.length = 0;
  validateLearning({ summary: '', updates: [{ ...explicit, evidence: 'outra fala' }] }, 'Costumo dizer tá ligado.', [], report);
  assert.equal(events[1].reason, 'missing_current_evidence');
  assert.throws(() => validateLearning({ updates: [] }, 'Privado', [], report));
  assert.equal(events.at(-1)?.reason, 'invalid_format');
  const serialized = serializeDiagnostic({ ...events[1], turnId: userId, ...{ text: 'private-conversation', secret: 'private-key' } });
  assert.equal(/private-conversation|private-key|outra fala|tá ligado|Resumo privado/.test(serialized), false);
  assert.equal(JSON.parse(serialized).turnId, userId);
  const withReferences=serializeDiagnostic({...events[1],turnId:userId,candidateIds:[userId,'private-conversation']});
  assert.deepEqual(JSON.parse(withReferences).candidateIds,[userId]); assert.equal(withReferences.includes('private-conversation'),false);
  assert.doesNotThrow(() => validateLearning({ summary: '', updates: [] }, '', [], () => { throw new Error('Log indisponível'); }));
});

test('diagnóstico de gravação separa preparação, vetorização, commit e cancelamento', async () => {
  const update = { slot: 'memory.objetivo', category: 'goals', categoryDescription: 'Objetivos', value: 'Fato privado',
    evidence: 'Fala privada', basis: 'stated' as const, status: 'known' as const };
  for (const failure of ['none', 'empty', 'preparation', 'embedding', 'commit', 'cancelled'] as const) {
    const events: MemoryDiagnostic[] = [];
    const active = new AbortController();
    let commits = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('talk_categories')) {
        if (failure === 'preparation') throw new Error('secret-upstream-body');
        return Response.json(initialCategories.map(([key,label,description]) => ({ key,label,description,color:initialColor(key),embedding:Array(1536).fill(.1) })));
      }
      if (url.endsWith('/embeddings')) {
        if (failure === 'embedding') return new Response('secret-upstream-body', { status: 500 });
        if (failure === 'cancelled') { active.abort(); throw new Error('cancelled'); }
        const body = JSON.parse(String(init?.body));
        return Response.json({ data: body.input.map((_: string, index: number) => ({ index, embedding: Array(1536).fill(.1) })) });
      }
      commits++;
      if (failure === 'commit') return new Response('secret-upstream-body', { status: 409 });
      return Response.json({ version: 1 });
    };
    const service = createMemoryService({ url: 'https://example.supabase.co', secret: 'sb_secret_test', userId, openaiKey: 'openai_test' }, fetcher);
    const save = () => service.save(userId, 'Fala privada', 'Resposta privada', empty,
      { summary: 'Resumo privado', updates: failure === 'empty' ? [] : [update] }, active.signal, (event) => { events.push(event); });
    if (failure === 'none' || failure === 'empty') {
      await save();
      assert.equal(events.at(-1)?.stage, 'commit'); assert.equal(events.at(-1)?.outcome, 'completed');
      assert.equal(events.at(-1)?.count, failure === 'empty' ? 0 : 1);
      assert.equal(events.some((event) => event.stage === 'embedding' && event.outcome === 'skipped'), failure === 'empty');
    } else {
      await assert.rejects(save);
      assert.equal(events.at(-1)?.stage, failure === 'cancelled' ? 'embedding' : failure);
      assert.equal(events.at(-1)?.outcome, failure === 'cancelled' ? 'cancelled' : 'failed');
      assert.equal(events.some((event) => event.stage === 'commit' && event.outcome === 'completed'), false);
      assert.equal(commits, failure === 'commit' ? 1 : 0);
    }
    assert.equal(/Fala privada|Resposta privada|Resumo privado|Fato privado|secret-upstream-body|sb_secret_test|openai_test/.test(JSON.stringify(events)), false);
  }
});

test('provedor real encaminha o diagnóstico de resposta estruturada sem nova chamada', async () => {
  let calls = 0;
  const events: MemoryDiagnostic[] = [];
  let output = JSON.stringify({ reply: 'Resposta privada', summary: '', updates: [] });
  const voice = createVoiceProvider({ openaiKey: 'test', cartesiaKey: 'test', voiceId: 'test', model: 'test' }, async () => {
    calls++;
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: output }] }] });
  });
  const reply = await voice.reply([{ role: 'user', content: 'Fala privada' }], AbortSignal.timeout(1000), empty, (event) => { events.push(event); });
  assert.equal(reply.learning?.updates.length, 0); assert.equal(calls, 1);
  assert.equal(events.find((event) => event.stage === 'proposal' && event.outcome === 'completed')?.count, 0);
  assert.equal(JSON.stringify(events).includes('privada'), false);
  output = 'invalid-json';
  await assert.rejects(voice.reply([{ role: 'user', content: 'Fala privada' }], AbortSignal.timeout(1000), empty, (event) => { events.push(event); }));
  assert.equal(events.at(-1)?.stage, 'proposal'); assert.equal(events.at(-1)?.reason, 'invalid_format');
});

test('padrão de linguagem aceita exemplos diferentes, exige três falas do usuário e preserva a prova', () => {
  const update = { slot: 'memory.linguagem_afetiva', category: 'expressions', categoryDescription: 'Padrões de linguagem',
    value: 'Padrão observado de linguagem afetiva ao se dirigir a pessoas próximas; hipótese revisável.',
    evidence: 'meu querido', basis: 'observed', status: 'known', supportingEvidence: ['meu bem', 'minha querida', 'meu querido'] };
  const history: Message[] = [{ role: 'user', content: 'Tudo bem, meu bem?' }, { role: 'user', content: 'Oi, minha querida.' }];
  const good = validateLearning({ summary: '', updates: [update] }, 'Obrigado, meu querido.', history);
  assert.equal(good.updates.length, 1);
  assert.match(good.updates[0].value, /Exemplos observados/);
  assert.match(good.updates[0].value, /minha querida/);
  assert.equal(validateLearning({ summary: '', updates: [update] }, 'Obrigado, meu querido.',
    [{ role: 'assistant', content: 'Tudo bem, meu bem? Oi, minha querida.' }]).updates.length, 0);
  assert.equal(validateLearning({ summary: '', updates: [update] }, 'Obrigado, meu querido.',
    [{ role: 'user', content: 'meu bem e minha querida' }]).updates.length, 0, 'Dois exemplos na mesma fala não são dois turnos.');
  assert.equal(validateLearning({ summary: '', updates: [{ ...update, supportingEvidence: ['inventado', 'minha querida', 'meu querido'] }] },
    'Obrigado, meu querido.', history).updates.length, 0);
  const overlap = { ...update, evidence: 'querida', supportingEvidence: ['querida', 'meu bem', 'minha querida'] };
  assert.equal(validateLearning({ summary: '', updates: [overlap] }, 'Oi, querida.',
    [{ role: 'user', content: 'minha querida' }, { role: 'user', content: 'meu bem' }]).updates.length, 1);
});

test('aprendizado exige origem na fala atual, não transforma uma ocorrência em estilo e respeita recusa', () => {
  const user = 'Quero preservar minha renda. Beleza, não quero falar da rotina.';
  const update = (category: string, evidence: string, basis = 'stated', status = 'known') => ({ slot: `memory.${category}`, category, categoryDescription: category, value: 'Valor', evidence, basis, status });
  const learning = validateLearning({ summary: 'Discutindo renda.', updates: [
    update('goals', 'preservar minha renda'), update('expressions', 'Beleza', 'observed'),
    update('principles', 'Uma frase dita só pelo avatar'), update('life_context', 'preservar minha renda', 'observed'),
    update('routine', 'não quero falar da rotina', 'stated', 'declined'),
  ] }, user, []);
  assert.deepEqual(learning.updates.map((item) => item.slot), ['memory.goals', 'memory.routine']);
  assert.equal(learning.updates[1].value, '');
  const repeated = validateLearning({ summary: '', updates: [update('expressions', 'Beleza', 'observed')] }, user,
    [{ role: 'user', content: 'Beleza, vamos começar.' }, { role: 'assistant', content: 'Beleza.' }, { role: 'user', content: 'Beleza, entendi.' }]);
  assert.equal(repeated.updates.length, 1);
  assert.throws(() => validateLearning({ summary: 'x'.repeat(2401), updates: [] }, user, []));
});

test('assuntos da vida aceitam relatos e rejeitam experiências difíceis inferidas como padrão', () => {
  const user = 'Minha irmã é Ana. Meu amigo é João. Trabalho como programador. Estudo JavaScript. Moro sozinho. Mudei de cidade. Passei por uma perda.';
  const updates = [
    ['family', 'Minha irmã é Ana'], ['friends', 'Meu amigo é João'], ['work', 'Trabalho como programador'],
    ['studies', 'Estudo JavaScript'], ['personal_life', 'Moro sozinho'], ['life_events', 'Mudei de cidade'],
    ['difficult_experiences', 'Passei por uma perda'],
  ].map(([category, evidence]) => ({ slot: `memory.${category}`, category, categoryDescription: category, value: evidence, evidence, basis: 'stated', status: 'known' }));
  assert.equal(validateLearning({ summary: '', updates: updates.slice(0, 6) }, user, []).updates.length, 6);
  assert.equal(validateLearning({ summary: '', updates: updates.slice(6) }, user, []).updates[0].category, 'difficult_experiences');
  assert.equal(validateLearning({ summary: '', updates: [{ ...updates[6], basis: 'observed' }] }, user, []).updates.length, 0);
});

test('cliente recupera histórico, cria embeddings, preserva usuário e versão no commit e não expõe a chave em falhas', async () => {
  const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  let denied = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ url, body, headers: new Headers(init?.headers) });
    if (denied) return new Response('secret-must-not-leak', { status: 403 });
    if (url.includes('/talk_categories?')) return Response.json(initialCategories.map(([key,label,description]) => ({ key,label,description,color:initialColor(key),embedding:Array(1536).fill(.1) })));
    if (url.endsWith('/embeddings')) return Response.json({ data: (body.input as string[]).map((_value, index) => ({ index, embedding: Array(1536).fill(0.1) })), usage: { total_tokens: 12 } });
    if (url.endsWith('talk_load_context_v2')) return Response.json({ summary: 'Projeto em andamento.', version: 2,
      profile: [{ slot: 'routine', value: '', evidence: 'Não quero falar disso.', basis: 'stated', status: 'declined' }], relevant: [],
      recent: [{ user_text: 'Quero preservar minha renda.', assistant_text: 'Vamos considerar isso.' }] });
    return Response.json({ version: 3 });
  };
  const metrics: Record<string, string | number>[] = [];
  const service = createMemoryService({ url: 'https://example.supabase.co', secret: 'sb_secret_test', userId, openaiKey: 'openai_test' }, fetcher, (entry) => metrics.push(entry));
  const release = service.acquire()!; assert.equal(service.acquire(), null); release(); release(); assert.ok(service.acquire());
  const context = await service.load('Vamos continuar?', new AbortController().signal);
  assert.equal(context.version, 2); assert.equal(context.recent.length, 2); assert.equal(context.gaps.includes('routine'), false);
  await service.save('22222222-2222-4222-8222-222222222222', 'Quero preservar minha renda.', 'Vamos considerar isso.', context,
    { summary: 'Preservar renda.', updates: [{ slot: 'memory.preservar_renda', category:'goals',categoryDescription:'Objetivos', value: 'Preservar renda', evidence: 'preservar minha renda', basis: 'stated', status: 'known' }] }, new AbortController().signal);
  const commit = requests.at(-1)!;
  assert.equal(commit.body.p_user_id, userId); assert.equal(commit.body.p_expected_version, 2);
  assert.equal(commit.headers.get('apikey'), 'sb_secret_test'); assert.equal(commit.headers.has('Authorization'), false);
  assert.equal(metrics.length, 2); assert.equal(metrics.some((entry) => 'text' in entry || 'secret' in entry), false);
  const inspection = await service.inspect(new AbortController().signal); assert.equal(inspection.version, 2);
  assert.equal(requests.at(-1)?.body.p_embedding, null);
  denied = true;
  await assert.rejects(service.inspect(new AbortController().signal), (error: Error) => !error.message.includes('secret-must-not-leak') && error.message.startsWith('Memória:'));
});

test('resposta personalizada mantém contexto como dados e entrega só o texto falado para TTS', async () => {
  let requestBody: Record<string, unknown> = {};
  const fetcher: typeof fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({
      reply: 'Como manter sua renda enquanto valida o projeto?', summary: 'Preservar renda durante o projeto.',
      updates: [{ slot: 'memory.preservar_renda', category:'goals',categoryDescription:'Objetivos', value: 'Preservar renda', evidence: 'preservar minha renda', basis: 'stated', status: 'known' }],
    }) }] }], usage: { input_tokens: 100, output_tokens: 80 } });
  };
  const voice = createVoiceProvider({ openaiKey: 'test', cartesiaKey: 'test', voiceId: 'test', model: 'gpt-6-luna' }, fetcher);
  const answer = await voice.reply([{ role: 'user', content: 'Quero preservar minha renda.' }], new AbortController().signal, empty);
  assert.equal(answer.text, 'Como manter sua renda enquanto valida o projeto?'); assert.equal(answer.learning?.updates[0].slot, 'memory.preservar_renda');
  assert.equal(requestBody.store, false); assert.equal((requestBody.text as { format: { type: string } }).format.type, 'json_schema');
  assert.equal((requestBody.input as { content: string }[])[0].content.includes('Dados de continuidade'), true);
  assert.equal(answer.outputTokens, 80);
});

test('fatos distintos na mesma categoria são aceitos; campo agregado e evidência de outra fala são rejeitados', () => {
  const update = (slot: string, evidence: string) => ({ slot,category:'interests',categoryDescription:'Hobbies e gostos',value:evidence,evidence,basis:'stated',status:'known' });
  const facts = validateLearning({summary:'',updates:[update('memory.futebol','gosto de jogar bola'),update('memory.cor_favorita','minha cor favorita é azul'),
    update('interests','gosto de jogar bola'), update('memory.inventada','gosto de nadar')]}, 'Eu gosto de jogar bola e minha cor favorita é azul.', []);
  assert.deepEqual(facts.updates.map((fact) => fact.slot), ['memory.futebol','memory.cor_favorita']);
});

test('nomes equivalentes reutilizam categorias; cor semântica é estável e legível no fundo escuro', () => {
  assert.equal(categoryKey(' Educação '),'studies'); assert.equal(categoryKey('Trabalho'),'work');
  const anchors = initialCategories.map(([key,label,description],i) => ({key,label,description,color:initialColor(key),embedding:Array.from({length:17},(_,j)=>i===j?1:0)}));
  const blue = semanticColor(anchors[4].embedding, anchors);
  const near = semanticColor(anchors[4].embedding.map((value,i)=>i===5?.01:value), anchors);
  assert.equal(semanticColor(anchors[4].embedding, anchors),blue);
  const difference = [1,3,5].reduce((sum,index)=>sum+Math.abs(parseInt(blue.slice(index,index+2),16)-parseInt(near.slice(index,index+2),16)),0);
  assert.ok(difference < 10);
  for (const color of [...anchors.map((item)=>item.color),blue]) {
    assert.match(color,/^#[0-9a-f]{6}$/);
    const channels = [1,3,5].map((i)=>parseInt(color.slice(i,i+2),16)/255).map((v)=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
    const luminance = channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;
    assert.ok((luminance+.05)/(.006+.05)>4.5);
  }
});

test('memória fica desativada sem chave e recusa URL ou identificador inválido', () => {
  assert.equal(readMemoryConfig({}), null);
  assert.throws(() => readMemoryConfig({ SUPABASE_SECRET_KEY: 'sb_secret_test', SUPABASE_URL: 'http://bad.example', LOCAL_USER_ID: userId, OPENAI_API_KEY: 'test' }));
  assert.equal(readMemoryConfig({ SUPABASE_SECRET_KEY: 'sb_secret_test', SUPABASE_URL: 'https://example.supabase.co', LOCAL_USER_ID: userId, OPENAI_API_KEY: 'test' })?.userId, userId);
});

test('categoria nova é persistida e reutilizada; repetição exata reaproveita a chave do fato', async () => {
  const catalog = initialCategories.map(([key,label,description],i)=>({key,label,description,color:initialColor(key),embedding:Array.from({length:1536},(_,j)=>j===i?1:0)}));
  const commits: Record<string,unknown>[] = []; let additions=0;
  const fetcher: typeof fetch = async(input,init)=> {
    const url=String(input),body=init?.body?JSON.parse(String(init.body)):null;
    if(url.includes('/talk_categories?')) {
      if(init?.method==='POST') {additions++;catalog.push(...body);return Response.json(body);}
      return Response.json(catalog);
    }
    if(url.endsWith('/embeddings')) return Response.json({data:body.input.map((_:string,index:number)=>({index,embedding:Array.from({length:1536},(_,j)=>j===100?1:0)}))});
    commits.push(body); return Response.json({version:1});
  };
  const service=createMemoryService({url:'https://example.supabase.co',secret:'sb_secret_test',userId,openaiKey:'test'},fetcher);
  const context: MemoryContext={...empty,catalog:[{slot:'memory.cidade_desejada',value:'Quer conhecer Lisboa',category:'viagens',status:'known'}]};
  const learning={summary:'',updates:[{slot:'memory.nova_chave',category:'Viagens',categoryDescription:'Destinos e experiências de viagem',value:'Quer conhecer Lisboa',evidence:'quero conhecer Lisboa',basis:'stated' as const,status:'known' as const}]};
  await service.save('test','Eu quero conhecer Lisboa.','Resposta',context,learning,new AbortController().signal);
  await service.save('test2','Eu quero conhecer Lisboa.','Resposta',context,learning,new AbortController().signal);
  assert.equal(additions,1); assert.equal((commits[0].p_updates as {slot:string}[])[0].slot,'memory.cidade_desejada');
  assert.match(catalog.at(-1)!.color,/^#[0-9a-f]{6}$/); assert.equal(catalog.at(-1)!.label,'Viagens');
});

test('mapa lê somente vetores ativos do usuário local, aceita serialização pgvector e não gera embeddings', async () => {
  let requested = ''; let auth: Headers | undefined; let invalid = false;
  const fetcher: typeof fetch = async (url, init) => {
    requested = String(url); auth = new Headers(init?.headers);
    assert.equal(init?.method, undefined);
    return Response.json(Array.from({ length: 201 }, (_, i) => ({ id: String(i), slot: 'interests', value: 'Bola', evidence: 'gosto de jogar bola',
      basis: 'stated', created_at: '2026-10-08', embedding: invalid ? '[1,2]' : i % 2 ? Array(1536).fill(0.1) : JSON.stringify(Array(1536).fill(0.1)) })));
  };
  const service = createMemoryService({ url: 'https://example.supabase.co', secret: 'sb_secret_test', userId, openaiKey: 'openai_test' }, fetcher);
  const result = await service.vectors(new AbortController().signal);
  const params = new URL(requested).searchParams;
  assert.equal(params.get('user_id'), `eq.${userId}`); assert.equal(params.get('active'), 'eq.true'); assert.equal(params.get('status'), 'eq.known');
  assert.equal(auth!.get('apikey'), 'sb_secret_test'); assert.equal(result.items.length, 200); assert.equal(result.truncated, true);
  assert.equal(result.items[0].embedding.length, 1536); assert.equal(requested.includes('openai'), false);
  invalid = true; await assert.rejects(service.vectors(new AbortController().signal), /formato de vetores inválido/);
});

test('contagem de memórias pede só o total ao Supabase e lê o Content-Range', async () => {
  let asked = '', prefer = '';
  const fetcher: typeof fetch = async (input, init) => {
    asked = String(input); prefer = new Headers(init?.headers).get('Prefer') ?? '';
    return new Response('[]', { status: 200, headers: { 'Content-Range': '0-0/42' } });
  };
  const service = createMemoryService({ url: 'https://example.supabase.co', secret: 'sb_secret_test', userId, openaiKey: 'test' }, fetcher);
  assert.equal(await service.count!(new AbortController().signal), 42);
  assert.equal(prefer, 'count=exact');
  for (const part of ['/rest/v1/talk_memories?', 'active=eq.true', 'status=eq.known', 'embedding=not.is.null', `user_id=eq.${userId}`]) assert.ok(asked.includes(part), part);
  const broken: typeof fetch = async () => new Response('[]', { status: 200 });
  await assert.rejects(createMemoryService({ url: 'https://example.supabase.co', secret: 'sb_secret_test', userId, openaiKey: 'test' }, broken).count!(new AbortController().signal));
});
