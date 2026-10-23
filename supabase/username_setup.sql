alter table public.profiles
  add column if not exists username_changed_at timestamptz;

update public.profiles
set username_changed_at = created_at
where username is not null
  and lower(username) <> 'player'
  and username_changed_at is null;

create unique index if not exists profiles_username_case_insensitive_unique
  on public.profiles (lower(username))
  where username is not null;

drop function if exists public.claim_username(uuid, text);

create function public.claim_username(p_user_id uuid, p_username text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_username text := btrim(p_username);
  existing_profile public.profiles%rowtype;
  next_change_at timestamptz;
begin
  if p_user_id is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if normalized_username is null
    or normalized_username <> p_username
    or normalized_username !~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{1,18}[A-Za-z0-9]$' then
    raise exception 'username_invalid' using errcode = '22023';
  end if;

  insert into public.profiles (id, display_name)
  values (p_user_id, 'Player')
  on conflict (id) do nothing;

  select *
  into existing_profile
  from public.profiles
  where id = p_user_id
  for update;

  if existing_profile.username is not null
    and lower(existing_profile.username) <> 'player'
    and lower(existing_profile.display_name) <> 'player'
    and lower(existing_profile.username) = lower(normalized_username) then
    next_change_at := coalesce(existing_profile.username_changed_at, now()) + interval '30 days';
    return jsonb_build_object(
      'username', existing_profile.username,
      'next_change_at', next_change_at
    );
  end if;

  if existing_profile.username is not null
    and lower(existing_profile.username) <> 'player'
    and lower(existing_profile.display_name) <> 'player'
    and coalesce(existing_profile.username_changed_at, now()) > now() - interval '30 days' then
    next_change_at := coalesce(existing_profile.username_changed_at, now()) + interval '30 days';
    raise exception 'username_cooldown'
      using errcode = 'P0001',
        detail = to_char(next_change_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  end if;

  update public.profiles
  set username = normalized_username,
      display_name = normalized_username,
      username_changed_at = now()
  where id = p_user_id;

  next_change_at := now() + interval '30 days';
  return jsonb_build_object(
    'username', normalized_username,
    'next_change_at', next_change_at
  );
exception
  when unique_violation then
    raise exception 'username_taken' using errcode = '23505';
end;
$$;

revoke all on function public.claim_username(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_username(uuid, text) to service_role;

revoke update (username, display_name) on public.profiles from authenticated;
