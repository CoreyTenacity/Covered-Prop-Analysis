import assert from "node:assert/strict";
import test from "node:test";
import { decidePartitionPublication, decideAllPartitions, tallyPartition } from "./health-gate.ts";

test("a healthy partition publishes", () => {
  const d = decidePartitionPublication({ partition: "MLB:covered-picks", scoreReady: 30, scoreLimited: 2, scoreBlocked: 0, blockedByCause: {}, worstStageStatus: "healthy" });
  assert.equal(d.action, "publish");
  assert.equal(d.health, "healthy");
});

test("blocked ONLY by genuine provider absence is not degradation - it publishes", () => {
  const d = decidePartitionPublication({ partition: "MLB:covered-picks", scoreReady: 10, scoreLimited: 20, scoreBlocked: 0, blockedByCause: { provider_absent: 20 }, worstStageStatus: "healthy" });
  assert.equal(d.action, "publish");
  assert.equal(d.pipelineBlockedShare, 0);
});

test("a pipeline-fault blocked share above the threshold holds the route and retains the prior snapshot", () => {
  const d = decidePartitionPublication({ partition: "WNBA:covered-picks", scoreReady: 5, scoreLimited: 0, scoreBlocked: 15, blockedByCause: { enrichment_error: 15 }, worstStageStatus: "degraded" }, { maxPipelineBlockedShare: 0.5 });
  assert.equal(d.action, "hold_retain_prior");
  assert.equal(d.health, "degraded");
  assert.ok(d.pipelineBlockedShare > 0.5);
});

test("a failed upstream stage holds the route regardless of counts", () => {
  const d = decidePartitionPublication({ partition: "MLB:covered-picks", scoreReady: 40, scoreLimited: 0, scoreBlocked: 0, blockedByCause: {}, worstStageStatus: "failed" });
  assert.equal(d.action, "hold_retain_prior");
  assert.equal(d.health, "failed");
});

test("an empty partition publishes honestly (fewer/none is not a failure)", () => {
  const d = decidePartitionPublication({ partition: "WNBA:covered-picks", scoreReady: 0, scoreLimited: 0, scoreBlocked: 0, blockedByCause: {}, worstStageStatus: "healthy" });
  assert.equal(d.action, "publish");
  assert.equal(d.health, "healthy");
});

test("a modest pipeline-blocked share below threshold still publishes (degraded) - healthy props are not held hostage", () => {
  const d = decidePartitionPublication({ partition: "MLB:covered-picks", scoreReady: 30, scoreLimited: 0, scoreBlocked: 3, blockedByCause: { join_failed: 3 }, worstStageStatus: "degraded" }, { maxPipelineBlockedShare: 0.5 });
  assert.equal(d.action, "publish");
  assert.equal(d.health, "degraded");
});

test("one degraded league does NOT block a healthy league (partitions decided independently)", () => {
  const decisions = decideAllPartitions([
    { partition: "MLB:covered-picks", scoreReady: 30, scoreLimited: 0, scoreBlocked: 0, blockedByCause: {}, worstStageStatus: "healthy" },
    { partition: "WNBA:covered-picks", scoreReady: 2, scoreLimited: 0, scoreBlocked: 18, blockedByCause: { enrichment_error: 18 }, worstStageStatus: "degraded" },
  ]);
  const mlb = decisions.find((d) => d.partition === "MLB:covered-picks")!;
  const wnba = decisions.find((d) => d.partition === "WNBA:covered-picks")!;
  assert.equal(mlb.action, "publish");
  assert.equal(wnba.action, "hold_retain_prior");
});

test("tallyPartition separates provider-absent from pipeline faults", () => {
  const t = tallyPartition("MLB:covered-picks", [
    { state: "score_ready" },
    { state: "score_limited" },
    { state: "score_blocked", blockerCause: "provider_absent" },
    { state: "score_blocked", blockerCause: "enrichment_error" },
  ], "degraded");
  assert.equal(t.scoreReady, 1);
  assert.equal(t.scoreLimited, 1);
  assert.equal(t.scoreBlocked, 2);
  assert.equal(t.blockedByCause.provider_absent, 1);
  assert.equal(t.blockedByCause.enrichment_error, 1);
});
