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

function buildSourceRows() {
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
  } satisfies OddsPullConfigRow));
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

function makeCacheRecord(cacheKey: string, payload: unknown) {
  return {
    cache_key: cacheKey,
    provider: "sharpapi",
    payload,
    fetched_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    source_updated_at: null,
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
      return new Response(JSON.stringify(options.oddsPullConfigs), {
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
    cacheStore.set(cacheKey, makeCacheRecord(cacheKey, expectedCanonical));
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
    assert.equal(calls.filter((call) => call.path === "odds_pull_configs").length, 0);
    assert.deepEqual(cacheStore.get(cacheKey)?.payload, expectedCanonical);
  });
});

test("a legacy cache entry is ignored and rewritten under the versioned key", async () => {
  const sourceRows = buildSourceRows();
  const expectedCanonical = normalizeSharpPullConfigs(sourceRows);
  const { calls, cacheStore } = makeFetchHarness({
    oddsPullConfigs: sourceRows,
    initialCacheRecord: makeCacheRecord(legacyCacheKey, expectedCanonical),
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
    assert.equal(calls.filter((call) => call.path === "odds_pull_configs").length, 1);
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
    initialCacheRecord: makeCacheRecord(cacheKey, expectedCanonical),
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
    assert.equal(calls.filter((call) => call.path === "odds_pull_configs").length, 0);
    assert.deepEqual(cacheStore.get(cacheKey)?.payload, expectedCanonical);
  });
});

test("a cached canonical empty array is a hit under the versioned key", async () => {
  const { calls, cacheStore } = makeFetchHarness({
    oddsPullConfigs: [],
    initialCacheRecord: makeCacheRecord(cacheKey, []),
  });
  await withSupabaseEnv(async () => {
    await withProviderCacheMemoScope(async () => {
      const first = await loadSharpPullConfigs({ enabledOnly: false });
      const second = await loadSharpPullConfigs({ enabledOnly: true });

      assert.deepEqual(first, []);
      assert.deepEqual(second, []);
    });

    assert.deepEqual(
      calls.filter((call) => call.path === "provider_cache" && call.method === "GET").map((call) => call.cacheKey),
      [cacheKey],
    );
    assert.equal(calls.filter((call) => call.path === "odds_pull_configs").length, 0);
    assert.deepEqual(cacheStore.get(cacheKey)?.payload, []);
  });
});
