-- Expansão compatível: preserva funções v1, histórico e versões antigas.
begin;
create table public.talk_categories (
  user_id uuid not null references public.talk_profiles(user_id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9_]{1,48}$'),
  label text not null check (char_length(label) between 1 and 60),
  description text not null check (char_length(description) between 1 and 200),
  color text not null check (color ~ '^#[0-9a-f]{6}$'),
  embedding extensions.vector(1536),
  primary key (user_id, key)
);
alter table public.talk_categories enable row level security;
revoke all on public.talk_categories from anon, authenticated;
grant select, insert, update, delete on public.talk_categories to service_role;
alter table public.talk_memories add column category_key text;
alter table public.talk_memories add column migrated_from uuid references public.talk_memories(id);
alter table public.talk_memories add constraint talk_memories_category_fk foreign key (user_id, category_key)
  references public.talk_categories(user_id, key);
create index talk_memories_category_idx on public.talk_memories(user_id, category_key) where active;
create index talk_memories_migrated_idx on public.talk_memories(migrated_from) where migrated_from is not null;
-- A antiga restrição de padrões observados era ligada ao campo agregado.
do $$ declare c record; begin
  for c in select conname from pg_constraint where conrelid = 'public.talk_memories'::regclass
    and contype = 'c' and pg_get_constraintdef(oid) like '%basis%observed%expressions%'
  loop execute format('alter table public.talk_memories drop constraint %I', c.conname); end loop;
end $$;
alter table public.talk_memories add constraint talk_memories_observed_topic_check check
  (basis <> 'observed' or slot in ('expressions','reasoning_style') or
    (slot like 'memory.%' and category_key is not null and category_key in ('expressions','reasoning_style')));

create function public.talk_load_context_v2(p_user_id uuid, p_embedding extensions.vector(1536) default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  insert into public.talk_profiles(user_id) values(p_user_id) on conflict do nothing;
  select jsonb_build_object('summary', p.summary, 'version', p.version,
    'categories', coalesce((select jsonb_agg(jsonb_build_object('key',c.key,'label',c.label,'description',c.description,'color',c.color) order by c.key)
      from public.talk_categories c where c.user_id = p_user_id), '[]'::jsonb),
    -- Inspeção mostra fatos individuais; no prompt, o perfil básico fica pequeno.
    'profile', coalesce((select jsonb_agg(to_jsonb(f) - 'embedding' - 'user_id' - 'active' order by f.created_at)
      from (select m.* from public.talk_memories m where m.user_id = p_user_id and m.active
        and (p_embedding is null or m.category_key in ('identity','speaking_preferences','expressions','reasoning_style') or m.status = 'declined')
        order by m.created_at desc limit 200) f), '[]'::jsonb),
    'relevant', coalesce((select jsonb_agg(to_jsonb(f) - 'embedding' - 'user_id' - 'active') from
      (select m.* from public.talk_memories m where m.user_id = p_user_id and m.active and m.status = 'known'
        and p_embedding is not null and 1 - (m.embedding operator(extensions.<=>) p_embedding) >= .35
        order by m.embedding operator(extensions.<=>) p_embedding limit 12) f), '[]'::jsonb),
    -- Chaves e valores para reconhecer repetição/correção; vetores não vão para o modelo.
    'catalog', coalesce((select jsonb_agg(jsonb_build_object('slot',f.slot,'value',f.value,'category',f.category_key,'status',f.status)) from
      (select m.* from public.talk_memories m where m.user_id = p_user_id and m.active order by m.created_at desc limit 200) f), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('user_text',r.user_text,'assistant_text',r.assistant_text) order by r.sequence) from
      (select t.* from public.talk_turns t where t.user_id = p_user_id order by t.sequence desc limit 10) r), '[]'::jsonb)
  ) into result from public.talk_profiles p where p.user_id = p_user_id;
  return result;
end $$;

