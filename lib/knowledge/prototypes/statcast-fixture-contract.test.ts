import assert from "node:assert/strict";
import test from "node:test";

import { validateStatcastFixtureRow, type StatcastFixtureRow } from "./statcast-fixture-contract.ts";
import { deriveMlbFeaturesFromStatcastFixture } from "./statcast-fixture-features.ts";

function baseRow(overrides: Partial<StatcastFixtureRow> = {}): StatcastFixtureRow {
  return {
    provenance: "statcast-fixture-prototype",
    canonicalPlayerId: "player-1",
    canonicalEventId: "event-1",
    canonicalTeamId: "team-1",
    role: "pitcher",
    handedness: "R",
    sampleWindow: { startDate: "2026-07-01", endDate: "2026-07-30" },
    sourceGameIds: ["game-1", "game-2", "game-3"],
    plateAppearancesOrBattersFaced: 100,
    strikeouts: 28,
    swings: 220,
    whiffs: 30,
    battedBalls: 60,
    hardHitBattedBalls: 26,
    xwoba: 0.31,
    fetchedAt: "2026-07-31T00:00:00.000Z",
    completenessState: "complete",
    ...overrides,
  };
}

test("1) complete valid data: passes contract validation and derives real, non-null pitcher features", () => {
  const row = baseRow();
  const validation = validateStatcastFixtureRow(row);
  assert.equal(validation.valid, true, validation.reasons.join("; "));
  const derived = deriveMlbFeaturesFromStatcastFixture(row);
  assert.equal(derived.ok, true);
  if (derived.ok) {
    assert.equal(derived.pitcherFeatures?.season_k_rate, 0.28);
    assert.equal(derived.pitcherFeatures?.swinging_strike_rate, 0.1364);
    assert.equal(derived.handedness?.pitcher_side, "R");
  }
});

test("2) missing player identity: an empty canonicalPlayerId fails contract validation, never silently derives a feature under an invented identity", () => {
  const row = baseRow({ canonicalPlayerId: "" });
  const validation = validateStatcastFixtureRow(row);
  assert.equal(validation.valid, false);
  assert.ok(validation.reasons.some((r) => r.includes("canonicalPlayerId")));
});

test("3) wrong event: canonicalEventId missing fails validation the same way -- the contract requires a real event/team scope, never an assumed one", () => {
  const row = baseRow({ canonicalEventId: "" });
  const validation = validateStatcastFixtureRow(row);
  assert.equal(validation.valid, false);
  assert.ok(validation.reasons.some((r) => r.includes("canonicalEventId")));
});

test("4) contradictory handedness: a pitcher marked switch-handed (\"S\") is rejected as internally contradictory", () => {
  const row = baseRow({ role: "pitcher", handedness: "S" });
  const validation = validateStatcastFixtureRow(row);
  assert.equal(validation.valid, false);
  assert.ok(validation.reasons.some((r) => r.includes("switch")));
});

test("5) zero legitimate events: a real, fully-observed zero-PA window derives null rates (not a fabricated 0%), while the row itself is NOT unavailable", () => {
  const row = baseRow({ plateAppearancesOrBattersFaced: 0, strikeouts: 0, swings: 0, whiffs: 0, battedBalls: 0, hardHitBattedBalls: 0, xwoba: null, sourceGameIds: [] });
  const validation = validateStatcastFixtureRow(row);
  assert.equal(validation.valid, true, validation.reasons.join("; "));
  const derived = deriveMlbFeaturesFromStatcastFixture(row);
  assert.equal(derived.ok, true);
  if (derived.ok) {
    assert.equal(derived.pitcherFeatures?.season_k_rate, null, "a rate can never be computed from a zero denominator -- must be null, not 0");
    assert.equal(derived.pitcherFeatures?.swinging_strike_rate, null);
  }
});

test("6) missing events (never measured): completenessState=unavailable with a null denominator is refused outright, distinct from the zero-legitimate-events case above", () => {
  const row = baseRow({
    plateAppearancesOrBattersFaced: null, strikeouts: null, swings: null, whiffs: null, battedBalls: null, hardHitBattedBalls: null, xwoba: null,
    sourceGameIds: [], completenessState: "unavailable",
  });
  const validation = validateStatcastFixtureRow(row);
  assert.equal(validation.valid, true, validation.reasons.join("; "));
  const derived = deriveMlbFeaturesFromStatcastFixture(row);
  assert.equal(derived.ok, false, "an unavailable population must never derive a feature row, real or null-valued");
  if (!derived.ok) assert.match(derived.reason, /no population was observed/);
});

