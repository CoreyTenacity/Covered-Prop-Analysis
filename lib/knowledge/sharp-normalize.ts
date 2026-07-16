import type { Sport } from "@/lib/types";
import type { SharpApiOddsPayload } from "@/lib/providers/sharpapi";

export type NormalizedSharpMarketCandidate = {
  provider: "sharpapi";
  sport: Extract<Sport, "MLB" | "NBA" | "WNBA">;
  leagueId: "mlb" | "nba" | "wnba";
  eventId: string;
  providerMarketType: string;
  marketType: string;
  statType: string;
  playerName: string;
  team: string | null;
  homeTeam: string;
  awayTeam: string;
  gameTime: string;
  sportsbook: string;
  line: number;
  overPrice: number | null;
  underPrice: number | null;
  rawPayload: Record<string, unknown>;
  rawRows: Record<string, unknown>[];
  limitations: string[];
  dataQuality: "incomplete" | "partial";
};

type NormalizeOptions = {
  sport: Extract<Sport, "MLB" | "NBA" | "WNBA">;
  sportsbook?: string | null;
  providerMarketType?: string | null;
};

const CANONICAL_MARKET_MAP: Record<string, string> = {
  player_points: "player_points",
  player_rebounds: "player_rebounds",
  player_assists: "player_assists",
  player_points_rebounds_assists: "player_pra",
  player_threes: "player_threes",
  player_hits: "batter_hits",
  player_total_bases: "batter_total_bases",
  player_runs: "batter_runs",
  player_rbis: "batter_rbis",
  player_strikeouts: "pitcher_strikeouts",
  player_home_runs: "batter_home_runs",
  player_walks: "batter_walks",
  player_stolen_bases: "batter_stolen_bases",
  player_hits_runs_rbis: "batter_hits_runs_rbis",
  player_outs_recorded: "pitcher_outs_recorded",
  player_earned_runs: "pitcher_earned_runs",
  player_hits_allowed: "pitcher_hits_allowed",
  player_walks_allowed: "pitcher_walks_allowed",
};

const MARKET_LABELS: Record<string, string> = {
  player_points: "Points",
  player_rebounds: "Rebounds",
  player_assists: "Assists",
  player_pra: "Points + Rebounds + Assists",
  player_threes: "Three-Pointers Made",
  batter_hits: "Hits",
  batter_total_bases: "Total Bases",
  batter_runs: "Runs",
  batter_rbis: "RBIs",
  pitcher_strikeouts: "Pitcher Strikeouts",
  batter_home_runs: "Home Runs",
  batter_walks: "Walks",
  batter_stolen_bases: "Stolen Bases",
  batter_hits_runs_rbis: "Hits + Runs + RBIs",
  pitcher_outs_recorded: "Outs Recorded",
  pitcher_earned_runs: "Earned Runs Allowed",
  pitcher_hits_allowed: "Hits Allowed",
  pitcher_walks_allowed: "Walks Allowed",
};

function asText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeName(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");
}

function canonicalMarketType(providerMarketType: string) {
  return CANONICAL_MARKET_MAP[providerMarketType] ?? providerMarketType;
}

function statLabel(marketType: string) {
  return MARKET_LABELS[marketType] ?? marketType.replaceAll("_", " ");
}

function leagueIdFromSport(sport: NormalizeOptions["sport"]) {
  if (sport === "MLB") return "mlb";
  if (sport === "WNBA") return "wnba";
  return "nba";
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
  ].map(asText).filter(Boolean);
  const directionWords = new Set(["over", "under", "more", "less"]);
  return candidates.find((value) => !directionWords.has(value.toLowerCase())) ?? "";
}

function teamNameFromRow(row: Record<string, unknown>, homeTeam: string, awayTeam: string) {
  const candidates = [
    row.team,
    row.team_name,
    row.player_team,
    row.playerTeam,
  ].map(asText).filter(Boolean);
  return candidates.find((value) => value === homeTeam || value === awayTeam) ?? null;
}

function isFutureGame(gameTime: string, now = Date.now()) {
  const timestamp = new Date(gameTime).getTime();
  return Number.isFinite(timestamp) && timestamp > now;
}

function isMainLineRow(row: Record<string, unknown>) {
  if (row.is_main_line === true) return true;
  if (row.is_alternate_line === false) return true;
  if (row.is_main_line === false || row.is_alternate_line === true) return false;
  return true;
}

