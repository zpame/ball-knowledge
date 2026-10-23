create extension if not exists pgcrypto;

drop view if exists public.leaderboard;
drop trigger if exists create_profile_after_signup on auth.users;
drop function if exists public.create_profile_for_user();
drop table if exists public.profiles;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text unique,
  display_name text not null default 'Player',
  created_at timestamptz not null default now()
);

create table if not exists public.teams (
  id bigint primary key,
  abbreviation text not null,
  name text not null,
  color text not null default '#A3E635'
);

create table if not exists public.games (
  id bigint primary key,
  game_date date not null,
  start_at timestamptz not null,
  home_team_id bigint not null references public.teams (id),
  visitor_team_id bigint not null references public.teams (id),
  home_team_score integer,
  visitor_team_score integer,
  status text not null
);

create table if not exists public.picks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users (id) on delete cascade,
  game_id bigint not null references public.games (id) on delete cascade,
  picked_team_id bigint not null references public.teams (id),
  game_date date not null,
  unique (user_id, game_id)
);

drop function if exists public.make_pick(bigint, bigint);
drop policy if exists "Users read their own picks" on public.picks;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'picks'
      and column_name = 'user_id'
      and data_type = 'text'
  ) then
    alter table public.picks
      alter column user_id type uuid using nullif(user_id, '')::uuid;
  end if;
end;
$$;

create unique index if not exists picks_user_game_unique
  on public.picks (user_id, game_id);

create or replace function public.create_profile_for_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    nullif(new.raw_user_meta_data ->> 'username', ''),
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), 'Player')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists create_profile_after_signup on auth.users;
create trigger create_profile_after_signup
  after insert on auth.users
  for each row execute procedure public.create_profile_for_user();

insert into public.profiles (id, display_name)
select
  users.id,
  coalesce(nullif(users.raw_user_meta_data ->> 'display_name', ''), 'Player')
from auth.users as users
on conflict (id) do nothing;

create or replace function public.make_pick(p_game_id bigint, p_picked_team_id bigint)
returns public.picks
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  selected_game public.games%rowtype;
  saved_pick public.picks%rowtype;
begin
  if current_user_id is null then
    raise exception 'Sign in to submit a pick';
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
  values (current_user_id, p_game_id, p_picked_team_id, selected_game.game_date)
  on conflict (user_id, game_id)
  do update set picked_team_id = excluded.picked_team_id
  returning * into saved_pick;

  return saved_pick;
end;
$$;

revoke all on function public.make_pick(bigint, bigint) from public;
grant execute on function public.make_pick(bigint, bigint) to authenticated;

drop view if exists public.leaderboard;
create view public.leaderboard as
with settled as (
  select
    p.user_id,
    p.created_at,
    g.start_at,
    p.game_date,
    p.picked_team_id = case
      when g.home_team_score > g.visitor_team_score then g.home_team_id
      else g.visitor_team_id
    end as won,
    row_number() over (
      partition by p.user_id
      order by g.start_at desc, p.created_at desc, g.id desc
    ) as pick_number
  from public.picks p
  join public.games g on g.id = p.game_id
  where lower(g.status) = 'final'
    and g.home_team_score is not null
    and g.visitor_team_score is not null
),
latest_result as (
  select
    user_id,
    pick_number,
    won,
    first_value(won) over (partition by user_id order by pick_number) as current_result
  from settled
),
streak_boundaries as (
  select
    user_id,
    min(pick_number) filter (where won <> current_result) as first_different_pick,
    bool_or(current_result) as current_streak_is_win
  from latest_result
  group by user_id
),
streaks as (
  select
    lr.user_id,
    count(*) filter (
      where lr.pick_number < coalesce(sb.first_different_pick, 2147483647)
    )::integer as current_streak,
    sb.current_streak_is_win
  from latest_result lr
  join streak_boundaries sb on sb.user_id = lr.user_id
  group by lr.user_id, sb.first_different_pick, sb.current_streak_is_win
),
clock as (
  select (now() at time zone 'America/New_York')::date as today
),
periods as (
  select
    period,
    case period
      when 'week' then date_trunc('week', clock.today)::date
      when 'season' then make_date(
        extract(year from clock.today)::integer
          - case when extract(month from clock.today) < 10 then 1 else 0 end,
        10,
        1
      )
      else null
    end as start_date
  from (values ('week'::text), ('season'::text), ('all_time'::text)) as choices(period)
  cross join clock
),
records as (
  select
    periods.period,
    settled.user_id,
    count(*)::integer as total_picks,
    count(*) filter (where settled.won)::integer as wins
  from periods
  join settled
    on periods.period = 'all_time'
    or settled.game_date >= periods.start_date
  group by periods.period, settled.user_id
),
scored as (
  select
    r.period,
    r.user_id,
    coalesce(nullif(pr.display_name, ''), nullif(pr.username, ''), 'Player') as display_name,
    r.wins,
    r.total_picks - r.wins as losses,
    r.total_picks,
    round(r.wins::numeric / nullif(r.total_picks, 0) * 100, 1) as win_percentage,
    s.current_streak,
    s.current_streak_is_win,
    (
      (r.wins::numeric / r.total_picks)
      + 1.96 * 1.96 / (2 * r.total_picks)
      - 1.96 * sqrt(
          (r.wins::numeric / r.total_picks)
          * (1 - r.wins::numeric / r.total_picks)
          / r.total_picks
          + 1.96 * 1.96 / (4 * r.total_picks * r.total_picks)
        )
    ) / (1 + 1.96 * 1.96 / r.total_picks) as confidence_score
  from records r
  join public.profiles pr on pr.id = r.user_id
  join streaks s on s.user_id = r.user_id
)
select
  period,
  rank() over (
    partition by period
    order by confidence_score desc, wins desc, total_picks desc
  )::integer as rank,
  user_id,
  display_name,
  wins,
  losses,
  total_picks,
  win_percentage,
  current_streak,
  current_streak_is_win,
  confidence_score
from scored;

alter table public.profiles enable row level security;
alter table public.teams enable row level security;
alter table public.games enable row level security;
alter table public.picks enable row level security;

drop policy if exists "Profiles are publicly readable" on public.profiles;
create policy "Profiles are publicly readable"
  on public.profiles for select using (true);
drop policy if exists "Users update their own profile" on public.profiles;
create policy "Users update their own profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

drop policy if exists "Teams are publicly readable" on public.teams;
create policy "Teams are publicly readable"
  on public.teams for select using (true);

drop policy if exists "Games are publicly readable" on public.games;
create policy "Games are publicly readable"
  on public.games for select using (true);

drop policy if exists "Users read their own picks" on public.picks;
create policy "Users read their own picks"
  on public.picks for select to authenticated
  using ((select auth.uid()) = user_id);

grant select on public.profiles, public.teams, public.games to anon, authenticated;
grant select on public.picks to authenticated;
grant update (username, display_name) on public.profiles to authenticated;
grant select on public.leaderboard to anon, authenticated;
