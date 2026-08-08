import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { refreshMlbInjuries } from "./mlb.ts";
import { injuryCheckCacheKey } from "./shared.ts";
import { createSupabaseFixture, type FixtureRow } from "../supabase-fixture-harness.ts";

/**
 * Job-level coverage for the injury-context freshness marker's write path
 * (lib/knowledge/enrichment/mlb.ts refreshMlbInjuries). This is the write side
 * of the "checked vs unavailable" contract whose read side is tested in
 * scoring-service.test.ts / adapters/mlb.test.ts. The required invariant per
 * owner policy: a marker means the source was successfully queried for the
 * exact relevant team AND the result was actually persisted -- not merely
 * that a fetch returned 200.
 */

function withE2eEnv(run: () => Promise<void>) {
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

const TEAMS_PAYLOAD = {
  teams: [
    { id: 111, name: "Test Team One" },
    { id: 222, name: "Test Team Two" },
  ],
};

function rosterPayload(teamId: number, entries: Array<{ id: number; name: string; statusCode?: string; statusDescription?: string; note?: string }>) {
  return {
    roster: entries.map((entry) => ({
      person: { id: entry.id, fullName: entry.name },
      status: { code: entry.statusCode ?? "D10", description: entry.statusDescription ?? "10-Day Injured List" },
      note: entry.note ?? null,
    })),
  };
}

function statsApiRouter(handlers: {
  team1Roster?: () => unknown | null; // null => simulate a failed fetch (non-200)
  team2Roster?: () => unknown | null;
}) {
  return async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname !== "statsapi.mlb.com") {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/v1/teams") {
      return new Response(JSON.stringify(TEAMS_PAYLOAD), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/v1/teams/111/roster") {
      const payload = handlers.team1Roster?.();
      if (payload === null) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify(payload ?? rosterPayload(111, [])), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/v1/teams/222/roster") {
      const payload = handlers.team2Roster?.();
      if (payload === null) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify(payload ?? rosterPayload(222, [])), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

function baseSeed(): Record<string, FixtureRow[]> {
  return {
    teams: [
      { id: "team-1", name: "Test Team One", league_id: "mlb" },
      { id: "team-2", name: "Test Team Two", league_id: "mlb" },
    ],
    source_mappings: [
      { provider: "mlb-stats-api", entity_type: "player", league_id: "mlb", external_id: "9001", entity_id: "player-1" },
    ],
    current_props: [],
    injuries: [],
    provider_cache: [],
  };
}

test("refreshMlbInjuries: checked and no injury found -- an empty roster result still writes a fresh, successful-check marker", async () => {
  await withE2eEnv(async () => {
    const fixture = createSupabaseFixture(baseSeed(), { onOtherRequest: statsApiRouter({}) });
    await refreshMlbInjuries();
    const markers = fixture.tables.get("provider_cache") ?? [];
    assert.ok(markers.some((row) => row.cache_key === injuryCheckCacheKey("mlb-team", "team-1")), "team-1 marker must exist after a clean (zero-record) fetch");
    assert.ok(markers.some((row) => row.cache_key === injuryCheckCacheKey("mlb-team", "team-2")), "team-2 marker must exist after a clean (zero-record) fetch");
    assert.equal((fixture.tables.get("injuries") ?? []).length, 0, "no injuries rows expected when the roster has no flagged players");
  });
});

test("refreshMlbInjuries: checked and injury found -- a flagged roster entry is persisted AND the marker is written", async () => {
  await withE2eEnv(async () => {
    const fixture = createSupabaseFixture(baseSeed(), {
      onOtherRequest: statsApiRouter({
        team1Roster: () => rosterPayload(111, [{ id: 9001, name: "Injured Player" }]),
      }),
    });
    await refreshMlbInjuries();
    const injuries = fixture.tables.get("injuries") ?? [];
    assert.equal(injuries.length, 1);
    assert.equal(injuries[0]!.player_id, "player-1");
    assert.equal(injuries[0]!.team_id, "team-1");
    const markers = fixture.tables.get("provider_cache") ?? [];
    assert.ok(markers.some((row) => row.cache_key === injuryCheckCacheKey("mlb-team", "team-1")));
  });
});

test("refreshMlbInjuries: failed retrieval -- a non-200 roster response writes NO marker for that team, and leaves its existing rows untouched", async () => {
  await withE2eEnv(async () => {
    const seed = baseSeed();
    seed.injuries = [{ id: "existing-1", team_id: "team-1", league_id: "mlb", report_source: "mlb-stats-api", injury_date: new Date().toISOString().slice(0, 10), status: "Day-To-Day", player_id: "player-1" }];
    const fixture = createSupabaseFixture(seed, {
      onOtherRequest: statsApiRouter({ team1Roster: () => null }),
    });
    await refreshMlbInjuries();
    const markers = fixture.tables.get("provider_cache") ?? [];
    assert.equal(markers.some((row) => row.cache_key === injuryCheckCacheKey("mlb-team", "team-1")), false, "a failed fetch must never write a successful-check marker");
    const injuries = fixture.tables.get("injuries") ?? [];
    assert.ok(injuries.some((row) => row.id === "existing-1"), "a failed fetch must not delete previously-known injury data for that team");
  });
});

test("refreshMlbInjuries: persistence failure -- if the insert throws after a successful fetch, the marker must NOT be written (proves the fetch-then-persist-then-mark ordering)", async () => {
  await withE2eEnv(async () => {
    const seed = baseSeed();
    const fixture = createSupabaseFixture(seed, {
      onOtherRequest: statsApiRouter({
        team1Roster: () => rosterPayload(111, [{ id: 9001, name: "Injured Player" }]),
      }),
    });
    const originalFetch = globalThis.fetch;
    mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/rest/v1/injuries") && (init?.method ?? "GET") === "POST") {
        throw new Error("simulated Supabase insert failure");
      }
      return originalFetch(input, init);
    });
    await refreshMlbInjuries();
    const markers = fixture.tables.get("provider_cache") ?? [];
    assert.equal(markers.some((row) => row.cache_key === injuryCheckCacheKey("mlb-team", "team-1")), false, "a persistence failure must never be masked by a marker claiming the check succeeded");
  });
});

