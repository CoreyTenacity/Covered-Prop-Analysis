import type { ProviderFetchResult } from "./provider-adapter";
import { normalizedSecret } from "./env.ts";

export type SportsGameOddsPayload = {
  data?: unknown[];
  pagination?: { total?: number; count?: number; limit?: number; has_more?: boolean; next_cursor?: string };
  meta?: Record<string, unknown>;
  [key: string]: unknown;
};

export type SportsGameOddsFetchAttempt = {
  sportKey: string;
  status: "fetched" | "provider-error";
  cost: number;
  remaining: number | null;
  fetchedAt?: string;
  error?: string;
};

export type NormalizedSportsGameOddsProp = {
  id: string;
  provider: "sports-game-odds";
  sportKey: string;
  eventId: string;
  playerName: string;
  team: null;
  homeTeam: string;
  awayTeam: string;
  gameTime: string;
  marketKey: string;
  statType: string;
  direction: "More" | "Less";
  line: number;
  dataQuality: "incomplete";
  limitations: string[];
};

export class SportsGameOddsAdapter {
  readonly id = "sports-game-odds";
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly oddsPath: string;
  private readonly authHeader: string;
  private readonly authScheme: string;
  private readonly tennisOddsPath: string;
  private readonly tennisSportKeys: string[];

  constructor(
    apiKey = process.env.SPORTS_GAME_ODDS_API_KEY,
    baseUrl = process.env.SPORTS_GAME_ODDS_BASE_URL || "https://api.sportsgameodds.com/api/v2",
    oddsPath = process.env.SPORTS_GAME_ODDS_ODDS_PATH || "/odds",
    authHeader = process.env.SPORTS_GAME_ODDS_AUTH_HEADER || "Authorization",
    authScheme = process.env.SPORTS_GAME_ODDS_AUTH_SCHEME || "Bearer",
    tennisOddsPath = process.env.SPORTS_GAME_ODDS_TENNIS_ODDS_PATH || oddsPath || "/odds",
    tennisSportKeys = process.env.SPORTS_GAME_ODDS_TENNIS_SPORT_KEYS || "tennis_atp_wta,tennis_atp,tennis_wta,tennis",
  ) {
    this.apiKey = normalizedSecret(apiKey);
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.oddsPath = oddsPath.startsWith("/") ? oddsPath : `/${oddsPath}`;
    this.authHeader = normalizedSecret(authHeader);
    this.authScheme = normalizedSecret(authScheme);
    this.tennisOddsPath = tennisOddsPath.startsWith("/") ? tennisOddsPath : `/${tennisOddsPath}`;
    this.tennisSportKeys = tennisSportKeys.split(",").map((value) => value.trim()).filter(Boolean);
  }

  configured() {
    return Boolean(this.apiKey);
  }

