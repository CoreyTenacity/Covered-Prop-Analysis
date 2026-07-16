import type { ProviderFetchResult } from "./provider-adapter";
import { normalizedSecret } from "./env.ts";

const baseUrl = "https://api.sharpapi.io/api/v1";

export type SharpApiLeague = "MLB" | "WNBA" | "NBA" | "NFL";

export type SharpApiFetchInput = {
  sport?: string;
  league?: SharpApiLeague;
  sportsbook?: string | null;
  marketType?: string | null;
  eventId?: string | null;
  date?: string | null;
  cursor?: string;
  limit?: number;
  playerPropsOnly?: boolean;
  allowFallbacks?: boolean;
  timeoutMs?: number;
};

export type SharpApiOddsPayload = {
  data?: unknown[];
  pagination?: { total?: number; count?: number; limit?: number; has_more?: boolean; next_cursor?: string };
  [key: string]: unknown;
};

export type SharpApiProviderError = Error & {
  status?: number;
  requestUrl?: string;
  retryAfter?: number | null;
  responseBody?: string;
  requestMeta?: Record<string, unknown>;
};

export class SharpApiAdapter {
  readonly id = "sharpapi";
  private readonly apiKey: string | undefined;

  constructor(apiKey = process.env.SHARPAPI_KEY) { this.apiKey = normalizedSecret(apiKey); }
  configured() { return Boolean(this.apiKey); }

  async fetchOdds(input: SharpApiFetchInput): Promise<ProviderFetchResult<SharpApiOddsPayload>> {
    if (!this.apiKey) throw new Error("SHARPAPI_KEY is not configured.");
    const upperLeague = input.league?.toUpperCase() as SharpApiLeague | undefined;
    const strictAttempt = {
      sport: input.sport,
      league: upperLeague,
      sportsbook: input.sportsbook ?? null,
      marketType: input.marketType ?? null,
      eventId: input.eventId ?? null,
      date: input.date ?? null,
      cursor: input.cursor,
      limit: input.limit,
      playerPropsOnly: input.playerPropsOnly !== false,
    };
    const attempts = input.allowFallbacks === false
      ? [strictAttempt]
      : [
          strictAttempt,
          {
            sport: input.sport?.toLowerCase(),
            league: upperLeague?.toLowerCase() as SharpApiLeague | undefined,
            sportsbook: input.sportsbook ?? null,
            marketType: input.marketType ?? null,
            eventId: input.eventId ?? null,
            date: input.date ?? null,
            cursor: input.cursor,
            limit: input.limit,
            playerPropsOnly: input.playerPropsOnly !== false,
          },
          {
            sport: input.sport,
            league: upperLeague,
            sportsbook: input.sportsbook ?? null,
            marketType: input.marketType ?? null,
            eventId: input.eventId ?? null,
            date: input.date ?? null,
            cursor: undefined,
            limit: input.limit,
            playerPropsOnly: false,
          },
          {
            sport: input.sport?.toLowerCase(),
            league: upperLeague?.toLowerCase() as SharpApiLeague | undefined,
            sportsbook: input.sportsbook ?? null,
            marketType: input.marketType ?? null,
            eventId: input.eventId ?? null,
            date: input.date ?? null,
            cursor: undefined,
            limit: input.limit,
            playerPropsOnly: false,
          },
        ];

    let lastError: Error | null = null;
    for (const attempt of attempts) {
      const url = new URL(`${baseUrl}/odds`);
      url.searchParams.set("limit", String(Math.min(100, Math.max(1, attempt.limit ?? 50))));
      if (attempt.league) url.searchParams.set("league", String(attempt.league));
      if (attempt.sport) url.searchParams.set("sport", String(attempt.sport));
      if (attempt.playerPropsOnly) url.searchParams.set("is_player_prop", "true");
      if (attempt.cursor) url.searchParams.set("cursor", attempt.cursor);
      if (attempt.sportsbook) url.searchParams.set("sportsbook", attempt.sportsbook);
      if (attempt.marketType) url.searchParams.set("market_type", attempt.marketType);
      if (attempt.eventId) url.searchParams.set("event_id", attempt.eventId);
      if (attempt.date) url.searchParams.set("date", attempt.date);
      const response = await fetch(url, { headers: { "X-API-Key": this.apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(input.timeoutMs ?? 12_000), cache: "no-store" });
      const rawBody = await response.text().catch(() => "");
      let payload: SharpApiOddsPayload | null = null;
      if (rawBody) {
        try {
          payload = JSON.parse(rawBody) as SharpApiOddsPayload;
        } catch {
          payload = null;
        }
      }
      if (response.ok) {
        if (!payload || typeof payload !== "object") throw new Error("SharpAPI returned an invalid payload.");
        return {
          data: payload,
          cost: 1,
          remaining: null,
          fetchedAt: new Date().toISOString(),
        };
      }
      const error = new Error(
        response.status === 429
          ? "SharpAPI rate limit reached."
          : `SharpAPI request failed with status ${response.status}.`,
      ) as SharpApiProviderError;
      error.status = response.status;
      error.requestUrl = url.toString();
      error.requestMeta = {
        league: attempt.league ?? null,
        sport: attempt.sport ?? null,
        sportsbook: attempt.sportsbook ?? null,
        marketType: attempt.marketType ?? null,
        eventId: attempt.eventId ?? null,
        date: attempt.date ?? null,
        playerPropsOnly: attempt.playerPropsOnly,
      };
      const headerRetryAfter = Number(response.headers.get("retry-after") ?? "");
      const bodyRetryAfter = payload && typeof payload === "object" && payload.error && typeof payload.error === "object"
        ? Number((payload.error as Record<string, unknown>).retryAfter ?? (payload.error as Record<string, unknown>).retry_after ?? "")
        : Number.NaN;
      error.retryAfter = Number.isFinite(headerRetryAfter) ? headerRetryAfter : Number.isFinite(bodyRetryAfter) ? bodyRetryAfter : null;
      error.responseBody = rawBody.slice(0, 1000);
      lastError = error;
      if (response.status !== 400) break;
    }

    throw lastError ?? new Error("SharpAPI request failed.");
  }

  async fetchLeagueOdds(league: SharpApiLeague, options: { playerPropsOnly?: boolean; cursor?: string; limit?: number } = {}): Promise<ProviderFetchResult<SharpApiOddsPayload>> {
    return this.fetchOdds({
      league,
      playerPropsOnly: options.playerPropsOnly,
      cursor: options.cursor,
      limit: options.limit,
    });
  }
}

export function summarizeSharpApiPayload(payload: SharpApiOddsPayload) {
  const records = Array.isArray(payload.data) ? payload.data : [];
  const propRecords = records.filter((record) => record && typeof record === "object" && (record as Record<string, unknown>).is_player_prop === true).length;
  const marketTypes = [...new Set(records.map((record) => {
    if (!record || typeof record !== "object") return "";
    const value = (record as Record<string, unknown>).market_type;
    return typeof value === "string" ? value : "";
  }).filter(Boolean))].slice(0, 20);
  return { records: records.length, propRecords, hasMore: payload.pagination?.has_more === true, marketTypes };
}
