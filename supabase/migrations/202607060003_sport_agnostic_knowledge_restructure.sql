create extension if not exists pgcrypto;

alter table if exists public.leagues
  add column if not exists active boolean not null default true;

insert into public.sports (id, code, name)
values
  ('baseball', 'BASEBALL', 'Baseball'),
  ('basketball', 'BASKETBALL', 'Basketball'),
  ('football', 'FOOTBALL', 'Football'),
  ('tennis', 'TENNIS', 'Tennis')
on conflict (id) do update
set
  code = excluded.code,
  name = excluded.name,
  updated_at = now();

insert into public.leagues (id, sport_id, code, name, level, active)
values
  ('mlb', 'baseball', 'MLB', 'Major League Baseball', 'pro', true),
  ('nba', 'basketball', 'NBA', 'National Basketball Association', 'pro', true),
  ('wnba', 'basketball', 'WNBA', 'Women''s National Basketball Association', 'pro', true),
  ('nfl', 'football', 'NFL', 'National Football League', 'pro', false),
  ('tennis', 'tennis', 'TENNIS', 'Tennis', 'pro', false)
on conflict (id) do update
set
  sport_id = excluded.sport_id,
  code = excluded.code,
  name = excluded.name,
  level = excluded.level,
  active = excluded.active,
  updated_at = now();

update public.teams set sport_id = 'baseball' where league_id = 'mlb';
update public.teams set sport_id = 'basketball' where league_id in ('nba', 'wnba');
update public.players set sport_id = 'baseball' where league_id = 'mlb';
update public.players set sport_id = 'basketball' where league_id in ('nba', 'wnba');
update public.games set sport_id = 'baseball' where league_id = 'mlb';
update public.games set sport_id = 'basketball' where league_id in ('nba', 'wnba');
update public.player_game_logs set sport_id = 'baseball' where league_id = 'mlb';
update public.player_game_logs set sport_id = 'basketball' where league_id in ('nba', 'wnba');
update public.team_game_logs set sport_id = 'baseball' where league_id = 'mlb';
update public.team_game_logs set sport_id = 'basketball' where league_id in ('nba', 'wnba');
update public.player_recent_features set sport_id = 'baseball' where league_id = 'mlb';
update public.player_recent_features set sport_id = 'basketball' where league_id in ('nba', 'wnba');
update public.team_recent_features set sport_id = 'baseball' where league_id = 'mlb';
update public.team_recent_features set sport_id = 'basketball' where league_id in ('nba', 'wnba');
update public.matchup_features set sport_id = 'baseball' where league_id = 'mlb';
update public.matchup_features set sport_id = 'basketball' where league_id in ('nba', 'wnba');
update public.injuries set sport_id = 'baseball' where league_id = 'mlb';
update public.injuries set sport_id = 'basketball' where league_id in ('nba', 'wnba');
update public.lineups set sport_id = 'baseball' where league_id = 'mlb';
update public.lineups set sport_id = 'basketball' where league_id in ('nba', 'wnba');
update public.rest_context set sport_id = 'baseball' where league_id = 'mlb';
update public.rest_context set sport_id = 'basketball' where league_id in ('nba', 'wnba');
update public.markets set sport_id = 'baseball' where league_id = 'mlb';
update public.markets set sport_id = 'basketball' where league_id in ('nba', 'wnba');
update public.odds_snapshots set sport_id = 'baseball' where league_id = 'mlb';
update public.odds_snapshots set sport_id = 'basketball' where league_id in ('nba', 'wnba');
update public.current_props set sport_id = 'baseball' where league_id = 'mlb';
update public.current_props set sport_id = 'basketball' where league_id in ('nba', 'wnba');
update public.score_inputs set sport_id = 'baseball' where league_id = 'mlb';
update public.score_inputs set sport_id = 'basketball' where league_id in ('nba', 'wnba');
update public.scored_props set sport_id = 'baseball' where league_id = 'mlb';
update public.scored_props set sport_id = 'basketball' where league_id in ('nba', 'wnba');

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  sport_id text not null references public.sports(id) on delete cascade,
  league_id text not null references public.leagues(id) on delete cascade,
  event_type text not null default 'game',
  season text,
  scheduled_date date not null,
  start_time timestamptz not null,
  status text not null default 'scheduled',
  display_name text not null,
  home_team_id uuid references public.teams(id) on delete set null,
  away_team_id uuid references public.teams(id) on delete set null,
  venue text,
  venue_city text,
  venue_state text,
  provider_event_ids jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.events is 'Canonical sport-agnostic contest table. New knowledge, odds, scoring, and grading logic should use events/event_id.';