test("7) insufficient sample: a very small but real denominator still derives a mathematically real rate (the adapter's own sample-size gating, not this module, decides whether that's usable)", () => {
  const row = baseRow({ plateAppearancesOrBattersFaced: 3, strikeouts: 1, swings: 6, whiffs: 1, completenessState: "insufficient_sample" });
  const validation = validateStatcastFixtureRow(row);
  assert.equal(validation.valid, true, validation.reasons.join("; "));
  const derived = deriveMlbFeaturesFromStatcastFixture(row);
  assert.equal(derived.ok, true);
  if (derived.ok) assert.equal(derived.pitcherFeatures?.season_k_rate, Number((1 / 3).toFixed(4)));
});

test("8) stale fixture: completenessState=stale is refused, never silently reused as current", () => {
  const row = baseRow({ completenessState: "stale" });
  const derived = deriveMlbFeaturesFromStatcastFixture(row);
  assert.equal(derived.ok, false);
  if (!derived.ok) assert.match(derived.reason, /stale/);
});

test("9) duplicate source rows: overlapping sourceGameIds within one row are the caller's responsibility to dedupe before construction -- this contract does not silently double-count, it only forbids internally contradictory counts (verified here: duplicated game ids alone do not make strikeouts exceed plateAppearances, so this stays valid, and the derived rate is unaffected by the duplicate list)", () => {
  const row = baseRow({ sourceGameIds: ["game-1", "game-1", "game-2"] });
  const validation = validateStatcastFixtureRow(row);
  assert.equal(validation.valid, true);
  const derived = deriveMlbFeaturesFromStatcastFixture(row);
  assert.equal(derived.ok, true);
  if (derived.ok) assert.equal(derived.pitcherFeatures?.season_k_rate, 0.28, "the derived rate depends only on the row's own numerator/denominator counts, not on how many source games are listed");
});

test("10) doubleheader: two distinct games on the same date are supported as separate sourceGameIds within one sample window without contradiction", () => {
  const row = baseRow({ sourceGameIds: ["game-1a", "game-1b"], sampleWindow: { startDate: "2026-07-15", endDate: "2026-07-15" } });
  const validation = validateStatcastFixtureRow(row);
  assert.equal(validation.valid, true, validation.reasons.join("; "));
});

test("11) recent roster/team change: the row's own canonicalTeamId is validated for presence, but this contract deliberately does NOT cross-check it against the event's actual home/away teams -- that cross-check belongs to the real identity-resolution layer (entity_aliases/current_props), which this synthetic prototype does not reimplement. A missing canonicalTeamId is still rejected.", () => {
  const row = baseRow({ canonicalTeamId: "" });
  const validation = validateStatcastFixtureRow(row);
  assert.equal(validation.valid, false);
  assert.ok(validation.reasons.some((r) => r.includes("canonicalTeamId")));
});

test("contradictory sample counts (whiffs exceeding swings) are rejected even when completenessState claims complete", () => {
  const row = baseRow({ swings: 10, whiffs: 50 });
  const validation = validateStatcastFixtureRow(row);
  assert.equal(validation.valid, false);
  assert.ok(validation.reasons.some((r) => r.includes("whiffs cannot exceed swings")));
});

test("batter role derives hard-hit rate and xwOBA (precomputed, never re-derived from raw components)", () => {
  const row = baseRow({ role: "batter", handedness: "L", strikeouts: null, xwoba: 0.355 });
  const derived = deriveMlbFeaturesFromStatcastFixture(row);
  assert.equal(derived.ok, true);
  if (derived.ok) {
    assert.equal(derived.batterFeatures?.hard_hit_rate, Number((26 / 60).toFixed(4)));
    assert.equal(derived.batterFeatures?.xwoba, 0.355);
    assert.equal(derived.handedness?.batter_side, "L");
    assert.equal(derived.pitcherFeatures, null, "a batter row must never populate pitcher-shaped fields");
  }
});

test("ambiguous_identity and contradictory completeness states both refuse derivation", () => {
  for (const state of ["ambiguous_identity", "contradictory"] as const) {
    const derived = deriveMlbFeaturesFromStatcastFixture(baseRow({ completenessState: state }));
    assert.equal(derived.ok, false, `${state} must refuse derivation`);
  }
});
