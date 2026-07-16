import assert from "node:assert/strict";
import test from "node:test";
import { summarizeSportsGameOddsPayload, SportsGameOddsAdapter } from "./sports-game-odds.ts";

test("reports whether SportsGameOdds is configured", () => {
  assert.equal(new SportsGameOddsAdapter("").configured(), false);
});

test("summarizes SportsGameOdds player-prop payloads", () => {
  const summary = summarizeSportsGameOddsPayload({
    data: [
      { is_player_prop: true, market_type: "player_points", sport_key: "basketball_nba" },
      { is_player_prop: false, marketType: "moneyline", sportKey: "basketball_nba" },
    ],
    pagination: { has_more: true },
  });

  assert.deepEqual(summary, {
    records: 2,
    propRecords: 1,
    hasMore: true,
    sports: ["basketball_nba"],
    marketTypes: ["player_points", "moneyline"],
  });
});
