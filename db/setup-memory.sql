-- Bootstrap de projeto novo. Estrutura aplicada ao projeto Talk2Urself em 08/10/2026.
-- Não reaplique este bootstrap em um banco que já contém estas tabelas.
begin;
create schema if not exists extensions;
create extension if not exists vector with schema extensions;
create table public.talk_profiles (
  user_id uuid primary key,
  summary text not null default '' check (char_length(summary) <= 2400),
  version integer not null default 0 check (version >= 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.talk_turns (
  id uuid primary key,
  user_id uuid not null references public.talk_profiles(user_id) on delete cascade,
  sequence bigint generated always as identity,
  user_text text not null check (char_length(user_text) between 1 and 4000),
  assistant_text text not null check (char_length(assistant_text) between 1 and 4000),
  created_at timestamptz not null default now(), unique (user_id, id)
);
create index talk_turns_user_sequence_idx on public.talk_turns(user_id, sequence desc);
create table public.talk_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.talk_profiles(user_id) on delete cascade,
  slot text not null check (slot ~ '^(name|life_context|family|friends|work|studies|personal_life|life_events|difficult_experiences|goals|principles|routine|constraints|interests|speaking_preferences|expressions|reasoning_style|memory\.[a-z0-9_]{1,48})$'),
  value text not null check (char_length(value) <= 600),
  evidence text not null check (char_length(evidence) between 3 and 500),
  basis text not null check (basis in ('stated', 'observed')),
  status text not null check (status in ('known', 'declined')),
  source_turn_id uuid not null,
  embedding extensions.vector(1536), active boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (user_id, source_turn_id) references public.talk_turns(user_id, id) on delete cascade,
  check ((status = 'known' and char_length(value) > 0 and embedding is not null) or (status = 'declined' and value = '' and embedding is null)),
  check (basis <> 'observed' or slot in ('expressions', 'reasoning_style'))
);
create unique index talk_memories_active_slot_idx on public.talk_memories(user_id, slot) where active;
create index talk_memories_source_idx on public.talk_memories(user_id, source_turn_id);
-- Uso local pessoal: as tabelas não dão acesso aos clientes públicos.
alter table public.talk_profiles enable row level security;
alter table public.talk_turns enable row level security;
alter table public.talk_memories enable row level security;
revoke all on public.talk_profiles, public.talk_turns, public.talk_memories from anon, authenticated;
grant select, insert, update, delete on public.talk_profiles, public.talk_turns, public.talk_memories to service_role;
grant usage, select on sequence public.talk_turns_sequence_seq to service_role;
grant usage on schema extensions to service_role;

create function public.talk_load_context(p_user_id uuid, p_embedding extensions.vector(1536) default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  insert into public.talk_profiles(user_id) values (p_user_id) on conflict do nothing;
  select jsonb_build_object(
    'summary', p.summary, 'version', p.version,
    'profile', coalesce((select jsonb_agg(jsonb_build_object('slot', m.slot, 'value', m.value, 'evidence', m.evidence, 'basis', m.basis, 'status', m.status) order by m.slot)
      from public.talk_memories m where m.user_id = p_user_id and m.active and m.slot not like 'memory.%'), '[]'::jsonb),
    'relevant', coalesce((select jsonb_agg(jsonb_build_object('slot', f.slot, 'value', f.value, 'evidence', f.evidence, 'basis', f.basis, 'status', f.status))
      from (select m.* from public.talk_memories m where m.user_id = p_user_id and m.active and m.status = 'known'
        and p_embedding is not null and m.slot like 'memory.%'
        and 1 - (m.embedding operator(extensions.<=>) p_embedding) >= 0.35
        order by m.embedding operator(extensions.<=>) p_embedding limit 6) f), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('user_text', r.user_text, 'assistant_text', r.assistant_text) order by r.sequence)
      from (select t.* from public.talk_turns t where t.user_id = p_user_id order by t.sequence desc limit 10) r), '[]'::jsonb)
  ) into result from public.talk_profiles p where p.user_id = p_user_id;
  return result;
end;
$$;
-- Turno, resumo e revisões são gravados juntos em uma transação.
create function public.talk_commit_turn(p_user_id uuid, p_turn_id uuid, p_user_text text, p_assistant_text text,
  p_expected_version integer, p_summary text, p_updates jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare current_version integer; item jsonb; previous public.talk_memories%rowtype;
begin
  select version into current_version from public.talk_profiles where user_id = p_user_id for update;
  if not found then raise exception 'Perfil inexistente'; end if;
  if exists (select 1 from public.talk_turns where id = p_turn_id and user_id = p_user_id) then
    return jsonb_build_object('version', current_version, 'duplicate', true);
  end if;
  if current_version <> p_expected_version then raise exception 'Contexto desatualizado'; end if;
  if jsonb_typeof(p_updates) <> 'array' or jsonb_array_length(p_updates) > 6 then raise exception 'Atualização inválida'; end if;
  insert into public.talk_turns(id, user_id, user_text, assistant_text) values (p_turn_id, p_user_id, p_user_text, p_assistant_text);
  for item in select * from jsonb_array_elements(p_updates) loop
    if position((item->>'evidence') in p_user_text) = 0 then raise exception 'Evidência inválida'; end if;
    select * into previous from public.talk_memories where user_id = p_user_id and slot = item->>'slot' and active;
    if found and previous.value = item->>'value' and previous.status = item->>'status' and previous.basis = item->>'basis' then continue; end if;
    update public.talk_memories set active = false where user_id = p_user_id and slot = item->>'slot' and active;
    insert into public.talk_memories(user_id, slot, value, evidence, basis, status, source_turn_id, embedding)
      values (p_user_id, item->>'slot', item->>'value', item->>'evidence', item->>'basis', item->>'status', p_turn_id,
        case when item->>'status' = 'known' then (item->'embedding')::text::extensions.vector else null end);
  end loop;
  update public.talk_profiles set summary = p_summary, version = version + 1, updated_at = now() where user_id = p_user_id;
  return jsonb_build_object('version', current_version + 1, 'duplicate', false);
end;
$$;
revoke all on function public.talk_load_context(uuid, extensions.vector) from public, anon, authenticated;
revoke all on function public.talk_commit_turn(uuid, uuid, text, text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.talk_load_context(uuid, extensions.vector) to service_role;
grant execute on function public.talk_commit_turn(uuid, uuid, text, text,integer, text, jsonb) to service_role;
commit;
