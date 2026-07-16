import type { OddsProviderAdapter, ProviderEvent, ProviderFetchResult } from "./provider-adapter";
import { normalizedSecret } from "./env.ts";

const baseUrl = "https://api.the-odds-api.com/v4";

type OddsApiEvent = {
  id?: unknown;
  sport_key?: unknown;
  commence_time?: unknown;
  home_team?: unknown;
  away_team?: unknown;
};

export const coveredSportKeys = {
  MLB: "baseball_mlb",
  WNBA: "basketball_wnba",
  NFL: "americanfootball_nfl",
  NBA: "basketball_nba",
} as const;

export function estimateEventPropsCost(markets: string[], regions = ["us"]) {
  const uniqueMarkets = new Set(markets.map((value) => value.trim()).filter(Boolean)).size;
  const uniqueRegions = new Set(regions.map((value) => value.trim()).filter(Boolean)).size;
  return uniqueMarkets * uniqueRegions;
}

export function assertPlayerPropMarkets(markets: string[]) {
  const invalid = markets.filter((market) => !/^(player|batter|pitcher)_/.test(market));
  if (!markets.length || invalid.length) throw new Error(`Only player-prop markets are permitted${invalid.length ? `; rejected: ${invalid.join(", ")}` : "."}`);
}

function usage(response: Response) {
  const cost = Number(response.headers.get("x-requests-last"));
  const remaining = Number(response.headers.get("x-requests-remaining"));
  return {
    cost: Number.isFinite(cost) ? cost : 0,
    remaining: Number.isFinite(remaining) ? remaining : null,
  };
}

function normalizeEvent(value: OddsApiEvent): ProviderEvent | null {
  if (![value.id, value.sport_key, value.commence_time, value.home_team, value.away_team].every((field) => typeof field === "string" && field.length > 0)) return null;
  return { id: value.id as string, sportKey: value.sport_key as string, commenceTime: value.commence_time as string, homeTeam: value.home_team as string, awayTeam: value.away_team as string };
}

export class TheOddsApiAdapter implements OddsProviderAdapter {
  readonly id = "the-odds-api";
  private readonly apiKey: string | undefined;

  constructor(apiKey = process.env.THE_ODDS_API_KEY) {
    this.apiKey = normalizedSecret(apiKey);
  }

  configured() {
    return Boolean(this.apiKey);
  }

  private async get(path: string, params: Record<string, string>): Promise<{ response: Response; payload: unknown }> {
    if (!this.apiKey) throw new Error("THE_ODDS_API_KEY is not configured.");
    const url = new URL(`${baseUrl}${path}`);
    Object.entries({ ...params, apiKey: this.apiKey }).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000), cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`The Odds API request failed with status ${response.status}.`);
    return { response, payload };
  }

  async listEvents(sportKey: string): Promise<ProviderFetchResult<ProviderEvent[]>> {
    const { response, payload } = await this.get(`/sports/${encodeURIComponent(sportKey)}/events`, { dateFormat: "iso" });
    const values = Array.isArray(payload) ? payload as OddsApiEvent[] : [];
    return { data: values.map(normalizeEvent).filter((event): event is ProviderEvent => Boolean(event)), ...usage(response), fetchedAt: new Date().toISOString() };
  }

  async fetchEventPlayerProps(input: { sportKey: string; eventId: string; markets: string[]; regions?: string[] }): Promise<ProviderFetchResult<unknown>> {
    const regions = input.regions?.length ? input.regions : ["us"];
    assertPlayerPropMarkets(input.markets);
    if (estimateEventPropsCost(input.markets, regions) < 1) throw new Error("At least one market and region are required.");
    const { response, payload } = await this.get(`/sports/${encodeURIComponent(input.sportKey)}/events/${encodeURIComponent(input.eventId)}/odds`, {
      regions: regions.join(","), markets: input.markets.join(","), oddsFormat: "american", dateFormat: "iso", includeMultipliers: "true",
    });
    return { data: payload, ...usage(response), fetchedAt: new Date().toISOString() };
  }
}
