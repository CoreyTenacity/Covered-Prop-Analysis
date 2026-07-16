import { getProviderCache, putProviderCache } from "@/lib/db/provider-cache";
import { insertRows, selectRows, updateRows } from "@/lib/db/supabase-server";
import type { CanonicalLeagueRow, CanonicalSportRow, KnowledgeLeagueCode, OddsPullConfigRow } from "@/lib/knowledge/types";
import { listPullStrategies } from "@/lib/knowledge/pull-strategy";

const sports: CanonicalSportRow[] = [
  { id: "baseball", code: "BASEBALL", name: "Baseball" },
  { id: "basketball", code: "BASKETBALL", name: "Basketball" },
  { id: "football", code: "FOOTBALL", name: "Football" },
  { id: "tennis", code: "TENNIS", name: "Tennis" },
];

const leagues: CanonicalLeagueRow[] = [
  { id: "mlb", sport_id: "baseball", code: "MLB", name: "Major League Baseball", level: "pro", active: true },
  { id: "nba", sport_id: "basketball", code: "NBA", name: "National Basketball Association", level: "pro", active: true },
  { id: "wnba", sport_id: "basketball", code: "WNBA", name: "Women's National Basketball Association", level: "pro", active: true },
  { id: "nfl", sport_id: "football", code: "NFL", name: "National Football League", level: "pro", active: false },
  { id: "tennis", sport_id: "tennis", code: "TENNIS", name: "Tennis", level: "pro", active: false },
];

export const marketLabels: Record<string, string> = {
  player_points: "Points",
  player_rebounds: "Rebounds",
  player_assists: "Assists",
  player_pra: "Points + Rebounds + Assists",
  player_points_rebounds: "Points + Rebounds",
  player_points_assists: "Points + Assists",
  player_rebounds_assists: "Rebounds + Assists",
  player_points_rebounds_assists: "Points + Rebounds + Assists",
  player_threes: "Three-Pointers Made",
  batter_hits: "Hits",
  batter_total_bases: "Total Bases",
  batter_runs: "Runs",
  batter_rbis: "RBIs",
  batter_home_runs: "Home Runs",
  batter_walks: "Walks",
  batter_stolen_bases: "Stolen Bases",
  batter_hits_runs_rbis: "Hits + Runs + RBIs",
  pitcher_strikeouts: "Pitcher Strikeouts",
  pitcher_earned_runs: "Earned Runs Allowed",
  pitcher_hits_allowed: "Hits Allowed",
  pitcher_walks_allowed: "Walks Allowed",
  pitcher_outs_recorded: "Outs Recorded",
};

export const CATALOG_SEED_VERSION = "2026-07-13a";
const CATALOG_SEED_CACHE_KEY = "knowledge-catalog:seed-version:latest";
const CATALOG_MAX_WRITE_ROWS = 128;

export type CatalogSeedOptions = {
  forceReconcile?: boolean;
};

type CatalogSportsbookRow = {
  id?: string;
  code: string;
  display_name: string;
  provider: string;
  metadata: Record<string, unknown>;
};

type CatalogMarketRow = {
  id?: string;
  sport_id: string;
  league_id: string;
  market_type: string;
  display_name: string;
  category: string;
  player_scope: string;
  stat_family: string;
  is_combo: boolean;
  metadata: Record<string, unknown>;
};

type CatalogSeedState = {
  version: string;
  seededAt: string;
  counts: {
    sports: number;
    leagues: number;
    sportsbooks: number;
    markets: number;
    pullConfigs: number;
  };
};

type RowPlan<T> = {
  insertRows: T[];
  updateRows: Array<{ id: string; row: T }>;
  skipped: number;
};

type CatalogSeedPlan = {
  sports: RowPlan<CanonicalSportRow>;
  leagues: RowPlan<CanonicalLeagueRow>;
  sportsbooks: RowPlan<CatalogSportsbookRow>;
  markets: RowPlan<CatalogMarketRow>;
  pullConfigs: RowPlan<OddsPullConfigRow>;
  modelVersionMissing: boolean;
  totalWrites: number;
};

