import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent } from "./provider-adapter.ts";
import { approvedPropMarkets, buildPropRefreshPlan } from "./prop-refresh-plan.ts";

const now = new Date("2026-07-04T12:00:00Z");
const event = (id: string, sportKey: string, hours: number): ProviderEvent => ({
  id, sportKey, commenceTime: new Date(now.getTime() + hours * 3_600_000).toISOString(), homeTeam: `Home ${id}`, awayTeam: `Away ${id}`,
});

test("plans only near-term approved sports under the hard cost ceiling", () => {
  const plan = buildPropRefreshPlan([
    event("m1", "baseball_mlb", 2), event("m2", "baseball_mlb", 4), event("m3", "baseball_mlb", 5),
    event("w1", "basketball_wnba", 3), event("n1", "americanfootball_nfl", 200), event("x1", "soccer_epl", 2),
  ], { now });
  assert.equal(plan.requests.length, 15);
  assert.equal(plan.maximumCost, 15);
  assert.deepEqual(new Set(plan.requests.slice(0, 4).map((request) => request.eventId)), new Set(["m1", "m2", "m3", "w1"]));
  assert.ok(plan.maximumCost <= plan.ceiling);
  assert.equal(plan.propCallsEnabled, false);
});

test("never exceeds the configured total cost", () => {
  const plan = buildPropRefreshPlan([event("m1", "baseball_mlb", 1), event("w1", "basketball_wnba", 2)], { now, maximumTotalCost: 2 });
  assert.equal(plan.requests.length, 2);
  assert.equal(plan.maximumCost, 2);
});

test("does not spend today's prop budget on the next Eastern calendar day", () => {
  const lateNow = new Date("2026-07-05T20:00:00Z");
  const plan = buildPropRefreshPlan([
    { id: "today", sportKey: "baseball_mlb", commenceTime: "2026-07-05T23:00:00Z", homeTeam: "H1", awayTeam: "A1" },
    { id: "tomorrow", sportKey: "baseball_mlb", commenceTime: "2026-07-06T23:00:00Z", homeTeam: "H2", awayTeam: "A2" },
  ], { now: lateNow, maximumTotalCost: 2 });
  assert.deepEqual([...new Set(plan.requests.map((request) => request.eventId))], ["today"]);
});

test("automatically weights the daily credit split by each league's available games", () => {
  const mlb = Array.from({ length: 15 }, (_, index) => event(`mlb-${index}`, "baseball_mlb", 1 + index / 10));
  const wnba = Array.from({ length: 2 }, (_, index) => event(`wnba-${index}`, "basketball_wnba", 3 + index));
  const plan = buildPropRefreshPlan([...mlb, ...wnba], { now, maximumTotalCost: 15 });
  assert.equal(plan.requests.filter((request) => request.sportKey === "baseball_mlb").length, 13);
  assert.equal(plan.requests.filter((request) => request.sportKey === "basketball_wnba").length, 2);
  assert.equal(plan.maximumCost, 15);
});

test("keeps NBA and WNBA prop planning focused on core scoring and combo markets", () => {
  assert.deepEqual(approvedPropMarkets.basketball_nba, [
    "player_points",
    "player_rebounds",
    "player_assists",
    "player_points_rebounds",
    "player_points_assists",
    "player_rebounds_assists",
    "player_points_rebounds_assists",
  ]);
  assert.deepEqual(approvedPropMarkets.basketball_wnba, [
    "player_points",
    "player_rebounds",
    "player_assists",
    "player_points_rebounds",
    "player_points_assists",
    "player_rebounds_assists",
    "player_points_rebounds_assists",
  ]);
});
