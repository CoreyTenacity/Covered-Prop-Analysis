import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { refreshBasketballInjuries } from "./basketball.ts";
import { injuryCheckCacheKey } from "./shared.ts";
import { createSupabaseFixture, type FixtureRow } from "../supabase-fixture-harness.ts";

/**
 * Covers the "partial response" gap found this session: refreshBasketballInjuries
 * previously read payload.data.records but never checked payload.data.errors, so
 * a 200-status fetch that failed to extract any real records (a genuinely
 * partial/unreliable result) was silently treated the same as a clean, complete
 * report -- deleting today's existing rows and writing a successful-check marker
 * regardless. Uses the NBA path (simple JSON/HTML fetch) rather than WNBA's PDF
 * path, which needs no additional mocking beyond the source URL's own fetch.
 */

function withE2eEnv(run: () => Promise<void>) {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalNbaUrl = process.env.NBA_INJURY_REPORT_URL;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJtest";
  process.env.NBA_INJURY_REPORT_URL = "https://example-nba-injuries.test/report";
  return run().finally(() => {
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
    if (originalNbaUrl === undefined) delete process.env.NBA_INJURY_REPORT_URL;
    else process.env.NBA_INJURY_REPORT_URL = originalNbaUrl;
    mock.restoreAll();
  });
}

function baseSeed(): Record<string, FixtureRow[]> {
  return {
    entity_aliases: [{ entity_id: "player-1", entity_type: "player", league_id: "nba", normalized_alias: "injured player" }],
    injuries: [],
    provider_cache: [],
  };
}

function nbaRouter(body: string, contentType = "text/plain") {
  return async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname !== "example-nba-injuries.test") return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response(body, { status: 200, headers: { "Content-Type": contentType } });
  };
}

test("refreshBasketballInjuries: a partial response (no records extracted, errors populated) writes NO marker and does not touch existing rows", async () => {
  await withE2eEnv(async () => {
    const seed = baseSeed();
    seed.injuries = [{ id: "existing-1", league_id: "nba", report_source: "official-injuries", injury_date: new Date().toISOString().slice(0, 10), status: "Day-To-Day", player_id: "player-1" }];
    const fixture = createSupabaseFixture(seed, { onOtherRequest: nbaRouter("not json and not an html table either") });
    const result = await refreshBasketballInjuries("NBA", { teamIdAllowlist: ["team-1"] });
    assert.equal((result as { partial?: boolean }).partial, true, "a payload with zero extractable records and a non-empty errors array must be reported as partial");
    const markers = fixture.tables.get("provider_cache") ?? [];
    assert.equal(markers.some((row) => row.cache_key === injuryCheckCacheKey("nba-league", "nba")), false, "a partial result must never write a successful-check marker");
    const injuries = fixture.tables.get("injuries") ?? [];
    assert.ok(injuries.some((row) => row.id === "existing-1"), "a partial result must not delete previously-known injury data");
  });
});

test("refreshBasketballInjuries: a clean, fully-parsed empty report (zero players listed) still writes a marker -- distinct from a partial/unparseable one", async () => {
  await withE2eEnv(async () => {
    const fixture = createSupabaseFixture(baseSeed(), { onOtherRequest: nbaRouter("[]", "application/json") });
    await refreshBasketballInjuries("NBA", { teamIdAllowlist: ["team-1"] });
    const markers = fixture.tables.get("provider_cache") ?? [];
    assert.ok(markers.some((row) => row.cache_key === injuryCheckCacheKey("nba-league", "nba")), "an empty JSON array is a genuinely complete, interpretable result (nobody listed), not a parse failure -- must still mark the check successful");
  });
});
