import fs from 'node:fs/promises';
import {createMemoryService,readMemoryConfig} from '../apps/server/src/memory.ts';
const config=readMemoryConfig(); if(!config) throw new Error('Configure a memória no servidor.');
const signal=AbortSignal.timeout(90_000);
async function request(path,body,method='POST') {
  const response=await fetch(`${config.url}/rest/v1/${path}`,{method,headers:{apikey:config.secret,'Content-Type':'application/json',Prefer:'return=representation'},body:body===undefined?undefined:JSON.stringify(body),signal});
  if(!response.ok) throw new Error('A conversão não foi concluída. Os registros anteriores continuam disponíveis.');
  return response.json();
}
const snapshot=JSON.parse(await fs.readFile('.local/atomic-migration/before.json','utf8'));
const legacy=snapshot.memories.find(m=>m.active&&m.slot==='interests');
if(!legacy || !legacy.value.includes('jogar bola') || !legacy.value.includes('azul')) throw new Error('Revise o plano de conversão: o bloco esperado não está no snapshot.');
const football=snapshot.turns.find(t=>t.user_text==='Eu gosto de jogar bola quando eu tenho tempo livre.');
const blue=snapshot.turns.find(t=>t.user_text==='A minha cor favorita é azul.');
if(!football||!blue) throw new Error('As falas originais não foram encontradas; não será atribuída uma origem inventada.');
const plan=[{slot:'memory.esporte_preferido',category:'interests',value:'Gosta de jogar bola quando tem tempo livre.',evidence:football.user_text,source_turn_id:football.id},
  {slot:'memory.cor_favorita',category:'preferences',value:'Sua cor favorita é azul.',evidence:blue.user_text,source_turn_id:blue.id}];
const service=createMemoryService(config);
// Inicializa as categorias uma vez. Esta etapa gera embeddings de categorias.
const context=await service.load('Preparação da organização de memórias individuais.',signal);
const response=await fetch('https://api.openai.com/v1/embeddings',{method:'POST',headers:{Authorization:`Bearer ${config.openaiKey}`,'Content-Type':'application/json'},
  body:JSON.stringify({model:'text-embedding-3-small',dimensions:1536,input:plan.map(fact=>fact.value)}),signal});
if(!response.ok) throw new Error('Não foi possível preparar os embeddings. O bloco anterior foi preservado.');
const data=await response.json();
const vectors=data.data?.sort((a,b)=>a.index-b.index);
if(vectors?.length!==plan.length||vectors.some((item,index)=>item.index!==index||!Array.isArray(item.embedding)||item.embedding.length!==1536||item.embedding.some(v=>typeof v!=='number'||!Number.isFinite(v)))) throw new Error('Embeddings inválidos; nenhuma memória foi substituída.');
const result=await request('rpc/talk_split_legacy_memory',{p_user_id:config.userId,p_legacy_id:legacy.id,p_expected_version:context.version,
  p_facts:plan.map((fact,index)=>({...fact,embedding:vectors[index].embedding}))});
// A altura já era um fato independente. Acrescenta só a etiqueta, sem recriar o vetor.
const height=snapshot.memories.find(m=>m.active&&m.slot==='memory.altura');
if(height) await request(`talk_memories?user_id=eq.${config.userId}&id=eq.${height.id}&category_key=is.null`,{category_key:'identity'},'PATCH');
await fs.writeFile('.local/atomic-migration/result.json',JSON.stringify({legacyId:legacy.id,version:result.version,plan},null,2));
const view=await service.vectors(signal);
console.log(JSON.stringify({converted:!result.duplicate,count:view.items.length,facts:view.items.map(({value,evidence,category})=>({value,evidence,category})),embeddingTokens:data.usage?.total_tokens}));
