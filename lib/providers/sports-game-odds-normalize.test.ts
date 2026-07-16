import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSportsGameOddsProps } from "./sports-game-odds.ts";

test("normalizes player props from the SportsGameOdds payload shape", () => {
  const futureGameTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const result = normalizeSportsGameOddsProps({
    data: [
      {
        is_player_prop: true,
        event_id: "game-1",
        selection: "Player One",
        selection_type: "over",
        market_type: "player_hits",
        line: 1.5,
        event_start_time: futureGameTime,
        home_team: "Home",
        away_team: "Away",
      },
      { is_player_prop: false, event_id: "game-2" },
    ],
  }, "baseball_mlb");

  assert.equal(result.sourceRecords, 2);
  assert.equal(result.rejected, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.provider, "sports-game-odds");
  assert.equal(result.candidates[0]?.sportKey, "baseball_mlb");
  assert.equal(result.candidates[0]?.direction, "More");
});

test("filters out alternate lines and keeps the main line", () => {
  const futureGameTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const result = normalizeSportsGameOddsProps({
    data: [
      {
        is_player_prop: true,
        event_id: "game-1",
        player_name: "Player One",
        selection_type: "over",
        market_type: "player_points",
        line: 23.5,
        event_start_time: futureGameTime,
        home_team: "Home",
        away_team: "Away",
        is_main_line: true,
      },
      {
        is_player_prop: true,
        event_id: "game-1",
        player_name: "Player One",
        selection_type: "over",
        market_type: "player_points",
        line: 4.5,
        event_start_time: futureGameTime,
        home_team: "Home",
        away_team: "Away",
        is_main_line: false,
        is_alternate_line: true,
      },
    ],
  }, "basketball_wnba");

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.line, 23.5);
});

test("accepts true main lines below 1", () => {
  const futureGameTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const result = normalizeSportsGameOddsProps({
    data: [
      {
        is_player_prop: true,
        event_id: "game-2",
        player_name: "Player Two",
        selection_type: "under",
        market_type: "player_points",
        line: 0.5,
        event_start_time: futureGameTime,
        home_team: "Home",
        away_team: "Away",
        is_main_line: true,
      },
    ],
  }, "basketball_wnba");

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.line, 0.5);
});