export function validateCatalogSeedPlan(plan: CatalogSeedPlan) {
  if (plan.totalWrites > CATALOG_MAX_WRITE_ROWS) {
    throw new Error(`Catalog seed would write ${plan.totalWrites} rows, exceeding the emergency cap of ${CATALOG_MAX_WRITE_ROWS}.`);
  }
}

function rowValue(row: Record<string, unknown>, key: string) {
  const value = row[key];
  return value === undefined ? null : value;
}

function comparableValue(value: unknown) {
  if (value === null || value === undefined) return null;
  return typeof value === "object" ? JSON.stringify(value) : value;
}

function rowsEqual(left: Record<string, unknown>, right: Record<string, unknown>, keys: string[]) {
  return keys.every((key) => comparableValue(rowValue(left, key)) === comparableValue(rowValue(right, key)));
}

function rowKey(row: Record<string, unknown>, keys: string[]) {
  return keys.map((key) => String(rowValue(row, key) ?? "")).join("|");
}

function uniqueDesiredRows<T extends Record<string, unknown>>(rows: T[], keys: string[]) {
  return [...new Map(rows.map((row) => [rowKey(row, keys), row] as const)).values()];
}

function planTableRows<T extends Record<string, unknown>>(desiredRows: T[], existingRows: Array<T & { id?: string }>, keys: string[], compareKeys: string[]): RowPlan<T> {
  const existingByKey = new Map(existingRows.map((row) => [rowKey(row, keys), row] as const));
  const insertRows: T[] = [];
  const updateRows: Array<{ id: string; row: T }> = [];
  let skipped = 0;

  for (const row of uniqueDesiredRows(desiredRows, keys)) {
    const existing = existingByKey.get(rowKey(row, keys));
    if (!existing) {
      insertRows.push(row);
      continue;
    }
    if (rowsEqual(existing, row, compareKeys)) {
      skipped += 1;
      continue;
    }
    if (!existing.id) {
      insertRows.push(row);
      continue;
    }
    updateRows.push({ id: existing.id, row });
  }

  return { insertRows, updateRows, skipped };
}

