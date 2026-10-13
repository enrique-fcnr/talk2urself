-- Additive migration. Existing conversation, memory and commit functions remain intact.
begin;
create table public.talk_language_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.talk_profiles(user_id) on delete cascade,
  expression text not null check(char_length(expression) between 2 and 60),
  state text not null default 'pending' check(state in ('pending','confirmed','rejected','expired')),
  first_seen_at timestamptz not null, last_seen_at timestamptz not null,
  last_sequence bigint not null, memory_slot text,
  generation integer not null default 0,
  unique(user_id,expression), unique(user_id,id)
);
create table public.talk_language_evidence (
  user_id uuid not null, candidate_id uuid not null,
  position integer not null check(position between 1 and 6), source_turn_id uuid not null,
  seen_at timestamptz not null,
  generation integer not null default 0,
  primary key(user_id,candidate_id,position), unique(user_id,candidate_id,source_turn_id),
  foreign key(user_id,candidate_id) references public.talk_language_candidates(user_id,id) on delete cascade,
  foreign key(user_id,source_turn_id) references public.talk_turns(user_id,id) on delete cascade
);
create index talk_language_evidence_source_idx on public.talk_language_evidence(user_id,source_turn_id);
create index talk_language_candidates_pending_idx on public.talk_language_candidates(user_id,last_seen_at) where state='pending';
alter table public.talk_language_candidates enable row level security;
alter table public.talk_language_evidence enable row level security;
revoke all on public.talk_language_candidates,public.talk_language_evidence from public,anon,authenticated;
grant select,insert,update on public.talk_language_candidates,public.talk_language_evidence to service_role;

create function public.talk_language_words(p_text text) returns text[]
language sql immutable security invoker set search_path='' as $$
  select coalesce(array_agg(m[1]),array[]::text[]) from regexp_matches(lower(p_text),'[[:alnum:]]+','g') as words(m)
$$;

