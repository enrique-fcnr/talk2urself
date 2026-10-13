-- Read-only deployment checks; does not expose conversation text or identifiers.
select
  (select count(*)=2 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in('talk_language_candidates','talk_language_evidence')) as tables_ready,
  (select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in('talk_language_candidates','talk_language_evidence')) as rls_enabled,
  (not has_table_privilege('anon','public.talk_language_candidates','select')
    and not has_table_privilege('authenticated','public.talk_language_evidence','select')
    and not has_function_privilege('anon','public.talk_apply_language_v2(uuid,uuid,integer,jsonb,uuid[])','execute')) as server_only,
  exists(select 1 from pg_trigger where tgname='talk_turn_language_candidates' and not tgisinternal) as capture_enabled,
  to_regprocedure('public.talk_load_language_candidates(uuid,uuid)') is not null as reader_ready,
  to_regprocedure('public.talk_apply_language_v2(uuid,uuid,integer,jsonb,uuid[])') is not null as writer_ready,
  (select count(*) from public.talk_language_candidates) as candidates,
  (select count(*) from public.talk_language_evidence) as evidence_references,
  not exists(select 1 from public.talk_language_candidates group by user_id having count(*)>500) as candidate_limit_ok,
  not exists(select 1 from public.talk_language_evidence group by user_id,candidate_id having count(*)>6) as evidence_limit_ok;