export function buildCatalogSeedPlan(existing: {
  sports: Array<CanonicalSportRow>;
  leagues: Array<CanonicalLeagueRow>;
  sportsbooks: Array<CatalogSportsbookRow>;
  markets: Array<CatalogMarketRow>;
  pullConfigs: Array<OddsPullConfigRow>;
  modelVersionExists: boolean;
}): CatalogSeedPlan {
  const strategies = listPullStrategies("sharpapi");
  const sportsbookRows: CatalogSportsbookRow[] = [...new Set(strategies.map((row) => row.sportsbook).filter(Boolean))].map((sportsbook) => ({
    code: sportsbook!.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    display_name: sportsbook!,
    provider: "sharpapi",
    metadata: {},
  }));

  const marketRows: CatalogMarketRow[] = Object.keys(
    strategies.reduce<Record<string, true>>((accumulator, row) => {
      accumulator[`${row.league}:${row.marketType}`] = true;
      return accumulator;
    }, {}),
  ).map((key) => {
    const [league, marketType] = key.split(":");
    return {
      sport_id: sportIdForLeague(league as KnowledgeLeagueCode),
      league_id: league.toLowerCase(),
      market_type: marketType,
      display_name: marketLabels[marketType] ?? marketType.replaceAll("_", " "),
      category: categoryForLeague(league as KnowledgeLeagueCode),
      player_scope: marketType.startsWith("pitcher_") ? "pitcher" : marketType.startsWith("batter_") ? "batter" : "player",
      stat_family: statFamily(marketType),
      is_combo: marketType.split("_").filter((part) => ["points", "rebounds", "assists", "hits", "runs", "rbis", "bases"].includes(part)).length > 1,
      metadata: {
        provider: "sharpapi",
      },
    } satisfies CatalogMarketRow;
  });

  const pullConfigRows: OddsPullConfigRow[] = strategies.map((strategy) => ({
    provider: strategy.provider,
    sport_id: strategy.sport.toLowerCase(),
    league_id: strategy.league.toLowerCase(),
    market_type: strategy.marketType,
    sportsbook: strategy.sportsbook,
    priority: strategy.priority,
    pull_cadence_minutes: strategy.pullCadenceMinutes,
    enabled: strategy.enabled,
    metadata: strategy.metadata ?? {},
  }));

  const sportsPlan = planTableRows(sports, existing.sports, ["code"], ["code", "name"]);
  const leaguesPlan = planTableRows(leagues, existing.leagues, ["code"], ["sport_id", "code", "name", "level", "active"]);
  const sportsbooksPlan = planTableRows(sportsbookRows, existing.sportsbooks, ["code"], ["code", "display_name", "provider", "metadata"]);
  const marketsPlan = planTableRows(marketRows, existing.markets, ["league_id", "market_type"], ["sport_id", "league_id", "market_type", "display_name", "category", "player_scope", "stat_family", "is_combo", "metadata"]);
  const pullConfigsPlan = planTableRows(pullConfigRows, existing.pullConfigs, ["provider", "league_id", "market_type", "sportsbook"], ["provider", "sport_id", "league_id", "market_type", "sportsbook", "priority", "pull_cadence_minutes", "enabled", "metadata"]);

  const totalWrites = sportsPlan.insertRows.length + sportsPlan.updateRows.length
    + leaguesPlan.insertRows.length + leaguesPlan.updateRows.length
    + sportsbooksPlan.insertRows.length + sportsbooksPlan.updateRows.length
    + marketsPlan.insertRows.length + marketsPlan.updateRows.length
    + pullConfigsPlan.insertRows.length + pullConfigsPlan.updateRows.length
    + (existing.modelVersionExists ? 0 : 1);

  return {
    sports: sportsPlan,
    leagues: leaguesPlan,
    sportsbooks: sportsbooksPlan,
    markets: marketsPlan,
    pullConfigs: pullConfigsPlan,
    modelVersionMissing: !existing.modelVersionExists,
    totalWrites,
  };
}

async function applyRowPlan<T extends Record<string, unknown>>(
  table: string,
  plan: RowPlan<T>,
  filtersForId: (id: string) => Array<{ column: string; value: string }>,
) {
  if (plan.insertRows.length) {
    await insertRows(table, plan.insertRows as Array<Record<string, unknown>>, { returning: "minimal" });
  }
  for (const update of plan.updateRows) {
    await updateRows(table, filtersForId(update.id), update.row as Record<string, unknown>, { returning: "minimal" });
  }
}

function sportIdForLeague(league: KnowledgeLeagueCode) {
  if (league === "MLB") return "baseball";
  if (league === "NFL") return "football";
  if (league === "TENNIS") return "tennis";
  return "basketball";
}

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

function categoryForLeague(league: KnowledgeLeagueCode) {
  if (league === "MLB") return "baseball";
  if (league === "NFL") return "football";
  if (league === "TENNIS") return "tennis";
  return "basketball";
}

