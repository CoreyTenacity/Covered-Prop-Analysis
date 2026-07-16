create extension if not exists pgcrypto;

create table if not exists public.sports (
  id text primary key,
  code text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.leagues (
  id text primary key,
  sport_id text not null references public.sports(id) on delete cascade,
  code text not null unique,
  name text not null,
  level text not null default 'pro',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  sport_id text not null references public.sports(id) on delete cascade,
  league_id text not null references public.leagues(id) on delete cascade,
  code text not null,
  name text not null,
  city text,
  nickname text,
  abbreviation text,
  external_ids jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (league_id, code)
);

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  sport_id text not null references public.sports(id) on delete cascade,
  league_id text not null references public.leagues(id) on delete cascade,
  current_team_id uuid references public.teams(id) on delete set null,
  canonical_name text not null,
  first_name text,
  last_name text,
  normalized_name text not null,
  display_name text,
  primary_position text,
  secondary_positions text[] not null default '{}'::text[],
  bats text,
  throws text,
  shoots text,
  jersey_number text,
  birth_date date,
  active boolean not null default true,
  headshot_url text,
  external_ids jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  sport_id text not null references public.sports(id) on delete cascade,
  league_id text not null references public.leagues(id) on delete cascade,
  season text,
  scheduled_date date not null,
  start_time timestamptz not null,
  status text not null default 'scheduled',
  home_team_id uuid not null references public.teams(id) on delete cascade,
  away_team_id uuid not null references public.teams(id) on delete cascade,
  venue text,
  venue_city text,
  venue_state text,
  provider_event_ids jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.player_game_logs (
  id uuid primary key default gen_random_uuid(),
  sport_id text not null references public.sports(id) on delete cascade,
  league_id text not null references public.leagues(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  team_id uuid references public.teams(id) on delete set null,
  opponent_team_id uuid references public.teams(id) on delete set null,
  game_id uuid references public.games(id) on delete cascade,
  game_date date not null,
  season text,
  provider text not null,
  minutes numeric,
  points numeric,
  rebounds numeric,
  assists numeric,
  steals numeric,
  blocks numeric,
  turnovers numeric,
  fantasy_score numeric,
  hits numeric,
  singles numeric,
  doubles numeric,
  triples numeric,
  total_bases numeric,
  runs numeric,
  rbis numeric,
  home_runs numeric,
  walks numeric,
  strikeouts numeric,
  stolen_bases numeric,
  outs_recorded numeric,
  innings_pitched numeric,
  earned_runs numeric,
  hits_allowed numeric,
  walks_allowed numeric,
  stat_line jsonb not null default '{}'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.team_game_logs (
  id uuid primary key default gen_random_uuid(),
  sport_id text not null references public.sports(id) on delete cascade,
  league_id text not null references public.leagues(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  opponent_team_id uuid references public.teams(id) on delete set null,
  game_id uuid references public.games(id) on delete cascade,
  game_date date not null,
  season text,
  provider text not null,
  pace numeric,
  offensive_rating numeric,
  defensive_rating numeric,
  possessions numeric,
  implied_total numeric,
  team_total numeric,
  stat_line jsonb not null default '{}'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.player_recent_features (
  id uuid primary key default gen_random_uuid(),
  sport_id text not null references public.sports(id) on delete cascade,
  league_id text not null references public.leagues(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  feature_date date not null,
  source_window text not null default 'last_10',
  feature_payload jsonb not null default '{}'::jsonb,
  sample_size integer not null default 0,
  data_quality_score numeric,
  stale_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (player_id, feature_date, source_window)
);

create table if not exists public.team_recent_features (
  id uuid primary key default gen_random_uuid(),
  sport_id text not null references public.sports(id) on delete cascade,
  league_id text not null references public.leagues(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  feature_date date not null,
  source_window text not null default 'last_10',
  feature_payload jsonb not null default '{}'::jsonb,
  sample_size integer not null default 0,
  data_quality_score numeric,
  stale_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, feature_date, source_window)
);

create table if not exists public.matchup_features (
  id uuid primary key default gen_random_uuid(),
  sport_id text not null references public.sports(id) on delete cascade,
  league_id text not null references public.leagues(id) on delete cascade,
  game_id uuid references public.games(id) on delete cascade,
  team_id uuid references public.teams(id) on delete cascade,
  opponent_team_id uuid references public.teams(id) on delete cascade,
  feature_date date not null,
  matchup_type text not null default 'general',
  feature_payload jsonb not null default '{}'::jsonb,
  data_quality_score numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.injuries (
  id uuid primary key default gen_random_uuid(),
  sport_id text not null references public.sports(id) on delete cascade,
  league_id text not null references public.leagues(id) on delete cascade,
  player_id uuid references public.players(id) on delete cascade,
  team_id uuid references public.teams(id) on delete cascade,
  injury_date date not null,
  status text not null,
  report_source text not null,
  body_part text,
  note text,
  return_timeline text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lineups (
  id uuid primary key default gen_random_uuid(),
  sport_id text not null references public.sports(id) on delete cascade,
  league_id text not null references public.leagues(id) on delete cascade,
  game_id uuid references public.games(id) on delete cascade,
  team_id uuid references public.teams(id) on delete cascade,
  player_id uuid references public.players(id) on delete cascade,
  lineup_date date not null,
  batting_order integer,
  slot_index integer,
  starting_status text,
  confirmed boolean not null default false,
  position text,
  note text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rest_context (
  id uuid primary key default gen_random_uuid(),
  sport_id text not null references public.sports(id) on delete cascade,
  league_id text not null references public.leagues(id) on delete cascade,
  game_id uuid references public.games(id) on delete cascade,
  team_id uuid references public.teams(id) on delete cascade,
  player_id uuid references public.players(id) on delete cascade,
  context_date date not null,
  days_rest integer,
  back_to_back boolean,
  travel_note text,
  context_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.basketball_player_features (
  id uuid primary key default gen_random_uuid(),
  league_id text not null references public.leagues(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  game_id uuid references public.games(id) on delete cascade,
  feature_date date not null,
  recent_points_avg numeric,
  recent_rebounds_avg numeric,
  recent_assists_avg numeric,
  recent_minutes_avg numeric,
  season_points_avg numeric,
  season_rebounds_avg numeric,
  season_assists_avg numeric,
  usage_trend numeric,
  feature_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.basketball_team_context (
  id uuid primary key default gen_random_uuid(),
  league_id text not null references public.leagues(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  game_id uuid references public.games(id) on delete cascade,
  context_date date not null,
  pace numeric,
  offensive_rating numeric,
  defensive_rating numeric,
  standing text,
  record_summary text,
  context_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.basketball_opponent_context (
  id uuid primary key default gen_random_uuid(),
  league_id text not null references public.leagues(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  opponent_team_id uuid references public.teams(id) on delete cascade,
  game_id uuid references public.games(id) on delete cascade,
  context_date date not null,
  opponent_pace numeric,
  opponent_defensive_rating numeric,
  opponent_record_summary text,
  context_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mlb_batter_features (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  game_id uuid references public.games(id) on delete cascade,
  feature_date date not null,
  recent_hits_avg numeric,
  recent_total_bases_avg numeric,
  season_avg numeric,
  season_obp numeric,
  season_slg numeric,
  season_ops numeric,
  average_exit_velocity numeric,
  hard_hit_rate numeric,
  barrel_rate numeric,
  xba numeric,
  xslg numeric,
  xwoba numeric,
  feature_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mlb_pitcher_features (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  game_id uuid references public.games(id) on delete cascade,
  feature_date date not null,
  recent_strikeouts_avg numeric,
  recent_pitch_count_avg numeric,
  season_era numeric,
  season_whip numeric,
  season_k_rate numeric,
  season_bb_rate numeric,
  swinging_strike_rate numeric,
  velocity_trend numeric,
  feature_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mlb_starting_pitchers (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  player_id uuid references public.players(id) on delete set null,
  hand text,
  confirmed boolean not null default false,
  source text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game_id, team_id)
);

create table if not exists public.mlb_lineups (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  player_id uuid references public.players(id) on delete cascade,
  batting_order integer,
  field_position text,
  confirmed boolean not null default false,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mlb_weather (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  weather_date date not null,
  temperature_f numeric,
  wind_mph numeric,
  wind_direction text,
  precipitation_probability numeric,
  weather_note text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game_id, weather_date)
);

create table if not exists public.mlb_ballparks (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references public.teams(id) on delete cascade,
  venue_name text not null,
  city text,
  state text,
  roof_type text,
  park_factor numeric,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (venue_name)
);

create table if not exists public.mlb_handedness_splits (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  split_date date not null,
  batter_side text,
  pitcher_side text,
  stat_type text,
  split_value numeric,
  sample_size integer,
  feature_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mlb_bullpen_context (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  context_date date not null,
  era numeric,
  whip numeric,
  strikeout_rate numeric,
  walk_rate numeric,
  workload_note text,
  context_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, context_date)
);

create table if not exists public.sportsbooks (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  display_name text not null,
  provider text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.markets (
  id uuid primary key default gen_random_uuid(),
  sport_id text not null references public.sports(id) on delete cascade,
  league_id text references public.leagues(id) on delete cascade,
  market_type text not null,
  display_name text not null,
  category text,
  player_scope text not null default 'player',
  stat_family text,
  is_combo boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.model_versions (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  version text not null,
  description text,
  ruleset jsonb not null default '{}'::jsonb,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.odds_snapshots (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  sport_id text not null references public.sports(id) on delete cascade,
  league_id text not null references public.leagues(id) on delete cascade,
  sportsbook_id uuid references public.sportsbooks(id) on delete set null,
  market_id uuid references public.markets(id) on delete set null,
  provider_event_id text,
  provider_prop_key text not null,
  player_id uuid references public.players(id) on delete set null,
  team_id uuid references public.teams(id) on delete set null,
  opponent_team_id uuid references public.teams(id) on delete set null,
  game_id uuid references public.games(id) on delete set null,
  market_type text not null,
  player_name text not null,
  team_name text,
  opponent_name text,
  line numeric not null,
  direction text not null,
  american_odds integer,
  implied_probability numeric,
  is_main_line boolean not null default true,
  is_alternate_line boolean not null default false,
  match_confidence numeric,
  match_status text not null default 'unmatched',
  match_notes text,
  raw_payload jsonb not null default '{}'::jsonb,
  pulled_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.current_props (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  latest_snapshot_id uuid not null references public.odds_snapshots(id) on delete cascade,
  sport_id text not null references public.sports(id) on delete cascade,
  league_id text not null references public.leagues(id) on delete cascade,
  sportsbook_id uuid references public.sportsbooks(id) on delete set null,
  market_id uuid references public.markets(id) on delete set null,
  player_id uuid references public.players(id) on delete set null,
  team_id uuid references public.teams(id) on delete set null,
  opponent_team_id uuid references public.teams(id) on delete set null,
  game_id uuid references public.games(id) on delete set null,
  provider_event_id text,
  provider_prop_key text not null,
  market_type text not null,
  player_name text not null,
  team_name text,
  opponent_name text,
  line numeric not null,
  direction text not null,
  american_odds integer,
  implied_probability numeric,
  match_confidence numeric,
  match_status text not null default 'unmatched',
  match_notes text,
  is_main_line boolean not null default true,
  scheduled_date date,
  game_time timestamptz,
  data_quality_score numeric,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_prop_key)
);

create table if not exists public.score_inputs (
  id uuid primary key default gen_random_uuid(),
  current_prop_id uuid not null references public.current_props(id) on delete cascade,
  model_version_id uuid references public.model_versions(id) on delete set null,
  sport_id text not null references public.sports(id) on delete cascade,
  league_id text not null references public.leagues(id) on delete cascade,
  feature_payload jsonb not null default '{}'::jsonb,
  risk_flags text[] not null default '{}'::text[],
  stale_flags text[] not null default '{}'::text[],
  data_quality_score numeric,
  created_at timestamptz not null default now()
);

create table if not exists public.scored_props (
  id uuid primary key default gen_random_uuid(),
  current_prop_id uuid not null references public.current_props(id) on delete cascade,
  score_input_id uuid references public.score_inputs(id) on delete set null,
  model_version_id uuid references public.model_versions(id) on delete set null,
  player_id uuid references public.players(id) on delete set null,
  team_id uuid references public.teams(id) on delete set null,
  opponent_team_id uuid references public.teams(id) on delete set null,
  game_id uuid references public.games(id) on delete set null,
  market_id uuid references public.markets(id) on delete set null,
  sport_id text not null references public.sports(id) on delete cascade,
  league_id text not null references public.leagues(id) on delete cascade,
  projection numeric not null,
  line numeric not null,
  edge_value numeric not null,
  edge_score numeric not null,
  confidence_score numeric not null,
  trend_score numeric,
  matchup_score numeric,
  market_score numeric,
  data_quality_score numeric,
  recommendation text not null,
  risk_flags text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.score_explanations (
  id uuid primary key default gen_random_uuid(),
  scored_prop_id uuid not null references public.scored_props(id) on delete cascade,
  summary text,
  explanation text,
  reasoning_block text,
  factor_notes jsonb not null default '{}'::jsonb,
  risk_notes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (scored_prop_id)
);

create table if not exists public.grading_results (
  id uuid primary key default gen_random_uuid(),
  scored_prop_id uuid references public.scored_props(id) on delete set null,
  current_prop_id uuid references public.current_props(id) on delete set null,
  saved_pick_id text,
  player_id uuid references public.players(id) on delete set null,
  game_id uuid references public.games(id) on delete set null,
  market_type text not null,
  stat_type text,
  line numeric not null,
  actual_value numeric,
  result text not null,
  grading_source text not null,
  notes text,
  factor_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists teams_league_idx on public.teams (league_id);
create index if not exists players_league_team_idx on public.players (league_id, current_team_id);
create index if not exists players_normalized_name_idx on public.players (normalized_name);
create unique index if not exists players_identity_unique_idx on public.players (league_id, normalized_name, coalesce(current_team_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists games_league_date_idx on public.games (league_id, scheduled_date, start_time);
create index if not exists player_game_logs_player_date_idx on public.player_game_logs (player_id, game_date desc);
create unique index if not exists player_game_logs_provider_unique_idx on public.player_game_logs (provider, player_id, game_date, coalesce(game_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists team_game_logs_team_date_idx on public.team_game_logs (team_id, game_date desc);
create unique index if not exists team_game_logs_provider_unique_idx on public.team_game_logs (provider, team_id, game_date, coalesce(game_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists player_recent_features_player_date_idx on public.player_recent_features (player_id, feature_date desc);
create index if not exists team_recent_features_team_date_idx on public.team_recent_features (team_id, feature_date desc);
create index if not exists matchup_features_game_date_idx on public.matchup_features (game_id, feature_date desc);
create unique index if not exists matchup_features_unique_idx on public.matchup_features (coalesce(game_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(opponent_team_id, '00000000-0000-0000-0000-000000000000'::uuid), feature_date, matchup_type);
create index if not exists injuries_player_date_idx on public.injuries (player_id, injury_date desc);
create index if not exists lineups_game_team_idx on public.lineups (game_id, team_id);
create index if not exists rest_context_game_idx on public.rest_context (game_id, team_id, player_id);
create unique index if not exists rest_context_unique_idx on public.rest_context (coalesce(player_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(game_id, '00000000-0000-0000-0000-000000000000'::uuid), context_date);
create index if not exists basketball_player_features_player_game_idx on public.basketball_player_features (player_id, game_id, feature_date desc);
create unique index if not exists basketball_player_features_unique_idx on public.basketball_player_features (player_id, coalesce(game_id, '00000000-0000-0000-0000-000000000000'::uuid), feature_date);
create index if not exists basketball_team_context_team_game_idx on public.basketball_team_context (team_id, game_id, context_date desc);
create unique index if not exists basketball_team_context_unique_idx on public.basketball_team_context (team_id, coalesce(game_id, '00000000-0000-0000-0000-000000000000'::uuid), context_date);
create index if not exists basketball_opponent_context_team_game_idx on public.basketball_opponent_context (team_id, opponent_team_id, game_id, context_date desc);
create unique index if not exists basketball_opponent_context_unique_idx on public.basketball_opponent_context (team_id, coalesce(opponent_team_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(game_id, '00000000-0000-0000-0000-000000000000'::uuid), context_date);
create index if not exists mlb_batter_features_player_game_idx on public.mlb_batter_features (player_id, game_id, feature_date desc);
create unique index if not exists mlb_batter_features_unique_idx on public.mlb_batter_features (player_id, coalesce(game_id, '00000000-0000-0000-0000-000000000000'::uuid), feature_date);
create index if not exists mlb_pitcher_features_player_game_idx on public.mlb_pitcher_features (player_id, game_id, feature_date desc);
create unique index if not exists mlb_pitcher_features_unique_idx on public.mlb_pitcher_features (player_id, coalesce(game_id, '00000000-0000-0000-0000-000000000000'::uuid), feature_date);
create index if not exists mlb_starting_pitchers_game_idx on public.mlb_starting_pitchers (game_id);
create index if not exists mlb_lineups_game_idx on public.mlb_lineups (game_id, team_id);
create index if not exists mlb_weather_game_date_idx on public.mlb_weather (game_id, weather_date desc);
create unique index if not exists mlb_handedness_splits_unique_idx on public.mlb_handedness_splits (player_id, split_date, coalesce(batter_side, ''), coalesce(pitcher_side, ''), stat_type);
create index if not exists mlb_bullpen_context_team_date_idx on public.mlb_bullpen_context (team_id, context_date desc);
create unique index if not exists markets_league_market_type_unique_idx on public.markets (coalesce(league_id, ''), market_type);
create index if not exists odds_snapshots_provider_game_idx on public.odds_snapshots (provider, league_id, pulled_at desc);
create index if not exists odds_snapshots_match_status_idx on public.odds_snapshots (match_status, pulled_at desc);
create index if not exists current_props_active_idx on public.current_props (active, league_id, scheduled_date, game_time);
create index if not exists current_props_match_idx on public.current_props (match_status, match_confidence desc);
create index if not exists scored_props_created_idx on public.scored_props (created_at desc);
create index if not exists scored_props_league_score_idx on public.scored_props (league_id, edge_score desc, confidence_score desc);
create index if not exists grading_results_game_idx on public.grading_results (game_id, created_at desc);

alter table public.sports enable row level security;
alter table public.leagues enable row level security;
alter table public.teams enable row level security;
alter table public.players enable row level security;
alter table public.games enable row level security;
alter table public.player_game_logs enable row level security;
alter table public.team_game_logs enable row level security;
alter table public.player_recent_features enable row level security;
alter table public.team_recent_features enable row level security;
alter table public.matchup_features enable row level security;
alter table public.injuries enable row level security;
alter table public.lineups enable row level security;
alter table public.rest_context enable row level security;
alter table public.basketball_player_features enable row level security;
alter table public.basketball_team_context enable row level security;
alter table public.basketball_opponent_context enable row level security;
alter table public.mlb_batter_features enable row level security;
alter table public.mlb_pitcher_features enable row level security;
alter table public.mlb_starting_pitchers enable row level security;
alter table public.mlb_lineups enable row level security;
alter table public.mlb_weather enable row level security;
alter table public.mlb_ballparks enable row level security;
alter table public.mlb_handedness_splits enable row level security;
alter table public.mlb_bullpen_context enable row level security;
alter table public.sportsbooks enable row level security;
alter table public.markets enable row level security;
alter table public.model_versions enable row level security;
alter table public.odds_snapshots enable row level security;
alter table public.current_props enable row level security;
alter table public.score_inputs enable row level security;
alter table public.scored_props enable row level security;
alter table public.score_explanations enable row level security;
alter table public.grading_results enable row level security;

revoke all on table
  public.sports,
  public.leagues,
  public.teams,
  public.players,
  public.games,
  public.player_game_logs,
  public.team_game_logs,
  public.player_recent_features,
  public.team_recent_features,
  public.matchup_features,
  public.injuries,
  public.lineups,
  public.rest_context,
  public.basketball_player_features,
  public.basketball_team_context,
  public.basketball_opponent_context,
  public.mlb_batter_features,
  public.mlb_pitcher_features,
  public.mlb_starting_pitchers,
  public.mlb_lineups,
  public.mlb_weather,
  public.mlb_ballparks,
  public.mlb_handedness_splits,
  public.mlb_bullpen_context,
  public.sportsbooks,
  public.markets,
  public.model_versions,
  public.odds_snapshots,
  public.current_props,
  public.score_inputs,
  public.scored_props,
  public.score_explanations,
  public.grading_results
from anon, authenticated;

grant select, insert, update, delete on table
  public.sports,
  public.leagues,
  public.teams,
  public.players,
  public.games,
  public.player_game_logs,
  public.team_game_logs,
  public.player_recent_features,
  public.team_recent_features,
  public.matchup_features,
  public.injuries,
  public.lineups,
  public.rest_context,
  public.basketball_player_features,
  public.basketball_team_context,
  public.basketball_opponent_context,
  public.mlb_batter_features,
  public.mlb_pitcher_features,
  public.mlb_starting_pitchers,
  public.mlb_lineups,
  public.mlb_weather,
  public.mlb_ballparks,
  public.mlb_handedness_splits,
  public.mlb_bullpen_context,
  public.sportsbooks,
  public.markets,
  public.model_versions,
  public.odds_snapshots,
  public.current_props,
  public.score_inputs,
  public.scored_props,
  public.score_explanations,
  public.grading_results
to service_role;
