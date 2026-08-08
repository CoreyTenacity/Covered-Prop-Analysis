import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { withProviderCacheMemoScope } from "@/lib/db/provider-cache";
import { CATALOG_SEED_VERSION } from "./catalog.ts";
import { listPullStrategies } from "./pull-strategy.ts";
import type { OddsPullConfigRow } from "./types.ts";
import {
  filterSharpPullConfigs,
  loadSharpPullConfigs,
  normalizeSharpPullConfigs,
  sharpPullConfigCacheKey,
} from "./sharp-pull-config.ts";

const cacheKey = sharpPullConfigCacheKey();
const legacyCacheKey = `sharpapi:pull-configs:${CATALOG_SEED_VERSION}`;
const seedCacheKey = "knowledge-catalog:seed-version:latest";

const FIXTURE_REVISION = "2026-07-27T12:00:00.000Z";

function buildSourceRows(revision: string = FIXTURE_REVISION) {
  return listPullStrategies("sharpapi").map((row) => ({
    provider: row.provider,
    sport_id: row.sport.toLowerCase(),
    league_id: row.league.toLowerCase(),
    market_type: row.marketType,
    sportsbook: row.sportsbook,
    priority: row.priority,
    pull_cadence_minutes: row.pullCadenceMinutes,
    enabled: row.enabled,
    metadata: row.metadata ?? {},
    updated_at: revision,
  } satisfies OddsPullConfigRow & { updated_at: string }));
}

function sportLabel(sportId: string) {
  if (sportId === "baseball") return "BASEBALL";
  if (sportId === "football") return "FOOTBALL";
  if (sportId === "tennis") return "TENNIS";
  return "BASKETBALL";
}

function makeSentinelRecord() {
  return {
    cache_key: seedCacheKey,
    provider: "sharpapi",
    payload: {
      version: CATALOG_SEED_VERSION,
      seededAt: new Date().toISOString(),
      counts: { sports: 4, leagues: 5, sportsbooks: 2, markets: 8, pullConfigs: 8 },
    },
    fetched_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    source_updated_at: null,
    is_stale: false,
  };
}

function makeCacheRecord(cacheKey: string, payload: unknown, sourceUpdatedAt: string | null = null) {
  return {
    cache_key: cacheKey,
    provider: "sharpapi",
    payload,
    fetched_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    source_updated_at: sourceUpdatedAt,
    is_stale: false,
  };
}

