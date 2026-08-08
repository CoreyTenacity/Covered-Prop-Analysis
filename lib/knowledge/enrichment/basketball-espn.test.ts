import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { refreshWnbaMatchupFeatures } from "./basketball-espn.ts";
import { createSupabaseFixture } from "../supabase-fixture-harness.ts";

function withFixtureEnv(run: () => Promise<void>) {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJtest";
  return run().finally(() => {
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
    mock.restoreAll();
  });
}

test("WNBA ESPN/SportsDataverse matchup refresh keeps the natural repair's current team and event scope", async () => {
  await withFixtureEnv(async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString();
    const fixture = createSupabaseFixture({
      team_game_logs: [
        { id: "a1", league_id: "wnba", provider: "sportsdataverse-wnba", team_id: "team-a", event_id: "old-a", game_date: "2026-07-20", team_total: 80, pace: 98, offensive_rating: 107, defensive_rating: 102 },
        { id: "b1", league_id: "wnba", provider: "sportsdataverse-wnba", team_id: "team-b", event_id: "old-a", game_date: "2026-07-20", team_total: 76, pace: 97, offensive_rating: 103, defensive_rating: 106 },
        { id: "c1", league_id: "wnba", provider: "sportsdataverse-wnba", team_id: "team-c", event_id: "old-c", game_date: "2026-07-20", team_total: 90, pace: 101, offensive_rating: 111, defensive_rating: 99 },
        { id: "d1", league_id: "wnba", provider: "sportsdataverse-wnba", team_id: "team-d", event_id: "old-c", game_date: "2026-07-20", team_total: 70, pace: 95, offensive_rating: 100, defensive_rating: 110 },
      ],
      events: [
        { id: "event-target", league_id: "wnba", home_team_id: "team-b", away_team_id: "team-a", scheduled_date: "2026-08-02", start_time: future },
        { id: "event-unrelated", league_id: "wnba", home_team_id: "team-d", away_team_id: "team-c", scheduled_date: "2026-08-02", start_time: future },
      ],
      basketball_team_context: [],
      basketball_opponent_context: [],
      matchup_features: [],
    });

    const result = await refreshWnbaMatchupFeatures(now, {
      teamIds: ["team-a", "team-b"],
      eventIds: ["event-target"],
    });

    assert.equal(result.teamContexts, 2);
    assert.equal(result.matchupRows, 2);
    assert.deepEqual(
      (fixture.tables.get("basketball_team_context") ?? []).map((row) => row.team_id).sort(),
      ["team-a", "team-b"],
    );
    assert.deepEqual(
      (fixture.tables.get("basketball_opponent_context") ?? []).map((row) => row.event_id),
      ["event-target", "event-target"],
    );
    assert.equal(
      fixture.calls.some((call) => call.table === "events"),
      true,
      "the bounded event selection remains a normal Supabase read rather than a provider call",
    );
  });
});
