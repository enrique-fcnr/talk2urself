-- Execute after defining the migration in a transaction, then ROLLBACK.
do $$
declare owner uuid:=gen_random_uuid(); other_owner uuid:=gen_random_uuid(); source uuid; first_source uuid; second_source uuid;
  current_source uuid; candidate uuid; data jsonb; payload jsonb; result jsonb; rejected boolean:=false; i integer;
  started timestamptz:=clock_timestamp();
begin
  if has_table_privilege('anon','public.talk_language_candidates','select') or has_table_privilege('authenticated','public.talk_language_evidence','select')
    or has_function_privilege('anon','public.talk_load_language_candidates(uuid,uuid)','execute') then raise exception 'Public access leak'; end if;
  insert into public.talk_profiles(user_id) values(owner),(other_owner);
  insert into public.talk_categories(user_id,key,label,description,color) values(owner,'expressions','Expressions','Synthetic category','#8899aa');
  set local role service_role;
  for i in 1..13 loop
    source:=gen_random_uuid();
    if i=1 then first_source:=source; elsif i=7 then second_source:=source; elsif i=13 then current_source:=source; end if;
    perform public.talk_commit_turn_v2(owner,source,
      case when i in(1,7,13) then 'Vamos comparar com calma, tá ligado?' else 'Outro assunto completamente diferente.' end,
      'Resposta do personagem, pô, tá ligado.',i-1,'Resumo preservado','[]'::jsonb);
  end loop;
  data:=public.talk_load_language_candidates(owner,current_source);
  select id into candidate from public.talk_language_candidates where user_id=owner and expression='tá ligado';
  if candidate is null or not exists(select 1 from jsonb_array_elements(data->'candidates') where value->>'id'=candidate::text)
    or (select count(*) from public.talk_language_evidence where user_id=owner and candidate_id=candidate)<>3 then raise exception 'Spaced evidence not collected'; end if;
  if exists(select 1 from public.talk_language_candidates where user_id=owner and expression='pô') then raise exception 'Assistant speech collected'; end if;
  if exists(select 1 from jsonb_array_elements(data->'sources') where value->>'turnId'=first_source::text)
    then raise exception 'Test did not leave recent window'; end if;
  perform public.talk_record_language_candidates(owner,current_source);
  if (select count(*) from public.talk_language_evidence where user_id=owner and candidate_id=candidate)<>3 then raise exception 'Duplicate evidence'; end if;
  begin
    perform public.talk_load_language_candidates(other_owner,current_source);
  exception when others then rejected:=true; end;
  if not rejected then raise exception 'Foreign source accepted'; end if;
  payload:=jsonb_build_array(jsonb_build_object('slot','memory.ta_ligado','category','expressions','basis','observed','status','known',
    'value','Usa tá ligado para buscar confirmação.','evidence','Vamos comparar com calma, tá ligado?',
    'embedding',to_jsonb(array_fill(.1::real,array[1536])), 'candidateIds',jsonb_build_array(candidate),
    'languageEvidence',jsonb_build_array(jsonb_build_object('turnId',first_source,'text','Vamos comparar com calma, tá ligado?'),
      jsonb_build_object('turnId',second_source,'text','Vamos comparar com calma, tá ligado?'),
      jsonb_build_object('turnId',current_source,'text','Vamos comparar com calma, tá ligado?'))));
  rejected:=false;
  begin
    perform public.talk_apply_language_v2(owner,current_source,13,jsonb_set(payload,'{0,languageEvidence,0,text}','"Vamos comparar com calma"'::jsonb),array[]::uuid[]);
  exception when others then rejected:=true; end;
  if not rejected then raise exception 'Unrelated literal proof accepted'; end if;
  result:=public.talk_apply_language_v2(owner,current_source,13,payload,array[]::uuid[]);
  if (result->>'applied')::integer<>1 or (select state from public.talk_language_candidates where id=candidate)<>'confirmed'
    or (select count(*) from public.talk_turns where user_id=owner)<>13 or (select version from public.talk_profiles where user_id=owner)<>13
    or (select summary from public.talk_profiles where user_id=owner)<>'Resumo preservado' then raise exception 'Promotion broke invariants'; end if;
  result:=public.talk_apply_language_v2(owner,current_source,13,payload,array[]::uuid[]);
  if (result->>'applied')::integer<>0 or (select count(*) from public.talk_memories where user_id=owner and slot='memory.ta_ligado')<>1 then raise exception 'Promotion retry duplicated memory'; end if;
  select id into candidate from public.talk_language_candidates where user_id=owner and expression='comparar';
  result:=public.talk_apply_language_v2(owner,current_source,13,'[]'::jsonb,array[candidate]);
  if (select state from public.talk_language_candidates where id=candidate)<>'rejected' or (result->>'applied')::integer<>0
    then raise exception 'Candidate rejection failed'; end if;
  select id into candidate from public.talk_language_candidates where user_id=owner and expression='tá ligado';
  -- Existing writers remain compatible; confirmed candidate is not re-collected.
  perform public.talk_commit_turn_v2(owner,gen_random_uuid(),'Outra pergunta, tá ligado?','Resposta.',13,'Novo resumo','[]'::jsonb);
  if (select count(*) from public.talk_language_evidence where user_id=owner and candidate_id=candidate)<>3 then raise exception 'Confirmed candidate expanded'; end if;
  result:=public.talk_apply_language_v2(owner,current_source,13,payload,array[]::uuid[]);
  if (result->>'stale')::boolean is not true then raise exception 'Late analysis overwrote correction'; end if;
  -- Source references and candidate rows remain bounded under repeated collection.
  for i in 1..8 loop
    insert into public.talk_turns(id,user_id,user_text,assistant_text) values(gen_random_uuid(),owner,'Pô, uma nova fala para comparar.','Resposta.');
  end loop;
  if exists(select 1 from public.talk_language_evidence where user_id=owner group by candidate_id having count(*)>6)
    or (select count(*) from public.talk_language_candidates where user_id=owner)>500 then raise exception 'Capacity exceeded'; end if;
  -- Refusal stops new collection without deleting original history.
  perform public.talk_commit_turn_v2(owner,gen_random_uuid(),'Não quero registrar meu estilo.','Entendido.',14,'Recusa preservada',
    jsonb_build_array(jsonb_build_object('slot','memory.declined_expressions','category','expressions','basis','stated','status','declined',
      'value','','evidence','Não quero registrar meu estilo.','embedding',null)));
  insert into public.talk_turns(id,user_id,user_text,assistant_text) values(gen_random_uuid(),owner,'zebraexpressao inédita','Resposta.');
  if exists(select 1 from public.talk_language_candidates where user_id=owner and expression='zebraexpressao') then raise exception 'Refusal ignored'; end if;
  data:=public.talk_load_language_candidates(owner,source);
  if jsonb_array_length(data->'candidates')<>0 then raise exception 'Refused candidates exposed'; end if;
  -- Exercise the full cap: weak rows may be reused, but old references never become new proofs.
  insert into public.talk_language_candidates(user_id,expression,first_seen_at,last_seen_at,last_sequence)
    select other_owner,'weak'||n,now()-interval '1 day',now()-interval '1 day',0 from generate_series(1,500) n;
  source:=gen_random_uuid();
  insert into public.talk_turns(id,user_id,user_text,assistant_text) values(source,other_owner,'novogatilho exclusivo','Resposta.');
  if (select count(*) from public.talk_language_candidates where user_id=other_owner)<>500
    or not exists(select 1 from public.talk_language_candidates where user_id=other_owner and expression='novogatilho' and generation=1)
    or (select count(*) from public.talk_turns where user_id=other_owner)<>1 then raise exception 'Cap recycling broke preservation'; end if;
  data:=public.talk_load_language_candidates(other_owner,source);
  if jsonb_array_length(data->'candidates')<>0 or (data->>'atLimit')::boolean is not true then raise exception 'Recycled evidence inherited old proofs'; end if;
  reset role;
  raise notice 'Synthetic verification took % milliseconds',extract(epoch from clock_timestamp()-started)*1000;
end $$;
select 'PASS: spaced turns 1/7/13, user-only evidence, replay, promotion, source isolation, limits, refusals and existing writers' as verification;
