import assert from "node:assert/strict";
import test from "node:test";
import { gradePickResult } from "./picks.ts";

test("grades More picks from actual results", () => {
  assert.equal(gradePickResult(12, 10.5, "More"), "hit");
  assert.equal(gradePickResult(9, 10.5, "More"), "miss");
});

test("grades Less picks from actual results", () => {
  assert.equal(gradePickResult(8, 10.5, "Less"), "hit");
  assert.equal(gradePickResult(12, 10.5, "Less"), "miss");
});

test("treats exact actual matches as pushes", () => {
  assert.equal(gradePickResult(10, 10, "More"), "push");
  assert.equal(gradePickResult(10, 10, "Less"), "push");
});