  private async get(path: string, params: Record<string, string>): Promise<{ response: Response; payload: unknown }> {
    if (!this.apiKey) throw new Error("SPORTS_GAME_ODDS_API_KEY is not configured.");
    const url = new URL(`${this.baseUrl}${path}`);
    Object.entries(params).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value);
    });
    const response = await fetch(url, {
      headers: {
        [this.authHeader]: this.authScheme ? `${this.authScheme} ${this.apiKey}`.trim() : this.apiKey,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`SportsGameOdds request failed with status ${response.status}.`);
      (error as Error & { status?: number; requestUrl?: string }).status = response.status;
      (error as Error & { status?: number; requestUrl?: string }).requestUrl = url.toString();
      throw error;
    }
    return { response, payload };
  }

  private sportKeyAliases(sportKey: string) {
    const normalized = sportKey.toLowerCase();
    if (normalized === "baseball_mlb" || normalized === "mlb") return ["baseball_mlb", "MLB", "mlb"];
    if (normalized === "basketball_wnba" || normalized === "wnba") return ["basketball_wnba", "WNBA", "wnba"];
    if (normalized === "basketball_nba" || normalized === "nba") return ["basketball_nba", "NBA", "nba"];
    if (normalized === "americanfootball_nfl" || normalized === "nfl") return ["americanfootball_nfl", "NFL", "nfl"];
    return [sportKey];
  }

  async fetchPlayerProps(input: { sportKey: string; limit?: number; playerPropsOnly?: boolean; oddsPath?: string }): Promise<ProviderFetchResult<SportsGameOddsPayload>> {
    const aliases = this.sportKeyAliases(input.sportKey);
    const errors: string[] = [];
    for (const sport of aliases) {
      try {
        const { response, payload } = await this.get(input.oddsPath ?? this.oddsPath, {
          sport,
          limit: String(Math.max(1, Math.min(input.limit ?? 50, 100))),
          player_props: input.playerPropsOnly === false ? "false" : "true",
        });
        if (!payload || typeof payload !== "object") throw new Error("SportsGameOdds returned an invalid payload.");
        const cost = Number(response.headers.get("x-objects-last") ?? response.headers.get("x-requests-last") ?? "1");
        const remaining = Number(response.headers.get("x-objects-remaining") ?? response.headers.get("x-requests-remaining") ?? "");
        return {
          data: payload as SportsGameOddsPayload,
          cost: Number.isFinite(cost) && cost > 0 ? cost : 1,
          remaining: Number.isFinite(remaining) ? remaining : null,
          fetchedAt: new Date().toISOString(),
        };
      } catch (error) {
        const status = typeof error === "object" && error && "status" in error ? Number((error as { status?: unknown }).status) : null;
        const message = error instanceof Error ? error.message : "Unknown SportsGameOdds error";
        errors.push(`${sport}: ${message}`);
        if (status !== 404) break;
      }
    }

    throw new Error(errors.length ? `SportsGameOdds request failed. ${errors.join("; ")}` : "SportsGameOdds request failed.");
  }

  async fetchTennisPlayerProps(input: { limit?: number; playerPropsOnly?: boolean } = {}): Promise<ProviderFetchResult<SportsGameOddsPayload> & { attempts: SportsGameOddsFetchAttempt[]; sportKeys: string[] }> {
    const sportKeys = this.tennisSportKeys.length ? this.tennisSportKeys : ["tennis_atp_wta", "tennis_atp", "tennis_wta", "tennis"];
    const mergedRows: unknown[] = [];
    const attempts: SportsGameOddsFetchAttempt[] = [];
    let totalCost = 0;
    let remaining: number | null = null;
    let fetchedAt = new Date().toISOString();

    for (const sportKey of sportKeys) {
      try {
        const response = await this.fetchPlayerProps({
          sportKey,
          limit: input.limit ?? 50,
          playerPropsOnly: input.playerPropsOnly ?? true,
          oddsPath: this.tennisOddsPath,
        });
        const rows = Array.isArray(response.data.data) ? response.data.data : [];
        mergedRows.push(...rows);
        totalCost += response.cost;
        remaining = response.remaining;
        fetchedAt = response.fetchedAt;
        attempts.push({ sportKey, status: "fetched", cost: response.cost, remaining: response.remaining, fetchedAt: response.fetchedAt });
      } catch (error) {
        attempts.push({
          sportKey,
          status: "provider-error",
          cost: 0,
          remaining: null,
          error: error instanceof Error ? error.message : "Unknown SportsGameOdds tennis error",
        });
      }
    }

    if (!mergedRows.length) {
      const errorDetails = attempts.map((attempt) => `${attempt.sportKey}: ${attempt.error ?? attempt.status}`).join("; ");
      throw new Error(errorDetails ? `SportsGameOdds tennis request failed. ${errorDetails}` : "SportsGameOdds tennis request failed.");
    }

    return {
      data: {
        data: mergedRows,
        meta: { source: "sports-game-odds-tennis", sportKeys },
      },
      cost: totalCost || 1,
      remaining,
      fetchedAt,
      attempts,
      sportKeys,
    };
  }
}

export function summarizeSportsGameOddsPayload(payload: SportsGameOddsPayload) {
  const records = Array.isArray(payload.data) ? payload.data : [];
  const propRecords = records.filter((record) => record && typeof record === "object" && (record as Record<string, unknown>).is_player_prop === true).length;
  const marketTypes = [...new Set(records.map((record) => {
    if (!record || typeof record !== "object") return "";
    const value = (record as Record<string, unknown>).market_type ?? (record as Record<string, unknown>).marketType;
    return typeof value === "string" ? value : "";
  }).filter(Boolean))].slice(0, 20);
  const sports = [...new Set(records.map((record) => {
    if (!record || typeof record !== "object") return "";
    const value = (record as Record<string, unknown>).sport_key ?? (record as Record<string, unknown>).sportKey;
    return typeof value === "string" ? value : "";
  }).filter(Boolean))].slice(0, 20);
  return {
    records: records.length,
    propRecords,
    hasMore: payload.pagination?.has_more === true,
    sports,
    marketTypes,
  };
}

function asText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeMarketKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isMainLineRow(row: Record<string, unknown>) {
  if (row.is_main_line === false || row.is_alternate_line === true) return false;
  if (row.is_main_line === true) return true;
  if (row.is_alternate_line === false) return true;
  return true;
}

