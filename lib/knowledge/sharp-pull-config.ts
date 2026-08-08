import { getProviderCache, putProviderCache } from "@/lib/db/provider-cache";
import { CATALOG_SEED_VERSION, seedKnowledgeCatalog } from "@/lib/knowledge/catalog";
import { listPullStrategies } from "@/lib/knowledge/pull-strategy";
import type { ActiveKnowledgeLeagueCode, KnowledgeSportCode, OddsPullConfigRow } from "@/lib/knowledge/types";
import { selectRows } from "@/lib/db/supabase-server";

export type SharpPullConfigFilters = {
  sport?: string | null;
  league?: string | null;
  sportsbook?: string | null;
  marketType?: string | null;
  enabledOnly?: boolean;
};

export type SharpPullConfig = OddsPullConfigRow & {
  providerMarketType: string;
  tier: "core" | "secondary";
};

export const SHARP_PULL_CONFIG_CACHE_NAMESPACE = "v2";

export function sharpPullConfigCacheKey(seedVersion = CATALOG_SEED_VERSION) {
  return `sharpapi:pull-configs:${SHARP_PULL_CONFIG_CACHE_NAMESPACE}:${seedVersion}`;
}

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function normalizeRotationScope(value: string | null | undefined) {
  return normalize(value) || "all";
}

function asTier(value: unknown): "core" | "secondary" {
  return value === "secondary" ? "secondary" : "core";
}

function normalizeMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizeMetadata(entry));
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>)
    .sort((left, right) => left.localeCompare(right))
    .reduce<Record<string, unknown>>((accumulator, key) => {
      accumulator[key] = normalizeMetadata((value as Record<string, unknown>)[key]);
      return accumulator;
    }, {});
}

function fallbackStrategy(row: OddsPullConfigRow) {
  const normalizedLeague = normalize(row.league_id);
  const normalizedMarket = normalize(row.market_type);
  const normalizedSportsbook = normalize(row.sportsbook);
  return listPullStrategies("sharpapi").find((strategy) =>
    normalize(strategy.league) === normalizedLeague
    && normalize(strategy.marketType) === normalizedMarket
    && normalize(strategy.sportsbook) === normalizedSportsbook,
  ) ?? listPullStrategies("sharpapi").find((strategy) =>
    normalize(strategy.league) === normalizedLeague
    && normalize(strategy.marketType) === normalizedMarket,
  ) ?? null;
}

function toSharpConfig(row: OddsPullConfigRow) {
  const strategy = fallbackStrategy(row);
  const metadata = {
    ...(strategy?.metadata ?? {}),
    ...(row.metadata ?? {}),
  };
  return {
    ...row,
    metadata: normalizeMetadata(metadata) as Record<string, unknown>,
    providerMarketType:
      typeof metadata.providerMarketType === "string" && metadata.providerMarketType.trim()
        ? metadata.providerMarketType
        : row.market_type,
    tier: asTier(metadata.tier),
  } satisfies SharpPullConfig;
}

function compareSharpPullConfigs(left: SharpPullConfig, right: SharpPullConfig) {
  return left.priority - right.priority
    || left.league_id.localeCompare(right.league_id)
    || left.market_type.localeCompare(right.market_type)
    || normalize(left.sportsbook).localeCompare(normalize(right.sportsbook))
    || left.providerMarketType.localeCompare(right.providerMarketType)
    || left.provider.localeCompare(right.provider)
    || left.tier.localeCompare(right.tier);
}

export function filterSharpPullConfigs(configs: SharpPullConfig[], filters: SharpPullConfigFilters = {}) {
  return configs.filter((config) => matchesSharpPullConfig(config, filters));
}

export function normalizeSharpPullConfigs(rows: OddsPullConfigRow[]) {
  return rows
    .map(toSharpConfig)
    .sort(compareSharpPullConfigs);
}

function sharpPullConfigIdentity(config: SharpPullConfig) {
  return [
    normalize(config.provider),
    normalize(config.sport_id),
    normalize(config.league_id),
    normalize(config.market_type),
    normalizeRotationScope(config.sportsbook),
    normalize(config.providerMarketType),
    String(config.priority),
    normalize(config.tier),
    config.enabled ? "enabled" : "disabled",
  ].join("|");
}

function fingerprint(value: string) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function sharpPullConfigRotationKey(filters: SharpPullConfigFilters, configs: SharpPullConfig[]) {
  const filterScope = [
    normalizeRotationScope(filters.sport),
    normalizeRotationScope(filters.league),
    normalizeRotationScope(filters.sportsbook),
    normalizeRotationScope(filters.marketType),
  ].join(":");
  const configScope = configs
    .map(sharpPullConfigIdentity)
    .sort((left, right) => left.localeCompare(right))
    .join(";");
  return `sharpapi:rotation:${filterScope}:set:${fingerprint(configScope)}`;
}

function matchesSharpPullConfig(config: SharpPullConfig, filters: SharpPullConfigFilters) {
  if (filters.enabledOnly !== false && !config.enabled) return false;
  if (filters.sport && normalize(config.sport_id) !== normalize(filters.sport)) return false;
  if (filters.league && normalize(config.league_id) !== normalize(filters.league)) return false;
  if (filters.sportsbook && normalize(config.sportsbook) !== normalize(filters.sportsbook)) return false;
  if (filters.marketType && normalize(config.market_type) !== normalize(filters.marketType)) return false;
  return true;
}

