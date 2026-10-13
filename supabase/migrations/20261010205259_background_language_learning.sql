-- Compatible expansion: foreground commit functions and existing records remain unchanged.
begin;
create or replace function public.talk_apply_language(p_user_id uuid, p_source_turn_id uuid,
  p_expected_version integer, p_updates jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare current_version integer; source_text text; source_sequence bigint;
  item jsonb; previous public.talk_memories%rowtype; fact_key text; cat text; applied integer := 0;
begin
  select version into current_version from public.talk_profiles where user_id=p_user_id for update;
  if not found then raise exception 'Perfil inexistente'; end if;
  if current_version <> p_expected_version then return jsonb_build_object('stale',true,'applied',0); end if;
  select user_text, sequence into source_text, source_sequence from public.talk_turns where user_id=p_user_id and id=p_source_turn_id;
  if not found then raise exception 'Origem inexistente'; end if;
  if p_updates is null or jsonb_typeof(p_updates)<>'array' or jsonb_array_length(p_updates)>3 then raise exception 'Atualização inválida'; end if;
  if (select count(distinct value->>'slot') from jsonb_array_elements(p_updates))<>jsonb_array_length(p_updates) then raise exception 'Chaves repetidas'; end if;
  for item in select * from jsonb_array_elements(p_updates) loop
    fact_key := item->>'slot'; cat := item->>'category';
    if coalesce(fact_key,'') !~ '^memory\.[a-z0-9_]{1,48}$'
      or coalesce(cat,'') not in ('expressions','speaking_preferences','reasoning_style')
      or coalesce(item->>'status','') <> 'known' or coalesce(item->>'basis','') not in ('stated','observed')
      or (item->>'basis'='observed' and cat='speaking_preferences')
      or coalesce(char_length(item->>'value'),0) not between 1 and 600
      or coalesce(char_length(item->>'evidence'),0) not between 3 and 500
      or position(item->>'evidence' in source_text)=0
      or not exists(select 1 from public.talk_categories where user_id=p_user_id and key=cat)
      then raise exception 'Linguagem ou evidência inválida'; end if;
    -- Refusals and explicit preferences always outrank an inferred pattern.
    if exists(select 1 from public.talk_memories where user_id=p_user_id and active and status='declined'
      and (slot=fact_key or slot='memory.declined_' || cat)) then continue; end if;
    select * into previous from public.talk_memories where user_id=p_user_id and slot=fact_key and active;
    if found then
      if previous.basis='stated' and item->>'basis'='observed' then continue; end if;
      if previous.value=item->>'value' and previous.status='known' and previous.basis=item->>'basis' and previous.category_key=cat then continue; end if;
      if exists(select 1 from public.talk_turns where user_id=p_user_id and id=previous.source_turn_id and sequence>source_sequence) then continue; end if;
    end if;
    update public.talk_memories set active=false where user_id=p_user_id and slot=fact_key and active;
    insert into public.talk_memories(user_id,slot,value,evidence,basis,status,source_turn_id,embedding,category_key)
      values(p_user_id,fact_key,item->>'value',item->>'evidence',item->>'basis','known',p_source_turn_id,
        (item->'embedding')::text::extensions.vector,cat);
    applied := applied + 1;
  end loop;
  -- version remains the foreground conversation revision. A later foreground
  -- commit supersedes this source; the background never changes its summary.
  if applied>0 then update public.talk_profiles set updated_at=now() where user_id=p_user_id; end if;
  return jsonb_build_object('stale',false,'applied',applied);
end $$;
revoke all on function public.talk_apply_language(uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.talk_apply_language(uuid,uuid,integer,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
