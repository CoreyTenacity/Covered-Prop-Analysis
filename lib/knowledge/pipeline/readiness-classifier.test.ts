import assert from "node:assert/strict";
import test from "node:test";
import { classifyProp, HARD_BLOCKER_KEYS } from "./readiness-classifier.ts";

test("no blockers -> score_ready", () => {
  const c = classifyProp({ propId: "p1", publishabilityReasons: [] });
  assert.equal(c.state, "score_ready");
  assert.equal(c.blockers.length, 0);
});

test("soft reasons alone never block (stay score_ready)", () => {
  const c = classifyProp({ propId: "p1", publishabilityReasons: ["injury_uncertainty", "lineup_uncertainty", "stale_odds", "weather_missing"] });
  assert.equal(c.state, "score_ready");
});

test("a hard blocker -> score_blocked with the classified cause + recovery stage", () => {
  const c = classifyProp({ propId: "p1", publishabilityReasons: ["missing_matchup_context"] });
  assert.equal(c.state, "score_blocked");
  assert.deepEqual(c.blockers, [{ field: "matchup_context", cause: "enrichment_error", reconciliation: "matchup" }]);
  assert.equal(c.primaryCause, "enrichment_error");
});

test("stale_features maps to the 'stale' pipeline cause (recoverable via features)", () => {
  const c = classifyProp({ propId: "p1", publishabilityReasons: ["stale_features"] });
  assert.equal(c.state, "score_blocked");
  assert.equal(c.blockers[0].cause, "stale");
  assert.equal(c.blockers[0].reconciliation, "features");
});

test("identity blockers route to the identity reconciliation stage", () => {
  for (const reason of ["low_match_confidence", "unmatched_player", "unmatched_event", "missing_team"]) {
    const c = classifyProp({ propId: "p", publishabilityReasons: [reason] });
    assert.equal(c.blockers[0].reconciliation, "identity", reason);
  }
});

test("a proven+permitted provider-absent field converts its blocker to score_limited (not blocked)", () => {
  const c = classifyProp({ propId: "p1", publishabilityReasons: ["missing_recent_logs"], provenProviderAbsentFields: new Set(["recent_game_logs"]) });
  assert.equal(c.state, "score_limited");
  assert.equal(c.blockers.length, 0);
});

test("a genuine (unproven) missing_recent_logs stays score_blocked as ingestion_missing", () => {
  const c = classifyProp({ propId: "p1", publishabilityReasons: ["missing_recent_logs"] });
  assert.equal(c.state, "score_blocked");
  assert.equal(c.blockers[0].cause, "ingestion_missing");
  assert.equal(c.blockers[0].reconciliation, "ingestion");
});

test("every hard blocker key maps to a recoverable stage (nothing dead-ends)", () => {
  for (const key of HARD_BLOCKER_KEYS) {
    const c = classifyProp({ propId: "p", publishabilityReasons: [key] });
    assert.equal(c.blockers.length, 1, key);
    assert.notEqual(c.blockers[0].reconciliation, "none", key);
  }
});
