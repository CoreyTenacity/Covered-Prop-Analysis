// Route/league-partition health gate. Detects systematic pipeline degradation
// and decides, per the smallest affected publication boundary, whether to
// publish or hold-and-retain-the-prior-good-snapshot. Per the owner's policy:
// hold ONLY the affected route; healthy partitions still publish; a degradation
// caused by genuine provider absence is NOT a hold.
//
// Dependency-free (pure decision logic).

import type { MissingCause, StageStatus } from "./stage-result.ts";
import { isPipelineFailureCause } from "./stage-result.ts";
import type { ReadinessState } from "./provenance.ts";

export type PartitionKey = string; // e.g. "MLB:covered-picks"

export type PartitionReadiness = {
  partition: PartitionKey;
  scoreReady: number;
  scoreLimited: number;
  scoreBlocked: number;
  // blocked props grouped by cause, so provider-absent (not degradation) is
  // separable from pipeline faults.
  blockedByCause: Partial<Record<MissingCause, number>>;
  // worst upstream stage status for this partition (from stage results).
  worstStageStatus: StageStatus;
};

export type PublicationDecision = {
  partition: PartitionKey;
  action: "publish" | "hold_retain_prior";
  health: "healthy" | "degraded" | "failed";
  reason: string;
  // the pipeline-fault share that drove a hold (0 when provider-absent only).
  pipelineBlockedShare: number;
};

// A partition is DEGRADED when a meaningful share of its props are blocked by a
// PIPELINE fault (not provider absence). The default threshold holds a route
// when > maxPipelineBlockedShare of the scored pool is pipeline-blocked, OR when
// an upstream required stage failed outright. Genuine provider-absent props
// never count toward degradation - they are honest limited scores.
export function decidePartitionPublication(
  input: PartitionReadiness,
  options: { maxPipelineBlockedShare?: number } = {},
): PublicationDecision {
  const maxShare = options.maxPipelineBlockedShare ?? 0.5;
  const total = input.scoreReady + input.scoreLimited + input.scoreBlocked;

  const pipelineBlocked = (Object.entries(input.blockedByCause) as Array<[MissingCause, number]>)
    .filter(([cause]) => isPipelineFailureCause(cause))
    .reduce((sum, [, count]) => sum + count, 0);
  const pipelineBlockedShare = total > 0 ? pipelineBlocked / total : 0;

  if (input.worstStageStatus === "failed") {
    return { partition: input.partition, action: "hold_retain_prior", health: "failed", reason: "an upstream required stage failed for this partition", pipelineBlockedShare };
  }
  if (total === 0) {
    // nothing to publish is not a failure; publish an empty/fewer board honestly.
    return { partition: input.partition, action: "publish", health: "healthy", reason: "no active props in partition; publishing honestly", pipelineBlockedShare: 0 };
  }
  if (pipelineBlockedShare > maxShare) {
    return { partition: input.partition, action: "hold_retain_prior", health: "degraded", reason: `pipeline-blocked share ${(pipelineBlockedShare * 100).toFixed(1)}% exceeds ${(maxShare * 100).toFixed(0)}%`, pipelineBlockedShare };
  }
  const health: "healthy" | "degraded" = pipelineBlocked > 0 ? "degraded" : "healthy";
  return { partition: input.partition, action: "publish", health, reason: health === "degraded" ? "some pipeline-blocked props present but below hold threshold; publishing healthy props" : "partition healthy", pipelineBlockedShare };
}

// Decide publication for every partition independently, so one degraded league
// or route never blocks a healthy one.
export function decideAllPartitions(
  partitions: PartitionReadiness[],
  options?: { maxPipelineBlockedShare?: number },
): PublicationDecision[] {
  return partitions.map((p) => decidePartitionPublication(p, options));
}

// Convenience: tally a set of per-prop readiness+cause into a PartitionReadiness.
export function tallyPartition(
  partition: PartitionKey,
  props: Array<{ state: ReadinessState; blockerCause?: MissingCause }>,
  worstStageStatus: StageStatus,
): PartitionReadiness {
  const blockedByCause: Partial<Record<MissingCause, number>> = {};
  let scoreReady = 0, scoreLimited = 0, scoreBlocked = 0;
  for (const p of props) {
    if (p.state === "score_ready") scoreReady += 1;
    else if (p.state === "score_limited") scoreLimited += 1;
    else {
      scoreBlocked += 1;
      const cause = p.blockerCause ?? "enrichment_error";
      blockedByCause[cause] = (blockedByCause[cause] ?? 0) + 1;
    }
  }
  return { partition, scoreReady, scoreLimited, scoreBlocked, blockedByCause, worstStageStatus };
}
