import type { Message } from './voice.ts';
import { emitDiagnostic, type DiagnosticReason, type DiagnosticSink, type DiagnosticStage, type DiagnosticField, type DiagnosticDetail } from './memory-diagnostics.ts';
import type { VectorMemory, VectorSnapshot } from '../../../shared/vector-memory.ts';
import { categoryForProfile, categoryKey, cosine, discoveryOrder, identityCore, initialCategories, initialColor, semanticColor, type Category } from './categories.ts';
import { forLanguage, type SpeechLanguage } from './speech-language.ts';

// Campos desconhecidos permanecem vazios: uma lacuna nunca vira um fato inventado.
export const profileSlots = {
  name: 'Como você prefere ser chamado',
  life_context: 'Momento de vida',
  family: 'Família e pessoas próximas',
  friends: 'Amizades e vínculos importantes',
  work: 'Trabalho e carreira',
  studies: 'Estudos e aprendizado',
  personal_life: 'Vida pessoal e relacionamentos',
  life_events: 'Acontecimentos marcantes',
  difficult_experiences: 'Experiências difíceis relatadas',
  goals: 'Objetivos atuais',
  principles: 'Princípios e valores declarados',
  routine: 'Rotina',
  constraints: 'Limites de tempo e recursos',
  interests: 'Interesses',
  speaking_preferences: 'Como você prefere conversar',
  expressions: 'Expressões recorrentes',
  reasoning_style: 'Como você costuma avaliar decisões',
} as const;
export type LanguageSource = { turnId: string; text: string };
export type LanguageCandidate = { id: string; expression: string; sources: LanguageSource[] };
export type LanguageContext = { sources: LanguageSource[]; candidates: LanguageCandidate[]; atLimit: boolean };
export type MemoryUpdate = { slot: string; category: string; categoryDescription: string; value: string; evidence: string; basis: 'stated' | 'observed'; status: 'known' | 'declined';
  languageEvidence?: LanguageSource[]; candidateIds?: string[] };
export type Learning = { summary: string; updates: MemoryUpdate[] };
export type StoredMemory = { slot: string; category?: string; value: string; evidence: string; basis: string; status: 'known' | 'declined'; recordedAt?: string };
// identityGaps: the core topics the clone still does not know about the user (see identityCore).
export type MemoryContext = { speechLanguage?: SpeechLanguage; summary: string; profile: StoredMemory[]; relevant: StoredMemory[]; recent: Message[]; version: number; gaps: string[]; identityGaps?: string[];
  categories?: Category[]; catalog?: { slot: string; value: string; category: string | null; status: string }[]; language?: LanguageContext };
export interface MemoryService {
  acquire(): (() => void) | null;
  saveLanguage?(sourceTurnId: string, context: MemoryContext, updates: MemoryUpdate[], signal: AbortSignal, diagnostic?: DiagnosticSink, rejectedCandidates?: string[]): Promise<{ applied: number; stale: boolean }>;
  languageContext?(sourceTurnId: string, signal: AbortSignal): Promise<LanguageContext>;
  load(query: string, signal: AbortSignal): Promise<MemoryContext>;
  // The context without a query (profile, catalog, recent turns, summary, categories): it can load while the user's
  // speech is still being transcribed. recall: the memories closest to what was said, for the brain to light up.
  loadBase?(signal: AbortSignal): Promise<MemoryContext>;
  recall?(query: string, signal: AbortSignal): Promise<StoredMemory[]>;
  save(id: string, user: string, assistant: string, context: MemoryContext, learning: Learning, signal: AbortSignal, diagnostic?: DiagnosticSink): Promise<void>;
  inspect(signal: AbortSignal): Promise<MemoryContext>;
  vectors(signal: AbortSignal): Promise<VectorSnapshot>;
  // Saved facts with an embedding (the same set the memory map shows), counted without downloading vectors.
  count?(signal: AbortSignal): Promise<number>;
  // The user interrupted the reply: keep only what was said before the cut in the saved turn.
  trimReply?(turnId: string, text: string, signal: AbortSignal): Promise<void>;
  // The user picked up a sentence the clone cut short: that turn goes away (with what was learned from the fragment),
  // and the whole sentence is answered and learned from as one.
  forgetTurn?(turnId: string, signal: AbortSignal): Promise<void>;
}
export type MemoryConfig = { url: string; secret: string; userId: string; openaiKey: string };

