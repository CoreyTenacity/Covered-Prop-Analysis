create table if not exists saved_picks (
  id text primary key,
  opportunity_id text not null,
  saved_at timestamptz not null default now(),
  sport text not null,
  player_name text not null,
  team text not null,
  opponent text not null,
  stat_type text not null,
  line numeric not null,
  direction text not null,
  covered_score integer not null,
  recommendation_label text not null,
  confidence text,
  result text not null default 'pending',
  notes text not null default '',
  source text not null,
  player_id text,
  game_id text,
  actual_value numeric,
  graded_at timestamptz,
  grading_status text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table saved_picks enable row level security;
create index if not exists saved_picks_saved_at_idx on saved_picks (saved_at desc);
create index if not exists saved_picks_result_idx on saved_picks (result);
create index if not exists saved_picks_grading_status_idx on saved_picks (grading_status);

-- Server-only table. No public policies are created.
revoke all on table public.saved_picks from anon, authenticated;
grant select, insert, update, delete on table public.saved_picks to service_role;