comment on table public.games is 'Legacy compatibility table retained while the knowledge platform migrates to events/event_id.';

insert into public.events (
  id, sport_id, league_id, event_type, season, scheduled_date, start_time, status, display_name,
  home_team_id, away_team_id, venue, venue_city, venue_state, provider_event_ids, metadata, created_at, updated_at
)
select
  g.id,
  g.sport_id,
  g.league_id,
  'game',
  g.season,
  g.scheduled_date,
  g.start_time,
  g.status,
  coalesce(t_away.name || ' at ' || t_home.name, 'Scheduled event'),
  g.home_team_id,
  g.away_team_id,
  g.venue,
  g.venue_city,
  g.venue_state,
  g.provider_event_ids,
  g.metadata,
  g.created_at,
  g.updated_at
from public.games g
left join public.teams t_home on t_home.id = g.home_team_id
left join public.teams t_away on t_away.id = g.away_team_id
on conflict (id) do nothing;

create table if not exists public.participants (
  id uuid primary key,
  sport_id text not null references public.sports(id) on delete cascade,
  league_id text not null references public.leagues(id) on delete cascade,
  participant_type text not null,
  display_name text not null,
  normalized_name text not null,
  player_id uuid references public.players(id) on delete cascade,
  team_id uuid references public.teams(id) on delete cascade,
  active boolean not null default true,
  external_ids jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.participants (
  id, sport_id, league_id, participant_type, display_name, normalized_name, player_id, team_id, active, external_ids, metadata
)
select
  p.id,
  p.sport_id,
  p.league_id,
  'player',
  coalesce(p.display_name, p.canonical_name),
  p.normalized_name,
  p.id,
  p.current_team_id,
  p.active,
  p.external_ids,
  p.metadata
from public.players p
on conflict (id) do nothing;

insert into public.participants (
  id, sport_id, league_id, participant_type, display_name, normalized_name, player_id, team_id, active, external_ids, metadata
)
select
  t.id,
  t.sport_id,
  t.league_id,
  'team',
  t.name,
  lower(regexp_replace(t.name, '[^a-zA-Z0-9]+', '', 'g')),
  null,
  t.id,
  true,
  t.external_ids,
  t.metadata
from public.teams t
on conflict (id) do nothing;

create table if not exists public.event_participants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  participant_type text not null,
  team_id uuid references public.teams(id) on delete set null,
  role text,
  display_name text,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, participant_id, role)
);

insert into public.event_participants (event_id, participant_id, participant_type, team_id, role, display_name, sort_order, metadata)
select e.id, e.home_team_id, 'team', e.home_team_id, 'home', t_home.name, 1, '{}'::jsonb
from public.events e
join public.teams t_home on t_home.id = e.home_team_id
where e.home_team_id is not null
on conflict (event_id, participant_id, role) do nothing;

insert into public.event_participants (event_id, participant_id, participant_type, team_id, role, display_name, sort_order, metadata)
select e.id, e.away_team_id, 'team', e.away_team_id, 'away', t_away.name, 2, '{}'::jsonb
from public.events e
join public.teams t_away on t_away.id = e.away_team_id
where e.away_team_id is not null
on conflict (event_id, participant_id, role) do nothing;

