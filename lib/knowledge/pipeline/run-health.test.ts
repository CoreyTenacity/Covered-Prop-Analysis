import assert from "node:assert/strict";
import test from "node:test";
import { assessRunHealth, partitionFromScoring } from "./run-health.ts";

test("a fully publishable scoring pool is healthy and holds nothing", () => {
  const h = assessRunHealth({ league: "MLB", scoring: { publishableCount: 30, candidateCount: 0, skippedReasons: {} }, worstStageStatus: "healthy" });
  assert.equal(h.overall, "healthy");
  assert.deepEqual(h.heldRoutes, []);
});

test("a pool dominated by pipeline-caused blocks holds the affected routes and retains prior", () => {
  const h = assessRunHealth({ league: "WNBA", scoring: { publishableCount: 2, candidateCount: 18, skippedReasons: { missing_matchup_context: 18 } }, worstStageStatus: "degraded" });
  assert.equal(h.overall, "degraded");
  assert.deepEqual(h.heldRoutes.sort(), ["covered-picks", "parlay-options"]);
});

test("blocks caused only by soft reasons do not degrade or hold", () => {
  const h = assessRunHealth({ league: "MLB", scoring: { publishableCount: 20, candidateCount: 10, skippedReasons: { lineup_uncertainty: 10, weather_missing: 5 } }, worstStageStatus: "healthy" });
  // soft reasons are not blockers -> no pipeline-blocked share
  assert.equal(h.overall, "healthy");
  assert.deepEqual(h.heldRoutes, []);
});

test("partitionFromScoring maps blocker reasons to causes and ignores soft reasons", () => {
  const p = partitionFromScoring({ partition: "MLB:covered-picks", scoring: { publishableCount: 5, candidateCount: 7, skippedReasons: { missing_team_context: 4, stale_features: 3, stale_odds: 9 } }, worstStageStatus: "degraded" });
  assert.equal(p.scoreReady, 5);
  assert.equal(p.scoreBlocked, 7);
  assert.equal(p.blockedByCause.enrichment_error, 4); // missing_team_context
  assert.equal(p.blockedByCause.stale, 3); // stale_features
  // stale_odds is a soft reason -> not counted as any pipeline cause
  const totalCauses = Object.values(p.blockedByCause).reduce((s, n) => s + (n ?? 0), 0);
  assert.equal(totalCauses, 7);
});

test("a failed upstream stage forces held routes regardless of counts", () => {
  const h = assessRunHealth({ league: "MLB", scoring: { publishableCount: 30, candidateCount: 0, skippedReasons: {} }, worstStageStatus: "failed" });
  assert.equal(h.overall, "failed");
  assert.deepEqual(h.heldRoutes.sort(), ["covered-picks", "parlay-options"]);
});
