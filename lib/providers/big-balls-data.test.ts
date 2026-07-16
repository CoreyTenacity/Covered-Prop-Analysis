import assert from "node:assert/strict";
import test from "node:test";
import { BigBallsDataAdapter, extractBigBallsMatches, selectLineupEligibleMatch, summarizeBigBallsMatches } from "./big-balls-data.ts";

test("reports Big Balls Data configuration", () => {
  assert.equal(new BigBallsDataAdapter("").configured(), false);
  assert.equal(new BigBallsDataAdapter("bbs_test_key").configured(), true);
});

test("extracts matches from the provider value envelope", () => {
  const payload = { data: { scores: { value: [{ match_id: "bb_match_one" }] } } };
  assert.equal(extractBigBallsMatches(payload as never).length, 1);
  assert.equal(summarizeBigBallsMatches(payload as never).matches, 1);
});

test("only selects lineups inside the pregame window", () => {
  const now = new Date("2026-07-04T12:00:00Z");
  assert.equal(selectLineupEligibleMatch([{ match_id: "bb_match_soon", updated_at: "2026-07-04T14:00:00Z" }], now)?.match_id, "bb_match_soon");
  assert.equal(selectLineupEligibleMatch([{ match_id: "bb_match_later", updated_at: "2026-07-04T18:00:00Z" }], now), null);
});

test("summarizes match payload structure", () => {
  assert.deepEqual(summarizeBigBallsMatches({ data: [{ id: "one", home: "A", away: "B" }], meta: { source: "official-league" } }), {
    matches: 1, fields: ["id", "home", "away"], source: "official-league",
  });
});
