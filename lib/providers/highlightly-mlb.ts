import type { ProviderFetchResult } from "./provider-adapter";
import { normalizedSecret } from "./env.ts";

export type HighlightlyPlayersPayload = {
  data?: Array<{ id?: number; fullName?: string; logo?: string }>;
  pagination?: { totalCount?: number; offset?: number; limit?: number };
  plan?: { tier?: string; message?: string };
};
export type HighlightlyPlayerStatsPayload = unknown[];

export class HighlightlyMlbAdapter {
  readonly id = "highlightly";
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(apiKey = process.env.HIGHLIGHTLY_MLB_API_KEY, baseUrl = process.env.HIGHLIGHTLY_MLB_BASE_URL || "https://baseball.highlightly.net") {
    this.apiKey = normalizedSecret(apiKey);
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  configured() { return Boolean(this.apiKey); }

  async fetchPlayers(): Promise<ProviderFetchResult<HighlightlyPlayersPayload>> {
    if (!this.apiKey) throw new Error("HIGHLIGHTLY_MLB_API_KEY is not configured.");
    const url = new URL(`${this.baseUrl}/players`);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("offset", "0");
    const response = await fetch(url, { headers: { "x-rapidapi-key": this.apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(12_000), cache: "no-store" });
    const payload = await response.json().catch(() => null) as HighlightlyPlayersPayload | null;
    if (!response.ok) throw new Error(`Highlightly MLB request failed with status ${response.status}.`);
    if (!payload || !Array.isArray(payload.data)) throw new Error("Highlightly MLB returned an invalid player payload.");
    const remaining = Number(response.headers.get("x-ratelimit-requests-remaining"));
    return { data: payload, cost: 1, remaining: Number.isFinite(remaining) ? remaining : null, fetchedAt: new Date().toISOString() };
  }

  async fetchPlayerStatistics(playerId: number): Promise<ProviderFetchResult<HighlightlyPlayerStatsPayload>> {
    if (!this.apiKey) throw new Error("HIGHLIGHTLY_MLB_API_KEY is not configured.");
    if (!Number.isInteger(playerId) || playerId <= 0) throw new Error("Invalid Highlightly player ID.");
    const response = await fetch(`${this.baseUrl}/players/${playerId}/statistics`, { headers: { "x-rapidapi-key": this.apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(12_000), cache: "no-store" });
    const payload = await response.json().catch(() => null) as HighlightlyPlayerStatsPayload | null;
    if (!response.ok) throw new Error(`Highlightly MLB player statistics request failed with status ${response.status}.`);
    if (!Array.isArray(payload)) throw new Error("Highlightly MLB returned an invalid statistics payload.");
    const remaining = Number(response.headers.get("x-ratelimit-requests-remaining"));
    return { data: payload, cost: 1, remaining: Number.isFinite(remaining) ? remaining : null, fetchedAt: new Date().toISOString() };
  }
}

export function summarizeHighlightlyPlayers(payload: HighlightlyPlayersPayload) {
  const players = Array.isArray(payload.data) ? payload.data : [];
  const validPlayers = players.filter((player) => Number.isInteger(player.id) && typeof player.fullName === "string" && player.fullName.trim().length > 0).length;
  return { players: players.length, validPlayers, totalAvailable: typeof payload.pagination?.totalCount === "number" ? payload.pagination.totalCount : null, tier: payload.plan?.tier ?? null };
}

export function summarizeHighlightlyPlayerStats(payload: HighlightlyPlayerStatsPayload) {
  const records = payload.filter((value) => value && typeof value === "object") as Array<Record<string, unknown>>;
  const seasons = records.flatMap((record) => Array.isArray(record.perSeason) ? record.perSeason : []).filter((value) => value && typeof value === "object") as Array<Record<string, unknown>>;
  const current = [...seasons].sort((a, b) => Number(b.season ?? 0) - Number(a.season ?? 0))[0];
  const stats = current && Array.isArray(current.stats) ? current.stats as Array<Record<string, unknown>> : [];
  const teams = current && Array.isArray(current.teams) ? current.teams as Array<Record<string, unknown>> : [];
  return {
    records: records.length,
    seasons: seasons.length,
    latestSeason: typeof current?.season === "number" ? current.season : null,
    statNames: stats.map((stat) => typeof stat.name === "string" ? stat.name : "").filter(Boolean).slice(0, 40),
    teams: teams.map((team) => typeof team.displayName === "string" ? team.displayName : typeof team.name === "string" ? team.name : "").filter(Boolean),
  };
}
