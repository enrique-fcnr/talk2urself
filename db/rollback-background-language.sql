-- Stop the server's background worker before rollback. Existing memories and
-- foreground functions remain available; no personal record is removed.
begin;
drop function if exists public.talk_apply_language(uuid,uuid,integer,jsonb);
notify pgrst, 'reload schema';
commit;
