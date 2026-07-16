import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { CanonicalLeagueRow, CanonicalSportRow } from "./types.ts";
import {
  CATALOG_SEED_VERSION,
  buildCatalogSeedPlan,
  marketLabels,
  reconcileKnowledgeCatalog,
  seedKnowledgeCatalog,
  validateCatalogSeedPlan,
} from "./catalog.ts";
import { listPullStrategies } from "./pull-strategy.ts";

function statFamily(marketType: string) {
  if (marketType.includes("points")) return "points";
  if (marketType.includes("rebounds")) return "rebounds";
  if (marketType.includes("assists")) return "assists";
  if (marketType === "player_pra") return "pra";
  if (marketType.includes("hits")) return "hits";
  if (marketType.includes("strikeouts")) return "strikeouts";
  if (marketType.includes("bases")) return "total_bases";
  return marketType;
}

function isCombo(marketType: string) {
  return marketType.split("_").filter((part) => ["points", "rebounds", "assists", "hits", "runs", "rbis", "bases"].includes(part)).length > 1;
}

function buildNoOpExistingCatalog() {
  const strategies = listPullStrategies("sharpapi");
  const sports = [
    { id: "baseball", code: "BASEBALL", name: "Baseball" },
    { id: "basketball", code: "BASKETBALL", name: "Basketball" },
    { id: "football", code: "FOOTBALL", name: "Football" },
    { id: "tennis", code: "TENNIS", name: "Tennis" },
  ] satisfies CanonicalSportRow[];
  const leagues = [
    { id: "mlb", sport_id: "baseball", code: "MLB", name: "Major League Baseball", level: "pro", active: true },
    { id: "nba", sport_id: "basketball", code: "NBA", name: "National Basketball Association", level: "pro", active: true },
    { id: "wnba", sport_id: "basketball", code: "WNBA", name: "Women's National Basketball Association", level: "pro", active: true },
    { id: "nfl", sport_id: "football", code: "NFL", name: "National Football League", level: "pro", active: false },
    { id: "tennis", sport_id: "tennis", code: "TENNIS", name: "Tennis", level: "pro", active: false },
  ] satisfies CanonicalLeagueRow[];
  const sportsbooks = [...new Set(strategies.map((row) => row.sportsbook).filter(Boolean))].map((sportsbook) => ({
    id: sportsbook!.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    code: sportsbook!.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    display_name: sportsbook!,
    provider: "sharpapi",
    metadata: {},
  }));
  const markets = [...new Map(strategies.map((row) => {
    const market = {
      id: `${row.league.toLowerCase()}:${row.marketType}`,
      sport_id: row.sport.toLowerCase() === "baseball" ? "baseball" : "basketball",
      league_id: row.league.toLowerCase(),
      market_type: row.marketType,
      display_name: marketLabels[row.marketType] ?? row.marketType.replaceAll("_", " "),
      category: row.league === "MLB" ? "baseball" : "basketball",
      player_scope: row.marketType.startsWith("pitcher_") ? "pitcher" : row.marketType.startsWith("batter_") ? "batter" : "player",
      stat_family: statFamily(row.marketType),
      is_combo: isCombo(row.marketType),
      metadata: { provider: "sharpapi" },
    };
    return [market.id, market] as const;
  })).values()];
  const pullConfigs = strategies.map((row) => ({
    id: `${row.provider}:${row.league}:${row.marketType}:${row.sportsbook ?? "all"}`,
    provider: row.provider,
    sport_id: row.sport.toLowerCase(),
    league_id: row.league.toLowerCase(),
    market_type: row.marketType,
    sportsbook: row.sportsbook,
    priority: row.priority,
    pull_cadence_minutes: row.pullCadenceMinutes,
    enabled: row.enabled,
    metadata: row.metadata ?? {},
  }));
  return { sports, leagues, sportsbooks, markets, pullConfigs };
}

