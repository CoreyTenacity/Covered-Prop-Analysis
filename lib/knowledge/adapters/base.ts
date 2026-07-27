// Public-safe adapter contracts and shared helpers.
//
// Everything in this file is intentionally limited to one of three categories:
//   1. type contracts (erased at build time, zero runtime output)
//   2. generic utilities with no tuned values (clamp, numeric)
//   3. label mappings whose inputs AND outputs are both already published on
//      every public board row (see CoveredPickRow in read-types.ts:
//      covered_score/recommendation, confidence_score+data_quality_score/
//      confidence_label, risk_flags+data_quality_score/risk_label) -- so the
//      source here reveals nothing that reading the public API a few times does
//      not already reveal.
//
// The tuned scoring model itself -- projection formulas, factor weights, edge
// bands -- lives in the sport adapters (basketball.ts, mlb.ts) and the private
// scoring-engine Worker, NOT here. Helpers used only by those adapters live in
// ./scoring-internals.ts.
//
// Keep it that way: lib/knowledge/read-service.ts (the public read path) imports
// from this file, so anything added here is effectively public. If a new helper
// encodes real product judgment and is not already observable through the public
// API, put it in ./scoring-internals.ts instead.

export type StoredFeatureMap = Record<string, unknown>;

export type AdapterPropRow = {
  id: string;
  provider: string;
  latest_snapshot_id: string;
  sport_id: string;
  league_id: string;
  sportsbook_id: string | null;
  market_id: string | null;
  market_instance_key: string | null;
  provider_market_type: string | null;
  participant_id: string | null;
  participant_type: string | null;
  player_id: string | null;
  team_id: string | null;
  opponent_id: string | null;
  opponent_team_id: string | null;
  event_id: string | null;
  game_id: string | null;
  market_type: string;
  player_name: string;
  line: number;
  direction: "More" | "Less";
  side: "More" | "Less" | null;
  american_odds: number | null;
  over_price: number | null;
  under_price: number | null;
  implied_probability: number | null;
  match_confidence: number | null;
  match_status: string;
  match_quality_flags: string[];
  start_time: string | null;
  updated_at: string | null;
  data_quality_score: number | null;
  active: boolean;
};

export type AdapterScoreContext = {
  recent: StoredFeatureMap | null;
  matchup: StoredFeatureMap | null;
  playerFeatures: StoredFeatureMap | null;
  teamRecent: StoredFeatureMap | null;
  opponentRecent: StoredFeatureMap | null;
  teamContext: StoredFeatureMap | null;
  opponentContext: StoredFeatureMap | null;
  injuries: StoredFeatureMap | null;
  lineups: StoredFeatureMap | null;
  restContext: StoredFeatureMap | null;
  event: StoredFeatureMap | null;
  snapshot: StoredFeatureMap | null;
  freshness: {
    oddsPulledAt: string | null;
    oddsAgeMinutes: number | null;
    recentFeatureDate: string | null;
    recentFeatureSampleSize: number | null;
    recentFeatureStaleAfter: string | null;
    recentFeatureAgeHours: number | null;
    recentFeatureStale: boolean;
  };
  sportSpecific: Record<string, StoredFeatureMap | null>;
};

export type FactorImpact = "positive" | "negative" | "neutral" | "caution";

export type FactorExplanation = {
  name: string;
  label: string;
  impact: FactorImpact;
  description: string;
};

export type AdapterScoreOutput = {
  coveredScore: number;
  projection: number;
  edgeValue: number;
  edgeScore: number;
  confidenceScore: number;
  trendScore: number;
  matchupScore: number;
  marketScore: number;
  dataQualityScore: number;
  recommendation: string;
  riskFlags: string[];
  scoreLabel: string;
  confidenceLabel: string;
  riskLabel: string;
  factorNotes: Record<string, string>;
  factors: FactorExplanation[];
  structuredInputs: Record<string, unknown>;
  staleFlags: string[];
  summary: string;
  reasoningBlock: string;
};