type GroupedMarket = {
  representative: Record<string, unknown>;
  rows: Record<string, unknown>[];
  overPrice: number | null;
  underPrice: number | null;
};

export function normalizeSharpApiMarketPayload(payload: SharpApiOddsPayload, options: NormalizeOptions) {
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const groups = new Map<string, GroupedMarket>();
  let rejected = 0;
  const now = Date.now();
  const sportsbookFilter = normalizeKey(options.sportsbook ?? "");
  const providerMarketFilter = normalizeKey(options.providerMarketType ?? "");

  for (const value of rows) {
    if (!value || typeof value !== "object") {
      rejected += 1;
      continue;
    }
    const row = value as Record<string, unknown>;
    if (row.is_player_prop !== true) {
      rejected += 1;
      continue;
    }
    const eventId = asText(row.event_id);
    const playerName = playerNameFromRow(row);
    const providerMarketType = normalizeKey(asText(row.market_type));
    const selectionType = normalizeKey(asText(row.selection_type ?? row.side ?? row.market_side));
    const line = asNumber(row.line ?? row.handicap ?? row.points);
    const gameTime = asText(row.event_start_time);
    const sportsbook = asText(row.sportsbook);
    const homeTeam = asText(row.home_team);
    const awayTeam = asText(row.away_team);
    if (!isMainLineRow(row) || !eventId || !playerName || !providerMarketType || line === null || !gameTime || !homeTeam || !awayTeam || !sportsbook || !isFutureGame(gameTime, now)) {
      rejected += 1;
      continue;
    }
    if (sportsbookFilter && normalizeKey(sportsbook) !== sportsbookFilter) {
      rejected += 1;
      continue;
    }
    if (providerMarketFilter && providerMarketType !== providerMarketFilter) {
      rejected += 1;
      continue;
    }
    if (selectionType !== "over" && selectionType !== "under" && selectionType !== "more" && selectionType !== "less") {
      rejected += 1;
      continue;
    }
    const canonicalMarket = canonicalMarketType(providerMarketType);
    const key = [
      options.sport,
      eventId,
      normalizeName(playerName),
      normalizeKey(sportsbook),
      canonicalMarket,
      String(line),
    ].join("|");
    const existing = groups.get(key) ?? {
      representative: row,
      rows: [],
      overPrice: null,
      underPrice: null,
    };
    existing.rows.push(row);
    const price = asNumber(row.odds_american);
    if (selectionType === "over" || selectionType === "more") existing.overPrice = price;
    if (selectionType === "under" || selectionType === "less") existing.underPrice = price;
    groups.set(key, existing);
  }

  const candidates: NormalizedSharpMarketCandidate[] = [...groups.values()].map((group) => {
    const row = group.representative;
    const providerMarketType = normalizeKey(asText(row.market_type));
    const marketType = canonicalMarketType(providerMarketType);
    const homeTeam = asText(row.home_team);
    const awayTeam = asText(row.away_team);
    return {
      provider: "sharpapi",
      sport: options.sport,
      leagueId: leagueIdFromSport(options.sport),
      eventId: asText(row.event_id),
      providerMarketType,
      marketType,
      statType: statLabel(marketType),
      playerName: playerNameFromRow(row),
      team: teamNameFromRow(row, homeTeam, awayTeam),
      homeTeam,
      awayTeam,
      gameTime: new Date(asText(row.event_start_time)).toISOString(),
      sportsbook: asText(row.sportsbook),
      line: Number(row.line ?? row.handicap ?? row.points),
      overPrice: group.overPrice,
      underPrice: group.underPrice,
      rawPayload: {
        event_id: row.event_id,
        market_type: row.market_type,
        player_name: playerNameFromRow(row),
        sportsbook: row.sportsbook,
        event_start_time: row.event_start_time,
        line: row.line ?? row.handicap ?? row.points,
      },
      rawRows: group.rows,
      limitations: [
        "SharpAPI provides live market prices and contest context, but not full statistical enrichment.",
        "Main lines are kept; alternate lines are filtered out before storage.",
      ],
      dataQuality: group.overPrice !== null && group.underPrice !== null ? "partial" : "incomplete",
    };
  });

  return {
    candidates: candidates.sort((left, right) => new Date(left.gameTime).getTime() - new Date(right.gameTime).getTime() || left.playerName.localeCompare(right.playerName) || left.marketType.localeCompare(right.marketType)),
    rejected,
    sourceRecords: rows.length,
  };
}
