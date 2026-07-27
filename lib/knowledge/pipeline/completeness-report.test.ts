import assert from "node:assert/strict";
import test from "node:test";
import { buildCompletenessReport } from "./completeness-report.ts";

test("assembles the funnel + classification + measurement from summary data only", () => {
  const r = buildCompletenessReport({
    league: "MLB",
    runId: "run-1",
    contractVersion: "contracts-2026.07-A",
    steps: [
      { step: "sharp", status: "ok", durationMs: 500 },
      { step: "repair", status: "warning", durationMs: 6000 },
      { step: "score", status: "ok", durationMs: 1000 },
    ],
    repair: { reconcileAttempts: 2, outstandingAfterReconcile: 0 },
    scoring: { publishableCount: 20, candidateCount: 10, poolCount: 40, supabaseCalls: { currentRunCalls: 6 } },
    health: {
      overall: "degraded",
      heldRoutes: ["covered-picks"],
      partitions: [{ scoreReady: 20, scoreLimited: 3, scoreBlocked: 10, blockedByCause: { provider_absent: 4, enrichment_error: 6 } }],
    },
    providerCalls: 8,
  });
  assert.equal(r.propsEntered, 40);
  assert.equal(r.scoreReady, 20);
  assert.equal(r.scoreLimited, 3);
  assert.equal(r.scoreBlocked, 10);
  assert.equal(r.providerAbsent, 4);
  assert.equal(r.pipelineFailures, 6); // enrichment_error only; provider_absent excluded
  assert.equal(r.reconcileAttempts, 2);
  assert.equal(r.outstandingAfterReconcile, 0);
  assert.equal(r.validScores, 23); // ready + limited
  assert.equal(r.boardFloor, 70);
  assert.deepEqual(r.heldRoutes, ["covered-picks"]);
  assert.equal(r.priorSnapshotRetained, true);
  assert.equal(r.stageTimingsMs.repair, 6000);
  assert.equal(r.supabaseCalls, 6);
  assert.equal(r.providerCalls, 8);
  assert.equal(r.overallHealth, "degraded");
});

test("a healthy run holds nothing and retains no prior snapshot", () => {
  const r = buildCompletenessReport({
    league: "WNBA",
    steps: [{ step: "score", status: "ok", durationMs: 900 }],
    scoring: { publishableCount: 15, candidateCount: 0, poolCount: 15 },
    health: { overall: "healthy", heldRoutes: [], partitions: [{ scoreReady: 15, scoreLimited: 0, scoreBlocked: 0, blockedByCause: {} }] },
  });
  assert.equal(r.priorSnapshotRetained, false);
  assert.equal(r.pipelineFailures, 0);
  assert.equal(r.validScores, 15);
});