function playerNameFromRow(row: Record<string, unknown>) {
  const candidates = [
    row.player_name,
    row.playerName,
    row.player,
    row.participant,
    row.selection_name,
    row.selectionName,
    row.selection,
    row.name,
    row.description,
  ]
    .map(asText)
    .filter(Boolean);
  const directionWords = new Set(["over", "under", "more", "less"]);
  return candidates.find((value) => !directionWords.has(value.toLowerCase())) ?? "";
}

export function normalizeSportsGameOddsProps(payload: SportsGameOddsPayload, sportKey: string) {
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const candidates: NormalizedSportsGameOddsProp[] = [];
  let rejected = 0;
  const grouped = new Map<string, Map<string, { row: Record<string, unknown>; books: Map<string, number | null> }>>();

  for (const value of rows) {
    if (!value || typeof value !== "object") { rejected++; continue; }
    const row = value as Record<string, unknown>;
    const marketKey = normalizeMarketKey(asText(row.market_type ?? row.marketType ?? row.prop_type ?? row.stat_type));
    const playerName = playerNameFromRow(row);
    const eventId = asText(row.event_id ?? row.eventId ?? row.game_id ?? row.gameId);
    const gameTime = asText(row.event_start_time ?? row.start_time ?? row.commence_time ?? row.game_time);
    const line = asNumber(row.line ?? row.handicap ?? row.points);
    const directionValue = asText(row.selection_type ?? row.side ?? row.market_side).toLowerCase();
    const direction = directionValue === "less" || directionValue === "under" ? "Less" : directionValue === "more" || directionValue === "over" ? "More" : null;
    const isProp = row.is_player_prop === true || /^(player|batter|pitcher)_/.test(marketKey);
    if (!isMainLineRow(row) || !isProp || !playerName || !eventId || !gameTime || line === null || line <= 0 || !direction) { rejected++; continue; }
    const key = [sportKey, eventId, playerName.toLowerCase(), marketKey].join("|");
    const lineKey = String(line);
    const group = grouped.get(key) ?? new Map<string, { row: Record<string, unknown>; books: Map<string, number | null> }>();
    const lineGroup = group.get(lineKey) ?? { row, books: new Map<string, number | null>() };
    const sportsbook = asText(row.sportsbook ?? row.book ?? row.source);
    if (sportsbook) lineGroup.books.set(sportsbook, asNumber(row.odds_american ?? row.oddsAmerican ?? row.price));
    group.set(lineKey, lineGroup);
    grouped.set(key, group);
  }

  const median = (values: number[]) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  };

  for (const [id, lineGroups] of grouped.entries()) {
    const lineValues = [...lineGroups.keys()].map((value) => Number(value)).filter((value) => Number.isFinite(value));
    const medianLine = median(lineValues) ?? lineValues[0] ?? 0;
    const rankedLines = [...lineGroups.entries()]
      .map(([lineKey, group]) => {
        const bookEntries = [...group.books.entries()].map(([sportsbook, americanOdds]) => ({ sportsbook, americanOdds }));
        return {
          line: Number(lineKey),
          row: group.row,
          bookEntries,
          support: bookEntries.length,
        };
      })
      .sort((left, right) => right.support - left.support || Math.abs(left.line - medianLine) - Math.abs(right.line - medianLine));
    const chosen = rankedLines[0];
    if (!chosen) continue;
    const row = chosen.row;
    const normalizedMarketKey = id.split("|").at(-1) ?? normalizeMarketKey(asText(row.market_type ?? row.marketType ?? row.prop_type ?? row.stat_type));
    candidates.push({
      id: `sports-game-odds:${id}:${chosen.line}`,
      provider: "sports-game-odds",
      sportKey,
      eventId: asText(row.event_id ?? row.eventId ?? row.game_id ?? row.gameId),
      playerName: playerNameFromRow(row),
      team: null,
      homeTeam: asText(row.home_team ?? row.homeTeam),
      awayTeam: asText(row.away_team ?? row.awayTeam),
      gameTime: new Date(asText(row.event_start_time ?? row.start_time ?? row.commence_time ?? row.game_time)).toISOString(),
      marketKey: normalizedMarketKey,
      statType: asText(row.stat_type ?? row.market_label ?? row.marketLabel) || normalizedMarketKey.replaceAll("_", " "),
      direction: asText(row.selection_type ?? row.side ?? row.market_side).toLowerCase() === "less" || asText(row.selection_type ?? row.side ?? row.market_side).toLowerCase() === "under" ? "Less" : "More",
      line: chosen.line,
      dataQuality: "incomplete",
      limitations: ["Player team is not identified in this SportsGameOdds payload.", "Odds define the available line, not a statistical projection.", "Alternate lines for the same player/market are collapsed to the consensus line before scoring."],
    });
  }

  return { candidates, rejected, sourceRecords: rows.length };
}
