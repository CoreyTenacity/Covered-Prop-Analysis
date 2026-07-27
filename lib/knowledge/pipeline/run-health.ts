// Turns a scoring summary into per-route partition readiness and hold decisions,
// so the orchestrator can (a) surface run health (no silent degradation) and
// (b) hold a pipeline-degraded route while retaining its prior good snapshot.
// Uses only the scoring AGGREGATES already in the report (publishable/candidate
// counts + skippedReasons) so it adds zero Supabase reads.

import type { StageStatus, MissingCause } from "./stage-result.ts";
import { causeForBlocker } from "./readiness-classifier.ts";
import { decidePartitionPublication, type PartitionReadiness, type PublicationDecision } from "./health-gate.ts";

// Routes derived from the same scored pool. covered-picks + parlay-options both
// present scored props; model-performance is historical and is not gated here.
const SCORED_ROUTES = ["covered-picks", "parlay-options"] as const;
export type ScoredRoute = (typeof SCORED_ROUTES)[number];

export type ScoringSummaryLike = {
  publishableCount: number;
  candidateCount: number;
  skippedReasons?: Record<string, number> | null;
};

export type RunHealthAssessment = {
  league: string;
  partitions: PartitionReadiness[];
  decisions: PublicationDecision[];
  heldRoutes: ScoredRoute[];
  overall: "healthy" | "degraded" | "failed";
};

// Build a partition readiness from scoring aggregates. publishable => score_ready
// (a publishable prop by definition cleared all hard blockers); candidate =>
// score_blocked; blockedByCause derived from skippedReasons via the blocker->cause
// map (soft reasons and provider_absent-flagged reasons contribute no pipeline block).
export function partitionFromScoring(input: {
  partition: string;
  scoring: ScoringSummaryLike;
  worstStageStatus: StageStatus;
}): PartitionReadiness {
  const blockedByCause: Partial<Record<MissingCause, number>> = {};
  for (const [reason, count] of Object.entries(input.scoring.skippedReasons ?? {})) {
    const cause = causeForBlocker(reason);
    if (!cause) continue; // soft reason, not a block
    blockedByCause[cause] = (blockedByCause[cause] ?? 0) + count;
  }
  return {
    partition: input.partition,
    scoreReady: input.scoring.publishableCount,
    scoreLimited: 0,
    scoreBlocked: input.scoring.candidateCount,
    blockedByCause,
    worstStageStatus: input.worstStageStatus,
  };
}

export function assessRunHealth(input: {
  league: string;
  scoring: ScoringSummaryLike;
  worstStageStatus: StageStatus;
  maxPipelineBlockedShare?: number;
}): RunHealthAssessment {
  const partitions: PartitionReadiness[] = SCORED_ROUTES.map((route) =>
    partitionFromScoring({ partition: `${input.league}:${route}`, scoring: input.scoring, worstStageStatus: input.worstStageStatus }),
  );
  const decisions = partitions.map((p) => decidePartitionPublication(p, { maxPipelineBlockedShare: input.maxPipelineBlockedShare }));

  const heldRoutes: ScoredRoute[] = [];
  for (let i = 0; i < SCORED_ROUTES.length; i += 1) {
    if (decisions[i].action === "hold_retain_prior") heldRoutes.push(SCORED_ROUTES[i]);
  }

  const overall: "healthy" | "degraded" | "failed" = decisions.some((d) => d.health === "failed")
    ? "failed"
    : decisions.some((d) => d.health === "degraded")
      ? "degraded"
      : "healthy";

  return { league: input.league, partitions, decisions, heldRoutes, overall };
}
