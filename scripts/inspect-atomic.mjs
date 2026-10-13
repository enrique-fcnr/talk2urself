import fs from 'node:fs/promises';
const {SUPABASE_URL:url,SUPABASE_SECRET_KEY:key,LOCAL_USER_ID:user}=process.env;
async function get(table,select,extra='') {
  const response=await fetch(`${url}/rest/v1/${table}?user_id=eq.${user}&select=${select}${extra}`,{headers:{apikey:key}});
  if(!response.ok) throw new Error('Não foi possível consultar os registros para a migração.');
  return response.json();
}
const memories=await get('talk_memories','id,slot,value,evidence,source_turn_id,active,status,created_at','&order=created_at.asc&limit=1000');
const turns=await get('talk_turns','id,user_text,sequence','&order=sequence.asc&limit=1000');
const profiles=await get('talk_profiles','version,summary');
await fs.mkdir('.local/atomic-migration',{recursive:true});
await fs.writeFile('.local/atomic-migration/before.json',JSON.stringify({memories,turns,profiles},null,2));
console.log(JSON.stringify({version:profiles[0]?.version,active:memories.filter(m=>m.active),origins:turns},null,2));
