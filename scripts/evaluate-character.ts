// Avaliação opt-in: chama somente a OpenAI, com cenários fictícios. Não grava no Supabase nem gera voz.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createVoiceProvider, readVoiceConfig, type Message } from '../apps/server/src/voice.ts';
import { initialCategories, initialColor } from '../apps/server/src/categories.ts';
import type { MemoryContext, StoredMemory } from '../apps/server/src/memory.ts';

const config = readVoiceConfig();
if (!config) throw new Error('Configure as credenciais locais antes da avaliação.');
const voice = createVoiceProvider(config);
const fact = (slot: string, category: string, value: string): StoredMemory => ({ slot: `memory.${slot}`, category, value, evidence: value, basis: 'stated', status: 'known' });
const base: MemoryContext = { summary: '', profile: [], relevant: [], recent: [], version: 0, gaps: ['identity', 'family'],
  categories: initialCategories.map(([key, label, description]) => ({ key, label, description, color: initialColor(key) })), catalog: [] };
const identity = fact('nome', 'identity', 'Nome: Henrique.');
const cases: { title: string; user: string; context: MemoryContext; history?: Message[]; criterion: string }[] = [
  { title: 'Nome e descoberta', user: 'Meu nome é Henrique.', context: base,
    history: [{ role: 'assistant', content: 'Qual é meu nome?' }], criterion: 'Adota nome; uma pergunta em primeira pessoa; salva somente o nome declarado.' },
  { title: 'Recomendação autônoma em dia estressante',
    user: 'Hoje estou muito estressado. Meu amigo escreveu: seu projeto é perda de tempo, você nunca termina nada. Quero responder agora. O que acha?',
    context: { ...base, version: 2, profile: [identity, fact('criterios', 'principles', 'Valoriza sinceridade e cuidado com as palavras; quer preservar a amizade.')],
      summary: 'Ao responder impulsivamente, costuma se arrepender; quer preservar a amizade.' },
    criterion: 'Sugere resposta concreta, explica critérios e pode contrariar impulso; não exige escolher a resposta; estresse fica no resumo.' },
  { title: 'Sujeito e acontecimento hipotético', user: 'Minha irmã Ana é enfermeira. Eu sou designer. Se eu fosse morar em Recife, teria de trocar de emprego.',
    context: { ...base, version: 2, profile: [identity] }, criterion: 'Profissão da irmã não vira profissão do usuário; mudança hipotética não vira acontecimento.' },
  { title: 'Padrão contextual de linguagem', user: 'Vamos com calma, meu querido. Antes de decidir, eu quero comparar as opções.',
    history: [{ role: 'user', content: 'Obrigado, meu bem. Vamos pensar nas alternativas.' }, { role: 'assistant', content: 'Vamos comparar.' },
      { role: 'user', content: 'Tudo certo, minha querida. Quero olhar as opções antes de escolher.' }, { role: 'assistant', content: 'Vamos avaliar as opções.' }],
    context: { ...base, version: 3, profile: [identity] }, criterion: 'Hipóteses de linguagem/raciocínio precisam de três falas; não atribui traço definitivo nem inventa provas.' },
];
const results = [];
for (const scenario of cases) {
  const answer = await voice.reply([...(scenario.history ?? []), { role: 'user', content: scenario.user }], AbortSignal.timeout(60_000), scenario.context);
  results.push({ title: scenario.title, criterion: scenario.criterion, user: scenario.user, ...answer });
  console.log(JSON.stringify(results.at(-1)));
}
mkdirSync('.local', { recursive: true });
writeFileSync('.local/character-evaluation.json', JSON.stringify({ model: config.model, at: new Date().toISOString(), fictional: true, results }, null, 2));
