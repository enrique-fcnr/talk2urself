-- Run inside a transaction AFTER defining talk_apply_language, then ROLLBACK.
-- Random synthetic owners; no real profile, conversation, or memory is changed.
do $$
declare owner uuid := gen_random_uuid(); other_owner uuid := gen_random_uuid();
  source uuid := gen_random_uuid(); foreign_source uuid := gen_random_uuid();
  next_source uuid := gen_random_uuid(); payload jsonb; result jsonb; rejected boolean := false;
begin
  if has_function_privilege('anon','public.talk_apply_language(uuid,uuid,integer,jsonb)','execute')
    or has_function_privilege('authenticated','public.talk_apply_language(uuid,uuid,integer,jsonb)','execute')
    or not has_function_privilege('service_role','public.talk_apply_language(uuid,uuid,integer,jsonb)','execute')
    then raise exception 'Function permissions failed'; end if;
  insert into public.talk_profiles(user_id,summary,version) values(owner,'Original summary',3),(other_owner,'Other owner',0);
  insert into public.talk_categories(user_id,key,label,description,color)
    values(owner,'expressions','Expressions','Synthetic category','#8899aa');
  insert into public.talk_turns(id,user_id,user_text,assistant_text)
    values(source,owner,'Pô, vamos pensar, tá ligado?','Synthetic answer'),
      (foreign_source,other_owner,'Other user text','Other answer');
  payload := jsonb_build_array(jsonb_build_object('slot','memory.marker','category','expressions',
    'basis','observed','status','known','value','Uses a marker in informal questions.',
    'evidence','Pô, vamos pensar, tá ligado?', 'embedding',to_jsonb(array_fill(0.1::real,array[1536]))));
  -- Same role as the app, with existing RLS and table permissions.
  set local role service_role;
  result := public.talk_apply_language(owner,source,3,payload);
  if result<>jsonb_build_object('stale',false,'applied',1) then raise exception 'Initial write failed'; end if;
  if (select summary from public.talk_profiles where user_id=owner)<>'Original summary'
    or (select version from public.talk_profiles where user_id=owner)<>3
    or (select count(*) from public.talk_turns where user_id=owner)<>1
    then raise exception 'Background changed conversation'; end if;
  result := public.talk_apply_language(owner,source,3,payload);
  if (result->>'applied')::integer<>0 or (select count(*) from public.talk_memories where user_id=owner)<>1
    then raise exception 'Retry was not idempotent'; end if;
  result := public.talk_apply_language(owner,source,2,payload);
  if result<>jsonb_build_object('stale',true,'applied',0) then raise exception 'Stale context was accepted'; end if;
  begin
    perform public.talk_apply_language(owner,foreign_source,3,payload);
  exception when others then rejected := true; end;
  if not rejected then raise exception 'Foreign source was accepted'; end if;
  -- The foreground can still commit with its original expected version.
  perform public.talk_commit_turn_v2(owner,next_source,'Não uso mais esse marcador.','Correction accepted.',3,'New summary',
    jsonb_build_array(jsonb_build_object('slot','memory.marker','category','expressions',
      'basis','stated','status','known','value','Does not use the marker.', 'evidence','Não uso mais esse marcador.',
      'embedding',to_jsonb(array_fill(0.2::real,array[1536])))));
  if (select version from public.talk_profiles where user_id=owner)<>4 then raise exception 'Foreground revision failed'; end if;
  perform public.talk_apply_language(owner,next_source,4,
    jsonb_set(jsonb_set(payload,'{0,evidence}','"Não uso mais esse marcador."'),'{0,value}','"Inferred conflicting pattern."'));
  if (select value from public.talk_memories where user_id=owner and slot='memory.marker' and active)<>'Does not use the marker.'
    or (select count(*) from public.talk_memories where user_id=owner)<>2
    then raise exception 'Explicit correction or history lost'; end if;
  -- Later source and broad refusal also prevent background resurrection.
  perform public.talk_apply_language(owner,source,4,
    jsonb_set(jsonb_set(payload,'{0,basis}','"stated"'),'{0,value}','"Older preference."'));
  if (select value from public.talk_memories where user_id=owner and slot='memory.marker' and active)<>'Does not use the marker.'
    then raise exception 'Late source overwrote correction'; end if;
  perform public.talk_commit_turn_v2(owner,gen_random_uuid(),'Não quero registrar meu estilo.','Understood.',4,'Refusal preserved',
    jsonb_build_array(jsonb_build_object('slot','memory.declined_expressions','category','expressions',
      'basis','stated','status','declined','value','', 'evidence','Não quero registrar meu estilo.','embedding',null)));
  result := public.talk_apply_language(owner,source,5,payload);
  if (result->>'applied')::integer<>0 or exists(select 1 from public.talk_memories where user_id=owner and active and status='known')
    then raise exception 'Refusal was ignored'; end if;
  reset role;
end $$;
select 'PASS: write, retry, source isolation, stale context, corrections, refusals, history and foreground compatibility' as verification;
