// Bounded automatic reconciliation. Instead of the owner running manual repair
// jobs / one-off scripts each week, the normal pipeline: identifies score_blocked
// props, classifies the exact blocker, re-runs ONLY the necessary bounded
// enrichment stage when the failure is recoverable, revalidates the same fields,
// stops after a strict bounded attempt count, and retains the blocker if
// unresolved. It never hides failure - unresolved props stay blocked.
//
// The actual enrichment work is injected (runStage) so this module reuses the
// existing bounded enrichment functions as idempotent reconciliation functions
// and stays unit-testable without I/O.

import type { StageResult } from "./stage-result.ts";
import type { MissingCause } from "./stage-result.ts";
import type { ReconciliationStage } from "./field-contracts.ts";
import type { ReadinessState } from "./provenance.ts";

export type BlockedProp = {
  propId: string;
  // the blockers keeping this prop score_blocked, with the stage that could fix each.
  blockers: Array<{ field: string; cause: MissingCause; reconciliation: ReconciliationStage }>;
};

export type RevalidatedProp = { state: ReadinessState; blockers: Array<{ field: string; cause: MissingCause; reconciliation: ReconciliationStage }> };

export type ReconciliationReport = {
  attemptsByStage: Partial<Record<ReconciliationStage, number>>;
  stageResults: Array<{ stage: ReconciliationStage; attempt: number; result: StageResult<unknown> }>;
  resolvedPropIds: string[];
  stillBlockedPropIds: string[];
  // stages that were skipped because the blocker is not recoverable in-run.
  unrecoverablePropIds: string[];
};

const RECOVERABLE_STAGES: ReconciliationStage[] = ["identity", "ingestion", "features", "matchup", "support"];

// Deterministic stage order so reconciliation is idempotent and repeatable:
// upstream causes first (identity -> ingestion -> features/matchup/support), so
// fixing an identity gap can unblock everything downstream in one pass.
const STAGE_ORDER: ReconciliationStage[] = ["identity", "ingestion", "features", "matchup", "support"];

export async function reconcileBlockedProps(input: {
  blocked: BlockedProp[];
  maxAttemptsPerStage: number;
  runStage: (stage: ReconciliationStage, targetPropIds: string[]) => Promise<StageResult<unknown>>;
  revalidate: (propIds: string[]) => Promise<Map<string, RevalidatedProp>>;
}): Promise<ReconciliationReport> {
  const attemptsByStage: Partial<Record<ReconciliationStage, number>> = {};
  const stageResults: ReconciliationReport["stageResults"] = [];
  const resolved = new Set<string>();
  const unrecoverable = new Set<string>();

  // active[propId] = its current blockers. Mutated as reconciliation progresses.
  const active = new Map<string, BlockedProp>();
  for (const p of input.blocked) active.set(p.propId, p);

  // Props whose only blockers are non-recoverable (reconciliation "none") are
  // set aside immediately - never spin on something we cannot fix in-run.
  for (const [propId, p] of active) {
    if (p.blockers.every((b) => !RECOVERABLE_STAGES.includes(b.reconciliation))) {
      unrecoverable.add(propId);
      active.delete(propId);
    }
  }

  for (const stage of STAGE_ORDER) {
    for (let attempt = 1; attempt <= input.maxAttemptsPerStage; attempt += 1) {
      // which still-active props have a recoverable blocker for THIS stage?
      const targets = [...active.values()].filter((p) => p.blockers.some((b) => b.reconciliation === stage)).map((p) => p.propId);
      if (targets.length === 0) break; // nothing for this stage; move on

      attemptsByStage[stage] = (attemptsByStage[stage] ?? 0) + 1;
      const result = await input.runStage(stage, targets);
      stageResults.push({ stage, attempt, result });

      const revalidated = await input.revalidate(targets);
      let anyProgress = false;
      for (const propId of targets) {
        const rv = revalidated.get(propId);
        if (!rv) continue;
        if (rv.state !== "score_blocked") {
          resolved.add(propId);
          active.delete(propId);
          anyProgress = true;
        } else {
          // update remaining blockers (a stage may have cleared some)
          const before = active.get(propId)?.blockers.length ?? 0;
          active.set(propId, { propId, blockers: rv.blockers });
          if (rv.blockers.length < before) anyProgress = true;
        }
      }
      // Stop retrying this stage early if an attempt made no progress at all -
      // a bounded, non-spinning guarantee.
      if (!anyProgress) break;
    }
  }

  return {
    attemptsByStage,
    stageResults,
    resolvedPropIds: [...resolved],
    stillBlockedPropIds: [...active.keys()],
    unrecoverablePropIds: [...unrecoverable],
  };
}