create function public.talk_commit_turn_v2(p_user_id uuid, p_turn_id uuid, p_user_text text, p_assistant_text text,
  p_expected_version integer, p_summary text, p_updates jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare current_version integer; item jsonb; previous public.talk_memories%rowtype; fact_key text; cat text;
begin
  select version into current_version from public.talk_profiles where user_id = p_user_id for update;
  if not found then raise exception 'Perfil inexistente'; end if;
  if exists(select 1 from public.talk_turns where id = p_turn_id and user_id = p_user_id) then
    return jsonb_build_object('version',current_version,'duplicate',true); end if;
  if current_version <> p_expected_version then raise exception 'Contexto desatualizado'; end if;
  if jsonb_typeof(p_updates) <> 'array' or jsonb_array_length(p_updates) > 6 then raise exception 'Atualização inválida'; end if;
  if (select count(distinct value->>'slot') from jsonb_array_elements(p_updates)) <> jsonb_array_length(p_updates) then raise exception 'Chaves repetidas'; end if;
  insert into public.talk_turns(id,user_id,user_text,assistant_text) values(p_turn_id,p_user_id,p_user_text,p_assistant_text);
  for item in select * from jsonb_array_elements(p_updates) loop
    fact_key := item->>'slot'; cat := item->>'category';
    if fact_key is null or fact_key !~ '^memory\.[a-z0-9_]{1,48}$' or cat is null
      or not exists(select 1 from public.talk_categories where user_id=p_user_id and key=cat)
      or coalesce(char_length(item->>'evidence'),0) < 3 or position((item->>'evidence') in p_user_text) = 0 then raise exception 'Fato ou evidência inválida'; end if;
    -- Uma recusa ampla usa uma chave explícita e retira os fatos do assunto do contexto.
    if item->>'status'='declined' and fact_key = 'memory.declined_' || cat then
      update public.talk_memories set active=false where user_id=p_user_id and category_key=cat and active and status='known';
    end if;
    select * into previous from public.talk_memories where user_id=p_user_id and slot=fact_key and active;
    if found and previous.value=item->>'value' and previous.status=item->>'status' and previous.basis=item->>'basis'
      and previous.category_key=cat then continue; end if;
    update public.talk_memories set active=false where user_id=p_user_id and slot=fact_key and active;
    insert into public.talk_memories(user_id,slot,value,evidence,basis,status,source_turn_id,embedding,category_key)
      values(p_user_id,fact_key,item->>'value',item->>'evidence',item->>'basis',item->>'status',p_turn_id,
        case when item->>'status'='known' then (item->'embedding')::text::extensions.vector else null end,cat);
  end loop;
  update public.talk_profiles set summary=p_summary, version=version+1, updated_at=now() where user_id=p_user_id;
  return jsonb_build_object('version',current_version+1,'duplicate',false);
end $$;

-- Conversão de um bloco antigo: evidências conferidas na fala de origem de cada fato.
create function public.talk_split_legacy_memory(p_user_id uuid, p_legacy_id uuid, p_expected_version integer, p_facts jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare old public.talk_memories%rowtype; current_version integer; item jsonb;
begin
  select version into current_version from public.talk_profiles where user_id=p_user_id for update;
  select * into old from public.talk_memories where user_id=p_user_id and id=p_legacy_id;
  if not found then raise exception 'Memória inexistente'; end if;
  if not old.active then
    if exists(select 1 from public.talk_memories where migrated_from=p_legacy_id and user_id=p_user_id) then
      return jsonb_build_object('duplicate',true,'version',current_version); end if;
    raise exception 'Memória não está ativa';
  end if;
  if current_version <> p_expected_version then raise exception 'Contexto desatualizado'; end if;
  if jsonb_typeof(p_facts)<>'array' or jsonb_array_length(p_facts) not between 1 and 20 then raise exception 'Conversão inválida'; end if;
  for item in select * from jsonb_array_elements(p_facts) loop
    if coalesce(item->>'slot','') !~ '^memory\.[a-z0-9_]{1,48}$' or coalesce(char_length(item->>'evidence'),0)<3
      or not exists(select 1 from public.talk_turns where user_id=p_user_id and id=(item->>'source_turn_id')::uuid
        and position(item->>'evidence' in user_text)>0) then raise exception 'Origem inválida'; end if;
    if exists(select 1 from public.talk_memories where user_id=p_user_id and slot=item->>'slot' and active) then raise exception 'Fato já existe'; end if;
    insert into public.talk_memories(user_id,slot,value,evidence,basis,status,source_turn_id,embedding,category_key,migrated_from)
      values(p_user_id,item->>'slot',item->>'value',item->>'evidence','stated','known',(item->>'source_turn_id')::uuid,
        (item->'embedding')::text::extensions.vector,item->>'category',p_legacy_id);
  end loop;
  update public.talk_memories set active=false where id=p_legacy_id;
  update public.talk_profiles set version=version+1,updated_at=now() where user_id=p_user_id;
  return jsonb_build_object('duplicate',false,'version',current_version+1);
end $$;
revoke all on function public.talk_load_context_v2(uuid,extensions.vector) from public,anon,authenticated;
revoke all on function public.talk_commit_turn_v2(uuid,uuid,text,text,integer,text,jsonb) from public,anon,authenticated;
revoke all on function public.talk_split_legacy_memory(uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.talk_load_context_v2(uuid,extensions.vector) to service_role;
grant execute on function public.talk_commit_turn_v2(uuid,uuid,text,text,integer,text,jsonb) to service_role;
grant execute on function public.talk_split_legacy_memory(uuid,uuid,integer,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