export function readMemoryConfig(env: NodeJS.ProcessEnv = process.env): MemoryConfig | null {
  if (!env.SUPABASE_SECRET_KEY?.trim()) return null;
  const url = env.SUPABASE_URL?.trim() ?? '';
  const userId = env.LOCAL_USER_ID?.trim() ?? '';
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId) || !env.OPENAI_API_KEY?.trim()) {
    throw new Error('Memória: confira URL do Supabase, identificador local e chave da OpenAI.');
  }
  if (!env.SUPABASE_SECRET_KEY.trim().startsWith('sb_secret_')) throw new Error('Memória: use uma secret key do Supabase somente no servidor.');
  return { url, userId, secret: env.SUPABASE_SECRET_KEY.trim(), openaiKey: env.OPENAI_API_KEY.trim() };
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
const slotPattern = /^(name|life_context|family|friends|work|studies|personal_life|life_events|difficult_experiences|goals|principles|routine|constraints|interests|speaking_preferences|expressions|reasoning_style|memory\.[a-z0-9_]{1,48})$/;

function invalidMemoryField(update: unknown): { field: DiagnosticField; detail: DiagnosticDetail } | null {
  if (!object(update)) return { field:'proposal',detail:'invalid_type' };
  for (const field of ['slot','category','categoryDescription','value','evidence'] as const) {
    if (typeof update[field] !== 'string') return { field,detail:'invalid_type' };
    const text=update[field] as string;
    if (field==='slot' && !/^memory\.[a-z0-9_]{1,48}$/.test(text)) return { field,detail:'invalid_pattern' };
    if (field==='category' && !categoryKey(text)) return { field,detail:'empty' };
    if (field==='categoryDescription' && !text.trim()) return { field,detail:'empty' };
    if (field==='evidence' && text.trim().length<3) return { field,detail:'too_short' };
    const maximum={slot:Infinity,category:60,categoryDescription:200,value:600,evidence:500}[field];
    if(text.length>maximum) return { field,detail:'too_long' };
  }
  if (!['stated','observed'].includes(String(update.basis))) return { field:'basis',detail:'invalid_choice' };
  if (!['known','declined'].includes(String(update.status))) return { field:'status',detail:'invalid_choice' };
  return null;
}

