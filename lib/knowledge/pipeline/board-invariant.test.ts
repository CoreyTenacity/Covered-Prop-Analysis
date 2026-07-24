import assert from "node:assert/strict";
import test from "node:test";
import { clampCoveredPicksFloor, enforceCoveredPicksFloor, validateCoveredPicksFloor, coveredPicksScoreFilterOptions, COVERED_PICKS_MIN_SCORE } from "./board-invariant.ts";

type Row = { id: string; covered_score: number | null };
const score = (r: Row) => r.covered_score;
const key = (r: Row) => r.id;

test("the floor cannot be lowered below 70 by a param, only raised", () => {
  assert.equal(clampCoveredPicksFloor(50), 70);
  assert.equal(clampCoveredPicksFloor(0), 70);
  assert.equal(clampCoveredPicksFloor(null), 70);
  assert.equal(clampCoveredPicksFloor(undefined), 70);
  assert.equal(clampCoveredPicksFloor(85), 85); // raising is allowed
  assert.equal(COVERED_PICKS_MIN_SCORE, 70);
});

test("enforce removes every sub-70 and null-score row and sorts highest first", () => {
  const rows: Row[] = [
    { id: "a", covered_score: 72 },
    { id: "b", covered_score: 69 },
    { id: "c", covered_score: 91 },
    { id: "d", covered_score: null },
    { id: "e", covered_score: 70 },
  ];
  const out = enforceCoveredPicksFloor(rows, score, key);
  assert.deepEqual(out.map((r) => r.id), ["c", "a", "e"]);
  assert.ok(out.every((r) => (r.covered_score as number) >= 70));
});

test("dedup is deterministic and score-tie ordering is stable by key", () => {
  const rows: Row[] = [
    { id: "b", covered_score: 80 },
    { id: "a", covered_score: 80 },
    { id: "a", covered_score: 80 }, // duplicate key
  ];
  const out = enforceCoveredPicksFloor(rows, score, key);
  assert.deepEqual(out.map((r) => r.id), ["a", "b"]); // tie -> key asc, deduped
});

test("fewer qualifying rows yields a shorter board - the floor is never lowered to fill it", () => {
  const rows: Row[] = [{ id: "a", covered_score: 71 }, { id: "b", covered_score: 40 }, { id: "c", covered_score: 55 }];
  const out = enforceCoveredPicksFloor(rows, score, key);
  assert.deepEqual(out.map((r) => r.id), ["a"]); // only 1 qualifies; board is length 1, not padded
});

test("validate rejects a snapshot containing ANY sub-70 or null row", () => {
  assert.equal(validateCoveredPicksFloor([{ id: "a", covered_score: 70 }, { id: "b", covered_score: 99 }], score).ok, true);
  const bad = validateCoveredPicksFloor([{ id: "a", covered_score: 70 }, { id: "b", covered_score: 69 }, { id: "c", covered_score: null }], score);
  assert.equal(bad.ok, false);
  assert.equal(bad.offending, 2);
});

test("frontend score-filter options never offer a value below the floor", () => {
  const opts = coveredPicksScoreFilterOptions();
  assert.ok(opts.every((v) => v >= 70));
  assert.equal(opts[0], 70);
  assert.deepEqual(opts, [70, 80, 90]);
});
