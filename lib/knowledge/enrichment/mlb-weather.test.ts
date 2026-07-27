import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { refreshMlbWeather } from "./mlb.ts";
import { OpenMeteoWeatherAdapter } from "@/lib/providers/open-meteo-weather";

// Phase 5 — MLB weather game_id compatibility. mlb_weather.game_id is NOT NULL;
// refreshMlbWeather previously wrote game_id: null and every upsert failed with
// Postgres 23502 (observed live in run 29597712952's weather substage). The fix
// writes game_id: event.id (same UUID as event_id / the legacy games row) while
// keeping the event-first conflict target (event_id,weather_date) unchanged.

function withEnv(run: () => Promise<void>) {
  const prev = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJtest";
  return run().finally(() => {
    if (prev.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = prev.url;
    if (prev.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prev.key;
    mock.restoreAll();
  });
}

const EVENT_ID = "11111111-2222-3333-4444-555555555555";
const HOME_TEAM_ID = "home-team-uuid";
const AWAY_TEAM_ID = "away-team-uuid";

// One weather-eligible event: both teams present, home team ("Boston Red Sox")
// has coordinates, start_time inside the live weather window.
function installWeatherHarness(options: { includeTeams?: boolean } = {}) {
  const includeTeams = options.includeTeams ?? true;
  const startTime = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(); // +3h, in-window
  const scheduledDate = startTime.slice(0, 10);
  const weatherUpserts: Array<{ onConflict: string; rows: Array<Record<string, unknown>> }> = [];

  mock.method(OpenMeteoWeatherAdapter.prototype, "fetchMlbWeather", async () => ({
    data: { temperatureF: 72, windMph: 6, precipitationProbability: 10, note: "Clear · 72°F · 10% precip · 6 mph wind", fetchedAt: new Date().toISOString() },
    cost: 0, remaining: null, fetchedAt: new Date().toISOString(),
  }));

  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const table = (u.split("/rest/v1/").pop() ?? "").split("?")[0];
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });

    if (method === "GET") {
      if (table === "events") {
        return json([{
          id: EVENT_ID,
          start_time: startTime,
          scheduled_date: scheduledDate,
          home_team_id: includeTeams ? HOME_TEAM_ID : null,
          away_team_id: includeTeams ? AWAY_TEAM_ID : null,
        }]);
      }
      if (table === "teams") {
        return json([
          { id: HOME_TEAM_ID, name: "Boston Red Sox" },   // has coordinates
          { id: AWAY_TEAM_ID, name: "Tampa Bay Rays" },
        ]);
      }
      return json([]); // mlb_weather (empty -> refresh), current_props, players, provider_cache, etc.
    }
    if (method === "POST" && table === "mlb_weather") {
      const onConflict = new URLSearchParams(u.split("?")[1] ?? "").get("on_conflict") ?? "";
      const body = JSON.parse(String(init?.body ?? "[]"));
      weatherUpserts.push({ onConflict, rows: Array.isArray(body) ? body : [body] });
      return new Response(null, { status: 204 });
    }
    if (method === "POST") return json([]); // provider_cache etc.
    return new Response(null, { status: 204 }); // PATCH/DELETE
  });

  return { weatherUpserts, startTime, scheduledDate };
}

test("refreshMlbWeather writes game_id = event.id (not null) with event_id, keeping the event-first conflict target", async () => {
  await withEnv(async () => {
    const { weatherUpserts, scheduledDate } = installWeatherHarness({ includeTeams: true });
    const result = await refreshMlbWeather();
    assert.ok(result.inserted >= 1, "expected at least one weather row written");
    assert.equal(weatherUpserts.length >= 1, true);
    const write = weatherUpserts[0];
    const row = write.rows[0];
    // both ids present and equal to the internal event id (which doubles as the legacy games id)
    assert.equal(row.event_id, EVENT_ID);
    assert.equal(row.game_id, EVENT_ID);
    assert.notEqual(row.game_id, null);
    assert.equal(row.weather_date, scheduledDate);
    // event-first conflict target unchanged
    assert.equal(write.onConflict, "event_id,weather_date");
  });
});

test("refreshMlbWeather excludes a team-less event (no weather upsert without both teams)", async () => {
  await withEnv(async () => {
    const { weatherUpserts } = installWeatherHarness({ includeTeams: false });
    const result = await refreshMlbWeather();
    assert.equal(result.inserted, 0);
    assert.equal(weatherUpserts.length, 0);
  });
});