create table if not exists public.entity_aliases (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  provider text,
  league_id text references public.leagues(id) on delete cascade,
  alias text not null,
  normalized_alias text not null,
  alias_type text,
  confidence numeric,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.source_mappings (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  entity_type text not null,
  entity_id uuid not null,
  external_id text,
  external_key text,
  league_id text references public.leagues(id) on delete cascade,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.odds_pull_configs (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  sport_id text not null references public.sports(id) on delete cascade,
  league_id text not null references public.leagues(id) on delete cascade,
  market_type text not null,
  sportsbook text,
  priority integer not null default 100,
  pull_cadence_minutes integer not null default 5,
  enabled boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.player_game_logs add column if not exists event_id uuid references public.events(id) on delete cascade;
alter table public.team_game_logs add column if not exists event_id uuid references public.events(id) on delete cascade;
alter table public.matchup_features add column if not exists event_id uuid references public.events(id) on delete cascade;
alter table public.lineups add column if not exists event_id uuid references public.events(id) on delete cascade;
alter table public.rest_context add column if not exists event_id uuid references public.events(id) on delete cascade;
alter table public.basketball_player_features add column if not exists event_id uuid references public.events(id) on delete cascade;
alter table public.basketball_team_context add column if not exists event_id uuid references public.events(id) on delete cascade;
alter table public.basketball_opponent_context add column if not exists event_id uuid references public.events(id) on delete cascade;
alter table public.mlb_batter_features add column if not exists event_id uuid references public.events(id) on delete cascade;
alter table public.mlb_pitcher_features add column if not exists event_id uuid references public.events(id) on delete cascade;
alter table public.mlb_starting_pitchers add column if not exists event_id uuid references public.events(id) on delete cascade;
alter table public.mlb_lineups add column if not exists event_id uuid references public.events(id) on delete cascade;
alter table public.mlb_weather add column if not exists event_id uuid references public.events(id) on delete cascade;

alter table public.odds_snapshots add column if not exists event_id uuid references public.events(id) on delete set null;
alter table public.odds_snapshots add column if not exists participant_id uuid references public.participants(id) on delete set null;
alter table public.odds_snapshots add column if not exists participant_type text;
alter table public.odds_snapshots add column if not exists opponent_id uuid references public.participants(id) on delete set null;
alter table public.odds_snapshots add column if not exists match_quality_flags text[] not null default '{}'::text[];

alter table public.current_props add column if not exists event_id uuid references public.events(id) on delete set null;
alter table public.current_props add column if not exists participant_id uuid references public.participants(id) on delete set null;
alter table public.current_props add column if not exists participant_type text;
alter table public.current_props add column if not exists opponent_id uuid references public.participants(id) on delete set null;
alter table public.current_props add column if not exists match_quality_flags text[] not null default '{}'::text[];

alter table public.score_inputs add column if not exists event_id uuid references public.events(id) on delete set null;
alter table public.score_inputs add column if not exists participant_id uuid references public.participants(id) on delete set null;
alter table public.score_inputs add column if not exists participant_type text;

alter table public.scored_props add column if not exists event_id uuid references public.events(id) on delete set null;
alter table public.scored_props add column if not exists participant_id uuid references public.participants(id) on delete set null;
alter table public.scored_props add column if not exists participant_type text;
alter table public.scored_props add column if not exists opponent_id uuid references public.participants(id) on delete set null;

alter table public.grading_results add column if not exists event_id uuid references public.events(id) on delete set null;
alter table public.grading_results add column if not exists participant_id uuid references public.participants(id) on delete set null;
alter table public.grading_results add column if not exists participant_type text;
alter table public.grading_results add column if not exists league_id text references public.leagues(id) on delete set null;
alter table public.grading_results add column if not exists sport_id text references public.sports(id) on delete set null;

comment on column public.odds_snapshots.event_id is 'Canonical contest reference. New logic should prefer event_id over legacy game_id.';
comment on column public.current_props.event_id is 'Canonical contest reference. New logic should prefer event_id over legacy game_id.';
comment on column public.score_inputs.event_id is 'Canonical contest reference. New logic should prefer event_id over legacy game_id.';
comment on column public.scored_props.event_id is 'Canonical contest reference. New logic should prefer event_id over legacy game_id.';
comment on column public.grading_results.event_id is 'Canonical contest reference. New logic should prefer event_id over legacy game_id.';
comment on column public.odds_snapshots.game_id is 'Legacy compatibility only. Safe to remove after downstream consumers finish migrating to event_id.';
comment on column public.current_props.game_id is 'Legacy compatibility only. Safe to remove after downstream consumers finish migrating to event_id.';
comment on column public.scored_props.game_id is 'Legacy compatibility only. Safe to remove after downstream consumers finish migrating to event_id.';
comment on column public.grading_results.game_id is 'Legacy compatibility only. Safe to remove after downstream consumers finish migrating to event_id.';

update public.player_game_logs set event_id = game_id where event_id is null and game_id is not null;
update public.team_game_logs set event_id = game_id where event_id is null and game_id is not null;
update public.matchup_features set event_id = game_id where event_id is null and game_id is not null;
update public.lineups set event_id = game_id where event_id is null and game_id is not null;
update public.rest_context set event_id = game_id where event_id is null and game_id is not null;
update public.basketball_player_features set event_id = game_id where event_id is null and game_id is not null;
update public.basketball_team_context set event_id = game_id where event_id is null and game_id is not null;
update public.basketball_opponent_context set event_id = game_id where event_id is null and game_id is not null;
update public.mlb_batter_features set event_id = game_id where event_id is null and game_id is not null;
update public.mlb_pitcher_features set event_id = game_id where event_id is null and game_id is not null;
update public.mlb_starting_pitchers set event_id = game_id where event_id is null and game_id is not null;
update public.mlb_lineups set event_id = game_id where event_id is null and game_id is not null;
update public.mlb_weather set event_id = game_id where event_id is null and game_id is not null;
update public.odds_snapshots set event_id = game_id where event_id is null and game_id is not null;
update public.current_props set event_id = game_id where event_id is null and game_id is not null;
update public.scored_props set event_id = game_id where event_id is null and game_id is not null;
update public.grading_results set event_id = game_id where event_id is null and game_id is not null;

insert into public.entity_aliases (entity_type, entity_id, provider, league_id, alias, normalized_alias, alias_type, confidence, metadata)
select 'player', p.id, null, p.league_id, coalesce(p.display_name, p.canonical_name), p.normalized_name, 'canonical', 1, '{}'::jsonb
from public.players p
on conflict do nothing;

insert into public.entity_aliases (entity_type, entity_id, provider, league_id, alias, normalized_alias, alias_type, confidence, metadata)
select 'team', t.id, null, t.league_id, t.name, lower(regexp_replace(t.name, '[^a-zA-Z0-9]+', '', 'g')), 'canonical', 1, '{}'::jsonb
from public.teams t
on conflict do nothing;

insert into public.source_mappings (provider, entity_type, entity_id, external_id, external_key, league_id, metadata)
select
  'legacy-game',
  'event',
  e.id,
  e.provider_event_ids->>'sharpapi',
  e.display_name,
  e.league_id,
  '{}'::jsonb
from public.events e
where coalesce(e.provider_event_ids->>'sharpapi', '') <> ''
on conflict do nothing;

create table if not exists public.nfl_player_features (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid references public.participants(id) on delete cascade,
  player_id uuid references public.players(id) on delete cascade,
  event_id uuid references public.events(id) on delete cascade,
  feature_date date not null,
  feature_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nfl_team_features (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid references public.participants(id) on delete cascade,
  team_id uuid references public.teams(id) on delete cascade,
  event_id uuid references public.events(id) on delete cascade,
  feature_date date not null,
  feature_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nfl_matchup_features (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  feature_date date not null,
  feature_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nfl_depth_charts (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references public.teams(id) on delete cascade,
  feature_date date not null,
  feature_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nfl_weather (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  feature_date date not null,
  feature_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tennis_player_features (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid references public.participants(id) on delete cascade,
  event_id uuid references public.events(id) on delete cascade,
  feature_date date not null,
  feature_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tennis_matchup_features (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  feature_date date not null,
  feature_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tennis_surface_features (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  feature_date date not null,
  feature_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tennis_tournament_context (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  feature_date date not null,
  feature_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists participants_player_unique_idx on public.participants (player_id) where player_id is not null;
create unique index if not exists participants_team_unique_idx on public.participants (team_id) where team_id is not null;
create index if not exists participants_league_name_idx on public.participants (league_id, normalized_name);
create index if not exists events_league_date_idx on public.events (league_id, scheduled_date, start_time);
create index if not exists event_participants_event_idx on public.event_participants (event_id, role, sort_order);
create unique index if not exists entity_aliases_unique_idx on public.entity_aliases (entity_type, entity_id, coalesce(provider, ''), normalized_alias);
create index if not exists entity_aliases_lookup_idx on public.entity_aliases (entity_type, league_id, normalized_alias);
create unique index if not exists source_mappings_unique_idx on public.source_mappings (provider, entity_type, entity_id, coalesce(external_id, ''), coalesce(external_key, ''));
create unique index if not exists odds_pull_configs_unique_idx on public.odds_pull_configs (provider, league_id, market_type, coalesce(sportsbook, ''));
create index if not exists player_game_logs_event_idx on public.player_game_logs (event_id, player_id);
create index if not exists team_game_logs_event_idx on public.team_game_logs (event_id, team_id);
create index if not exists matchup_features_event_idx on public.matchup_features (event_id, feature_date desc);
create index if not exists current_props_event_idx on public.current_props (event_id, participant_id, market_type);
create index if not exists odds_snapshots_event_idx on public.odds_snapshots (event_id, participant_id, pulled_at desc);
create index if not exists scored_props_event_idx on public.scored_props (event_id, participant_id, created_at desc);
create index if not exists grading_results_event_idx on public.grading_results (event_id, created_at desc);

alter table public.events enable row level security;
alter table public.participants enable row level security;
alter table public.event_participants enable row level security;
alter table public.entity_aliases enable row level security;
alter table public.source_mappings enable row level security;
alter table public.odds_pull_configs enable row level security;
alter table public.nfl_player_features enable row level security;
alter table public.nfl_team_features enable row level security;
alter table public.nfl_matchup_features enable row level security;
alter table public.nfl_depth_charts enable row level security;
alter table public.nfl_weather enable row level security;
alter table public.tennis_player_features enable row level security;
alter table public.tennis_matchup_features enable row level security;
alter table public.tennis_surface_features enable row level security;
alter table public.tennis_tournament_context enable row level security;

revoke all on table
  public.events,
  public.participants,
  public.event_participants,
  public.entity_aliases,
  public.source_mappings,
  public.odds_pull_configs,
  public.nfl_player_features,
  public.nfl_team_features,
  public.nfl_matchup_features,
  public.nfl_depth_charts,
  public.nfl_weather,
  public.tennis_player_features,
  public.tennis_matchup_features,
  public.tennis_surface_features,
  public.tennis_tournament_context
from anon, authenticated;

grant select, insert, update, delete on table
  public.events,
  public.participants,
  public.event_participants,
  public.entity_aliases,
  public.source_mappings,
  public.odds_pull_configs,
  public.nfl_player_features,
  public.nfl_team_features,
  public.nfl_matchup_features,
  public.nfl_depth_charts,
  public.nfl_weather,
  public.tennis_player_features,
  public.tennis_matchup_features,
  public.tennis_surface_features,
  public.tennis_tournament_context
to service_role;
