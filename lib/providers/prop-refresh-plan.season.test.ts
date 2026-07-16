import assert from "node:assert/strict";
import test from "node:test";
import { buildPropRefreshPlan } from "./prop-refresh-plan.ts";
import type { ProviderEvent } from "./provider-adapter.ts";

test("skips offseason sports when planning props", () => {
  const events: ProviderEvent[] = [
    { id: "mlb-1", sportKey: "baseball_mlb", commenceTime: "2026-07-04T15:00:00Z", homeTeam: "H", awayTeam: "A" },
    { id: "nfl-1", sportKey: "americanfootball_nfl", commenceTime: "2026-07-04T15:00:00Z", homeTeam: "H", awayTeam: "A" },
    { id: "nba-1", sportKey: "basketball_nba", commenceTime: "2026-07-04T15:00:00Z", homeTeam: "H", awayTeam: "A" },
    { id: "wnba-1", sportKey: "basketball_wnba", commenceTime: "2026-07-04T17:00:00Z", homeTeam: "H", awayTeam: "A" },
  ];

  const plan = buildPropRefreshPlan(events, { now: new Date("2026-07-04T12:00:00Z"), maximumTotalCost: 10 });
  assert.deepEqual([...new Set(plan.requests.map((request) => request.sportKey))].sort(), ["baseball_mlb", "basketball_wnba"].sort());
});
