import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSharpApiProps } from "./normalize-sharpapi.ts";

test("normalizes and deduplicates SharpAPI player props by sportsbook", () => {
  const base = { is_player_prop: true, event_id: "game-1", selection: "Player One", selection_type: "over", line: 1.5, market_type: "player_hits", event_start_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), home_team: "Home", away_team: "Away" };
  const result = normalizeSharpApiProps({ data: [{ ...base, sportsbook: "book-a", odds_american: -110 }, { ...base, sportsbook: "book-b", odds_american: -120 }] }, "MLB");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].books.length, 2);
  assert.equal(result.candidates[0].statType, "Hits");
  assert.equal(result.candidates[0].direction, "More");
  assert.equal(result.candidates[0].team, null);
});

test("rejects incomplete and non-player records", () => {
  const result = normalizeSharpApiProps({ data: [{ is_player_prop: false }, { is_player_prop: true, selection: "Missing fields" }] }, "MLB");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected, 2);
});

test("rejects rows with a missing, null, zero, or negative line", () => {
  const base = { is_player_prop: true, event_id: "game-1", selection: "Player One", selection_type: "over", market_type: "player_hits", event_start_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), home_team: "Home", away_team: "Away", sportsbook: "book-a", odds_american: -110 };
  const result = normalizeSharpApiProps({
    data: [
      { ...base }, // line entirely absent
      { ...base, line: null },
      { ...base, line: 0 },
      { ...base, line: -1.5 },
    ],
  }, "MLB");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected, 4);
});

test("prefers an explicit player field over over/under wording", () => {
  const futureGameTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const result = normalizeSharpApiProps({
    data: [{
      is_player_prop: true,
      event_id: "game-2",
      player_name: "Player Two",
      selection: "Over",
      selection_type: "over",
      line: 1.5,
      market_type: "player_hits",
      event_start_time: futureGameTime,
      home_team: "Home",
      away_team: "Away",
      sportsbook: "book-a",
      odds_american: -110,
    }],
  }, "MLB");
  assert.equal(result.candidates[0].playerName, "Player Two");
});

test("filters out alternate lines and keeps only the main line", () => {
  const futureGameTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const result = normalizeSharpApiProps({
    data: [
      {
        is_player_prop: true,
        event_id: "game-3",
        player_name: "Player Three",
        selection_type: "over",
        line: 23.5,
        market_type: "player_points",
        event_start_time: futureGameTime,
        home_team: "Home",
        away_team: "Away",
        sportsbook: "book-a",
        odds_american: -110,
        is_main_line: true,
      },
      {
        is_player_prop: true,
        event_id: "game-3",
        player_name: "Player Three",
        selection_type: "over",
        line: 4.5,
        market_type: "player_points",
        event_start_time: "2026-07-06T15:00:00Z",
        home_team: "Home",
        away_team: "Away",
        sportsbook: "book-a",
        odds_american: -105,
        is_main_line: false,
        is_alternate_line: true,
      },
    ],
  }, "WNBA");

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].line, 23.5);
});

test("accepts true main lines below 1 and normalizes uppercase market keys", () => {
  const futureGameTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const result = normalizeSharpApiProps({
    data: [
      {
        is_player_prop: true,
        event_id: "game-4",
        player_name: "Player Four",
        selection_type: "under",
        line: 0.5,
        market_type: "PLAYER_EARNED_RUNS",
        event_start_time: futureGameTime,
        home_team: "Home",
        away_team: "Away",
        sportsbook: "book-a",
        odds_american: -110,
        is_main_line: true,
      },
    ],
  }, "MLB");

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].line, 0.5);
  assert.equal(result.candidates[0].marketKey, "player_earned_runs");
  assert.equal(result.candidates[0].statType, "Earned Runs Allowed");
  assert.equal(result.candidates[0].direction, "Less");
});