create function public.talk_record_language_candidates(p_user_id uuid,p_source_turn_id uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare source public.talk_turns%rowtype; tokens text[]; phrase text;
  candidate public.talk_language_candidates%rowtype; used integer; target_position integer;
  ignored text[] := array['a','o','as','os','um','uma','de','da','do','das','dos','e','é','em','no','na','que','eu','ele','ela','você','para','pra','por','com','se','não','mais','isso','essa','esse','me','minha','meu','tem','ter','quero'];
begin
  perform 1 from public.talk_profiles where user_id=p_user_id for update;
  select * into source from public.talk_turns where user_id=p_user_id and id=p_source_turn_id;
  if not found then raise exception 'Origem inexistente'; end if;
  -- A broad refusal prevents collection, not merely use in a later prompt.
  if exists(select 1 from public.talk_memories where user_id=p_user_id and active and status='declined' and slot='memory.declined_expressions') then return; end if;
  update public.talk_language_candidates set state='expired' where user_id=p_user_id and state='pending' and last_seen_at<now()-interval '90 days';
  tokens := public.talk_language_words(source.user_text);
  select count(*) into used from public.talk_language_candidates where user_id=p_user_id;
  for phrase in
    select q.phrase from (
      select distinct array_to_string(tokens[i:i+w-1],' ') as phrase
      from generate_series(1,coalesce(array_length(tokens,1),0)) i cross join generate_series(1,3) w
      where i+w-1<=array_length(tokens,1) and exists(select 1 from unnest(tokens[i:i+w-1]) token where token<>all(ignored))
    ) q where char_length(q.phrase) between 2 and 60
    order by exists(select 1 from public.talk_language_candidates c where c.user_id=p_user_id and c.expression=q.phrase) desc,
      char_length(q.phrase),q.phrase limit 96
  loop
    select * into candidate from public.talk_language_candidates where user_id=p_user_id and expression=phrase;
    if not found then
      if used>=500 then
        select c.* into candidate from public.talk_language_candidates c where c.user_id=p_user_id and c.state<>'confirmed' and c.last_sequence<source.sequence-6
          and (c.state in ('rejected','expired') or (select count(*) from public.talk_language_evidence e where e.user_id=p_user_id and e.candidate_id=c.id and e.generation=c.generation)<3)
          order by case when c.state in ('rejected','expired') then 0 else 1 end,c.last_seen_at,c.id limit 1;
        if not found then continue; end if;
        update public.talk_language_candidates set expression=phrase,state='pending',first_seen_at=source.created_at,last_seen_at=source.created_at,
          last_sequence=source.sequence,generation=generation+1,memory_slot=null where id=candidate.id returning * into candidate;
      else
        insert into public.talk_language_candidates(user_id,expression,first_seen_at,last_seen_at,last_sequence)
          values(p_user_id,phrase,source.created_at,source.created_at,source.sequence) returning * into candidate;
        used := used+1;
      end if;
    else
      if source.sequence<=candidate.last_sequence or candidate.state in ('confirmed','rejected') then continue; end if;
      update public.talk_language_candidates set last_seen_at=source.created_at,last_sequence=source.sequence,state='pending' where id=candidate.id;
    end if;
    if exists(select 1 from public.talk_language_evidence where user_id=p_user_id and candidate_id=candidate.id and generation=candidate.generation and source_turn_id=p_source_turn_id) then continue; end if;
    select n into target_position from generate_series(1,6) n where not exists(
      select 1 from public.talk_language_evidence e where e.user_id=p_user_id and e.candidate_id=candidate.id and e.generation=candidate.generation and e.position=n) order by n limit 1;
    if target_position is null then
      select position into target_position from public.talk_language_evidence where user_id=p_user_id and candidate_id=candidate.id order by seen_at,position limit 1;
    end if;
    -- Only bounded references are replaced. Original talk_turns are never deleted.
    insert into public.talk_language_evidence(user_id,candidate_id,position,source_turn_id,seen_at,generation)
      values(p_user_id,candidate.id,target_position,p_source_turn_id,source.created_at,candidate.generation)
      on conflict(user_id,candidate_id,position) do update set source_turn_id=excluded.source_turn_id,seen_at=excluded.seen_at,generation=excluded.generation;
  end loop;
end $$;

create function public.talk_capture_language() returns trigger
language plpgsql security invoker set search_path='' as $$
begin perform public.talk_record_language_candidates(new.user_id,new.id); return new; end $$;
create trigger talk_turn_language_candidates after insert on public.talk_turns
  for each row execute function public.talk_capture_language();

create function public.talk_load_language_candidates(p_user_id uuid,p_source_turn_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare source_sequence bigint; result jsonb;
begin
  select sequence into source_sequence from public.talk_turns where user_id=p_user_id and id=p_source_turn_id;
  if not found then raise exception 'Origem inexistente'; end if;
  select jsonb_build_object(
    'sources',coalesce((select jsonb_agg(jsonb_build_object('turnId',r.id,'text',r.user_text) order by r.sequence)
      from(select id,user_text,sequence from public.talk_turns where user_id=p_user_id and sequence<=source_sequence order by sequence desc limit 6) r),'[]'::jsonb),
    'candidates',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'expression',c.expression,'sources',
      (select jsonb_agg(jsonb_build_object('turnId',t.id,'text',t.user_text) order by t.sequence) from public.talk_language_evidence e
        join public.talk_turns t on t.user_id=e.user_id and t.id=e.source_turn_id where e.user_id=p_user_id and e.candidate_id=c.id and e.generation=c.generation
          and t.sequence<=source_sequence and e.seen_at>=now()-interval '90 days')))
      from(select c.* from public.talk_language_candidates c where c.user_id=p_user_id and c.state='pending'
        and not exists(select 1 from public.talk_memories m where m.user_id=p_user_id and m.active and m.status='declined' and m.slot='memory.declined_expressions')
        and exists(select 1 from public.talk_language_evidence where user_id=p_user_id and candidate_id=c.id and generation=c.generation and source_turn_id=p_source_turn_id)
        and (select count(*) from public.talk_language_evidence e join public.talk_turns t on t.user_id=e.user_id and t.id=e.source_turn_id
          where e.user_id=p_user_id and e.candidate_id=c.id and e.generation=c.generation and t.sequence<=source_sequence and e.seen_at>=now()-interval '90 days')>=3
        order by c.last_seen_at desc,char_length(c.expression),c.expression limit 12) c),'[]'::jsonb),
    'atLimit',(select count(*)>=500 from public.talk_language_candidates where user_id=p_user_id)
  ) into result;
  return result;
end $$;

