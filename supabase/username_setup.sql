create unique index if not exists profiles_username_case_insensitive_unique
  on public.profiles (lower(username))
  where username is not null;

create or replace function public.claim_username(p_user_id uuid, p_username text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_username text := btrim(p_username);
begin
  if p_user_id is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if normalized_username is null
    or normalized_username <> p_username
    or normalized_username !~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{1,18}[A-Za-z0-9]$' then
    raise exception 'username_invalid' using errcode = '22023';
  end if;

  insert into public.profiles (id, username, display_name)
  values (p_user_id, normalized_username, normalized_username)
  on conflict (id) do update
  set username = excluded.username,
      display_name = excluded.display_name;

  return normalized_username;
exception
  when unique_violation then
    raise exception 'username_taken' using errcode = '23505';
end;
$$;

revoke all on function public.claim_username(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_username(uuid, text) to service_role;

revoke update (username, display_name) on public.profiles from authenticated;
