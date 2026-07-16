import { getProviderCache, putProviderCache } from "@/lib/db/provider-cache";
import type { Sport } from "@/lib/types";

type SharedPropIndexEntry = {
  playerName: string;
  marketKey: string;
  line: number;
  provider: string;
  eventId?: string;
  updatedAt: string;
};

type SharedPropIndex = {
  refreshedAt: string;
  entries: Record<string, SharedPropIndexEntry>;
};

function easternDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function normalize(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
}

function normalizeMarketKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function sharedIndexKey(now = new Date()) {
  return `shared-prop-index:${easternDate(now)}`;
}

function scheduledDateKey(gameTime?: string, fallback = new Date()) {
  if (!gameTime) return easternDate(fallback);
  const parsed = new Date(gameTime);
  return Number.isNaN(parsed.getTime()) ? easternDate(fallback) : easternDate(parsed);
}

function propKey(input: { sport: Sport; playerName: string; marketKey: string; gameTime?: string }, now = new Date()) {
  return [
    input.sport,
    scheduledDateKey(input.gameTime, now),
    normalize(input.playerName),
    normalizeMarketKey(input.marketKey),
  ].join("|");
}

export async function loadSharedPropIndex(now = new Date()): Promise<SharedPropIndex> {
  const cached = await getProviderCache<SharedPropIndex>(sharedIndexKey(now));
  return cached?.payload ?? { refreshedAt: new Date(0).toISOString(), entries: {} };
}

export async function hasSharedMainLine(input: { sport: Sport; playerName: string; marketKey: string; line: number; now?: Date }) {
  const index = await loadSharedPropIndex(input.now ?? new Date());
  const key = propKey(input, input.now ?? new Date());
  const existing = index.entries[key];
  return Boolean(existing && existing.line === input.line);
}

export async function markSharedMainLine(input: {
  sport: Sport;
  playerName: string;
  marketKey: string;
  line: number;
  provider: string;
  eventId?: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const cacheKey = sharedIndexKey(now);
  const index = await loadSharedPropIndex(now);
  index.entries[propKey(input, now)] = {
    playerName: input.playerName,
    marketKey: normalizeMarketKey(input.marketKey),
    line: input.line,
    provider: input.provider,
    eventId: input.eventId,
    updatedAt: now.toISOString(),
  };
  index.refreshedAt = now.toISOString();
  await putProviderCache({
    cacheKey,
    provider: "the-odds-api",
    payload: index,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  });
  return index;
}

export async function filterAndMarkNewMainLines<T extends {
  sport: Sport;
  playerName: string;
  marketKey: string;
  line: number;
  eventId?: string;
  gameTime?: string;
}>(rows: T[], provider: string, now = new Date()) {
  const index = await loadSharedPropIndex(now);
  const kept: T[] = [];
  let skipped = 0;

  for (const row of rows) {
    const key = propKey(row, now);
    const existing = index.entries[key];
    if (existing && existing.line === row.line) {
      skipped += 1;
      continue;
    }
    index.entries[key] = {
      playerName: row.playerName,
      marketKey: normalizeMarketKey(row.marketKey),
      line: row.line,
      provider,
      eventId: row.eventId,
      updatedAt: now.toISOString(),
    };
    kept.push(row);
  }

  index.refreshedAt = now.toISOString();
  await putProviderCache({
    cacheKey: sharedIndexKey(now),
    provider: "the-odds-api",
    payload: index,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  });

  return { kept, skipped, index };
}
