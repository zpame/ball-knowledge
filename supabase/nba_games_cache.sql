create table if not exists public.nba_games_cache (
  cache_key text primary key,
  payload jsonb,
  last_requested_at timestamptz
);

alter table public.nba_games_cache enable row level security;
revoke all on table public.nba_games_cache from anon, authenticated;
grant select, insert, update, delete on table public.nba_games_cache to service_role;

create or replace function public.claim_nba_games_refresh()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.nba_games_cache (cache_key, last_requested_at)
  values ('games', now())
  on conflict (cache_key) do nothing;

  if found then
    return true;
  end if;

  update public.nba_games_cache
  set last_requested_at = now()
  where cache_key = 'games'
    and (
      last_requested_at is null
      or last_requested_at <= now() - interval '1 minute'
    );

  return found;
end;
$$;

revoke all on function public.claim_nba_games_refresh() from public, anon, authenticated;
grant execute on function public.claim_nba_games_refresh() to service_role;
