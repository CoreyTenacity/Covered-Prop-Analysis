import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { refreshMlbSchedulesLiveGate } from "./mlb.ts";
import { createSupabaseFixture } from "../supabase-fixture-harness.ts";

/**
 * Proves refreshMlbSchedulesLiveGate() distinguishes its three failure stages
 * (provider_fetch, event_persistence, future_event_verification) and that a
 * genuinely valid future schedule passes all three. Only the MLB Stats API
 * fetch and the Supabase REST fetch are mocked; no live network call occurs.
 */

function withMlbEnv(run: () => Promise<void>) {
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

function mockMlbStatsApi(handler: (url: URL) => Response) {
  return createSupabaseFixture({}, {
    onOtherRequest: async (input) => handler(new URL(String(input))),
  });
}

test("schedule live-gate: a provider fetch failure reports stage provider_fetch", async () => {
  await withMlbEnv(async () => {
    mockMlbStatsApi(() => new Response("Service unavailable", { status: 503 }));

    await assert.rejects(
      () => refreshMlbSchedulesLiveGate(new Date()),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const details = JSON.parse(error.message) as { stage: string };
        assert.equal(details.stage, "provider_fetch");
        return true;
      },
    );
  });
});

test("schedule live-gate: games returned but none persisted reports stage event_persistence", async () => {
  await withMlbEnv(async () => {
    // Every game is missing a required field (home team id), so ensureEvent()/ensureTeam()
    // are never reached and every game is skipped by the `continue` guard -- 0 of N persisted.
    mockMlbStatsApi(() => new Response(JSON.stringify({
      dates: [{
        date: "2026-07-20",
        games: [{
          gamePk: 1,
          gameDate: "2026-07-20T20:10:00Z",
          teams: {
            home: { team: { name: "Los Angeles Dodgers" } }, // missing id
            away: { team: { id: 137, name: "San Francisco Giants" } },
          },
        }],
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await assert.rejects(
      () => refreshMlbSchedulesLiveGate(new Date()),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const details = JSON.parse(error.message) as { stage: string; providerGamesReturned: number; normalizedEvents: number };
        assert.equal(details.stage, "event_persistence");
        assert.equal(details.providerGamesReturned, 1);
        assert.equal(details.normalizedEvents, 0);
        return true;
      },
    );
  });
});

test("schedule live-gate: zero games and no existing future events reports stage future_event_verification", async () => {
  await withMlbEnv(async () => {
    mockMlbStatsApi(() => new Response(JSON.stringify({ dates: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await assert.rejects(
      () => refreshMlbSchedulesLiveGate(new Date()),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const details = JSON.parse(error.message) as { stage: string; futureEventsVerified: number };
        assert.equal(details.stage, "future_event_verification");
        assert.equal(details.futureEventsVerified, 0);
        return true;
      },
    );
  });
});

test("schedule live-gate: provider and persistence failures are distinguishable from each other", async () => {
  await withMlbEnv(async () => {
    mockMlbStatsApi(() => new Response("Internal error", { status: 500 }));
    let providerFetchStage: string | null = null;
    try {
      await refreshMlbSchedulesLiveGate(new Date());
    } catch (error) {
      providerFetchStage = JSON.parse((error as Error).message).stage;
    }
    assert.equal(providerFetchStage, "provider_fetch");
  });

  await withMlbEnv(async () => {
    mockMlbStatsApi(() => new Response(JSON.stringify({
      dates: [{ date: "2026-07-20", games: [{ gamePk: 1, gameDate: "2026-07-20T20:10:00Z", teams: {} }] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    let persistenceStage: string | null = null;
    try {
      await refreshMlbSchedulesLiveGate(new Date());
    } catch (error) {
      persistenceStage = JSON.parse((error as Error).message).stage;
    }
    assert.equal(persistenceStage, "event_persistence");
  });
});

test("schedule live-gate: a valid future schedule passes provider fetch, persistence, and future-event verification", async () => {
  await withMlbEnv(async () => {
    const futureGameDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    mockMlbStatsApi(() => new Response(JSON.stringify({
      dates: [{
        date: futureGameDate.slice(0, 10),
        games: [{
          gamePk: 12345,
          gameDate: futureGameDate,
          status: { detailedState: "Scheduled", abstractGameState: "Preview" },
          venue: { name: "Dodger Stadium", location: { city: "Los Angeles", stateAbbrev: "CA" } },
          teams: {
            home: { team: { id: 119, name: "Los Angeles Dodgers", abbreviation: "LAD" } },
            away: { team: { id: 137, name: "San Francisco Giants", abbreviation: "SF" } },
          },
        }],
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await refreshMlbSchedulesLiveGate(new Date());
    assert.equal(result.league, "MLB");
    assert.equal(result.events, 1);
    assert.equal(result.futureEventsVerified, 1);
  });
});