export async function seedKnowledgeCatalog(options: CatalogSeedOptions = {}) {
  if (!options.forceReconcile) {
    const cached = await getProviderCache<CatalogSeedState>(CATALOG_SEED_CACHE_KEY);
    if (cached?.payload?.version === CATALOG_SEED_VERSION && !cached.is_stale && new Date(cached.expires_at).getTime() > Date.now()) {
      return;
    }
  }

  const strategies = listPullStrategies("sharpapi");
  const sportsbookCodes = [...new Set(strategies.map((row) => row.sportsbook).filter(Boolean))].map((sportsbook) => sportsbook!.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
  const leagueCodes = [...new Set(strategies.map((row) => row.league.toLowerCase()))];

  const [existingSports, existingLeagues, existingSportsbooks, existingMarkets, existingPullConfigs, existingModelVersion] = await Promise.all([
    selectRows<CanonicalSportRow>("sports", {
      select: "id,code,name",
      filters: [{ column: "code", operator: "in", value: sports.map((row) => row.code) }],
    }),
    selectRows<CanonicalLeagueRow>("leagues", {
      select: "id,code,sport_id,name,level,active",
      filters: [{ column: "code", operator: "in", value: leagues.map((row) => row.code) }],
    }),
    selectRows<CatalogSportsbookRow>("sportsbooks", {
      select: "id,code,display_name,provider,metadata",
      filters: [{ column: "code", operator: "in", value: sportsbookCodes }],
    }),
    selectRows<CatalogMarketRow>("markets", {
      select: "id,sport_id,league_id,market_type,display_name,category,player_scope,stat_family,is_combo,metadata",
      filters: [{ column: "league_id", operator: "in", value: leagueCodes }],
    }),
    selectRows<OddsPullConfigRow>("odds_pull_configs", { select: "id,provider,sport_id,league_id,market_type,sportsbook,priority,pull_cadence_minutes,enabled,metadata", filters: [{ column: "provider", value: "sharpapi" }] }),
    selectRows<{ id: string }>("model_versions", { select: "id", filters: [{ column: "name", value: "covered-knowledge-foundation" }], limit: 1 }),
  ]);

  const plan = buildCatalogSeedPlan({
    sports: existingSports,
    leagues: existingLeagues,
    sportsbooks: existingSportsbooks,
    markets: existingMarkets,
    pullConfigs: existingPullConfigs,
    modelVersionExists: Boolean(existingModelVersion[0]?.id),
  });

  validateCatalogSeedPlan(plan);

  await applyRowPlan("sports", plan.sports, (id) => [{ column: "id", value: id }]);
  await applyRowPlan("leagues", plan.leagues, (id) => [{ column: "id", value: id }]);
  await applyRowPlan("sportsbooks", plan.sportsbooks, (id) => [{ column: "id", value: id }]);
  await applyRowPlan("markets", plan.markets, (id) => [{ column: "id", value: id }]);
  await applyRowPlan("odds_pull_configs", plan.pullConfigs, (id) => [{ column: "id", value: id }]);

  if (plan.modelVersionMissing) {
    await insertRows("model_versions", [{
      name: "covered-knowledge-foundation",
      version: "2026-07-06a",
      description: "Universal event/participant knowledge foundation that scores stored props from stored features only.",
      active: true,
      ruleset: {
        source: "stored-knowledge-only",
        active_leagues: ["MLB", "NBA", "WNBA"],
        future_ready: ["NFL", "TENNIS"],
      },
    }], { returning: "minimal" });
  }

  const sentinelWriteSucceeded = await putProviderCache({
    cacheKey: CATALOG_SEED_CACHE_KEY,
    provider: "sharpapi",
    payload: {
      version: CATALOG_SEED_VERSION,
      seededAt: new Date().toISOString(),
      counts: {
        sports: sports.length,
        leagues: leagues.length,
        sportsbooks: sportsbookCodes.length,
        markets: Object.keys(strategies.reduce<Record<string, true>>((accumulator, row) => {
          accumulator[`${row.league}:${row.marketType}`] = true;
          return accumulator;
        }, {})).length,
        pullConfigs: strategies.length,
      },
    },
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (!sentinelWriteSucceeded) {
    throw new Error("Catalog seed sentinel write failed.");
  }
}

export async function reconcileKnowledgeCatalog() {
  await seedKnowledgeCatalog({ forceReconcile: true });
}
