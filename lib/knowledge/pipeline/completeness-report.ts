// The compact per-run completeness + measurement report. Assembled ONLY from
// data already computed in the pipeline summary (manifest meta, repair,
// scoring aggregates, health, reconciliation) + stage timings, so it adds zero
// Supabase reads and stores no duplicate raw provider payloads. Answers, per
// run/league/route/cause: how many props entered, how many are score-ready /
// limited / blocked, provider-absent vs pipeline-failure counts, reconciliation
// attempts, valid scores, board candidates >=70, rows published, prior-retained,
// stage timings, and DB/provider call counts.
//
// Dependency-free (pure assembler).

import type { MissingCause } from "./stage-result.ts";
import { COVERED_PICKS_MIN_SCORE } from "./board-invariant.ts";

export type CompletenessReport = {
  runId: string | null;
  league: string;
  contractVersion: string | null;
  // funnel
  propsEntered: number;
  scoreReady: number;
  scoreLimited: number;
  scoreBlocked: number;
  // classification
  providerAbsent: number;
  pipelineFailures: number;
  blockedByCause: Partial<Record<MissingCause, number>>;
  // reconciliation
  reconcileAttempts: number;
  outstandingAfterReconcile: number;
  // scoring + board
  validScores: number;
  boardCandidatesAtFloor: number;
  boardFloor: number;
  // publication
  heldRoutes: string[];
  priorSnapshotRetained: boolean;
  // measurement
  stageTimingsMs: Record<string, number>;
  supabaseCalls: number | null;
  providerCalls: number | null;
  overallHealth: string;
};

type StepLike = { step: string; status: string; durationMs?: number };

export function buildCompletenessReport(input: {
  league: string;
  runId?: string | null;
  contractVersion?: string | null;
  steps: StepLike[];
  repair?: { reconcileAttempts?: number; outstandingAfterReconcile?: number } | null;
  scoring?: { publishableCount?: number; candidateCount?: number; poolCount?: number; supabaseCalls?: { currentRunCalls?: number } | null } | null;
  health?: {
    overall?: string;
    heldRoutes?: string[];
    partitions?: Array<{ scoreReady?: number; scoreLimited?: number; scoreBlocked?: number; blockedByCause?: Partial<Record<MissingCause, number>> }>;
  } | null;
  providerCalls?: number | null;
}): CompletenessReport {
  // covered-picks partition is the canonical readiness view (parlay-options is
  // derived from the same pool); take the first partition to avoid double count.
  const partition = input.health?.partitions?.[0];
  const blockedByCause = partition?.blockedByCause ?? {};
  const providerAbsent = blockedByCause.provider_absent ?? 0;
  const pipelineFailures = (Object.entries(blockedByCause) as Array<[MissingCause, number]>)
    .filter(([cause]) => cause !== "provider_absent")
    .reduce((sum, [, count]) => sum + count, 0);

  const stageTimingsMs: Record<string, number> = {};
  for (const s of input.steps) if (typeof s.durationMs === "number") stageTimingsMs[s.step] = s.durationMs;

  const scoreReady = partition?.scoreReady ?? input.scoring?.publishableCount ?? 0;
  const scoreBlocked = partition?.scoreBlocked ?? input.scoring?.candidateCount ?? 0;
  const scoreLimited = partition?.scoreLimited ?? 0;

  return {
    runId: input.runId ?? null,
    league: input.league,
    contractVersion: input.contractVersion ?? null,
    propsEntered: input.scoring?.poolCount ?? scoreReady + scoreLimited + scoreBlocked,
    scoreReady,
    scoreLimited,
    scoreBlocked,
    providerAbsent,
    pipelineFailures,
    blockedByCause,
    reconcileAttempts: input.repair?.reconcileAttempts ?? 1,
    outstandingAfterReconcile: input.repair?.outstandingAfterReconcile ?? 0,
    validScores: scoreReady + scoreLimited,
    boardCandidatesAtFloor: scoreReady, // publishable, >= floor eligible
    boardFloor: COVERED_PICKS_MIN_SCORE,
    heldRoutes: input.health?.heldRoutes ?? [],
    priorSnapshotRetained: (input.health?.heldRoutes ?? []).length > 0,
    stageTimingsMs,
    supabaseCalls: input.scoring?.supabaseCalls?.currentRunCalls ?? null,
    providerCalls: input.providerCalls ?? null,
    overallHealth: input.health?.overall ?? "unknown",
  };
}
