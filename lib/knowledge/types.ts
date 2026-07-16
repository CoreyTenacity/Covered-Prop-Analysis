import type { Sport } from "@/lib/types";

export type KnowledgeSportCode = "BASEBALL" | "BASKETBALL" | "FOOTBALL" | "TENNIS";
export type ActiveKnowledgeLeagueCode = "MLB" | "NBA" | "WNBA";
export type KnowledgeLeagueCode = ActiveKnowledgeLeagueCode | "NFL" | "TENNIS";
export type KnowledgeJobLeague = ActiveKnowledgeLeagueCode;
export type SupportedProvider = "sharpapi" | "oddsapi" | "sportsgameodds";

export type ParticipantType = "player" | "team" | "batter" | "pitcher" | "tennis_player";
export type EventType = "game" | "match" | "contest";
export type EntityType = "sport" | "league" | "team" | "player" | "participant" | "event" | "market" | "sportsbook";

export type RefreshJobName =
  | "repair_prop_identities"
  | "refresh_players"
  | "refresh_teams"
  | "refresh_schedules"
  | "refresh_schedules_live_gate"
  | "refresh_completed_games"
  | "refresh_player_game_logs"
  | "refresh_team_game_logs"
  | "refresh_recent_features"
  | "refresh_injuries"
  | "refresh_lineups"
  | "refresh_rest_context"
  | "refresh_basketball_matchup_features"
  | "refresh_mlb_starting_pitchers"
  | "refresh_mlb_weather"
  | "refresh_mlb_ballparks"
  | "refresh_mlb_handedness_splits"
  | "refresh_mlb_bullpen_context"
  | "refresh_mlb_matchup_features"
  | "ingest_sportsdataverse_wnba";

export type PullStrategyConfig = {
  provider: SupportedProvider;
  sport: KnowledgeSportCode;
  league: ActiveKnowledgeLeagueCode;
  marketType: string;
  sportsbook: string | null;
  priority: number;
  pullCadenceMinutes: number;
  enabled: boolean;
  metadata?: Record<string, unknown>;
};

export type CanonicalSportRow = {
  id: string;
  code: KnowledgeSportCode;
  name: string;
};

export type CanonicalLeagueRow = {
  id: string;
  sport_id: string;
  code: KnowledgeLeagueCode;
  name: string;
  level: string;
  active?: boolean;
  created_at?: string;
  updated_at?: string;
};