export function validateLearning(value: unknown, user: string, history: Message[], diagnostic?: DiagnosticSink): Learning {
  if (!object(value) || typeof value.summary !== 'string' || value.summary.length > 2400 || !Array.isArray(value.updates) || value.updates.length > 6) {
    emitDiagnostic(diagnostic, { stage: 'validation', outcome: 'failed', reason: 'invalid_format' });
    throw new Error('A IA retornou uma atualização de memória inválida.');
  }
  const isLanguage = (update: unknown) => object(update) && typeof update.category === 'string' && ['expressions', 'speaking_preferences', 'reasoning_style'].includes(categoryKey(update.category));
  emitDiagnostic(diagnostic, { stage: 'proposal', outcome: 'completed', count: value.updates.length, languageCount: value.updates.filter(isLanguage).length });
  const slots = new Set<string>();
  const updates: MemoryUpdate[] = [];
  for (const [candidate, rawUpdate] of value.updates.entries()) {
    const reject = (reason: DiagnosticReason, fault?: {field:DiagnosticField;detail:DiagnosticDetail}) => emitDiagnostic(diagnostic, { stage: 'validation', outcome: 'rejected', candidate, language: isLanguage(rawUpdate), reason,...fault });
    const fault=invalidMemoryField(rawUpdate);
    if (fault || !object(rawUpdate)) {
      reject('invalid_fields',fault ?? {field:'proposal',detail:'invalid_type'});
      continue; // Não persiste uma inferência sem evidência literal na fala atual.
    }
    // Field validation above preserves the existing format contract.
    const update=rawUpdate as Record<string,unknown> & {slot:string;category:string;categoryDescription:string;value:string;evidence:string};
    if (slots.has(update.slot)) { reject('duplicate_slot'); continue; }
    if (!user.includes(update.evidence)) { reject('missing_current_evidence'); continue; }
    if (update.status === 'known' && !update.value.trim()) { reject('empty_value'); continue; }
    let storedValue = update.value.trim();
    if (update.basis === 'observed') {
      if (!['expressions', 'reasoning_style'].includes(categoryKey(update.category))) { reject('unsupported_observation'); continue; }
      const utterances = [...history.filter((message) => message.role === 'user').map((message) => message.content), user];
      if (Array.isArray(update.supportingEvidence) && update.supportingEvidence.length) {
        const samples = update.supportingEvidence;
        if (samples.length !== 3) { reject('invalid_samples',{field:'supportingEvidence',detail:'wrong_count'}); continue; }
        if (samples.some(sample=>typeof sample!=='string')) { reject('invalid_samples',{field:'supportingEvidence',detail:'invalid_type'}); continue; }
        if (samples.some(sample=>(sample as string).trim().length<3)) { reject('invalid_samples',{field:'supportingEvidence',detail:'too_short'}); continue; }
        if (samples.some(sample=>(sample as string).length>90)) { reject('invalid_samples',{field:'supportingEvidence',detail:'too_long'}); continue; }
        if (!samples.some(sample=>user.includes(sample as string))) { reject('invalid_samples',{field:'supportingEvidence',detail:'missing_current_sample'}); continue; }
        // Cada trecho deve estar numa fala diferente. Falas do personagem nunca servem de prova.
        function match(sampleIndex: number, used: Set<number>): boolean {
          if (sampleIndex === samples.length) return used.has(utterances.length - 1);
          return utterances.some((text, index) => !used.has(index) && text.includes(samples[sampleIndex] as string) &&
            match(sampleIndex + 1, new Set([...used, index])));
        }
        if (!match(0, new Set())) { reject('insufficient_user_utterances',{field:'supportingEvidence',detail:'unmatched_sources'}); continue; }
        storedValue += ` Exemplos observados: ${samples.map((sample) => JSON.stringify(sample)).join('; ')}.`;
        if (storedValue.length > 600) { reject('value_too_long'); continue; }
      } else {
        // Compatibilidade com atualizações anteriores baseadas na mesma expressão recorrente.
        const sample = update.evidence.toLocaleLowerCase('pt-BR');
        if (utterances.filter((text) => text.toLocaleLowerCase('pt-BR').includes(sample)).length < 3) { reject('insufficient_user_utterances'); continue; }
      }
    }
    slots.add(update.slot);
    updates.push({ slot: update.slot, category: update.category.trim(), categoryDescription: update.categoryDescription.trim(),
      value: update.status === 'declined' ? '' : storedValue, evidence: update.evidence,
      basis: update.basis as MemoryUpdate['basis'], status: update.status as MemoryUpdate['status'] });
    emitDiagnostic(diagnostic, { stage: 'validation', outcome: 'accepted', candidate, language: isLanguage(update) });
  }
  emitDiagnostic(diagnostic, { stage: 'validation', outcome: 'completed', count: updates.length, languageCount: updates.filter(isLanguage).length });
  return { summary: value.summary.trim(), updates };
}

