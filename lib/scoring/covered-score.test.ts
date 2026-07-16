import assert from "node:assert/strict";
import test from "node:test";
import { calculateEdge, labelForScore } from "./covered-score.ts";

test("calculates directional edge for More and Less picks", () => {
  assert.equal(calculateEdge(10, 12, "More"), 20);
  assert.equal(calculateEdge(10, 8, "Less"), 20);
});

test("uses documented recommendation thresholds", () => {
  assert.equal(labelForScore(80), "Strong Edge");
  assert.equal(labelForScore(79), "Good Play");
  assert.equal(labelForScore(65), "Good Play");
  assert.equal(labelForScore(50), "Risky");
  assert.equal(labelForScore(49), "Avoid");
});
