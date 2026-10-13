// Teste curto de contrato com a API real. Não grava dados sintéticos no Supabase e não gera voz.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createMemoryService,readMemoryConfig} from '../apps/server/src/memory.ts';
import {createVoiceProvider,readVoiceConfig} from '../apps/server/src/voice.ts';
const memoryConfig=readMemoryConfig(),voiceConfig=readVoiceConfig();
if(!memoryConfig||!voiceConfig) throw new Error('Configure os serviços no servidor.');
const signal=AbortSignal.timeout(90_000);
const service=createMemoryService(memoryConfig);
const context=await service.inspect(signal);
const voice=createVoiceProvider(voiceConfig);
const tests=[
  {text:'Meus hobbies são nadar e tocar violão. Guarde cada preferência separadamente.',check:(answer)=>{
    assert.equal(answer.learning.updates.length,2);assert.notEqual(answer.learning.updates[0].slot,answer.learning.updates[1].slot);
    assert.ok(answer.learning.updates.every(fact=>fact.category==='interests'));
  }},
  {text:'Quero corrigir uma informação: minha cor favorita agora é verde, e eu continuo gostando de jogar bola.',check:(answer)=>{
    const correction=answer.learning.updates.find(fact=>fact.slot==='memory.cor_favorita');
    assert.ok(correction);assert.match(correction.value,/verde/);assert.ok(!answer.learning.updates.some(fact=>fact.slot==='memory.esporte_preferido'));
  }},
  {text:'Tenho um cachorro chamado Thor. Quero organizar as informações sobre ele numa categoria própria de animais de estimação.',check:(answer)=>{
    assert.equal(answer.learning.updates.length,1);
    assert.ok(!context.categories.some(category=>category.key===answer.learning.updates[0].category));
  }},
];
for(const item of process.argv.includes('--pets-only') ? tests.slice(2) : tests.slice(0,2)) {
  const answer=await voice.reply([...context.recent,{role:'user',content:item.text}],signal,context);
  item.check(answer);
  await fs.appendFile('.local/usage.jsonl',JSON.stringify({service:'llm-evaluation',model:voice.model,inputTokens:answer.inputTokens,outputTokens:answer.outputTokens,cachedTokens:answer.cachedTokens})+'\n');
  console.log(JSON.stringify({passed:true,updates:answer.learning.updates.length,inputTokens:answer.inputTokens,outputTokens:answer.outputTokens}));
}
console.log('Contrato real confirmado; nenhum fato sintético foi salvo e nenhuma chamada de voz foi feita.');
