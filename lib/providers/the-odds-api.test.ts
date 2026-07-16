import assert from "node:assert/strict";
import test from "node:test";
import { assertPlayerPropMarkets, estimateEventPropsCost, TheOddsApiAdapter } from "./the-odds-api.ts";

test("estimates event prop cost by unique markets and regions", () => {
  assert.equal(estimateEventPropsCost(["player_points", "player_rebounds"], ["us"]), 2);
  assert.equal(estimateEventPropsCost(["player_points", "player_points"], ["us", "us2"]), 2);
});

test("does not make an unconfigured provider appear available", () => {
  assert.equal(new TheOddsApiAdapter("").configured(), false);
  assert.equal(new TheOddsApiAdapter("test-key").configured(), true);
});

test("rejects game and team markets before making a provider request", () => {
  assert.doesNotThrow(() => assertPlayerPropMarkets(["batter_hits", "player_points"]));
  assert.throws(() => assertPlayerPropMarkets(["h2h", "totals"]), /Only player-prop markets/);
});