create function public.talk_apply_language_v2(p_user_id uuid,p_source_turn_id uuid,p_expected_version integer,p_updates jsonb,p_rejected_ids uuid[])
returns jsonb language plpgsql security invoker set search_path='' as $$
declare actual integer; item jsonb; proof jsonb; target_candidate uuid; result jsonb;
begin
  select version into actual from public.talk_profiles where user_id=p_user_id for update;
  if actual<>p_expected_version then return jsonb_build_object('stale',true,'applied',0); end if;
  if p_updates is null or jsonb_typeof(p_updates)<>'array' or jsonb_array_length(p_updates)>3 or coalesce(array_length(p_rejected_ids,1),0)>12 then raise exception 'Propostas inválidas'; end if;
  if not exists(select 1 from public.talk_turns where user_id=p_user_id and id=p_source_turn_id) then raise exception 'Origem inexistente'; end if;
  for item in select * from jsonb_array_elements(p_updates) loop
    if item->>'basis'='observed' then
      if jsonb_typeof(item->'languageEvidence') is distinct from 'array' or jsonb_array_length(item->'languageEvidence')<>3 then raise exception 'Três evidências exigidas'; end if;
      if (select count(distinct value->>'turnId') from jsonb_array_elements(item->'languageEvidence'))<>3
        or not exists(select 1 from jsonb_array_elements(item->'languageEvidence') where value->>'turnId'=p_source_turn_id::text) then raise exception 'Origens inválidas'; end if;
      for proof in select * from jsonb_array_elements(item->'languageEvidence') loop
        if coalesce(char_length(proof->>'text'),0) not between 3 and 90 or not exists(select 1 from public.talk_turns
          where user_id=p_user_id and id=(proof->>'turnId')::uuid and position(proof->>'text' in user_text)>0)
          then raise exception 'Evidência inválida'; end if;
      end loop;
    end if;
    if jsonb_typeof(item->'candidateIds') is distinct from 'array' or jsonb_array_length(item->'candidateIds')>3 then raise exception 'Candidatos inválidos'; end if;
    for target_candidate in select value::text::uuid from jsonb_array_elements_text(item->'candidateIds') loop
      if not exists(select 1 from public.talk_language_candidates where user_id=p_user_id and id=target_candidate
        and (state='pending' or (state='confirmed' and memory_slot=item->>'slot'))) then raise exception 'Candidato inválido'; end if;
      if item->>'basis'<>'observed' or exists(select 1 from jsonb_array_elements(item->'languageEvidence') p where not exists(
        select 1 from public.talk_language_evidence e join public.talk_language_candidates c on c.user_id=e.user_id and c.id=e.candidate_id
          where e.user_id=p_user_id and e.candidate_id=target_candidate and e.generation=c.generation and e.source_turn_id=(p.value->>'turnId')::uuid
            and position(' '||c.expression||' ' in ' '||array_to_string(public.talk_language_words(p.value->>'text'),' ')||' ')>0))
        then raise exception 'Candidato sem prova'; end if;
    end loop;
  end loop;
  result := public.talk_apply_language(p_user_id,p_source_turn_id,p_expected_version,p_updates);
  if (result->>'stale')::boolean then return result; end if;
  for item in select * from jsonb_array_elements(p_updates) loop
    -- Only a matching, active observed memory can confirm a candidate.
    if exists(select 1 from public.talk_memories where user_id=p_user_id and active and slot=item->>'slot' and value=item->>'value' and basis=item->>'basis' and status='known') then
      update public.talk_language_candidates set state='confirmed',memory_slot=item->>'slot' where user_id=p_user_id
        and id in(select value::text::uuid from jsonb_array_elements_text(item->'candidateIds'));
    end if;
  end loop;
  update public.talk_language_candidates c set state='rejected' where c.user_id=p_user_id and c.state='pending' and c.id=any(coalesce(p_rejected_ids,array[]::uuid[]))
    and exists(select 1 from public.talk_language_evidence where user_id=p_user_id and candidate_id=c.id and generation=c.generation and source_turn_id=p_source_turn_id);
  return result;
end $$;
revoke all on function public.talk_language_words(text),public.talk_record_language_candidates(uuid,uuid),public.talk_capture_language(),
  public.talk_load_language_candidates(uuid,uuid),public.talk_apply_language_v2(uuid,uuid,integer,jsonb,uuid[]) from public,anon,authenticated;
grant execute on function public.talk_language_words(text),public.talk_record_language_candidates(uuid,uuid),public.talk_capture_language(),
  public.talk_load_language_candidates(uuid,uuid),public.talk_apply_language_v2(uuid,uuid,integer,jsonb,uuid[]) to service_role;
-- Bounded backfill of existing real turns; no inferred memory is inserted here.
do $$ declare row record; begin
  for row in select * from(select t.*,row_number() over(partition by user_id order by sequence desc) as n from public.talk_turns t) r where n<=50 order by sequence
  loop perform public.talk_record_language_candidates(row.user_id,row.id); end loop;
end $$;
notify pgrst,'reload schema';
commit;