test("refreshMlbInjuries: partial result across teams in the same run -- one team's failure does not block another team's marker (isolation)", async () => {
  await withE2eEnv(async () => {
    const fixture = createSupabaseFixture(baseSeed(), {
      onOtherRequest: statsApiRouter({
        team1Roster: () => null, // team-1 fails
        team2Roster: () => rosterPayload(222, []), // team-2 succeeds, clean
      }),
    });
    await refreshMlbInjuries();
    const markers = fixture.tables.get("provider_cache") ?? [];
    assert.equal(markers.some((row) => row.cache_key === injuryCheckCacheKey("mlb-team", "team-1")), false, "team-1's failed fetch must not get a marker");
    assert.ok(markers.some((row) => row.cache_key === injuryCheckCacheKey("mlb-team", "team-2")), "team-2's successful fetch must still get its own marker, independent of team-1");
  });
});

test("refreshMlbInjuries: successful retry after a prior failure -- a subsequent run with a working fetch writes the marker", async () => {
  await withE2eEnv(async () => {
    const seed = baseSeed();
    let attempt = 0;
    const fixture = createSupabaseFixture(seed, {
      onOtherRequest: statsApiRouter({
        team1Roster: () => {
          attempt += 1;
          return attempt === 1 ? null : rosterPayload(111, []);
        },
      }),
    });
    await refreshMlbInjuries();
    let markers = fixture.tables.get("provider_cache") ?? [];
    assert.equal(markers.some((row) => row.cache_key === injuryCheckCacheKey("mlb-team", "team-1")), false, "first attempt fails, no marker yet");

    await refreshMlbInjuries();
    markers = fixture.tables.get("provider_cache") ?? [];
    assert.ok(markers.some((row) => row.cache_key === injuryCheckCacheKey("mlb-team", "team-1")), "a later successful retry must write the marker");
  });
});

test("refreshMlbInjuries: marker persistence failure -- if putProviderCache itself fails after a successful insert, the context remains incomplete (no marker exists)", async () => {
  await withE2eEnv(async () => {
    const fixture = createSupabaseFixture(baseSeed(), {
      onOtherRequest: statsApiRouter({ team1Roster: () => rosterPayload(111, []) }),
    });
    const originalFetch = globalThis.fetch;
    mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/rest/v1/provider_cache") && (init?.method ?? "GET") === "POST") {
        throw new Error("simulated provider_cache write failure");
      }
      return originalFetch(input, init);
    });
    await refreshMlbInjuries();
    const markers = fixture.tables.get("provider_cache") ?? [];
    assert.equal(markers.some((row) => row.cache_key === injuryCheckCacheKey("mlb-team", "team-1")), false, "a marker-write failure must leave the context genuinely incomplete, not silently succeed");
  });
});

test("refreshMlbInjuries: retry succeeds without duplicate rows -- two successive successful runs for the same team/day leave exactly one row per injured player", async () => {
  await withE2eEnv(async () => {
    const fixture = createSupabaseFixture(baseSeed(), {
      onOtherRequest: statsApiRouter({ team1Roster: () => rosterPayload(111, [{ id: 9001, name: "Injured Player" }]) }),
    });
    await refreshMlbInjuries();
    const afterFirst = (fixture.tables.get("injuries") ?? []).length;
    await refreshMlbInjuries();
    const afterSecond = (fixture.tables.get("injuries") ?? []).length;
    assert.equal(afterFirst, 1);
    assert.equal(afterSecond, 1, "a second successful run for the same team/day must not duplicate the row (delete-then-insert, scoped per team)");
  });
});
