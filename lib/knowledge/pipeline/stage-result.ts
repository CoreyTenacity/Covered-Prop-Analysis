// Typed result envelope every pipeline stage returns. The redesign (Phases A-D)
// makes each stage validate its input, do bounded work, validate its output, and
// hand a StageResult forward instead of silently continuing after partial work.
//
// This module is deliberately dependency-free (no Supabase, no scoring imports)
// so it is safe to share across stages and cheap to unit-test.

// The single classification for why a required value is absent. This is the
// contract the owner asked for: "provider genuinely has no data" must be
// distinguishable from a pipeline failure. Only `provider_absent` means the
// provider truly had nothing; every other value is a pipeline fault.
export type MissingCause =
  | "provider_absent" //     proven absence: identity resolved, all approved sources attempted & OK, none returned a value, absence allowed by contract
  | "identity_failed" //     could not resolve player/team/event/opponent id
  | "ingestion_missing" //   an upstream ingestion/workflow stage did not run or produced nothing
  | "join_failed" //         rows exist but could not be associated (wrong/absent mapping)
  | "enrichment_error" //    the enrichment step threw or errored
  | "validation_rejected" // value present but failed its contract (bad shape/type/range)
  | "feature_gen_failed" //  feature generation from present context failed
  | "stale"; //              value present but older than its freshness cutoff (a pipeline failure, NOT absence)

export const PIPELINE_FAILURE_CAUSES: readonly MissingCause[] = [
  "identity_failed",
  "ingestion_missing",
  "join_failed",
  "enrichment_error",
  "validation_rejected",
  "feature_gen_failed",
  "stale",
];

export function isPipelineFailureCause(cause: MissingCause): boolean {
  return cause !== "provider_absent";
}

export type StageStatus = "healthy" | "degraded" | "failed";

export type StageResult<T> = {
  stage: string;
  status: StageStatus;
  // record accounting: how many records entered / finished / were blocked.
  processed: number;
  completed: number;
  blocked: number;
  // blocked/absent records grouped by classified cause.
  failuresByCause: Partial<Record<MissingCause, number>>;
  durationMs: number;
  // measurable cost, for the egress/runtime report. Omitted when not applicable.
  rowsRead?: number;
  rowsWritten?: number;
  providerCalls?: number;
  // human-readable, non-secret notes (reasons, thresholds hit). Never raw payloads.
  notes: string[];
  output: T;
};

export function emptyCauseTally(): Partial<Record<MissingCause, number>> {
  return {};
}

export function addCause(
  tally: Partial<Record<MissingCause, number>>,
  cause: MissingCause,
  n = 1,
): void {
  tally[cause] = (tally[cause] ?? 0) + n;
}

export function mergeCauseTally(
  a: Partial<Record<MissingCause, number>>,
  b: Partial<Record<MissingCause, number>>,
): Partial<Record<MissingCause, number>> {
  const out: Partial<Record<MissingCause, number>> = { ...a };
  for (const [cause, count] of Object.entries(b) as Array<[MissingCause, number]>) {
    out[cause] = (out[cause] ?? 0) + count;
  }
  return out;
}

// Derive a stage status from its accounting + an optional degradation predicate.
// A stage with any *pipeline-failure* blockers is at least "degraded"; a stage
// that could not run at all (processed 0 due to error) is "failed". Callers may
// override for stage-specific rules.
export function deriveStageStatus(input: {
  processed: number;
  blocked: number;
  failuresByCause: Partial<Record<MissingCause, number>>;
  hardFailed?: boolean;
}): StageStatus {
  if (input.hardFailed) return "failed";
  const pipelineBlocked = (Object.entries(input.failuresByCause) as Array<[MissingCause, number]>)
    .filter(([cause]) => isPipelineFailureCause(cause))
    .reduce((sum, [, count]) => sum + count, 0);
  if (pipelineBlocked > 0) return "degraded";
  return "healthy";
}

export function makeStageResult<T>(input: {
  stage: string;
  processed: number;
  completed: number;
  blocked: number;
  failuresByCause?: Partial<Record<MissingCause, number>>;
  durationMs: number;
  rowsRead?: number;
  rowsWritten?: number;
  providerCalls?: number;
  notes?: string[];
  output: T;
  hardFailed?: boolean;
  status?: StageStatus;
}): StageResult<T> {
  const failuresByCause = input.failuresByCause ?? {};
  return {
    stage: input.stage,
    status: input.status ?? deriveStageStatus({ processed: input.processed, blocked: input.blocked, failuresByCause, hardFailed: input.hardFailed }),
    processed: input.processed,
    completed: input.completed,
    blocked: input.blocked,
    failuresByCause,
    durationMs: input.durationMs,
    rowsRead: input.rowsRead,
    rowsWritten: input.rowsWritten,
    providerCalls: input.providerCalls,
    notes: input.notes ?? [],
    output: input.output,
  };
}
