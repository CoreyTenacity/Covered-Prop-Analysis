import assert from "node:assert/strict";
import test from "node:test";
import { describeGradingResult } from "./grading.ts";

test("describes hits, misses, and pushes in plain English", () => {
  assert.equal(describeGradingResult(12, 10.5, "More", "hit"), "Final result: hit — 12 cleared the 10.5 line on the over side.");
  assert.equal(describeGradingResult(9, 10.5, "More", "miss"), "Final result: miss — 9 stayed on the wrong side of the 10.5 line for the over side.");
  assert.equal(describeGradingResult(10, 10, "Less", "push"), "Final result: push at 10 against the 10 line.");
});

