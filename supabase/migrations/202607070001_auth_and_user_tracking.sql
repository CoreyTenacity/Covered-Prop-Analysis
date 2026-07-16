create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_picks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  scored_prop_id uuid references public.scored_props(id) on delete set null,
  current_prop_id uuid references public.current_props(id) on delete set null,
  odds_snapshot_id uuid references public.odds_snapshots(id) on delete set null,
  event_id uuid references public.events(id) on delete set null,
  participant_id uuid references public.participants(id) on delete set null,
  market_instance_key text,
  market_type text,
  side text,
  line numeric,
  odds_taken integer,
  sportsbook_id uuid references public.sportsbooks(id) on delete set null,
  stake_units numeric,
  status text not null default 'open',
  result text not null default 'pending',
  profit_units numeric,
  placed_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_parlays (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'open',
  total_legs integer not null default 0,
  stake_units numeric,
  combined_odds integer,
  result text not null default 'pending',
  profit_units numeric,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.user_parlay_legs (
  id uuid primary key default gen_random_uuid(),
  user_parlay_id uuid not null references public.user_parlays(id) on delete cascade,
  user_pick_id uuid references public.user_picks(id) on delete set null,
  scored_prop_id uuid references public.scored_props(id) on delete set null,
  current_prop_id uuid references public.current_props(id) on delete set null,
  odds_snapshot_id uuid references public.odds_snapshots(id) on delete set null,
  event_id uuid references public.events(id) on delete set null,
  participant_id uuid references public.participants(id) on delete set null,
  market_instance_key text,
  market_type text,
  side text,
  line numeric,
  odds_taken integer,
  sportsbook_id uuid references public.sportsbooks(id) on delete set null,
  leg_result text,
  created_at timestamptz not null default now()
);

create index if not exists profiles_created_idx on public.profiles (created_at desc);
create index if not exists user_picks_user_created_idx on public.user_picks (user_id, created_at desc);
create index if not exists user_picks_user_status_idx on public.user_picks (user_id, status, created_at desc);
create index if not exists user_picks_event_idx on public.user_picks (event_id, created_at desc);
create index if not exists user_parlays_user_created_idx on public.user_parlays (user_id, created_at desc);
create index if not exists user_parlay_legs_parlay_created_idx on public.user_parlay_legs (user_parlay_id, created_at asc);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute function public.touch_updated_at();

drop trigger if exists user_picks_touch_updated_at on public.user_picks;
create trigger user_picks_touch_updated_at
before update on public.user_picks
for each row execute function public.touch_updated_at();

drop trigger if exists user_parlays_touch_updated_at on public.user_parlays;
create trigger user_parlays_touch_updated_at
before update on public.user_parlays
for each row execute function public.touch_updated_at();

create or replace function public.handle_new_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data->>'display_name', ''),
      nullif(new.raw_user_meta_data->>'full_name', ''),
      split_part(coalesce(new.email, ''), '@', 1)
    )
  )
  on conflict (id) do update
    set display_name = coalesce(
      excluded.display_name,
      public.profiles.display_name
    ),
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_covered on auth.users;
create trigger on_auth_user_created_covered
after insert on auth.users
for each row execute function public.handle_new_profile();

alter table public.profiles enable row level security;
alter table public.user_picks enable row level security;
alter table public.user_parlays enable row level security;
alter table public.user_parlay_legs enable row level security;

grant select, insert, update on table public.profiles to authenticated;
grant select, insert, update, delete on table public.user_picks to authenticated;
grant select, insert, update, delete on table public.user_parlays to authenticated;
grant select, insert, update, delete on table public.user_parlay_legs to authenticated;

grant select, insert, update, delete on table public.profiles to service_role;
grant select, insert, update, delete on table public.user_picks to service_role;
grant select, insert, update, delete on table public.user_parlays to service_role;
grant select, insert, update, delete on table public.user_parlay_legs to service_role;

revoke all on table public.profiles from anon;
revoke all on table public.user_picks from anon;
revoke all on table public.user_parlays from anon;
revoke all on table public.user_parlay_legs from anon;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles
for select
to authenticated
using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
on public.profiles
for insert
to authenticated
with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

drop policy if exists "user_picks_select_own" on public.user_picks;
create policy "user_picks_select_own"
on public.user_picks
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "user_picks_insert_own" on public.user_picks;
create policy "user_picks_insert_own"
on public.user_picks
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "user_picks_update_own" on public.user_picks;
create policy "user_picks_update_own"
on public.user_picks
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "user_picks_delete_own" on public.user_picks;
create policy "user_picks_delete_own"
on public.user_picks
for delete
to authenticated
using (auth.uid() = user_id);

drop policy if exists "user_parlays_select_own" on public.user_parlays;
create policy "user_parlays_select_own"
on public.user_parlays
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "user_parlays_insert_own" on public.user_parlays;
create policy "user_parlays_insert_own"
on public.user_parlays
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "user_parlays_update_own" on public.user_parlays;
create policy "user_parlays_update_own"
on public.user_parlays
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "user_parlays_delete_own" on public.user_parlays;
create policy "user_parlays_delete_own"
on public.user_parlays
for delete
to authenticated
using (auth.uid() = user_id);

drop policy if exists "user_parlay_legs_select_own" on public.user_parlay_legs;
create policy "user_parlay_legs_select_own"
on public.user_parlay_legs
for select
to authenticated
using (
  exists (
    select 1
    from public.user_parlays
    where public.user_parlays.id = user_parlay_legs.user_parlay_id
      and public.user_parlays.user_id = auth.uid()
  )
);

drop policy if exists "user_parlay_legs_insert_own" on public.user_parlay_legs;
create policy "user_parlay_legs_insert_own"
on public.user_parlay_legs
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_parlays
    where public.user_parlays.id = user_parlay_legs.user_parlay_id
      and public.user_parlays.user_id = auth.uid()
  )
);

drop policy if exists "user_parlay_legs_update_own" on public.user_parlay_legs;
create policy "user_parlay_legs_update_own"
on public.user_parlay_legs
for update
to authenticated
using (
  exists (
    select 1
    from public.user_parlays
    where public.user_parlays.id = user_parlay_legs.user_parlay_id
      and public.user_parlays.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.user_parlays
    where public.user_parlays.id = user_parlay_legs.user_parlay_id
      and public.user_parlays.user_id = auth.uid()
  )
);

drop policy if exists "user_parlay_legs_delete_own" on public.user_parlay_legs;
create policy "user_parlay_legs_delete_own"
on public.user_parlay_legs
for delete
to authenticated
using (
  exists (
    select 1
    from public.user_parlays
    where public.user_parlays.id = user_parlay_legs.user_parlay_id
      and public.user_parlays.user_id = auth.uid()
  )
);

comment on table public.profiles is 'Optional account profile table for Covered. Public browsing remains available without auth.';
comment on table public.user_picks is 'Future user tracking table. Separate from grading_results, which grades the model.';
comment on table public.user_parlays is 'Future user parlay tracking table. Separate from model grading.';
comment on table public.user_parlay_legs is 'Future user parlay leg tracking table. Separate from model grading.';
