-- Recuperação do bloco antigo SEM apagar os fatos ou suas origens.
-- Usar somente antes de novas conversas, depois de parar o servidor e restaurar
-- os arquivos v1. Parâmetros vêm de .local/atomic-migration/result.json.
-- Defina talk.rollback_legacy_id e talk.rollback_version na mesma sessão SQL.
begin;
do $$
declare legacy uuid := current_setting('talk.rollback_legacy_id')::uuid;
  expected integer := current_setting('talk.rollback_version')::integer;
  owner uuid; actual integer;
begin
  select user_id into owner from public.talk_memories where id=legacy and not active;
  if not found then raise exception 'Bloco antigo não está disponível'; end if;
  select version into actual from public.talk_profiles where user_id=owner for update;
  if actual <> expected then raise exception 'Novas conversas existem; revisar recuperação sem sobrescrevê-las'; end if;
  if not exists(select 1 from public.talk_memories where migrated_from=legacy and user_id=owner and active) then
    raise exception 'Fatos da conversão não estão ativos'; end if;
  update public.talk_memories set active=false where migrated_from=legacy and user_id=owner and active;
  update public.talk_memories set active=true where id=legacy and user_id=owner;
  update public.talk_profiles set version=version+1,updated_at=now() where user_id=owner;
end $$;
commit;