// A single cheap, bounded lookup (ORDER BY updated_at DESC LIMIT 1 -- the same
// pattern already used elsewhere in this codebase, e.g. refreshMlbPlayerLogs's
// latest-game-log check) for the most recent write timestamp across every
// sharpapi odds_pull_configs row. Used as a revision marker so a routine
// enable/disable edit to the config table is detected automatically on the
// next load, instead of requiring a human to remember to flip the cache's
// `is_stale` flag by hand -- that manual step was proven live to be missed:
// a production config disable sat unenforced for over an hour, spending real
// Sharp physical requests on markets that were supposed to be off, because
// nothing re-derived staleness from the config table itself. Returns null
// (never blocks the caller) if the table is empty or the read fails; a null
// revision always fails the equality check below, which fails safe toward a
// fresh reload rather than toward silently trusting a stale cache.
async function loadSharpPullConfigsRevision(): Promise<string | null> {
  const rows = await selectRows<{ updated_at: string | null }>("odds_pull_configs", {
    select: "updated_at",
    filters: [{ column: "provider", value: "sharpapi" }],
    orderBy: "updated_at.desc",
    limit: 1,
  }).catch(() => []);
  return rows[0]?.updated_at ?? null;
}

export async function loadSharpPullConfigs(filters: SharpPullConfigFilters = {}): Promise<SharpPullConfig[]> {
  const cacheKey = sharpPullConfigCacheKey();
  const [cached, currentRevision] = await Promise.all([
    getProviderCache<SharpPullConfig[]>(cacheKey),
    loadSharpPullConfigsRevision(),
  ]);
  const cacheMatchesCurrentRevision = currentRevision !== null && cached?.source_updated_at === currentRevision;
  if (
    Array.isArray(cached?.payload)
    && !cached.is_stale
    && new Date(cached.expires_at).getTime() > Date.now()
    && cacheMatchesCurrentRevision
  ) {
    return filterSharpPullConfigs(cached.payload, filters);
  }

  await seedKnowledgeCatalog();
  const rows = await selectRows<OddsPullConfigRow>("odds_pull_configs", {
    select: "provider,sport_id,league_id,market_type,sportsbook,priority,pull_cadence_minutes,enabled,metadata",
    filters: [{ column: "provider", value: "sharpapi" }],
    orderBy: "priority.asc",
  }).catch(() => null);

  const sourceRows = rows ?? listPullStrategies("sharpapi").map((row) => ({
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
  const configs = normalizeSharpPullConfigs(sourceRows);
  // Only stamp the revision fetched at the top of this call when the DB read
  // that produced `configs` actually succeeded (`rows` non-null). If it fell
  // back to the code-side strategy list (DB read failed), storing a real
  // revision here would let a later successful DB read be skipped as a false
  // cache hit -- so the fallback path stores null instead, which always
  // fails the equality check above and forces a fresh reload attempt on the
  // next call rather than pinning a long-lived cache entry to a revision
  // nobody actually confirmed against.
  const revisionForWrite = rows ? currentRevision : null;
  await putProviderCache({
    cacheKey,
    provider: "sharpapi",
    payload: configs,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    sourceUpdatedAt: revisionForWrite,
  });

  return filterSharpPullConfigs(configs, filters);
}

export function sharpLeagueCode(leagueId: string): ActiveKnowledgeLeagueCode {
  const normalized = normalize(leagueId);
  if (normalized === "mlb") return "MLB";
  if (normalized === "wnba") return "WNBA";
  return "NBA";
}

export function sharpSportCode(leagueId: string): KnowledgeSportCode {
  return sharpLeagueCode(leagueId) === "MLB" ? "BASEBALL" : "BASKETBALL";
}

export function sharpMinuteRequestLimit() {
  const parsed = Number(process.env.SHARPAPI_MAX_REQUESTS_PER_MINUTE ?? process.env.SHARPAPI_REQUESTS_PER_REFRESH ?? "8");
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(10, Math.floor(parsed)) : 8;
}

export function sharpRequestSpacingMs() {
  const parsed = Number(process.env.SHARPAPI_REQUEST_SPACING_MS ?? "6500");
  return Number.isFinite(parsed) && parsed >= 0 ? Math.max(0, Math.floor(parsed)) : 6500;
}

export function cadenceCacheKey(config: Pick<SharpPullConfig, "league_id" | "sportsbook" | "market_type">, suffix = "latest") {
  return [
    "sharpapi",
    "cadence",
    config.league_id,
    normalize(config.sportsbook) || "all",
    config.market_type,
    suffix,
  ].join(":");
}

export async function pullDue(config: SharpPullConfig, now = new Date()) {
  const cached = await getProviderCache<{ lastPulledAt: string }>(cadenceCacheKey(config));
  if (!cached?.payload.lastPulledAt) return true;
  const elapsedMinutes = (now.getTime() - new Date(cached.payload.lastPulledAt).getTime()) / 60_000;
  return elapsedMinutes >= Math.max(1, config.pull_cadence_minutes);
}

export async function markPulled(config: SharpPullConfig, now = new Date()) {
  await putProviderCache({
    cacheKey: cadenceCacheKey(config),
    provider: "sharpapi",
    payload: { lastPulledAt: now.toISOString() },
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
}