export type TeamRow = {
  id?: string;
  sport_id: string;
  league_id: string;
  code: string;
  name: string;
  city?: string | null;
  nickname?: string | null;
  abbreviation?: string | null;
  logo_url?: string | null;
  external_ids?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type PlayerRow = {
  id?: string;
  sport_id: string;
  league_id: string;
  current_team_id?: string | null;
  canonical_name: string;
  first_name?: string | null;
  last_name?: string | null;
  normalized_name: string;
  display_name?: string | null;
  primary_position?: string | null;
  secondary_positions?: string[];
  bats?: string | null;
  throws?: string | null;
  shoots?: string | null;
  jersey_number?: string | null;
  birth_date?: string | null;
  active?: boolean;
  headshot_url?: string | null;
  external_ids?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type ParticipantRow = {
  id?: string;
  sport_id: string;
  league_id: string;
  participant_type: ParticipantType;
  display_name: string;
  normalized_name: string;
  player_id?: string | null;
  team_id?: string | null;
  image_url?: string | null;
  active?: boolean;
  external_ids?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type EventRow = {
  id?: string;
  sport_id: string;
  league_id: string;
  event_type: EventType;
  season?: string | null;
  scheduled_date: string;
  start_time: string;
  status: string;
  display_name?: string | null;
  home_team_id?: string | null;
  away_team_id?: string | null;
  venue?: string | null;
  venue_city?: string | null;
  venue_state?: string | null;
  provider_event_ids?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type LegacyGameRow = {
  id?: string;
  sport_id: string;
  league_id: string;
  season?: string | null;
  scheduled_date: string;
  start_time: string;
  status: string;
  home_team_id: string;
  away_team_id: string;
  venue?: string | null;
  venue_city?: string | null;
  venue_state?: string | null;
  provider_event_ids?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type OddsSnapshotInsert = {
  provider: SupportedProvider;
  sport_id: string;
  league_id: string;
  sportsbook_id?: string | null;
  market_id?: string | null;
  market_instance_key?: string | null;
  provider_market_type?: string | null;
  provider_event_id?: string | null;
  provider_prop_key: string;
  // Canonical contest identity for all new knowledge architecture work.
  event_id?: string | null;
  participant_id?: string | null;
  participant_type?: ParticipantType | null;
  player_id?: string | null;
  team_id?: string | null;
  opponent_id?: string | null;
  opponent_team_id?: string | null;
  // Legacy compatibility only. New logic should prefer event_id.
  game_id?: string | null;
  market_type: string;
  player_name: string;
  team_name?: string | null;
  opponent_name?: string | null;
  line: number;
  direction: "More" | "Less";
  side?: "More" | "Less" | null;
  american_odds?: number | null;
  over_price?: number | null;
  under_price?: number | null;
  implied_probability?: number | null;
  is_main_line?: boolean;
  is_alternate_line?: boolean;
  match_confidence?: number | null;
  match_status?: string;
  match_notes?: string | null;
  match_quality_flags?: string[];
  raw_payload?: Record<string, unknown>;
  // Canonical contest start time for product reads and historical replay.
  start_time?: string | null;
  pulled_at?: string;
};

export type CurrentPropUpsert = {
  provider: SupportedProvider;
  latest_snapshot_id: string;
  prop_state?: "raw_current";
  sport_id: string;
  league_id: string;
  sportsbook_id?: string | null;
  market_id?: string | null;
  market_instance_key?: string | null;
  provider_market_type?: string | null;
  participant_id?: string | null;
  participant_type?: ParticipantType | null;
  player_id?: string | null;
  team_id?: string | null;
  opponent_id?: string | null;
  opponent_team_id?: string | null;
  // Canonical contest identity for all new knowledge architecture work.
  event_id?: string | null;
  // Legacy compatibility only. New logic should prefer event_id.
  game_id?: string | null;
  provider_event_id?: string | null;
  provider_prop_key: string;
  market_type: string;
  player_name: string;
  team_name?: string | null;
  opponent_name?: string | null;
  line: number;
  direction: "More" | "Less";
  side?: "More" | "Less" | null;
  american_odds?: number | null;
  over_price?: number | null;
  under_price?: number | null;
  implied_probability?: number | null;
  match_confidence?: number | null;
  match_status?: string;
  match_notes?: string | null;
  match_quality_flags?: string[];
  is_main_line?: boolean;
  scheduled_date?: string | null;
  // Canonical contest start time for new product reads.
  start_time?: string | null;
  // Legacy compatibility only. Keep mirrored with start_time until downstream readers migrate.
  game_time?: string | null;
  data_quality_score?: number | null;
  active?: boolean;
  updated_at?: string;
};

export type MatchResolution = {
  playerId: string | null;
  teamId: string | null;
  opponentId: string | null;
  opponentTeamId: string | null;
  participantId: string | null;
  participantType: ParticipantType | null;
  eventId: string | null;
  legacyGameId: string | null;
  marketId: string | null;
  sportsbookId: string | null;
  matchConfidence: number;
  matchStatus: "strongly_resolved" | "matched" | "ambiguous" | "unmatched";
  matchNotes: string;
  matchQualityFlags: string[];
};

export type ScoreResultRow = {
  current_prop_id: string;
  score_input_id?: string | null;
  model_version_id?: string | null;
  participant_id?: string | null;
  participant_type?: ParticipantType | null;
  player_id?: string | null;
  team_id?: string | null;
  opponent_id?: string | null;
  opponent_team_id?: string | null;
  event_id?: string | null;
  game_id?: string | null;
  market_id?: string | null;
  sport_id: string;
  league_id: string;
  covered_score: number;
  projection: number;
  line: number;
  edge_value: number;
  edge_score: number;
  confidence_score: number;
  trend_score?: number | null;
  matchup_score?: number | null;
  market_score?: number | null;
  data_quality_score?: number | null;
  recommendation: string;
  risk_flags: string[];
  prop_state?: "candidate" | "publishable";
  publishable?: boolean;
  publishability_reasons?: string[];
};

export type ScoreExplanationRow = {
  scored_prop_id: string;
  event_id?: string | null;
  participant_id?: string | null;
  summary: string;
  score_label?: string | null;
  confidence_label?: string | null;
  risk_label?: string | null;
  explanation: string;
  reasoning_block: string;
  factor_notes: Record<string, unknown>;
  factors?: Array<Record<string, unknown>>;
  risk_notes: Array<string | Record<string, unknown>>;
};

export type EntityAliasRow = {
  id?: string;
  sport_id?: string | null;
  entity_type: EntityType;
  entity_id: string;
  provider?: string | null;
  league_id?: string | null;
  alias: string;
  normalized_alias: string;
  alias_type?: string | null;
  confidence?: number | null;
  metadata?: Record<string, unknown>;
};

export type SourceMappingRow = {
  provider: string;
  entity_type: EntityType;
  entity_id: string;
  external_id?: string | null;
  external_key?: string | null;
  league_id?: string | null;
  metadata?: Record<string, unknown>;
};

export type OddsPullConfigRow = {
  provider: SupportedProvider;
  sport_id: string;
  league_id: string;
  market_type: string;
  sportsbook: string | null;
  priority: number;
  pull_cadence_minutes: number;
  enabled: boolean;
  metadata?: Record<string, unknown>;
};

export function sportToKnowledgeSportCode(sport: Sport): KnowledgeSportCode {
  switch (sport) {
    case "MLB":
      return "BASEBALL";
    case "NBA":
    case "WNBA":
      return "BASKETBALL";
    case "NFL":
      return "FOOTBALL";
    case "Tennis":
      return "TENNIS";
  }
}
