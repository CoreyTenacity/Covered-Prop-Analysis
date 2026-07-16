import assert from "node:assert/strict";
import test from "node:test";
import { HighlightlyMlbAdapter, summarizeHighlightlyPlayers, summarizeHighlightlyPlayerStats } from "./highlightly-mlb.ts";

test("reports Highlightly configuration", () => {
  assert.equal(new HighlightlyMlbAdapter("").configured(), false);
  assert.equal(new HighlightlyMlbAdapter("test-key").configured(), true);
});

test("summarizes the latest available player season", () => {
  const summary = summarizeHighlightlyPlayerStats([{ perSeason: [{ season: 2025, stats: [{ name: "Total Hits", value: 100 }], teams: [{ displayName: "Pittsburgh Pirates" }] }] }]);
  assert.equal(summary.latestSeason, 2025);
  assert.deepEqual(summary.statNames, ["Total Hits"]);
  assert.deepEqual(summary.teams, ["Pittsburgh Pirates"]);
});

test("summarizes only usable player identities", () => {
  assert.deepEqual(summarizeHighlightlyPlayers({ data: [{ id: 1, fullName: "Player One" }, { fullName: "Missing ID" }], pagination: { totalCount: 20 }, plan: { tier: "BASIC" } }), {
    players: 2, validPlayers: 1, totalAvailable: 20, tier: "BASIC",
  });
});
