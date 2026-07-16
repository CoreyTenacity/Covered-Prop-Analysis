import type { ProviderFetchResult } from "./provider-adapter";
import { normalizedSecret } from "./env.ts";

export type BigBallsPayload = { data?: unknown; meta?: Record<string, unknown>; [key: string]: unknown };

export function extractBigBallsMatches(payload: BigBallsPayload) {
  if (Array.isArray(payload.data)) return payload.data;
  if (!payload.data || typeof payload.data !== "object") return [];
  const scores = (payload.data as Record<string, unknown>).scores;
  if (!scores || typeof scores !== "object") return [];
  const value = (scores as Record<string, unknown>).value;
  return Array.isArray(value) ? value : [];
}

export function selectLineupEligibleMatch(matches: unknown[], now = new Date(), windowHours = 3) {
  const upper = now.getTime() + windowHours * 60 * 60 * 1000;
  return matches
    .filter((value) => value && typeof value === "object")
    .map((value) => value as Record<string, unknown>)
    .filter((match) => typeof match.match_id === "string")
    .filter((match) => {
      const start = new Date(String(match.scheduled_at ?? match.starts_at ?? match.updated_at ?? "")).getTime();
      return Number.isFinite(start) && start >= now.getTime() && start <= upper;
    })
    .sort((a, b) => new Date(String(a.scheduled_at ?? a.starts_at ?? a.updated_at)).getTime() - new Date(String(b.scheduled_at ?? b.starts_at ?? b.updated_at)).getTime())[0] ?? null;
}

export class BigBallsDataAdapter {
  readonly id = "big-balls-data";
  private readonly apiKey: string | undefined;
  private readonly authHeader: string;
  private readonly authScheme: string;

  constructor(
    apiKey = process.env.BBS_API_KEY,
    authHeader = process.env.BBS_AUTH_HEADER || "",
    authScheme = process.env.BBS_AUTH_SCHEME || "",
  ) {
    this.apiKey = normalizedSecret(apiKey);
    this.authHeader = normalizedSecret(authHeader);
    this.authScheme = normalizedSecret(authScheme);
  }
  configured() { return Boolean(this.apiKey); }

  private requestHeaders(style: "api-key" | "bearer") {
    if (!this.apiKey) return { Accept: "application/json" };
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.authHeader) {
      headers[this.authHeader] = this.authScheme ? `${this.authScheme} ${this.apiKey}`.trim() : this.apiKey;
      return headers;
    }
    if (style === "bearer") {
      headers.Authorization = `Bearer ${this.apiKey}`;
      return headers;
    }
    headers["x-api-key"] = this.apiKey;
    return headers;
  }

  private async fetchJson(url: URL | string, style: "api-key" | "bearer") {
    const response = await fetch(url, {
      headers: this.requestHeaders(style),
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null) as BigBallsPayload | null;
    return { response, payload };
  }

  async fetchMlbMatches(date: string): Promise<ProviderFetchResult<BigBallsPayload>> {
    if (!this.apiKey) throw new Error("BBS_API_KEY is not configured.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Use an ISO date for the MLB match lookup.");
    const url = new URL("https://api.bigballsdata.com/v1/matches");
    url.searchParams.set("sport", "baseball");
    url.searchParams.set("league", "mlb");
    url.searchParams.set("date", date);
    let { response, payload } = await this.fetchJson(url, "api-key");
    if (!response.ok && [401, 403].includes(response.status) && !this.authHeader) {
      const retry = await this.fetchJson(url, "bearer");
      response = retry.response;
      payload = retry.payload;
    }
    if (!response.ok) throw new Error(`Big Balls Data request failed with status ${response.status}.`);
    if (!payload || typeof payload !== "object") throw new Error("Big Balls Data returned an invalid payload.");
    return { data: payload, cost: 1, remaining: null, fetchedAt: new Date().toISOString() };
  }

  async fetchMlbLineup(matchId: string): Promise<ProviderFetchResult<BigBallsPayload>> {
    if (!this.apiKey) throw new Error("BBS_API_KEY is not configured.");
    if (!/^bb_match_[A-Za-z0-9]+$/.test(matchId)) throw new Error("Invalid Big Balls Data match ID.");
    const url = `https://api.bigballsdata.com/v1/stored/matches/${encodeURIComponent(matchId)}/lineups`;
    let { response, payload } = await this.fetchJson(url, "api-key");
    if (!response.ok && [401, 403].includes(response.status) && !this.authHeader) {
      const retry = await this.fetchJson(url, "bearer");
      response = retry.response;
      payload = retry.payload;
    }
    if (!response.ok) throw new Error(`Big Balls Data lineup request failed with status ${response.status}.`);
    if (!payload || typeof payload !== "object") throw new Error("Big Balls Data returned an invalid lineup payload.");
    return { data: payload, cost: 1, remaining: null, fetchedAt: new Date().toISOString() };
  }
}

export function summarizeBigBallsMatches(payload: BigBallsPayload) {
  const matches = extractBigBallsMatches(payload);
  const fields = [...new Set(matches.flatMap((match) => match && typeof match === "object" ? Object.keys(match) : []))].slice(0, 30);
  return { matches: matches.length, fields, source: typeof payload.meta?.source === "string" ? payload.meta.source : null };
}

export function summarizeBigBallsLineup(payload: BigBallsPayload) {
  const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
  const fields = Object.keys(data).slice(0, 30);
  const arrays = Object.fromEntries(Object.entries(data).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, (value as unknown[]).length]));
  return { fields, arrays, source: typeof payload.meta?.source === "string" ? payload.meta.source : null };
}