function makeCatalogFetchHarness(existing: ReturnType<typeof buildNoOpExistingCatalog> & { modelVersionExists: boolean }, options: {
  sentinelFresh?: boolean;
  failOnTableWrite?: string | null;
  failOnSentinelWrite?: boolean;
} = {}) {
  const calls: Array<{ method: string; table: string }> = [];
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = new URL(String(input));
    const path = url.pathname.split("/rest/v1/").pop() ?? url.pathname;
    const table = path.split("?")[0];
    calls.push({ method, table });

    if (table === "provider_cache") {
      if (method === "GET") {
        const cacheKey = url.searchParams.get("cache_key")?.replace(/^eq\./, "") ?? "";
        if (cacheKey === "knowledge-catalog:seed-version:latest" && options.sentinelFresh !== false) {
          return new Response(JSON.stringify([{
            cache_key: cacheKey,
            provider: "sharpapi",
            payload: {
              version: CATALOG_SEED_VERSION,
              seededAt: new Date().toISOString(),
              counts: {
                sports: existing.sports.length,
                leagues: existing.leagues.length,
                sportsbooks: existing.sportsbooks.length,
                markets: existing.markets.length,
                pullConfigs: existing.pullConfigs.length,
              },
            },
            fetched_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
            source_updated_at: null,
            is_stale: false,
          }]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (options.failOnSentinelWrite && body.cache_key === "knowledge-catalog:seed-version:latest") {
          return new Response(JSON.stringify({ error: "sentinel write failed" }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
        return new Response(null, { status: 204 });
      }
    }

    if (method === "GET") {
      if (table === "sports") {
        return new Response(JSON.stringify(existing.sports), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (table === "leagues") {
        return new Response(JSON.stringify(existing.leagues), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (table === "sportsbooks") {
        return new Response(JSON.stringify(existing.sportsbooks), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (table === "markets") {
        return new Response(JSON.stringify(existing.markets), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (table === "odds_pull_configs") {
        return new Response(JSON.stringify(existing.pullConfigs), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (table === "model_versions") {
        return new Response(JSON.stringify(existing.modelVersionExists ? [{ id: "model-version-1" }] : []), { status: 200, headers: { "Content-Type": "application/json" } });
      }
    }

    if (method === "POST" || method === "PATCH") {
      if (options.failOnTableWrite && table === options.failOnTableWrite) {
        return new Response(JSON.stringify({ error: `${table} write failed` }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    }

    return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return { calls };
}

function withCatalogEnv(run: () => Promise<void>) {
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

test("catalog seed is a no-op when existing rows already match", () => {
  const existing = buildNoOpExistingCatalog();
  const plan = buildCatalogSeedPlan({
    sports: existing.sports,
    leagues: existing.leagues,
    sportsbooks: existing.sportsbooks,
    markets: existing.markets,
    pullConfigs: existing.pullConfigs,
    modelVersionExists: true,
  });

  assert.equal(plan.totalWrites, 0);
  assert.equal(plan.sports.insertRows.length, 0);
  assert.equal(plan.sports.updateRows.length, 0);
  assert.equal(plan.leagues.insertRows.length, 0);
  assert.equal(plan.leagues.updateRows.length, 0);
  assert.equal(plan.sportsbooks.insertRows.length, 0);
  assert.equal(plan.markets.insertRows.length, 0);
  assert.equal(plan.pullConfigs.insertRows.length, 0);
});

test("catalog seed detects changed rows and validates the emergency cap", () => {
  const existing = buildNoOpExistingCatalog();
  const alteredLeagues = existing.leagues.map((row) =>
    row.code === "MLB" ? { ...row, name: "Major League Baseball Updated" } : row,
  );
  const plan = buildCatalogSeedPlan({
    sports: existing.sports,
    leagues: alteredLeagues,
    sportsbooks: existing.sportsbooks,
    markets: existing.markets,
    pullConfigs: existing.pullConfigs,
    modelVersionExists: true,
  });

  assert.equal(plan.leagues.updateRows.length, 1);
  assert.equal(plan.totalWrites, 1);
  assert.throws(() => validateCatalogSeedPlan({ ...plan, totalWrites: 129 }), /emergency cap/i);
});

test("a fresh catalog sentinel skips routine catalog reads and writes", async () => {
  const existing = { ...buildNoOpExistingCatalog(), modelVersionExists: true };
  const { calls } = makeCatalogFetchHarness(existing);

  await withCatalogEnv(async () => {
    await seedKnowledgeCatalog();
    assert.deepEqual(calls, [{ method: "GET", table: "provider_cache" }]);
  });
});

test("the explicit integrity path bypasses the sentinel and performs one bounded reconciliation", async () => {
  const existing = {
    ...buildNoOpExistingCatalog(),
    modelVersionExists: true,
    leagues: buildNoOpExistingCatalog().leagues.map((row) =>
      row.code === "MLB" ? { ...row, name: "Major League Baseball Updated" } : row,
    ),
  };
  const { calls } = makeCatalogFetchHarness(existing);

  await withCatalogEnv(async () => {
    await reconcileKnowledgeCatalog();
    assert.ok(calls.some((call) => call.table === "sports"));
    assert.ok(calls.some((call) => call.table === "leagues"));
    assert.ok(calls.some((call) => call.method === "PATCH" && call.table === "leagues"));
    assert.ok(!calls.some((call) => call.method === "GET" && call.table === "provider_cache"));
    assert.ok(calls.filter((call) => call.method === "POST" && call.table === "provider_cache").length >= 1);
  });
});

test("a failed required catalog write prevents sentinel persistence", async () => {
  const existing = {
    ...buildNoOpExistingCatalog(),
    modelVersionExists: true,
    leagues: buildNoOpExistingCatalog().leagues.map((row) =>
      row.code === "MLB" ? { ...row, name: "Major League Baseball Updated" } : row,
    ),
  };
  const { calls } = makeCatalogFetchHarness(existing, { failOnTableWrite: "leagues" });

  await withCatalogEnv(async () => {
    await assert.rejects(() => reconcileKnowledgeCatalog(), /leagues write failed|failed/i);
    assert.ok(!calls.some((call) => call.method === "POST" && call.table === "provider_cache"));
  });
});

test("a failed sentinel write is surfaced as a failed seed operation", async () => {
  const existing = { ...buildNoOpExistingCatalog(), modelVersionExists: true };
  const { calls } = makeCatalogFetchHarness(existing, { failOnSentinelWrite: true });

  await withCatalogEnv(async () => {
    await assert.rejects(() => reconcileKnowledgeCatalog(), /sentinel write failed/i);
    assert.ok(calls.some((call) => call.method === "POST" && call.table === "provider_cache"));
  });
});
