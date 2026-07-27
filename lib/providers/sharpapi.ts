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
  /**
   * The caller's remaining physical-request allowance for THIS call
   * (typically requestLimit - outboundSharpRequests already used this run).
   * The compatibility retry is only attempted when a second physical request
   * actually fits within this budget -- it is checked BEFORE issuing the
   * retry, not counted after the fact. Defaults to 2 (the pre-existing
   * behavior: canonical attempt + at most one retry) when omitted.
   */
  maxPhysicalRequests?: number;
};

export type SharpApiOddsPayload = {
  data?: unknown[];
  pagination?: { total?: number; count?: number; limit?: number; has_more?: boolean; next_cursor?: string };
  [key: string]: unknown;
};

/** Distinct failure classes so callers never lump a malformed-request (400)
 * response together with genuine rate limiting (429), a network timeout, or
 * an upstream server error (5xx) -- each has a different correct response
 * (a 400 should not be retried with the same shape; a 429 should back off;
 * a timeout/5xx is transient and safe to retry next cycle). */
export type SharpApiErrorClass = "bad_request" | "rate_limited" | "server_error" | "timeout" | "network_error";

export type SharpApiProviderError = Error & {
  status?: number;
  errorClass?: SharpApiErrorClass;
  requestUrl?: string;
  retryAfter?: number | null;
  responseBody?: string;
  requestMeta?: Record<string, unknown>;
  /** Real physical HTTP requests this call made to SharpAPI, including any
   * internal compatibility retry. Callers must count this, not assume 1. */
  physicalRequestCount?: number;
};

function classifySharpApiError(input: { status?: number; timedOut?: boolean }): SharpApiErrorClass {
  if (input.timedOut) return "timeout";
  if (input.status === 429) return "rate_limited";
  if (input.status === 400) return "bad_request";
  if (typeof input.status === "number" && input.status >= 500) return "server_error";
  return "network_error";
}

function sleep(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SharpApiAdapter {
  readonly id = "sharpapi";
  private readonly apiKey: string | undefined;

  constructor(apiKey = process.env.SHARPAPI_KEY) { this.apiKey = normalizedSecret(apiKey); }
  configured() { return Boolean(this.apiKey); }

  // Spacing between the strict attempt and its one compatibility retry (both
  // are real physical calls to the same per-minute-limited provider, so a
  // retry must not fire back-to-back with zero delay).
  static readonly RETRY_SPACING_MS = 1_500;

  async fetchOdds(input: SharpApiFetchInput): Promise<ProviderFetchResult<SharpApiOddsPayload> & { physicalRequestCount: number }> {
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
    // At most one justified compatibility retry (case-folded league/sport),
    // not four immediate variants. The dropped variants (forcing
    // playerPropsOnly:false and discarding the cursor) were never confirmed
    // necessary against current successful responses -- the strict shape
    // alone succeeds reliably (verified directly against the live provider
    // 2026-07-26) -- so they are removed rather than carried forward
    // unaccounted-for.
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
        ];

    const maxPhysicalRequests = Math.max(1, Math.floor(input.maxPhysicalRequests ?? 2));
    let lastError: SharpApiProviderError | null = null;
    let physicalRequestCount = 0;
    for (const attempt of attempts) {
      // Enforced BEFORE issuing the request, not counted after the fact: a
      // compatibility retry never fires unless a physical-request slot is
      // actually still available in the caller's budget. If the canonical
      // attempt itself already exhausts the allowance (maxPhysicalRequests
      // <= 1) and fails, there is nothing left to report but that failure --
      // no retry is attempted, regardless of the response status.
      if (physicalRequestCount >= maxPhysicalRequests) break;
      if (physicalRequestCount > 0) {
        // A second physical call is about to happen -- space it, don't fire
        // it immediately after the first.
        await sleep(SharpApiAdapter.RETRY_SPACING_MS);
      }
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

      let response: Response;
      physicalRequestCount += 1;
      try {
        response = await fetch(url, { headers: { "X-API-Key": this.apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(input.timeoutMs ?? 12_000), cache: "no-store" });
      } catch (networkError) {
        const timedOut = networkError instanceof Error && networkError.name === "TimeoutError";
        const error = new Error(
          timedOut ? "SharpAPI request timed out." : `SharpAPI request failed: ${networkError instanceof Error ? networkError.message : String(networkError)}`,
        ) as SharpApiProviderError;
        error.errorClass = classifySharpApiError({ timedOut });
        error.requestUrl = url.toString();
        error.physicalRequestCount = physicalRequestCount;
        lastError = error;
        // A timeout/network failure is not the "retry a different casing"
        // case the compatibility attempt exists for -- stop rather than
        // burn a second physical request on the same transient condition.
        break;
      }

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
          physicalRequestCount,
        };
      }
      const error = new Error(
        response.status === 429
          ? "SharpAPI rate limit reached."
          : `SharpAPI request failed with status ${response.status}.`,
      ) as SharpApiProviderError;
      error.status = response.status;
      error.errorClass = classifySharpApiError({ status: response.status });
      error.requestUrl = url.toString();
      error.physicalRequestCount = physicalRequestCount;
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
