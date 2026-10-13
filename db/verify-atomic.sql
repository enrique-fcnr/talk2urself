select 'Tabelas privadas com RLS' as check_name,
  (select count(*)=4 and bool_and(relrowsecurity) from pg_class where oid in
    ('public.talk_profiles'::regclass,'public.talk_turns'::regclass,'public.talk_memories'::regclass,'public.talk_categories'::regclass)) as passed
union all select 'Categorias inacessíveis a clientes públicos',
  not has_table_privilege('anon','public.talk_categories','SELECT') and not has_table_privilege('authenticated','public.talk_categories','SELECT')
union all select 'Funções novas restritas ao servidor',
  not has_function_privilege('anon','public.talk_load_context_v2(uuid,extensions.vector)','EXECUTE')
  and not has_function_privilege('authenticated','public.talk_commit_turn_v2(uuid,uuid,text,text,integer,text,jsonb)','EXECUTE')
  and not has_function_privilege('anon','public.talk_split_legacy_memory(uuid,uuid,integer,jsonb)','EXECUTE')
union all select 'Fatos ativos individuais e categorizados',
  not exists(select 1 from public.talk_memories where active and status='known' and (slot not like 'memory.%' or category_key is null))
union all select 'Origem de cada fato confere com a fala',
  not exists(select 1 from public.talk_memories m join public.talk_turns t on t.id=m.source_turn_id and t.user_id=m.user_id
    where m.active and m.status='known' and position(m.evidence in t.user_text)=0)
union all select 'Embeddings originais com 1536 dimensões',
  not exists(select 1 from public.talk_memories where active and status='known' and extensions.vector_dims(embedding)<>1536)
union all select 'Bloco antigo e histórico preservados',
  exists(select 1 from public.talk_memories where not active and slot='interests')
  and exists(select 1 from public.talk_memories where active and migrated_from is not null);
