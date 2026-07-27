// The explicit MLB + WNBA enrichment matrix. Every scoring input is declared
// here with its sources, applicability, freshness, whether it is hard-required
// (i.e. its absence/staleness blocks a valid Covered Score), whether genuine
// provider absence is permitted, and how the pipeline reconciles it.
//
// This is the single machine-readable contract the Phase C readiness gates
// consume, so "which fields must a prop have before it can be scored" is defined
// in ONE place instead of being implicit in scoring-service.ts. The hardRequired
// flags are grounded in the actual publishability blockers in
// scoring-service.ts:publishabilityAssessment (verified): identity
// (player/participant/event/team/opponent + match confidence), recent features
// (present + fresh), team context, and matchup context are the blockers; every
// sport-specific input (weather, handedness, pace, minutes, …) is a soft
// scoring input whose absence penalizes but does not block.
//
// Dependency-free (no Supabase, no scoring) so it is a pure contract.

import type { MissingCause } from "./stage-result.ts";

export type ContractSport = "MLB" | "WNBA";

// How the pipeline should try to recover a missing/stale field before giving up.
export type ReconciliationStage =
  | "identity" //   re-run identity resolution
  | "ingestion" //  re-run the provider ingestion that feeds this field
  | "features" //   re-run recent/rolling feature generation
  | "matchup" //    re-run team/opponent/matchup context computation
  | "support" //    re-run an MLB support refresh (lineups/pitchers/weather/…)
  | "none"; //      not recoverable in-run (e.g. genuine provider absence)

