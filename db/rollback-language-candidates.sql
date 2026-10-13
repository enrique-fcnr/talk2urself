-- Stop the new worker or deploy the previous app before rollback.
-- Preserve both candidate tables and all conversation/memory data for recovery.
begin;
drop trigger if exists talk_turn_language_candidates on public.talk_turns;
drop function if exists public.talk_capture_language();
drop function if exists public.talk_apply_language_v2(uuid,uuid,integer,jsonb,uuid[]);
drop function if exists public.talk_load_language_candidates(uuid,uuid);
-- Collection helper and word tokenizer can remain for a later resume.
notify pgrst,'reload schema';
commit;
