import type { PublicSnapshotResponseMeta } from "@/lib/knowledge/public-snapshot-types";
import type { ParlayCommentary } from "@/lib/knowledge/commentary";

export type KnowledgeFactor = {
  name?: string | null;
  label?: string | null;
  impact?: "positive" | "negative" | "neutral" | "caution" | string | null;
  description?: string | null;
};

export type KnowledgeSportsbook = {
  id: string;
  code: string;
  display_name: string;
};

export type CoveredPickRow = {
  scored_prop_id: string;
  current_prop_id: string;
  odds_snapshot_id: string | null;
  market_instance_key: string | null;
  event_id: string | null;
  participant_id: string | null;
  participant_type: string | null;
  player_display_name: string;
  participant_image_url: string | null;
  player_headshot_url: string | null;
  team_display_name: string | null;
  team_logo_url: string | null;
  opponent_display_name: string | null;
  opponent_logo_url: string | null;
  event_display_name: string | null;
  sport: string;
  league: string;
  market_type: string;
  market_display_label: string;
  sportsbook_id: string | null;
  sportsbook: KnowledgeSportsbook | null;
  sportsbooks?: KnowledgeSportsbook[];
  sportsbook_count?: number;
  grouped_variant_count?: number;
  side: string | null;
  line: number;
  over_price: number | null;
  under_price: number | null;
  start_time: string | null;
  covered_score: number | null;
  edge_score: number | null;
  confidence_score: number | null;
  data_quality_score: number | null;
  recommendation: string | null;
  score_label: string | null;
  confidence_label: string | null;
  risk_label: string | null;
  explanation_summary: string | null;
  factor_breakdown: KnowledgeFactor[];
  risk_flags: string[];
  grading_result: {
    result?: string | null;
    final_stat?: number | null;
    line?: number | null;
    grade_reason?: string | null;
  } | null;
  last_updated: string | null;
  /** 2026-08-07 Covered Picks/Analyzer evidence parity: the SAME
   * ParlayOptionEvidence shape getParlayOptions already builds, computed the
   * same way (batched, from already-stored score_inputs.feature_payload +
   * player_game_logs) so "Why this score?" shows identical evidence for the
   * same prop on either surface. Declared after ParlayOptionEvidence below. */
  evidence?: ParlayOptionEvidence | null;
  commentary?: ParlayCommentary | null;
};

export type CoveredPicksResponse = PublicSnapshotResponseMeta & {
  product_mode: string;
  count: number;
  rows: CoveredPickRow[];
};

/**
 * Expanded, deterministic evidence for the Parlay Builder's "expanded
 * evidence" disclosure tier -- every field is either read directly from the
 * already-stored score_inputs.feature_payload (structuredInputs, written
 * once at scoring time, never recomputed here) or counted directly from
 * already-stored player_game_logs rows against this exact prop's own
 * current line. Null means the underlying source genuinely has no value
 * (e.g. too few stored games), never a fabricated placeholder.
 */
export type ParlayOptionEvidence = {
  projection: number | null;
  edgeValue: number | null;
  last5Avg: number | null;
  last10Avg: number | null;
  /** How many of the last 5 stored games (up to 5) cleared this prop's exact current line, in this prop's direction. */
  last5HitCount: number | null;
  /** How many stored games were actually available for the last5HitCount denominator (<=5). */
  last5SampleSize: number | null;
  last10HitCount: number | null;
  last10SampleSize: number | null;
  /** Last-5-game minutes average (basketball only; null for MLB/unsupported markets). */
  recentMinutesAvg: number | null;
  minutesTrend: number | null;
  usageTrend: number | null;
  matchupNote: string | null;
  injuryNote: string | null;
  /** ISO timestamp of the freshest input this evidence was built from. */
  dataRefreshedAt: string | null;
};

export type ParlayOptionRow = {
  current_prop_id: string;
  latest_scored_prop_id: string | null;
  latest_snapshot_id: string | null;
  market_instance_key: string | null;
  event_id: string | null;
  participant_id: string | null;
  participant_type: string | null;
  display_label: string;
  sport: string;
  league: string;
  event_display_name: string | null;
  participant_display_name: string;
  participant_image_url: string | null;
  player_headshot_url: string | null;
  team_display_name: string | null;
  team_logo_url: string | null;
  opponent_display_name: string | null;
  opponent_logo_url: string | null;
  market_type: string;
  sportsbook: KnowledgeSportsbook | null;
  sportsbooks?: KnowledgeSportsbook[];
  sportsbook_count?: number;
  grouped_variant_count?: number;
  side: string | null;
  line: number;
  over_price: number | null;
  under_price: number | null;
  start_time: string | null;
  match_status: string;
  match_confidence: number | null;
  match_quality_flags: string[];
  publishability_status?: string | null;
  publishability_reasons?: string[];
  covered_score: number | null;
  score_label: string | null;
  confidence_label: string | null;
  risk_label: string | null;
  /** Bounded, public-safe commentary computed once during scoring and reused
   * here -- never fetched per-card. Null only when no explanation row exists
   * yet for this scored prop (e.g. a legacy pre-explanation row). */
  commentary?: ParlayCommentary | null;
  /** Null only when the linked scored_props row has no score_input_id (a legacy
   * shape not produced by the current pipeline) -- omitted, never fabricated,
   * per the same contract commentary already follows. Individual fields within
   * a non-null evidence object are independently null when their own source
   * (a specific feature_payload key, a named factor, or player_game_logs rows
   * for that player) is genuinely absent. */
  evidence?: ParlayOptionEvidence | null;
};

export type ParlayOptionsResponse = PublicSnapshotResponseMeta & {
  count: number;
  rows: ParlayOptionRow[];
};

export type ModelPerformanceBucket = {
  key: string;
  total_graded: number;
  wins: number;
  losses: number;
  pushes: number;
  no_grades: number;
  hit_rate_excluding_pushes_no_grades: number | null;
  push_rate: number | null;
  no_grade_rate: number | null;
  average_covered_score: number | null;
  average_confidence_score: number | null;
};

export type ModelPerformanceSummary = {
  total_graded: number;
  wins: number;
  losses: number;
  pushes: number;
  no_grades: number;
  hit_rate_excluding_pushes_no_grades: number | null;
  push_rate: number | null;
  no_grade_rate: number | null;
  average_covered_score: number | null;
  average_confidence_score: number | null;
};

export type ModelPerformanceFactRow = {
  graded_at: string | null;
  sport_id: string | null;
  league_id: string | null;
  market_type: string;
  result: string;
  grade_status: string | null;
  model_version_id: string | null;
  current_prop_id: string | null;
  scored_prop_id: string | null;
  covered_score: number | null;
  confidence_score: number | null;
  recommendation: string | null;
  score_label: string | null;
  confidence_label: string | null;
  risk_label: string | null;
  sportsbook_code: string | null;
  sportsbook_display_name: string | null;
};

export type ModelPerformanceResponse = PublicSnapshotResponseMeta & {
  summary: ModelPerformanceSummary;
  performance_by_sport: ModelPerformanceBucket[];
  performance_by_league: ModelPerformanceBucket[];
  performance_by_market_type: ModelPerformanceBucket[];
  performance_by_score_label: ModelPerformanceBucket[];
  performance_by_confidence_label: ModelPerformanceBucket[];
  performance_by_risk_label: ModelPerformanceBucket[];
  count: number;
  rows: ModelPerformanceFactRow[];
};