export type FieldContract = {
  field: string; // canonical name
  sports: ContractSport[];
  // ordered source preference (first = authoritative). Names are provider/table
  // identifiers, not secrets.
  sourcePriority: string[];
  fallbackSources: string[];
  // which market/stat types this field applies to. `"*"` = all markets for the
  // listed sports.
  appliesToMarkets: "*" | string[];
  // max age before the value is considered `stale` (a pipeline failure). null =
  // no freshness requirement (static/reference data).
  freshnessMs: number | null;
  // if true, absence/staleness makes the prop score_blocked (no valid score).
  hardRequired: boolean;
  // if true, a *proven* provider absence (see provider-absent proof standard) is
  // acceptable and yields score_limited rather than score_blocked.
  absencePermitted: boolean;
  // effect when the field is absent AND absence is not permitted / not proven.
  consequenceWhenAbsent: "block" | "penalize";
  reconciliation: ReconciliationStage;
  // the classified cause to attribute when this field is missing for a
  // pipeline reason (used by the readiness gate + completeness report). Never
  // provider_absent - that is only reached via the absence-proof standard.
  pipelineFailureCause: Exclude<MissingCause, "provider_absent">;
  notes?: string;
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Market applicability helpers (canonical/internal market_type values).
const WNBA_PLAYER_MARKETS = ["player_points", "player_rebounds", "player_assists", "player_pra", "player_threes", "player_steals", "player_blocks", "player_turnovers", "player_double_double"];
const MLB_BATTER_MARKETS = ["batter_hits", "batter_total_bases", "batter_home_runs", "batter_rbis", "batter_runs", "batter_singles", "batter_doubles", "batter_stolen_bases", "batter_hits_runs_rbis", "batter_walks", "batter_strikeouts"];
const MLB_PITCHER_MARKETS = ["pitcher_strikeouts", "pitcher_outs", "pitcher_earned_runs", "pitcher_hits_allowed", "pitcher_walks", "pitcher_wins"];

export const FIELD_CONTRACTS: FieldContract[] = [
  // ---- Common identity (hard-required, both sports) ----
  { field: "player_identity", sports: ["MLB", "WNBA"], sourcePriority: ["players", "entity_aliases", "source_mappings"], fallbackSources: ["sharpapi_name_match"], appliesToMarkets: "*", freshnessMs: null, hardRequired: true, absencePermitted: false, consequenceWhenAbsent: "block", reconciliation: "identity", pipelineFailureCause: "identity_failed" },
  { field: "participant", sports: ["MLB", "WNBA"], sourcePriority: ["participants"], fallbackSources: [], appliesToMarkets: "*", freshnessMs: null, hardRequired: true, absencePermitted: false, consequenceWhenAbsent: "block", reconciliation: "identity", pipelineFailureCause: "identity_failed" },
  { field: "team", sports: ["MLB", "WNBA"], sourcePriority: ["teams", "entity_aliases"], fallbackSources: [], appliesToMarkets: "*", freshnessMs: null, hardRequired: true, absencePermitted: false, consequenceWhenAbsent: "block", reconciliation: "identity", pipelineFailureCause: "identity_failed" },
  { field: "opponent", sports: ["MLB", "WNBA"], sourcePriority: ["events", "teams"], fallbackSources: [], appliesToMarkets: "*", freshnessMs: null, hardRequired: true, absencePermitted: false, consequenceWhenAbsent: "block", reconciliation: "identity", pipelineFailureCause: "join_failed" },
  { field: "event", sports: ["MLB", "WNBA"], sourcePriority: ["events", "source_mappings"], fallbackSources: [], appliesToMarkets: "*", freshnessMs: null, hardRequired: true, absencePermitted: false, consequenceWhenAbsent: "block", reconciliation: "identity", pipelineFailureCause: "identity_failed" },
  { field: "event_start_time", sports: ["MLB", "WNBA"], sourcePriority: ["events"], fallbackSources: ["espn_schedule", "mlb_stats_api"], appliesToMarkets: "*", freshnessMs: null, hardRequired: true, absencePermitted: false, consequenceWhenAbsent: "block", reconciliation: "ingestion", pipelineFailureCause: "ingestion_missing" },
  { field: "market_stat_type", sports: ["MLB", "WNBA"], sourcePriority: ["current_props"], fallbackSources: [], appliesToMarkets: "*", freshnessMs: null, hardRequired: true, absencePermitted: false, consequenceWhenAbsent: "block", reconciliation: "ingestion", pipelineFailureCause: "ingestion_missing" },
  { field: "line", sports: ["MLB", "WNBA"], sourcePriority: ["current_props", "sharpapi"], fallbackSources: [], appliesToMarkets: "*", freshnessMs: 12 * HOUR, hardRequired: true, absencePermitted: false, consequenceWhenAbsent: "block", reconciliation: "ingestion", pipelineFailureCause: "ingestion_missing" },
  { field: "direction", sports: ["MLB", "WNBA"], sourcePriority: ["current_props"], fallbackSources: [], appliesToMarkets: "*", freshnessMs: null, hardRequired: true, absencePermitted: false, consequenceWhenAbsent: "block", reconciliation: "ingestion", pipelineFailureCause: "ingestion_missing" },
  { field: "sportsbook", sports: ["MLB", "WNBA"], sourcePriority: ["current_props", "sharpapi"], fallbackSources: [], appliesToMarkets: "*", freshnessMs: null, hardRequired: false, absencePermitted: true, consequenceWhenAbsent: "penalize", reconciliation: "ingestion", pipelineFailureCause: "ingestion_missing" },

  // ---- Common enrichment context (hard-required, both sports) ----
  { field: "recent_game_logs", sports: ["MLB", "WNBA"], sourcePriority: ["player_game_logs"], fallbackSources: ["sportsdataverse-wnba", "mlb-stats-api"], appliesToMarkets: "*", freshnessMs: 3 * DAY, hardRequired: true, absencePermitted: true, consequenceWhenAbsent: "block", reconciliation: "ingestion", pipelineFailureCause: "ingestion_missing", notes: "provider_absent permitted for a genuine first-game player with no prior logs (proven)." },
  { field: "recent_form_features", sports: ["MLB", "WNBA"], sourcePriority: ["player_recent_features", "basketball_player_features"], fallbackSources: [], appliesToMarkets: "*", freshnessMs: 12 * HOUR, hardRequired: true, absencePermitted: false, consequenceWhenAbsent: "block", reconciliation: "features", pipelineFailureCause: "feature_gen_failed", notes: "derived from recent_game_logs; staleness => stale (pipeline failure)." },
  { field: "hit_rate_inputs", sports: ["MLB", "WNBA"], sourcePriority: ["player_recent_features"], fallbackSources: ["player_game_logs"], appliesToMarkets: "*", freshnessMs: 12 * HOUR, hardRequired: false, absencePermitted: true, consequenceWhenAbsent: "penalize", reconciliation: "features", pipelineFailureCause: "feature_gen_failed" },
  { field: "team_context", sports: ["MLB", "WNBA"], sourcePriority: ["basketball_team_context", "team_game_logs", "mlb_team_features"], fallbackSources: [], appliesToMarkets: "*", freshnessMs: DAY, hardRequired: true, absencePermitted: false, consequenceWhenAbsent: "block", reconciliation: "matchup", pipelineFailureCause: "enrichment_error" },
  { field: "opponent_context", sports: ["MLB", "WNBA"], sourcePriority: ["basketball_opponent_context", "mlb_opponent_features"], fallbackSources: [], appliesToMarkets: "*", freshnessMs: DAY, hardRequired: true, absencePermitted: false, consequenceWhenAbsent: "block", reconciliation: "matchup", pipelineFailureCause: "enrichment_error" },
  { field: "matchup_context", sports: ["MLB", "WNBA"], sourcePriority: ["matchup_features", "basketball_opponent_context"], fallbackSources: [], appliesToMarkets: "*", freshnessMs: DAY, hardRequired: true, absencePermitted: false, consequenceWhenAbsent: "block", reconciliation: "matchup", pipelineFailureCause: "enrichment_error" },
  { field: "projection_inputs", sports: ["MLB", "WNBA"], sourcePriority: ["basketball_player_features", "mlb_player_features"], fallbackSources: [], appliesToMarkets: "*", freshnessMs: 12 * HOUR, hardRequired: false, absencePermitted: false, consequenceWhenAbsent: "penalize", reconciliation: "features", pipelineFailureCause: "feature_gen_failed" },
  { field: "score_explanation_inputs", sports: ["MLB", "WNBA"], sourcePriority: ["derived"], fallbackSources: [], appliesToMarkets: "*", freshnessMs: null, hardRequired: false, absencePermitted: false, consequenceWhenAbsent: "penalize", reconciliation: "features", pipelineFailureCause: "feature_gen_failed" },

  // ---- Common context, soft ----
  { field: "injury_availability", sports: ["MLB", "WNBA"], sourcePriority: ["injuries", "official-injuries"], fallbackSources: [], appliesToMarkets: "*", freshnessMs: 12 * HOUR, hardRequired: false, absencePermitted: true, consequenceWhenAbsent: "penalize", reconciliation: "ingestion", pipelineFailureCause: "ingestion_missing", notes: "absence permitted: no injury record commonly means healthy." },
  { field: "role_context", sports: ["MLB", "WNBA"], sourcePriority: ["player_recent_features", "lineups"], fallbackSources: [], appliesToMarkets: "*", freshnessMs: DAY, hardRequired: false, absencePermitted: true, consequenceWhenAbsent: "penalize", reconciliation: "features", pipelineFailureCause: "feature_gen_failed" },

  // ---- WNBA-specific ----
  { field: "expected_minutes", sports: ["WNBA"], sourcePriority: ["basketball_player_features", "player_recent_features"], fallbackSources: ["role_proxy"], appliesToMarkets: WNBA_PLAYER_MARKETS, freshnessMs: DAY, hardRequired: false, absencePermitted: true, consequenceWhenAbsent: "penalize", reconciliation: "features", pipelineFailureCause: "feature_gen_failed", notes: "role proxy (recent minutes avg) is the permitted fallback." },
  { field: "pace", sports: ["WNBA"], sourcePriority: ["basketball_team_context", "team_game_logs"], fallbackSources: [], appliesToMarkets: WNBA_PLAYER_MARKETS, freshnessMs: DAY, hardRequired: false, absencePermitted: false, consequenceWhenAbsent: "penalize", reconciliation: "matchup", pipelineFailureCause: "enrichment_error" },
  { field: "basketball_player_features", sports: ["WNBA"], sourcePriority: ["basketball_player_features"], fallbackSources: ["player_recent_features"], appliesToMarkets: WNBA_PLAYER_MARKETS, freshnessMs: 12 * HOUR, hardRequired: false, absencePermitted: false, consequenceWhenAbsent: "penalize", reconciliation: "features", pipelineFailureCause: "feature_gen_failed" },
  { field: "wnba_lineup_context", sports: ["WNBA"], sourcePriority: ["lineups", "injuries"], fallbackSources: [], appliesToMarkets: WNBA_PLAYER_MARKETS, freshnessMs: 12 * HOUR, hardRequired: false, absencePermitted: true, consequenceWhenAbsent: "penalize", reconciliation: "support", pipelineFailureCause: "ingestion_missing", notes: "absence permitted until lineups are posted pre-game." },

  // ---- MLB-specific ----
  { field: "opponent_pitcher", sports: ["MLB"], sourcePriority: ["mlb_starting_pitchers", "events.metadata.probable_pitchers"], fallbackSources: [], appliesToMarkets: MLB_BATTER_MARKETS, freshnessMs: DAY, hardRequired: false, absencePermitted: true, consequenceWhenAbsent: "penalize", reconciliation: "support", pipelineFailureCause: "ingestion_missing", notes: "absence permitted until the probable pitcher is announced." },
  { field: "handedness", sports: ["MLB"], sourcePriority: ["players.bats", "players.throws"], fallbackSources: [], appliesToMarkets: [...MLB_BATTER_MARKETS, ...MLB_PITCHER_MARKETS], freshnessMs: null, hardRequired: false, absencePermitted: true, consequenceWhenAbsent: "penalize", reconciliation: "support", pipelineFailureCause: "join_failed" },
  { field: "handedness_splits", sports: ["MLB"], sourcePriority: ["mlb_handedness_splits"], fallbackSources: [], appliesToMarkets: MLB_BATTER_MARKETS, freshnessMs: DAY, hardRequired: false, absencePermitted: true, consequenceWhenAbsent: "penalize", reconciliation: "support", pipelineFailureCause: "feature_gen_failed", notes: "requires both the batter's hand and the opposing pitcher's hand; absent until the pitcher is set." },
  { field: "weather", sports: ["MLB"], sourcePriority: ["mlb_weather", "open-meteo"], fallbackSources: [], appliesToMarkets: "*", freshnessMs: 3 * HOUR, hardRequired: false, absencePermitted: true, consequenceWhenAbsent: "penalize", reconciliation: "support", pipelineFailureCause: "enrichment_error", notes: "absence PERMITTED for indoor/dome venues (no applicable value); a request/parse/write failure is enrichment_error, NOT provider_absent." },
  { field: "ballpark_context", sports: ["MLB"], sourcePriority: ["mlb_ballparks"], fallbackSources: ["events.venue"], appliesToMarkets: "*", freshnessMs: null, hardRequired: false, absencePermitted: true, consequenceWhenAbsent: "penalize", reconciliation: "support", pipelineFailureCause: "ingestion_missing" },
  { field: "bullpen_context", sports: ["MLB"], sourcePriority: ["mlb_bullpen_context"], fallbackSources: ["player_game_logs"], appliesToMarkets: MLB_BATTER_MARKETS, freshnessMs: DAY, hardRequired: false, absencePermitted: true, consequenceWhenAbsent: "penalize", reconciliation: "support", pipelineFailureCause: "feature_gen_failed" },
  { field: "mlb_player_features", sports: ["MLB"], sourcePriority: ["mlb_player_features", "player_recent_features"], fallbackSources: [], appliesToMarkets: [...MLB_BATTER_MARKETS, ...MLB_PITCHER_MARKETS], freshnessMs: 12 * HOUR, hardRequired: false, absencePermitted: false, consequenceWhenAbsent: "penalize", reconciliation: "features", pipelineFailureCause: "feature_gen_failed" },
];

// Is a field applicable to a given prop's sport + market?
export function fieldApplies(contract: FieldContract, input: { sport: ContractSport; marketType: string | null }): boolean {
  if (!contract.sports.includes(input.sport)) return false;
  if (contract.appliesToMarkets === "*") return true;
  if (!input.marketType) return false;
  return contract.appliesToMarkets.includes(input.marketType);
}

// The hard-required, applicable fields a prop must satisfy to earn a valid score.
export function hardRequiredFieldsFor(input: { sport: ContractSport; marketType: string | null }): FieldContract[] {
  return FIELD_CONTRACTS.filter((c) => c.hardRequired && fieldApplies(c, input));
}

// All applicable fields (hard + soft) for a prop.
export function applicableFieldsFor(input: { sport: ContractSport; marketType: string | null }): FieldContract[] {
  return FIELD_CONTRACTS.filter((c) => fieldApplies(c, input));
}

export function getFieldContract(field: string): FieldContract | undefined {
  return FIELD_CONTRACTS.find((c) => c.field === field);
}