export interface SportAdapter {
  name: string;
  supportsLeague(leagueId: string): boolean;
  buildScore(prop: AdapterPropRow, context: AdapterScoreContext): AdapterScoreOutput;
}

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function numeric(value: unknown) {
  // `Number(null) === 0`, so without this explicit check a genuinely missing
  // (SQL NULL) feature column is silently treated as a measured zero -- e.g. a
  // pitcher with no stored strikeout-rate data reads as "0% strikeout rate"
  // instead of "unknown". Only null/undefined mean "missing" here; a real
  // numeric zero (Number(0) === 0) still passes through unchanged below.
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Structured direction-aware edge.
 *
 * Kept in base.ts (public-safe) because it is pure math with no tuned values --
 * the sign of `projection - line` (or its inverse for Less/Under) is fully
 * determined by the already-published prop fields. The *policy* of how much
 * positive credit an edge magnitude earns lives elsewhere (see
 * scoring-internals.ts's edgeMagnitudeCredit), so this file exposes only the
 * classification, not the scoring weight.
 *
 *   - favorable   = projection agrees with the selected side
 *   - unfavorable = projection opposes the selected side (must never earn positive edge credit)
 *   - neutral     = projection equals the line exactly
 *   - unavailable = projection/line/direction is missing or invalid
 */
export type EdgeDirection = "favorable" | "neutral" | "unfavorable" | "unavailable";

export type DirectionalEdge = {
  /** Signed edge (positive = agrees with pick, negative = opposes). Null if unavailable. */
  signedEdge: number | null;
  /** |signedEdge| for reporting only; NEVER use this directly for positive score credit
   *  -- an unfavorable edge has a large magnitude but must earn zero credit. */
  absoluteMagnitude: number;
  direction: EdgeDirection;
  /** The normalized direction actually used for the computation, or null if the input
   *  direction was invalid/missing. */
  normalizedDirection: "More" | "Less" | null;
};

/** Normalize provider-side direction aliases (More/Over/Less/Under, any case) to the
 *  canonical two-value contract used across scoring, snapshots, and explanations. */
export function normalizePropDirection(value: unknown): "More" | "Less" | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  if (lower === "more" || lower === "over") return "More";
  if (lower === "less" || lower === "under") return "Less";
  return null;
}

export function computeDirectionalEdge(input: {
  projection: number | null | undefined;
  line: number | null | undefined;
  direction: unknown;
}): DirectionalEdge {
  const projection = numeric(input.projection);
  const line = numeric(input.line);
  const normalizedDirection = normalizePropDirection(input.direction);
  if (projection === null || line === null || normalizedDirection === null) {
    return { signedEdge: null, absoluteMagnitude: 0, direction: "unavailable", normalizedDirection };
  }
  const raw = normalizedDirection === "Less" ? line - projection : projection - line;
  const rounded = Number(raw.toFixed(2));
  const absoluteMagnitude = Math.abs(rounded);
  const direction: EdgeDirection = rounded > 0 ? "favorable" : rounded < 0 ? "unfavorable" : "neutral";
  return { signedEdge: rounded, absoluteMagnitude, direction, normalizedDirection };
}

export function recommendationForCoveredScore(coveredScore: number) {
  if (coveredScore >= 85) return "Elite";
  if (coveredScore >= 72) return "Strong";
  if (coveredScore >= 60) return "Playable";
  if (coveredScore >= 50) return "Lean";
  if (coveredScore >= 40) return "Pass";
  return "Avoid";
}

export function confidenceLabelFor(confidenceScore: number, dataQualityScore: number) {
  if (dataQualityScore < 8 || confidenceScore < 18) return "Data Limited";
  if (confidenceScore >= 36) return "High Confidence";
  if (confidenceScore >= 24) return "Medium Confidence";
  return "Low Confidence";
}

export function riskLabelFor(riskFlags: string[], dataQualityScore: number) {
  const severe = riskFlags.filter((flag) =>
    [
      "unsupported_market",
      "missing_event",
      "missing_participant",
      "low_match_confidence",
      "stale_odds",
      "stale_features",
      "injury_uncertainty",
      "lineup_uncertainty",
    ].includes(flag),
  ).length;
  if (severe >= 3 || dataQualityScore < 8) return "High Risk";
  if (severe >= 2) return "Elevated Risk";
  if (severe >= 1 || riskFlags.length >= 3) return "Moderate Risk";
  return "Low Risk";
}
