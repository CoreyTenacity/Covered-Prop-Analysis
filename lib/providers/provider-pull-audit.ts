import { getProviderCache, putProviderCache } from "@/lib/db/provider-cache";
import type { Direction, Sport } from "@/lib/types";
import type { ProviderId } from "./provider-contracts.ts";

export type ProviderPullAuditProp = {
  id: string;
  provider: ProviderId;
  sport: Sport;
  sportKey: string;
  eventId: string;
  matchup: string;
  commenceTime: string;
  playerName: string;
  statType: string;
  marketKey: string;
  direction: Direction;
  line: number;
  homeTeam: string;
  awayTeam: string;
  sourceLabel?: string;
  books?: Array<{ sportsbook: string; americanOdds: number | null }>;
  rawMarketTypes?: string[];
  dataQuality?: string;
  limitations?: string[];
};

export type ProviderPullAuditEvent = {
  eventId: string;
  matchup: string;
  commenceTime: string;
  propCount: number;
  rawMarketTypes: string[];
  playerProps: ProviderPullAuditProp[];
};

export type ProviderPullAuditEntry = {
  source: "refresh" | "coverage-check" | "normalize" | "manual";
  provider: ProviderId;
  sport: Sport;
  sportKey: string;
  status: "fetched" | "cached" | "budget-blocked" | "provider-error" | "skipped";
  fetchedAt: string;
  cost?: number;
  remaining?: number | null;
  limit?: number;
  normalized?: number;
  rejected?: number;
  usage?: { allowed?: boolean; daily_used?: number; monthly_used?: number | null };
  error?: string;
  requestedMarkets?: string[];
  summary?: Record<string, unknown>;
  events: ProviderPullAuditEvent[];
};

export type ProviderPullAuditLog = {
  refreshedAt: string;
  entries: ProviderPullAuditEntry[];
};

function easternDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

export function groupProviderPullAuditProps(props: ProviderPullAuditProp[], requestedMarkets: string[] = []) {
  const grouped = new Map<string, ProviderPullAuditEvent>();
  for (const prop of props) {
    const key = prop.eventId;
    const event = grouped.get(key) ?? {
      eventId: prop.eventId,
      matchup: prop.matchup,
      commenceTime: prop.commenceTime,
      propCount: 0,
      rawMarketTypes: [],
      playerProps: [],
    };
    event.propCount += 1;
    event.rawMarketTypes = [...new Set([...event.rawMarketTypes, ...(prop.rawMarketTypes ?? []), prop.marketKey, ...requestedMarkets].filter(Boolean))];
    event.playerProps.push(prop);
    event.matchup = event.matchup || prop.matchup;
    event.commenceTime = event.commenceTime || prop.commenceTime;
    grouped.set(key, event);
  }
  return [...grouped.values()].sort((left, right) => new Date(left.commenceTime).getTime() - new Date(right.commenceTime).getTime());
}

export async function getProviderPullAuditLog(provider: ProviderId, now = new Date()) {
  const cacheKey = `${provider}:audit:${easternDate(now)}`;
  return getProviderCache<ProviderPullAuditLog>(cacheKey);
}

export async function appendProviderPullAuditEntry(
  provider: ProviderId,
  entry: Omit<ProviderPullAuditEntry, "events"> & { playerProps?: ProviderPullAuditProp[] },
) {
  const now = new Date();
  const cacheKey = `${provider}:audit:${easternDate(now)}`;
  const cached = await getProviderCache<ProviderPullAuditLog>(cacheKey);
  const events = entry.playerProps ? groupProviderPullAuditProps(entry.playerProps, entry.requestedMarkets ?? []) : [];
  const nextEntry: ProviderPullAuditEntry = {
    ...entry,
    events,
    fetchedAt: entry.fetchedAt || now.toISOString(),
  };
  const payload: ProviderPullAuditLog = {
    refreshedAt: cached?.fetched_at ?? now.toISOString(),
    entries: [...(cached?.payload.entries ?? []), nextEntry].slice(-120),
  };
  await putProviderCache({
    cacheKey,
    provider,
    payload,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  });
  return payload;
}

export function compactProviderAuditEntries(entries: ProviderPullAuditEntry[]) {
  const bySport = new Map<string, ProviderPullAuditEntry>();
  for (const entry of entries) {
    const key = `${entry.provider}:${entry.sport}`;
    const previous = bySport.get(key);
    if (!previous) {
      bySport.set(key, entry);
      continue;
    }
    const events = new Map(previous.events.map((event) => [event.eventId, event]));
    for (const event of entry.events) {
      const existing = events.get(event.eventId);
      if (!existing) {
        events.set(event.eventId, event);
        continue;
      }
      const props = new Map(existing.playerProps.map((prop) => [prop.id, prop]));
      for (const prop of event.playerProps) props.set(prop.id, prop);
      const playerProps = [...props.values()];
      events.set(event.eventId, {
        ...existing,
        ...event,
        propCount: playerProps.length,
        rawMarketTypes: [...new Set([...existing.rawMarketTypes, ...event.rawMarketTypes])],
        playerProps,
      });
    }
    bySport.set(key, {
      ...previous,
      ...entry,
      cost: (previous.cost ?? 0) + (entry.cost ?? 0),
      normalized: [...events.values()].reduce((sum, event) => sum + event.propCount, 0),
      rejected: (previous.rejected ?? 0) + (entry.rejected ?? 0),
      requestedMarkets: [...new Set([...(previous.requestedMarkets ?? []), ...(entry.requestedMarkets ?? [])])],
      events: [...events.values()].sort((a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime()),
    });
  }
  return [...bySport.values()];
}