function makeFetchHarness(options: {
  oddsPullConfigs: Array<Record<string, unknown>>;
  initialCacheRecord?: Record<string, unknown> | null;
}) {
  const cacheStore = new Map<string, Record<string, unknown>>();
  const calls: Array<{ method: string; path: string; cacheKey?: string }> = [];
  if (options.initialCacheRecord) {
    cacheStore.set(String(options.initialCacheRecord.cache_key), options.initialCacheRecord);
  }

  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = new URL(String(input));
    const path = url.pathname.split("/rest/v1/").pop() ?? url.pathname;
    const table = path.split("?")[0];
    let requestCacheKey = url.searchParams.get("cache_key")?.replace(/^eq\./, "") || undefined;
    if (table === "provider_cache" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (typeof body.cache_key === "string") {
        requestCacheKey = body.cache_key;
      }
    }
    calls.push({ method, path: table, cacheKey: requestCacheKey });

    if (table === "provider_cache") {
      if (method === "GET") {
        if (requestCacheKey === seedCacheKey) {
          return new Response(JSON.stringify([makeSentinelRecord()]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        const record = requestCacheKey ? cacheStore.get(requestCacheKey) ?? null : null;
        return new Response(JSON.stringify(record ? [record] : []), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.cache_key) {
          cacheStore.set(String(body.cache_key), body);
        }
        return new Response(null, { status: 204 });
      }

      if (method === "DELETE") {
        const keys = requestCacheKey ? [requestCacheKey] : [];
        for (const key of keys) cacheStore.delete(key);
        return new Response(null, { status: 204 });
      }
    }

    if (table === "odds_pull_configs" && method === "GET") {
      // Mirror real PostgREST filter/order/limit semantics -- the revision
      // query is scoped by `provider=eq.sharpapi`, and must actually exclude
      // other providers' rows for provider isolation to be meaningfully
      // tested, not just structurally assumed from the query builder.
      let rows = [...options.oddsPullConfigs];
      const providerFilter = url.searchParams.get("provider");
      if (providerFilter?.startsWith("eq.")) {
        const wanted = providerFilter.slice(3);
        rows = rows.filter((row) => row.provider === wanted);
      }
      const order = url.searchParams.get("order");
      if (order) {
        const [column, direction] = order.split(".");
        rows.sort((a, b) => {
          const av = String(a[column] ?? "");
          const bv = String(b[column] ?? "");
          return direction === "desc" ? bv.localeCompare(av) : av.localeCompare(bv);
        });
      }
      const limit = url.searchParams.get("limit");
      if (limit) rows = rows.slice(0, Number(limit));
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  return { calls, cacheStore };
}

function withSupabaseEnv(run: () => Promise<void>) {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJtest";
  return run().finally(() => {
    if (originalUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    }
    if (originalKey === undefined) {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    } else {
      process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
    }
    mock.restoreAll();
  });
}

test("narrow and broad calls reuse the canonical cache without contamination", async () => {
  const sourceRows = buildSourceRows();
  const expectedCanonical = normalizeSharpPullConfigs(sourceRows);
  const narrowSource = sourceRows[0];
  const narrowFilters = {
    sport: sportLabel(String(narrowSource?.sport_id ?? "basketball")),
    league: String(narrowSource?.league_id ?? "wnba").toUpperCase(),
    sportsbook: String(narrowSource?.sportsbook ?? "DraftKings"),
    marketType: String(narrowSource?.market_type ?? "player_points"),
    enabledOnly: true,
  };
  const { calls, cacheStore } = makeFetchHarness({ oddsPullConfigs: sourceRows, initialCacheRecord: null });

  await withSupabaseEnv(async () => {
    cacheStore.set(cacheKey, makeCacheRecord(cacheKey, expectedCanonical, FIXTURE_REVISION));
    await withProviderCacheMemoScope(async () => {
      const narrow = await loadSharpPullConfigs(narrowFilters);
      const broad = await loadSharpPullConfigs({ enabledOnly: false });

      assert.deepEqual(narrow, filterSharpPullConfigs(expectedCanonical, narrowFilters));
      assert.deepEqual(broad, expectedCanonical);
    });

    assert.deepEqual(
      calls.filter((call) => call.path === "provider_cache" && call.method === "GET").map((call) => call.cacheKey),
      [cacheKey],
    );
    // A cache hit still costs one cheap bounded revision-check read of
    // odds_pull_configs per call (2 calls above -> 2 reads) -- this is the
    // intentional cost of automatic invalidation; it never re-reads the full
    // config list or re-writes the cache when the revision is unchanged.
    assert.equal(calls.filter((call) => call.path === "odds_pull_configs").length, 2);
    assert.deepEqual(cacheStore.get(cacheKey)?.payload, expectedCanonical);
  });
});

test("a legacy cache entry is ignored and rewritten under the versioned key", async () => {
  const sourceRows = buildSourceRows();
  const expectedCanonical = normalizeSharpPullConfigs(sourceRows);
  const { calls, cacheStore } = makeFetchHarness({
    oddsPullConfigs: sourceRows,
    initialCacheRecord: makeCacheRecord(legacyCacheKey, expectedCanonical, FIXTURE_REVISION),
  });

  await withSupabaseEnv(async () => {
    await withProviderCacheMemoScope(async () => {
      const broad = await loadSharpPullConfigs({ enabledOnly: false });

      assert.deepEqual(broad, expectedCanonical);
    });

    assert.deepEqual(
      calls.filter((call) => call.path === "provider_cache" && call.method === "GET").map((call) => call.cacheKey),
      [cacheKey, seedCacheKey],
    );
    assert.equal(calls.some((call) => call.method === "GET" && call.cacheKey === legacyCacheKey), false);
    assert.deepEqual(
      calls.filter((call) => call.path === "provider_cache" && call.method === "POST").map((call) => call.cacheKey),
      [cacheKey],
    );
    // The versioned key has no entry at all (only the legacy key does), so
    // this is a genuine cache miss: one revision-check read up front, plus
    // one full-config read in the reload branch.
    assert.equal(calls.filter((call) => call.path === "odds_pull_configs").length, 2);
    assert.deepEqual(cacheStore.get(cacheKey)?.payload, expectedCanonical);
    assert.equal(cacheStore.has(legacyCacheKey), true);
  });
});

test("filtered calls derive locally from a cached canonical payload", async () => {
  const sourceRows = buildSourceRows();
  const expectedCanonical = normalizeSharpPullConfigs(sourceRows);
  const enabledSource = sourceRows.find((row) => row.enabled) ?? sourceRows[0];
  const narrowFilters = {
    sport: sportLabel(String(enabledSource?.sport_id ?? "basketball")),
    league: String(enabledSource?.league_id ?? "mlb").toUpperCase(),
    sportsbook: String(enabledSource?.sportsbook ?? "DraftKings"),
    marketType: String(enabledSource?.market_type ?? "player_points"),
    enabledOnly: true,
  };
  const bySportsbook = {
    sportsbook: String(sourceRows[0]?.sportsbook ?? "DraftKings"),
    enabledOnly: false,
  };
  const byMarketType = {
    marketType: String(sourceRows[0]?.market_type ?? "player_points"),
    enabledOnly: false,
  };
  const { calls, cacheStore } = makeFetchHarness({
    oddsPullConfigs: sourceRows,
    initialCacheRecord: makeCacheRecord(cacheKey, expectedCanonical, FIXTURE_REVISION),
  });

  await withSupabaseEnv(async () => {
    await withProviderCacheMemoScope(async () => {
      const broad = await loadSharpPullConfigs({ enabledOnly: false });
      const narrow = await loadSharpPullConfigs(narrowFilters);
      const sportsbookFiltered = await loadSharpPullConfigs(bySportsbook);
      const marketTypeFiltered = await loadSharpPullConfigs(byMarketType);

      assert.deepEqual(broad, expectedCanonical);
      assert.deepEqual(narrow, filterSharpPullConfigs(expectedCanonical, narrowFilters));
      assert.deepEqual(sportsbookFiltered, filterSharpPullConfigs(expectedCanonical, bySportsbook));
      assert.deepEqual(marketTypeFiltered, filterSharpPullConfigs(expectedCanonical, byMarketType));
    });

    assert.deepEqual(
      calls.filter((call) => call.path === "provider_cache" && call.method === "GET").map((call) => call.cacheKey),
      [cacheKey],
    );
    // 4 calls, each a genuine cache hit -> 4 cheap revision-check reads, zero
    // full-config reloads (the payload never changes from expectedCanonical).
    assert.equal(calls.filter((call) => call.path === "odds_pull_configs").length, 4);
    assert.deepEqual(cacheStore.get(cacheKey)?.payload, expectedCanonical);
  });
});

test("a cached canonical empty-after-filtering payload is a hit when the config table's revision is unchanged", async () => {
  // The config TABLE has rows (so a revision exists) but every row is
  // filtered out by the caller's filters -- exercising "cached payload
  // resolves to an empty array" without the degenerate "table itself has
  // zero rows" case, which cannot carry a meaningful revision at all.
  const sourceRows = buildSourceRows();
  const { calls, cacheStore } = makeFetchHarness({
    oddsPullConfigs: sourceRows,
    initialCacheRecord: makeCacheRecord(cacheKey, [], FIXTURE_REVISION),
  });
  await withSupabaseEnv(async () => {
    await withProviderCacheMemoScope(async () => {
      const first = await loadSharpPullConfigs({ enabledOnly: false, league: "NO_SUCH_LEAGUE" });
      const second = await loadSharpPullConfigs({ enabledOnly: true, league: "NO_SUCH_LEAGUE" });

      assert.deepEqual(first, []);
      assert.deepEqual(second, []);
    });

    assert.deepEqual(
      calls.filter((call) => call.path === "provider_cache" && call.method === "GET").map((call) => call.cacheKey),
      [cacheKey],
    );
    // Both calls are genuine hits against the (empty) cached payload -- one
    // revision-check read per call, no reload.
    assert.equal(calls.filter((call) => call.path === "odds_pull_configs").length, 2);
    assert.deepEqual(cacheStore.get(cacheKey)?.payload, []);
  });
});

test("a truly empty config table (no rows at all) has no revision to trust, so it always attempts a fresh reload", async () => {
  // Degenerate case: the config table itself has zero rows, so there is no
  // revision marker to compare against. This must never be treated as a
  // silent permanent cache hit -- it should keep attempting a bounded
  // reload (harmless and cheap; it will keep resolving to []).
  const { calls } = makeFetchHarness({
    oddsPullConfigs: [],
    initialCacheRecord: makeCacheRecord(cacheKey, [], null),
  });
  await withSupabaseEnv(async () => {
    await withProviderCacheMemoScope(async () => {
      const result = await loadSharpPullConfigs({ enabledOnly: false });
      assert.deepEqual(result, []);
    });
    // Revision check (1) + full reload attempt (1) since no revision was
    // ever available to trust as a match.
    assert.equal(calls.filter((call) => call.path === "odds_pull_configs").length, 2);
  });
});

test("disabling a config row takes effect on the next load without any manual cache edit (the exact production defect this fix prevents)", async () => {
  const sourceRows = buildSourceRows(FIXTURE_REVISION);
  const target = sourceRows.find((row) => row.enabled) ?? sourceRows[0];
  const expectedBefore = normalizeSharpPullConfigs(sourceRows);
  const { calls } = makeFetchHarness({
    oddsPullConfigs: sourceRows,
    initialCacheRecord: makeCacheRecord(cacheKey, expectedBefore, FIXTURE_REVISION),
  });

  await withSupabaseEnv(async () => {
    await withProviderCacheMemoScope(async () => {
      const before = await loadSharpPullConfigs({ enabledOnly: true });
      assert.ok(before.some((row) => row.market_type === target.market_type && row.sportsbook === target.sportsbook));
    });

    // Simulate a production config write: the row's enabled flag flips and
    // its updated_at (the revision marker) advances -- no cache row is
    // touched, mirroring exactly how the real odds_pull_configs UPDATE works.
    target.enabled = false;
    (target as { updated_at: string }).updated_at = "2026-07-27T13:00:00.000Z";

    await withProviderCacheMemoScope(async () => {
      const after = await loadSharpPullConfigs({ enabledOnly: true });
      assert.equal(after.some((row) => row.market_type === target.market_type && row.sportsbook === target.sportsbook), false, "disabled config must disappear from the enabled-only plan on the very next load");
    });

    // Proves the reload actually happened (not a coincidental cache hit).
    assert.ok(calls.filter((call) => call.path === "odds_pull_configs").length >= 3);
  });
});

test("re-enabling a previously disabled config row takes effect on the next load", async () => {
  const sourceRows = buildSourceRows(FIXTURE_REVISION);
  const target = sourceRows.find((row) => !row.enabled);
  assert.ok(target, "fixture must include at least one disabled row");
  const expectedBefore = normalizeSharpPullConfigs(sourceRows);
  makeFetchHarness({
    oddsPullConfigs: sourceRows,
    initialCacheRecord: makeCacheRecord(cacheKey, expectedBefore, FIXTURE_REVISION),
  });

  await withSupabaseEnv(async () => {
    await withProviderCacheMemoScope(async () => {
      const before = await loadSharpPullConfigs({ enabledOnly: true });
      assert.equal(before.some((row) => row.market_type === target!.market_type && row.sportsbook === target!.sportsbook), false);
    });

    target!.enabled = true;
    (target as unknown as { updated_at: string }).updated_at = "2026-07-27T14:00:00.000Z";

    await withProviderCacheMemoScope(async () => {
      const after = await loadSharpPullConfigs({ enabledOnly: true });
      assert.ok(after.some((row) => row.market_type === target!.market_type && row.sportsbook === target!.sportsbook), "re-enabled config must reappear in the enabled-only plan on the very next load");
    });
  });
});

test("league isolation: a WNBA config change does not corrupt or omit MLB rows in the reloaded plan", async () => {
  const sourceRows = buildSourceRows(FIXTURE_REVISION);
  const wnbaRow = sourceRows.find((row) => row.league_id === "wnba" && row.enabled);
  assert.ok(wnbaRow);
  const expectedBefore = normalizeSharpPullConfigs(sourceRows);
  makeFetchHarness({
    oddsPullConfigs: sourceRows,
    initialCacheRecord: makeCacheRecord(cacheKey, expectedBefore, FIXTURE_REVISION),
  });

  await withSupabaseEnv(async () => {
    wnbaRow!.enabled = false;
    (wnbaRow as unknown as { updated_at: string }).updated_at = "2026-07-27T15:00:00.000Z";

    await withProviderCacheMemoScope(async () => {
      const mlb = await loadSharpPullConfigs({ league: "MLB", enabledOnly: true });
      assert.ok(mlb.length > 0, "MLB configs must be unaffected by a WNBA-only config change");
      assert.ok(mlb.every((row) => row.league_id === "mlb"));
    });
  });
});

test("stale cache flag forces a reload even when the revision still matches", async () => {
  const sourceRows = buildSourceRows(FIXTURE_REVISION);
  const expectedCanonical = normalizeSharpPullConfigs(sourceRows);
  const staleButMatchingRevision = { ...makeCacheRecord(cacheKey, expectedCanonical, FIXTURE_REVISION), is_stale: true };
  const { calls } = makeFetchHarness({
    oddsPullConfigs: sourceRows,
    initialCacheRecord: staleButMatchingRevision,
  });

  await withSupabaseEnv(async () => {
    await withProviderCacheMemoScope(async () => {
      const result = await loadSharpPullConfigs({ enabledOnly: false });
      assert.deepEqual(result, expectedCanonical);
    });
    // is_stale=true must force the full reload path (revision check + full config read)
    // even though source_updated_at matches -- is_stale remains an explicit override.
    assert.equal(calls.filter((call) => call.path === "odds_pull_configs").length, 2);
  });
});

test("the pull-config cache key is deterministic for a given seed version", () => {
  assert.equal(sharpPullConfigCacheKey(), sharpPullConfigCacheKey());
  assert.equal(sharpPullConfigCacheKey("2026-07-13a"), sharpPullConfigCacheKey("2026-07-13a"));
  assert.notEqual(sharpPullConfigCacheKey("2026-07-13a"), sharpPullConfigCacheKey("2026-08-01a"));
});

test("a cache entry stamped with a 365-day expiry does not lock in a stale config once the revision changes (the exact production defect)", async () => {
  const sourceRows = buildSourceRows(FIXTURE_REVISION);
  const target = sourceRows.find((row) => row.enabled) ?? sourceRows[0];
  const expectedBefore = normalizeSharpPullConfigs(sourceRows);
  // A cache record that looks exactly like the real long-lived (365-day) entry
  // this bug was found against: not stale, far-future expiry, matching the
  // OLD revision.
  const longLivedRecord = makeCacheRecord(cacheKey, expectedBefore, FIXTURE_REVISION);
  makeFetchHarness({ oddsPullConfigs: sourceRows, initialCacheRecord: longLivedRecord });

  await withSupabaseEnv(async () => {
    // A production config write happens: the row is disabled and its
    // updated_at advances. The cache row itself is never touched -- exactly
    // what happened in production before this fix.
    target.enabled = false;
    (target as unknown as { updated_at: string }).updated_at = "2026-07-27T16:00:00.000Z";

    await withProviderCacheMemoScope(async () => {
      const after = await loadSharpPullConfigs({ enabledOnly: true });
      assert.equal(
        after.some((row) => row.market_type === target.market_type && row.sportsbook === target.sportsbook),
        false,
        "the far-future expires_at must not override a genuinely changed config revision",
      );
    });
  });
});

test("provider isolation: another provider's config row change does not affect the sharpapi revision or plan", async () => {
  const sourceRows = buildSourceRows(FIXTURE_REVISION);
  const expectedCanonical = normalizeSharpPullConfigs(sourceRows);
  const otherProviderRow = { provider: "some-other-provider", sport_id: "baseball", league_id: "mlb", market_type: "player_hits", sportsbook: "DraftKings", priority: 1, pull_cadence_minutes: 1, enabled: true, metadata: {}, updated_at: FIXTURE_REVISION };
  const combinedRows = [...sourceRows, otherProviderRow];
  const { calls } = makeFetchHarness({
    oddsPullConfigs: combinedRows,
    initialCacheRecord: makeCacheRecord(cacheKey, expectedCanonical, FIXTURE_REVISION),
  });

  await withSupabaseEnv(async () => {
    await withProviderCacheMemoScope(async () => {
      const before = await loadSharpPullConfigs({ enabledOnly: false });
      assert.deepEqual(before, expectedCanonical);
    });

    // Simulate a write to the OTHER provider's row -- must not invalidate the
    // sharpapi-scoped cache, since the revision query filters provider=eq.sharpapi.
    otherProviderRow.updated_at = "2026-07-27T23:59:00.000Z";
    otherProviderRow.enabled = false;

    await withProviderCacheMemoScope(async () => {
      const after = await loadSharpPullConfigs({ enabledOnly: false });
      assert.deepEqual(after, expectedCanonical, "sharpapi plan must be unaffected by another provider's config change");
    });

    // Both calls should have been genuine hits (2 revision-check reads, no reload)
    // since the sharpapi-scoped revision never actually changed.
    assert.equal(calls.filter((call) => call.path === "odds_pull_configs").length, 2);
  });
});