// With a reply language, expressions learned in the other language are left out (see speech-language.ts).
export function memoryContextText(context: MemoryContext, language?: SpeechLanguage): string {
  const pick = <T extends { slot: string; category?: string | null }>(items: T[]) => language ? forLanguage(items, language) : items;
  return JSON.stringify({ referenceDate: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }), summary: context.summary, profile: pick(context.profile), relevant: pick(context.relevant),
    categories: context.categories?.map(({ key, label, description }) => ({ key, label, description })), catalog: context.catalog && pick(context.catalog),
    gaps: context.gaps.map((slot) => ({ slot, topic: initialCategories.find(([key]) => key === slot)?.[2] ?? profileSlots[slot as keyof typeof profileSlots] })),
    ...(context.identityGaps?.length ? { identidadeEmFormacao: context.identityGaps } : {}) });
}

export const learningSchema = {
  type: 'object', additionalProperties: false, required: ['reply', 'summary', 'updates'],
  properties: {
    reply: { type: 'string' }, summary: { type: 'string' },
    updates: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['slot', 'category', 'categoryDescription', 'value', 'evidence', 'basis', 'status', 'supportingEvidence'],
      properties: { slot: { type: 'string' }, category: { type: 'string' }, categoryDescription: { type: 'string' }, value: { type: 'string' }, evidence: { type: 'string' },
        basis: { type: 'string', enum: ['stated', 'observed'] }, status: { type: 'string', enum: ['known', 'declined'] }, supportingEvidence: { type: 'array', items: { type: 'string' } } },
    } },
  },
};

function parseContext(data: unknown): MemoryContext {
  if (!object(data) || typeof data.summary !== 'string' || !Number.isSafeInteger(data.version) || Number(data.version) < 0 ||
      !Array.isArray(data.profile) || !Array.isArray(data.relevant) || !Array.isArray(data.recent)) throw new Error('Memória: formato de contexto inválido.');
  function memories(values: unknown[]): StoredMemory[] {
    return values.filter(object).filter((row) => typeof row.slot === 'string' && slotPattern.test(row.slot) && typeof row.value === 'string' &&
      typeof row.evidence === 'string' && typeof row.basis === 'string' && (row.status === 'known' || row.status === 'declined'))
      .map((row) => ({ slot: String(row.slot), value: String(row.value).slice(0, 600), evidence: String(row.evidence).slice(0, 500),
        category: typeof row.category_key === 'string' ? row.category_key : categoryForProfile[String(row.slot)],
        recordedAt: typeof row.created_at === 'string' ? row.created_at : undefined,
        basis: String(row.basis), status: row.status as StoredMemory['status'] }));
  }
  const profile = memories(data.profile);
  const relevant = memories(data.relevant);
  const recent: Message[] = data.recent.filter(object).filter((row) => typeof row.user_text === 'string' && typeof row.assistant_text === 'string')
    .flatMap((row) => [{ role: 'user' as const, content: String(row.user_text) }, { role: 'assistant' as const, content: String(row.assistant_text) }]);
  while (recent.length > 2 && recent.reduce((length, message) => length + message.content.length, 0) > 12000) recent.splice(0, 2);
  const known = (key: string) => [...profile, ...relevant].some((row) => row.category === key) ||
    (Array.isArray(data.catalog) && data.catalog.filter(object).some((row) => row.category === key));
  return { summary: data.summary.slice(0, 2400), profile, relevant, recent, version: Number(data.version),
    categories: Array.isArray(data.categories) ? data.categories.filter(object).filter((row) =>
      ['key','label','description','color'].every((key) => typeof row[key] === 'string')) as Category[] : [],
    catalog: Array.isArray(data.catalog) ? data.catalog.filter(object).filter((row) => typeof row.slot === 'string' &&
      typeof row.value === 'string' && typeof row.status === 'string' && (row.category === null || typeof row.category === 'string')) as MemoryContext['catalog'] : [],
    // Lacunas são assuntos sem relatos; ter um fato não preenche toda a categoria.
    // Topics still unknown, in discovery order; sensitive or observed-only categories are not gaps to ask about.
    gaps: discoveryOrder.filter((key) => !known(key)),
    // A core topic counts once anything is saved under it, or the user declined it.
    identityGaps: identityCore.filter((item) => !item.categories.some(known)).map((item) => item.topic) };
}

