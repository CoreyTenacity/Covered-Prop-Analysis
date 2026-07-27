import assert from "node:assert/strict";
import test from "node:test";
import { reconcileBlockedProps, type BlockedProp, type RevalidatedProp } from "./reconciliation.ts";
import { makeStageResult } from "./stage-result.ts";
import type { ReconciliationStage } from "./field-contracts.ts";

const okStage = (stage: string) => makeStageResult({ stage, processed: 1, completed: 1, blocked: 0, durationMs: 1, output: null });

test("a recoverable blocker is resolved after the bounded stage re-runs once", async () => {
  const blocked: BlockedProp[] = [{ propId: "p1", blockers: [{ field: "matchup_context", cause: "enrichment_error", reconciliation: "matchup" }] }];
  let matchupRuns = 0;
  const report = await reconcileBlockedProps({
    blocked,
    maxAttemptsPerStage: 3,
    runStage: async (stage) => { if (stage === "matchup") matchupRuns += 1; return okStage(stage); },
    revalidate: async () => new Map<string, RevalidatedProp>([["p1", { state: "score_ready", blockers: [] }]]),
  });
  assert.deepEqual(report.resolvedPropIds, ["p1"]);
  assert.deepEqual(report.stillBlockedPropIds, []);
  assert.equal(matchupRuns, 1);
});

test("bounded: a persistently-blocked prop stops after maxAttemptsPerStage and stays blocked (never hides failure)", async () => {
  const blocked: BlockedProp[] = [{ propId: "p1", blockers: [{ field: "recent_form_features", cause: "feature_gen_failed", reconciliation: "features" }] }];
  let runs = 0;
  const report = await reconcileBlockedProps({
    blocked,
    maxAttemptsPerStage: 2,
    runStage: async (stage) => { runs += 1; return okStage(stage); },
    // never resolves, and each attempt clears one blocker then a new identical one "reappears" => still blocked, but progress each time
    revalidate: async () => new Map<string, RevalidatedProp>([["p1", { state: "score_blocked", blockers: [{ field: "recent_form_features", cause: "feature_gen_failed", reconciliation: "features" }] }]]),
  });
  // no progress -> stops after the first attempt (bounded, non-spinning)
  assert.deepEqual(report.stillBlockedPropIds, ["p1"]);
  assert.ok(runs <= 2);
});

test("a non-recoverable blocker (reconciliation 'none') is set aside, never retried", async () => {
  const blocked: BlockedProp[] = [{ propId: "p1", blockers: [{ field: "recent_game_logs", cause: "provider_absent", reconciliation: "none" }] }];
  let runs = 0;
  const report = await reconcileBlockedProps({
    blocked,
    maxAttemptsPerStage: 3,
    runStage: async (stage) => { runs += 1; return okStage(stage); },
    revalidate: async () => new Map(),
  });
  assert.deepEqual(report.unrecoverablePropIds, ["p1"]);
  assert.equal(runs, 0);
});

test("no-progress stops a stage early instead of spinning the full attempt budget", async () => {
  const blocked: BlockedProp[] = [{ propId: "p1", blockers: [{ field: "team_context", cause: "enrichment_error", reconciliation: "matchup" }] }];
  let runs = 0;
  await reconcileBlockedProps({
    blocked,
    maxAttemptsPerStage: 5,
    runStage: async (stage) => { runs += 1; return okStage(stage); },
    revalidate: async () => new Map<string, RevalidatedProp>([["p1", { state: "score_blocked", blockers: [{ field: "team_context", cause: "enrichment_error", reconciliation: "matchup" }] }]]),
  });
  assert.equal(runs, 1); // stopped after the first no-progress attempt
});

test("upstream-first order: fixing identity unblocks a downstream matchup blocker in the same pass", async () => {
  // p1 is blocked at identity; once identity is fixed, revalidation shows it ready.
  const blocked: BlockedProp[] = [{ propId: "p1", blockers: [
    { field: "player_identity", cause: "identity_failed", reconciliation: "identity" },
    { field: "matchup_context", cause: "enrichment_error", reconciliation: "matchup" },
  ] }];
  const order: ReconciliationStage[] = [];
  const report = await reconcileBlockedProps({
    blocked,
    maxAttemptsPerStage: 2,
    runStage: async (stage) => { order.push(stage); return okStage(stage); },
    // after identity runs, the prop resolves fully (identity was the root)
    revalidate: async () => new Map<string, RevalidatedProp>([["p1", { state: "score_ready", blockers: [] }]]),
  });
  assert.equal(order[0], "identity"); // identity attempted before matchup
  assert.deepEqual(report.resolvedPropIds, ["p1"]);
});
