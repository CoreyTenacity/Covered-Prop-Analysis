// Bridge from the existing scoring publishability output to the readiness
// taxonomy. scoreCurrentProps already computes publishability blockers
// (scoring-service.ts:publishabilityAssessment); this maps those blocker strings
// to classified causes + a ReadinessState WITHOUT re-implementing or exposing the
// scoring formula. It lets the orchestrator classify already-scored props into
// score_ready / score_limited / score_blocked and drive reconciliation + the
// health gate.
//
// Dependency-free (pure mapping).

import type { MissingCause } from "./stage-result.ts";
import type { ReconciliationStage } from "./field-contracts.ts";
import type { ReadinessState } from "./provenance.ts";

// Map each publishability blocker string to (field, cause, recovery stage).
// Only HARD blockers appear here; soft reasons (injury/lineup/stale_odds) never
// block. `missing_recent_logs` maps to ingestion by default; the absence proof
// standard can reclassify it to provider_absent for a genuine first-game player.
const BLOCKER_MAP: Record<string, { field: string; cause: Exclude<MissingCause, "provider_absent">; reconciliation: ReconciliationStage }> = {
  low_match_confidence: { field: "player_identity", cause: "identity_failed", reconciliation: "identity" },
  unmatched_player: { field: "player_identity", cause: "identity_failed", reconciliation: "identity" },
  unmatched_event: { field: "event", cause: "identity_failed", reconciliation: "identity" },
  missing_team: { field: "team", cause: "identity_failed", reconciliation: "identity" },
  missing_opponent: { field: "opponent", cause: "join_failed", reconciliation: "identity" },
  missing_recent_logs: { field: "recent_game_logs", cause: "ingestion_missing", reconciliation: "ingestion" },
  missing_team_context: { field: "team_context", cause: "enrichment_error", reconciliation: "matchup" },
  missing_matchup_context: { field: "matchup_context", cause: "enrichment_error", reconciliation: "matchup" },
  stale_features: { field: "recent_form_features", cause: "stale", reconciliation: "features" },
};

const SOFT_REASONS = new Set(["injury_uncertainty", "lineup_uncertainty", "stale_odds", "weather_missing", "ballpark_missing"]);

export const HARD_BLOCKER_KEYS = Object.keys(BLOCKER_MAP);

// The classified cause for a publishability blocker string, or null if the
// string is a soft reason (never a blocker).
export function causeForBlocker(blocker: string): MissingCause | null {
  return BLOCKER_MAP[blocker]?.cause ?? null;
}

export type ClassifiedProp = {
  propId: string;
  state: ReadinessState;
  blockers: Array<{ field: string; cause: MissingCause; reconciliation: ReconciliationStage }>;
  // the single worst blocker cause, for partition tallying.
  primaryCause?: MissingCause;
};

// Classify one scored prop from its publishability reasons/risk flags.
// `provenProviderAbsentFields` lists fields proven provider_absent (via the
// absence proof standard) so a permitted absence yields score_limited, not
// score_blocked.
export function classifyProp(input: {
  propId: string;
  publishabilityReasons: string[];
  provenProviderAbsentFields?: Set<string>;
}): ClassifiedProp {
  const proven = input.provenProviderAbsentFields ?? new Set<string>();
  const blockers: ClassifiedProp["blockers"] = [];
  let hasLimited = false;

  for (const reason of input.publishabilityReasons) {
    if (SOFT_REASONS.has(reason)) continue;
    const mapped = BLOCKER_MAP[reason];
    if (!mapped) continue;
    // a permitted, proven provider-absent field is not a blocker -> limited.
    if (proven.has(mapped.field)) {
      hasLimited = true;
      continue;
    }
    blockers.push({ field: mapped.field, cause: mapped.cause, reconciliation: mapped.reconciliation });
  }

  const state: ReadinessState = blockers.length > 0 ? "score_blocked" : hasLimited ? "score_limited" : "score_ready";
  return { propId: input.propId, state, blockers, primaryCause: blockers[0]?.cause };
}

export function classifyProps(
  props: Array<{ propId: string; publishabilityReasons: string[]; provenProviderAbsentFields?: Set<string> }>,
): ClassifiedProp[] {
  return props.map(classifyProp);
}