export function createMemoryService(config: MemoryConfig, fetcher: typeof fetch = fetch,
  onUsage?: (metrics: Record<string, string | number>) => void): MemoryService {
  let busy = false;
  async function request(url: string, body: unknown, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    const response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Memória: não foi possível acessar o serviço. Confira a configuração e tente novamente.'); }
    return response.json();
  }
  async function rpc(name: string, body: unknown, signal: AbortSignal) {
    return request(`${config.url}/rest/v1/rpc/${name}`, body, { apikey: config.secret }, signal);
  }
  async function embeddings(texts: string[], signal: AbortSignal): Promise<number[][]> {
    const started = Date.now();
    const result = await request('https://api.openai.com/v1/embeddings', { model: 'text-embedding-3-small', input: texts, dimensions: 1536 },
      { Authorization: `Bearer ${config.openaiKey}` }, signal);
    if (!object(result) || !Array.isArray(result.data) || result.data.length !== texts.length) throw new Error('Memória: embeddings inválidos.');
    const rows = result.data.filter(object).sort((a, b) => Number(a.index) - Number(b.index));
    if (rows.length !== texts.length || rows.some((row, index) => row.index !== index || !Array.isArray(row.embedding) ||
      row.embedding.length !== 1536 || row.embedding.some((item: unknown) => typeof item !== 'number' || !Number.isFinite(item)))) throw new Error('Memória: embeddings inválidos.');
    onUsage?.({ service: 'embedding', model: 'text-embedding-3-small', elapsedMs: Date.now() - started,
      inputTokens: object(result.usage) && typeof result.usage.total_tokens === 'number' ? result.usage.total_tokens : 0 });
    return rows.map((row) => row.embedding as number[]);
  }
  async function categories(signal: AbortSignal): Promise<Category[]> {
    const response = await fetcher(`${config.url}/rest/v1/talk_categories?user_id=eq.${config.userId}&select=key,label,description,color,embedding&order=key&limit=300`,
      { headers: { apikey: config.secret }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Memória: não foi possível carregar categorias.'); }
    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) throw new Error('Memória: categorias inválidas.');
    return rows.map((row) => {
      if (!object(row) || !['key','label','description','color'].every((key) => typeof row[key] === 'string') || !/^#[0-9a-f]{6}$/.test(String(row.color))) throw new Error('Memória: categorias inválidas.');
      let embedding: unknown = row.embedding;
      if (typeof embedding === 'string') { try { embedding = JSON.parse(embedding); } catch { throw new Error('Memória: categorias inválidas.'); } }
      if (embedding !== null && embedding !== undefined && (!Array.isArray(embedding) || embedding.length !== 1536 || embedding.some((v) => typeof v !== 'number' || !Number.isFinite(v)))) throw new Error('Memória: categorias inválidas.');
      return { key: String(row.key), label: String(row.label), description: String(row.description), color: String(row.color), embedding: embedding as number[] | undefined };
    });
  }
  async function persistCategories(items: Category[], signal: AbortSignal) {
    if (!items.length) return;
    await request(`${config.url}/rest/v1/talk_categories?on_conflict=user_id,key`, items.map((item) => ({ ...item, user_id: config.userId })),
      { apikey: config.secret, Prefer: 'resolution=merge-duplicates,return=representation' }, signal);
  }
  async function ensureCategories(signal: AbortSignal): Promise<Category[]> {
    const current = await categories(signal);
    const missing = initialCategories.filter(([key]) => !current.some((item) => item.key === key && item.embedding));
    if (missing.length) {
      const vectors = await embeddings(missing.map(([, label, description]) => `${label}: ${description}`), signal);
      const added = missing.map(([key,label,description], index) => ({ key,label,description,color:initialColor(key),embedding:vectors[index] }));
      await persistCategories(added, signal);
      return [...current.filter((item) => !added.some((row) => row.key === item.key)), ...added];
    }
    return current;
  }
  return {
    acquire() { if (busy) return null; busy = true; let released = false; return () => { if (!released) { released = true; busy = false; } }; },
    async load(query, signal) {
      const [vector] = await embeddings([query], signal);
      const context = parseContext(await rpc('talk_load_context_v2', { p_user_id: config.userId, p_embedding: vector }, signal));
      const catalog = await ensureCategories(signal);
      context.categories = catalog.map(({ embedding: _vector, ...item }) => item);
      return context;
    },
    async inspect(signal) { return parseContext(await rpc('talk_load_context_v2', { p_user_id: config.userId, p_embedding: null }, signal)); },
    async loadBase(signal) {
      const [data, catalog] = await Promise.all([rpc('talk_load_context_v2', { p_user_id: config.userId, p_embedding: null }, signal), ensureCategories(signal)]);
      const context = parseContext(data);
      context.categories = catalog.map(({ embedding: _vector, ...item }) => item);
      return context;
    },
    async recall(query, signal) {
      const [vector] = await embeddings([query], signal);
      return parseContext(await rpc('talk_load_context_v2', { p_user_id: config.userId, p_embedding: vector }, signal)).relevant;
    },
    async languageContext(sourceTurnId, signal) {
      const data = await rpc('talk_load_language_candidates', { p_user_id: config.userId, p_source_turn_id: sourceTurnId }, signal);
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const sources = (value: unknown, limit: number): LanguageSource[] => {
        if (!Array.isArray(value) || value.length > limit || value.some(item => !object(item) || typeof item.turnId !== 'string' || !uuid.test(item.turnId) || typeof item.text !== 'string' || item.text.length > 4000)) throw new Error('Memória: evidências de linguagem inválidas.');
        return value as LanguageSource[];
      };
      if (!object(data) || !Array.isArray(data.candidates) || data.candidates.length > 12 || typeof data.atLimit !== 'boolean') throw new Error('Memória: candidatos inválidos.');
      const recent = sources(data.sources,6);
      if (recent.at(-1)?.turnId !== sourceTurnId) throw new Error('Memória: origem de linguagem inválida.');
      const candidates = data.candidates.map(item => {
        if (!object(item) || typeof item.id !== 'string' || !uuid.test(item.id) || typeof item.expression !== 'string' || item.expression.length > 60) throw new Error('Memória: candidato inválido.');
        return { id:item.id, expression:item.expression, sources:sources(item.sources,6) };
      });
      return { sources:recent,candidates,atLimit:data.atLimit };
    },
    async saveLanguage(sourceTurnId, context, updates, signal, diagnostic, rejectedCandidates = []) {
      const report: DiagnosticSink = (event) => emitDiagnostic(diagnostic, { ...event, source: 'language' });
      if (!updates.length && !rejectedCandidates.length) return { applied: 0, stale: false };
      if (updates.length > 3 || updates.some((item) => item.status !== 'known' ||
          !['expressions', 'speaking_preferences', 'reasoning_style'].includes(categoryKey(item.category)))) throw new Error('Memória: análise de linguagem inválida.');
      let stage: DiagnosticStage = 'embedding';
      try {
      emitDiagnostic(report, { stage: 'embedding', outcome: 'started', count: updates.length });
      const vectors = updates.length ? await embeddings(updates.map((item) => item.value), signal) : [];
      emitDiagnostic(report, { stage: 'embedding', outcome: 'completed', count: vectors.length });
      stage = 'commit';
      emitDiagnostic(report, { stage: 'commit', outcome: 'started', count: updates.length });
      const result = await rpc(context.language ? 'talk_apply_language_v2' : 'talk_apply_language', { p_user_id: config.userId, p_source_turn_id: sourceTurnId,
        p_expected_version: context.version, p_updates: updates.map((item, index) => ({ ...item, category: categoryKey(item.category), embedding: vectors[index] })),
        ...(context.language ? { p_rejected_ids:rejectedCandidates } : {}) }, signal);
      if (!object(result) || typeof result.applied !== 'number' || !Number.isInteger(result.applied) || result.applied < 0 || result.applied > updates.length || typeof result.stale !== 'boolean') throw new Error('Memória: resultado da análise inválido.');
      emitDiagnostic(report, { stage: 'commit', outcome: result.stale ? 'skipped' : 'completed', count: result.applied,
        ...(result.stale ? { reason: 'stale_context' as const } : {}) });
      return { applied: result.applied, stale: result.stale };
      } catch (error) {
        emitDiagnostic(report, { stage, outcome: signal.aborted ? 'cancelled' : 'failed', reason: 'service_error' });
        throw error;
      }
    },
    async forgetTurn(turnId, signal) {
      const response = await fetcher(`${config.url}/rest/v1/talk_turns?id=eq.${encodeURIComponent(turnId)}&user_id=eq.${config.userId}`, {
        method: 'DELETE', headers: { apikey: config.secret, Prefer: 'return=minimal' }, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Memória: não foi possível juntar a fala retomada.');
    },
    async trimReply(turnId, text, signal) {
      const response = await fetcher(`${config.url}/rest/v1/talk_turns?id=eq.${encodeURIComponent(turnId)}&user_id=eq.${config.userId}`, {
        method: 'PATCH', headers: { apikey: config.secret, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ assistant_text: text.slice(0, 4000) }), signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Memória: não foi possível ajustar a fala interrompida.');
    },
    async count(signal) {
      // PostgREST returns the total in Content-Range ("0-0/42") when asked for an exact count.
      const query = new URLSearchParams({ select: 'id', user_id: `eq.${config.userId}`, active: 'eq.true', status: 'eq.known',
        embedding: 'not.is.null', limit: '1' });
      const response = await fetcher(`${config.url}/rest/v1/talk_memories?${query}`, {
        headers: { apikey: config.secret, Prefer: 'count=exact' }, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
      await response.body?.cancel();
      const total = Number(response.headers.get('content-range')?.split('/')[1]);
      if (!response.ok || !Number.isInteger(total) || total < 0) throw new Error('Memória: não foi possível contar as memórias.');
      return total;
    },
    async vectors(signal) {
      // A identidade vem da configuração do servidor, nunca de um parâmetro do navegador.
      const limit = 200;
      const query = new URLSearchParams({ select: 'id,slot,value,evidence,basis,created_at,embedding,talk_categories(key,label,color)',
        user_id: `eq.${config.userId}`, active: 'eq.true', status: 'eq.known',
        order: 'created_at.desc,id.asc', limit: String(limit + 1) });
      const response = await fetcher(`${config.url}/rest/v1/talk_memories?${query}`, {
        headers: { apikey: config.secret }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Memória: não foi possível carregar os vetores.'); }
      const data: unknown = await response.json();
      if (!Array.isArray(data)) throw new Error('Memória: formato de vetores inválido.');
      const items: VectorMemory[] = data.slice(0, limit).map((row: unknown) => {
        if (!object(row) || !['id', 'slot', 'value', 'evidence', 'basis', 'created_at'].every((key) => typeof row[key] === 'string')) {
          throw new Error('Memória: formato de vetores inválido.');
        }
        // PostgREST serializa vector como texto; os testes também cobrem arrays.
        let vector: unknown;
        try { vector = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding; }
        catch { throw new Error('Memória: formato de vetores inválido.'); }
        if (!Array.isArray(vector) || vector.length !== 1536 || vector.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
          throw new Error('Memória: formato de vetores inválido.');
        }
        const category = object(row.talk_categories) && typeof row.talk_categories.key === 'string' && typeof row.talk_categories.label === 'string' &&
          typeof row.talk_categories.color === 'string' && /^#[0-9a-f]{6}$/.test(row.talk_categories.color) ?
          { key: row.talk_categories.key, label: row.talk_categories.label, color: row.talk_categories.color } : undefined;
        return { id: String(row.id), slot: String(row.slot), value: String(row.value), evidence: String(row.evidence), category,
          basis: String(row.basis), createdAt: String(row.created_at), embedding: vector as number[] };
      });
      return { items, limit, truncated: data.length > limit };
    },
    async save(id, user, assistant, context, learning, signal, diagnostic) {
      let stage: DiagnosticStage = 'preparation';
      emitDiagnostic(diagnostic, { stage, outcome: 'started', count: learning.updates.length });
      try {
      const catalog = await ensureCategories(signal);
      const updates: MemoryUpdate[] = [];
      for (const update of learning.updates) {
        let category = catalog.find((item) => item.key === categoryKey(update.category) || categoryKey(item.label) === categoryKey(update.category));
        if (!category) {
          if (catalog.length >= 300) throw new Error('Memória: limite de categorias atingido; precisamos revisar os assuntos existentes.');
          const [vector] = await embeddings([`${update.category}: ${update.categoryDescription}`], signal);
          // Apenas quase equivalentes são reunidos; relações mais fracas influenciam a cor.
          category = catalog.filter((item) => item.embedding && cosine(vector,item.embedding) >= .96)
            .sort((a,b) => cosine(vector,b.embedding!) - cosine(vector,a.embedding!))[0];
          if (!category) {
            category = { key:categoryKey(update.category), label:update.category.replace(/_/g,' '), description:update.categoryDescription,
              color:semanticColor(vector,catalog),embedding:vector };
            await persistCategories([category],signal); catalog.push(category);
          }
        }
        // Uma repetição exata reaproveita a chave, mesmo se o modelo propôs outra.
        const existing = context.catalog?.find((fact) => fact.status === update.status && fact.category === category!.key &&
          fact.value.trim().toLocaleLowerCase('pt-BR') === update.value.trim().toLocaleLowerCase('pt-BR'));
        const slot = existing?.slot ?? update.slot;
        if (!updates.some((fact) => fact.slot === slot)) updates.push({ ...update, slot, category:category.key });
      }
      const known = updates.filter((update) => update.status === 'known');
      emitDiagnostic(diagnostic, { stage, outcome: 'completed', count: updates.length });
      stage = 'embedding';
      emitDiagnostic(diagnostic, { stage, outcome: known.length ? 'started' : 'skipped', count: known.length,
        ...(known.length ? {} : { reason: 'no_known_updates' as const }) });
      const vectors = known.length ? await embeddings(known.map((update) => update.value), signal) : [];
      if (known.length) emitDiagnostic(diagnostic, { stage, outcome: 'completed', count: vectors.length });
      let index = 0;
      stage = 'commit';
      emitDiagnostic(diagnostic, { stage, outcome: 'started', count: updates.length });
      await rpc('talk_commit_turn_v2', { p_user_id: config.userId, p_turn_id: id, p_user_text: user, p_assistant_text: assistant,
        p_expected_version: context.version, p_summary: learning.summary,
        p_updates: updates.map((update) => ({ ...update, embedding: update.status === 'known' ? vectors[index++] : null })) }, signal);
      emitDiagnostic(diagnostic, { stage, outcome: 'completed', count: updates.length });
      } catch (error) {
        emitDiagnostic(diagnostic, { stage, outcome: signal.aborted ? 'cancelled' : 'failed', reason: 'service_error' });
        throw error;
      }
    },
  };
}
