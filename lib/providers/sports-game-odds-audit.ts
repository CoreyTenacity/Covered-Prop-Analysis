import { getProviderCache, putProviderCache } from "@/lib/db/provider-cache";
import type { NormalizedSportsGameOddsProp, SportsGameOddsPayload } from "@/lib/providers/sports-game-odds";
import { summarizeSportsGameOddsPayload } from "@/lib/providers/sports-game-odds";
import type { Sport } from "@/lib/types";

export type SportsGameOddsEventAudit = {
  eventId: string;
  matchup: string;
  commenceTime: string;
  propCount: number;
  marketTypes: string[];
  playerProps: NormalizedSportsGameOddsProp[];
};

export type SportsGameOddsAuditEntry = {
  source: "refresh" | "coverage-check";
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
  summary?: ReturnType<typeof summarizeSportsGameOddsPayload>;
  events: SportsGameOddsEventAudit[];
};

export type SportsGameOddsAuditLog = {
  refreshedAt: string;
  entries: SportsGameOddsAuditEntry[];
};

function easternDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function groupPropsByEvent(props: NormalizedSportsGameOddsProp[]) {
  const grouped = new Map<string, SportsGameOddsEventAudit>();
  for (const prop of props) {
    const key = prop.eventId;
    const event = grouped.get(key) ?? {
      eventId: prop.eventId,
      matchup: `${prop.awayTeam || "Away"} at ${prop.homeTeam || "Home"}`,
      commenceTime: prop.gameTime,
      propCount: 0,
      marketTypes: [],
      playerProps: [],
    };
    event.propCount += 1;
    event.marketTypes = [...new Set([...event.marketTypes, prop.statType])];
    event.playerProps.push(prop);
    if (!event.matchup || event.matchup.includes("Away at Home")) {
      event.matchup = `${prop.awayTeam || "Away"} at ${prop.homeTeam || "Home"}`;
    }
    event.commenceTime = event.commenceTime || prop.gameTime;
    grouped.set(key, event);
  }
  return [...grouped.values()].sort((left, right) => new Date(left.commenceTime).getTime() - new Date(right.commenceTime).getTime());
}

export async function getSportsGameOddsAuditLog(now = new Date()) {
  const cacheKey = `sports-game-odds:audit:${easternDate(now)}`;
  return getProviderCache<SportsGameOddsAuditLog>(cacheKey);
}

export async function appendSportsGameOddsAuditEntry(entry: Omit<SportsGameOddsAuditEntry, "events"> & { events?: NormalizedSportsGameOddsProp[] }) {
  const now = new Date();
  const cacheKey = `sports-game-odds:audit:${easternDate(now)}`;
  const cached = await getProviderCache<SportsGameOddsAuditLog>(cacheKey);
  const events = entry.events ? groupPropsByEvent(entry.events) : [];
  const nextEntry: SportsGameOddsAuditEntry = {
    ...entry,
    events,
    fetchedAt: entry.fetchedAt || now.toISOString(),
  };
  const payload: SportsGameOddsAuditLog = {
    refreshedAt: cached?.fetched_at ?? now.toISOString(),
    entries: [...(cached?.payload.entries ?? []), nextEntry].slice(-120),
  };
  await putProviderCache({
    cacheKey,
    provider: "sports-game-odds",
    payload,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  });
  return payload;
}
