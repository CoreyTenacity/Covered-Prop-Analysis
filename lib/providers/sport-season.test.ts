import assert from "node:assert/strict";
import test from "node:test";
import { activeSports, isSportInSeason, priorityCoverageSports } from "./sport-season.ts";

test("treats MLB and WNBA as in season in July while NFL and NBA are out", () => {
  const now = new Date("2026-07-04T12:00:00Z");
  assert.equal(isSportInSeason("MLB", now), true);
  assert.equal(isSportInSeason("WNBA", now), true);
  assert.equal(isSportInSeason("NFL", now), false);
  assert.equal(isSportInSeason("NBA", now), false);
});

test("lists only currently active sports", () => {
  const sports = activeSports(new Date("2026-07-04T12:00:00Z"));
  assert.deepEqual(sports.sort(), ["MLB", "Tennis", "WNBA"].sort());
});

test("prioritizes MLB and WNBA for the live board flow", () => {
  const sports = priorityCoverageSports(new Date("2026-07-04T12:00:00Z"));
  assert.deepEqual(sports, ["MLB", "WNBA"]);
});
