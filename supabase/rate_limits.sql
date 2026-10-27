create table if not exists public.rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  request_count integer not null,
  primary key (bucket, window_start)
);

create index if not exists rate_limits_window_start_idx
  on public.rate_limits (window_start);

alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from public, anon, authenticated, service_role;

create or replace function public.consume_rate_limit(
  p_bucket text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_window timestamptz;
  current_count integer;
begin
  if p_bucket is null or length(p_bucket) > 256
    or p_limit is null or p_limit < 1
    or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid_rate_limit_parameters' using errcode = '22023';
  end if;

  current_window := to_timestamp(
    (floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds)::double precision
  );

  delete from public.rate_limits
  where bucket = p_bucket and window_start < current_window;

  if random() < 0.01 then
    delete from public.rate_limits
    where window_start < now() - interval '1 day';
  end if;

  insert into public.rate_limits (bucket, window_start, request_count)
  values (p_bucket, current_window, 1)
  on conflict (bucket, window_start)
  do update set request_count = public.rate_limits.request_count + 1
  returning request_count into current_count;

  return current_count <= p_limit;
end;
$$;

revoke all on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;

drop function if exists public.make_pick(bigint, bigint);
drop function if exists public.make_pick_for_user(uuid, bigint, bigint);

create function public.make_pick_for_user(
  p_user_id uuid,
  p_game_id bigint,
  p_picked_team_id bigint
)
returns public.picks
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_game public.games%rowtype;
  saved_pick public.picks%rowtype;
begin
  if p_user_id is null then
    raise exception 'not_authenticated';
  end if;

  if not public.consume_rate_limit('pick:user:' || p_user_id::text, 30, 60) then
    raise exception 'rate_limited';
  end if;

  select * into selected_game
  from public.games
  where id = p_game_id
  for share;

  if not found then
    raise exception 'Game not found';
  end if;
  if p_picked_team_id not in (selected_game.home_team_id, selected_game.visitor_team_id) then
    raise exception 'Pick must be one of the teams playing this game';
  end if;
  if now() >= selected_game.start_at then
    raise exception 'Picks lock at tip-off';
  end if;

  insert into public.picks (user_id, game_id, picked_team_id, game_date)
  values (p_user_id, p_game_id, p_picked_team_id, selected_game.game_date)
  on conflict (user_id, game_id)
  do update set picked_team_id = excluded.picked_team_id
  returning * into saved_pick;

  return saved_pick;
end;
$$;

revoke all on function public.make_pick_for_user(uuid, bigint, bigint) from public, anon, authenticated;
grant execute on function public.make_pick_for_user(uuid, bigint, bigint) to service_role;
