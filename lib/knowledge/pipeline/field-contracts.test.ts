import assert from "node:assert/strict";
import test from "node:test";
import { fieldApplies, hardRequiredFieldsFor, applicableFieldsFor, getFieldContract, FIELD_CONTRACTS } from "./field-contracts.ts";
import { deriveReadiness, type FieldStatus } from "./provenance.ts";

test("hard-required applicable fields are the same identity+context set for both sports", () => {
  const wnba = new Set(hardRequiredFieldsFor({ sport: "WNBA", marketType: "player_points" }).map((c) => c.field));
  const mlb = new Set(hardRequiredFieldsFor({ sport: "MLB", marketType: "batter_hits" }).map((c) => c.field));
  for (const req of ["player_identity", "participant", "team", "opponent", "event", "recent_game_logs", "recent_form_features", "team_context", "opponent_context", "matchup_context"]) {
    assert.ok(wnba.has(req), `WNBA missing hard-required ${req}`);
    assert.ok(mlb.has(req), `MLB missing hard-required ${req}`);
  }
});

test("WNBA fields apply to WNBA player markets and never to MLB fields", () => {
  const fields = applicableFieldsFor({ sport: "WNBA", marketType: "player_points" }).map((c) => c.field);
  assert.ok(fields.includes("expected_minutes"));
  assert.ok(fields.includes("pace"));
  assert.ok(!fields.includes("weather"));
  assert.ok(!fields.includes("handedness"));
  assert.ok(!fields.includes("opponent_pitcher"));
});

test("MLB weather applies to every MLB market but is MLB-only and never hard-required", () => {
  assert.ok(fieldApplies(getFieldContract("weather")!, { sport: "MLB", marketType: "batter_hits" }));
  assert.ok(fieldApplies(getFieldContract("weather")!, { sport: "MLB", marketType: "pitcher_strikeouts" }));
  assert.ok(!fieldApplies(getFieldContract("weather")!, { sport: "WNBA", marketType: "player_points" }));
  assert.equal(getFieldContract("weather")!.hardRequired, false);
  assert.equal(getFieldContract("weather")!.absencePermitted, true); // dome games
});

test("MLB handedness_splits apply to batter markets, not pitcher markets", () => {
  assert.ok(fieldApplies(getFieldContract("handedness_splits")!, { sport: "MLB", marketType: "batter_total_bases" }));
  assert.ok(!fieldApplies(getFieldContract("handedness_splits")!, { sport: "MLB", marketType: "pitcher_strikeouts" }));
});

test("applicability is explicit: an unknown market gets only the '*' fields", () => {
  const fields = applicableFieldsFor({ sport: "MLB", marketType: "some_unknown_market" }).map((c) => c.field);
  assert.ok(fields.includes("weather")); // '*'
  assert.ok(fields.includes("player_identity")); // '*'
  assert.ok(!fields.includes("handedness_splits")); // batter-only
  assert.ok(!fields.includes("opponent_pitcher")); // batter-only
});

// ---- readiness derivation ----

const HARD = new Set(hardRequiredFieldsFor({ sport: "WNBA", marketType: "player_points" }).map((c) => c.field));

function present(field: string): FieldStatus { return { field, present: true, fresh: true }; }
function missing(field: string, cause: FieldStatus["cause"]): FieldStatus { return { field, present: false, fresh: false, cause }; }

test("readiness: all hard-required present+fresh -> score_ready", () => {
  const fields = [...HARD].map(present);
  const r = deriveReadiness({ fields, hardRequiredFields: HARD, provenAbsentFields: new Set() });
  assert.equal(r.state, "score_ready");
  assert.equal(r.blockers.length, 0);
});

test("readiness: a hard-required field missing for a pipeline cause -> score_blocked with classified blocker", () => {
  const fields = [...HARD].map((f) => (f === "matchup_context" ? missing(f, "enrichment_error") : present(f)));
  const r = deriveReadiness({ fields, hardRequiredFields: HARD, provenAbsentFields: new Set() });
  assert.equal(r.state, "score_blocked");
  assert.deepEqual(r.blockers, [{ field: "matchup_context", cause: "enrichment_error" }]);
});

test("readiness: only a proven+permitted provider-absent field -> score_limited (still valid)", () => {
  // recent_game_logs permitted absent (first-game player), everything else present.
  // (recent_game_logs is itself in HARD, so no need to append it.)
  const fields = [...HARD].map((f) => (f === "recent_game_logs" ? missing(f, "provider_absent") : present(f)));
  const r = deriveReadiness({ fields, hardRequiredFields: HARD, provenAbsentFields: new Set(["recent_game_logs"]) });
  assert.equal(r.state, "score_limited");
  assert.deepEqual(r.allowedProviderAbsent, ["recent_game_logs"]);
  assert.equal(r.blockers.length, 0);
});

test("readiness: a soft field missing (not proven absent) penalizes but never blocks", () => {
  const fields = [...HARD.values()].map(present).concat([missing("pace", "enrichment_error")]);
  const r = deriveReadiness({ fields, hardRequiredFields: HARD, provenAbsentFields: new Set() });
  assert.equal(r.state, "score_ready"); // pace is soft
  assert.equal(r.blockers.length, 0);
});

test("every field contract declares a pipeline failure cause and at least one source", () => {
  for (const c of FIELD_CONTRACTS) {
    assert.ok(c.sourcePriority.length > 0, `${c.field} has no sourcePriority`);
    assert.ok(c.pipelineFailureCause, `${c.field} has no pipelineFailureCause`);
    assert.ok(c.sports.length > 0, `${c.field} has no sports`);
  }
});
