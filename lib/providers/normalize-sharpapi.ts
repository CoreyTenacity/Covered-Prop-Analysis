import type { Direction, Sport } from "@/lib/types";
import type { SharpApiOddsPayload } from "./sharpapi";

export type NormalizedPropCandidate = {
  id: string;
  provider: "sharpapi";
  sport: Sport;
  eventId: string;
  playerName: string;
  team: null;
  homeTeam: string;
  awayTeam: string;
  gameTime: string;
  marketKey: string;
  statType: string;
  direction: Direction;
  line: number;
  books: Array<{ sportsbook: string; americanOdds: number | null }>;
  medianAmericanOdds: number | null;
  rawPayload: Record<string, unknown>;
  dataQuality: "incomplete";
  limitations: string[];
};

const marketLabels: Record<string, string> = {
  player_singles: "Singles",
  player_doubles: "Doubles",
  player_triples: "Triples",
  player_hits: "Hits",
  player_runs: "Runs",
  player_rbis: "RBIs",
  player_home_runs: "Home Runs",
  player_total_bases: "Total Bases",
  player_stolen_bases: "Stolen Bases",
  player_batting_strikeouts: "Batting Strikeouts",
  player_strikeouts: "Pitcher Strikeouts",
  player_earned_runs: "Earned Runs Allowed",
  player_hits_allowed: "Hits Allowed",
  player_walks_allowed: "Walks Allowed",
  player_walks: "Walks",
  player_hit_by_pitch: "Hit By Pitch",
  player_outs_recorded: "Outs Recorded",
  player_hits_runs_rbis: "Hits + Runs + RBIs",
  player_runs_rbis: "Runs + RBIs",
  player_hits_total_bases: "Hits + Total Bases",
  player_hits_runs_total_bases: "Hits + Runs + Total Bases",
  player_hits_runs_total_bases_rbis: "Hits + Runs + Total Bases + RBIs",
  player_fantasy_score: "Fantasy Score",
  player_on_base_percentage: "On-Base Percentage",
  player_slugging_percentage: "Slugging Percentage",
  player_points: "Points",
  player_rebounds: "Rebounds",
  player_assists: "Assists",
  player_threes: "Three-Pointers Made",
  player_field_goals_made: "Field Goals Made",
  player_field_goals_attempted: "Field Goals Attempted",
  player_free_throws_made: "Free Throws Made",
  player_free_throws_attempted: "Free Throws Attempted",
  player_turnovers: "Turnovers",
  player_steals: "Steals",
  player_blocks: "Blocks",
  player_points_rebounds: "Points + Rebounds",
  player_points_assists: "Points + Assists",
  player_rebounds_assists: "Rebounds + Assists",
  player_points_rebounds_assists: "Points + Rebounds + Assists",
  player_double_double: "Double Double",
  player_triple_double: "Triple Double",
  player_pass_yds: "Passing Yards",
  player_rush_yds: "Rushing Yards",
  player_reception_yds: "Receiving Yards",
  player_receptions: "Receptions",
};

function asText(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function asNumber(value: unknown) { const number = Number(value); return Number.isFinite(number) ? number : null; }
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
function isFutureGame(gameTime: string, now = Date.now()) {
  const timestamp = new Date(gameTime).getTime();
  return Number.isFinite(timestamp) && timestamp > now;
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
function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function normalizeSharpApiProps(payload: SharpApiOddsPayload, sport: Sport) {
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const groups = new Map<string, Map<string, { row: Record<string, unknown>; books: Map<string, number | null> }>>();
  let rejected = 0;
  const now = Date.now();

  for (const value of rows) {
    if (!value || typeof value !== "object") { rejected++; continue; }
    const row = value as Record<string, unknown>;
    if (row.is_player_prop !== true) { rejected++; continue; }
    const eventId = asText(row.event_id);
    const playerName = playerNameFromRow(row);
    const marketKey = normalizeMarketKey(asText(row.market_type));
    const directionValue = asText(row.selection_type).toLowerCase();
    const direction = directionValue === "over" ? "More" : directionValue === "under" ? "Less" : null;
    const line = asNumber(row.line);
    const gameTime = asText(row.event_start_time);
    if (!isMainLineRow(row) || !eventId || !playerName || !marketKey || !direction || line === null || line <= 0 || !gameTime || Number.isNaN(new Date(gameTime).getTime()) || !isFutureGame(gameTime, now)) { rejected++; continue; }
    const key = [sport, eventId, playerName.toLowerCase(), marketKey].join("|");
    const lineKey = String(line);
    const group = groups.get(key) ?? new Map<string, { row: Record<string, unknown>; books: Map<string, number | null> }>();
    const lineGroup = group.get(lineKey) ?? { row, books: new Map<string, number | null>() };
    const sportsbook = asText(row.sportsbook);
    if (sportsbook) lineGroup.books.set(sportsbook, asNumber(row.odds_american));
    group.set(lineKey, lineGroup);
    groups.set(key, group);
  }

  const candidates: NormalizedPropCandidate[] = [...groups.entries()].map(([id, lineGroups]) => {
    const lineValues = [...lineGroups.keys()].map((lineKey) => Number(lineKey)).filter((value) => Number.isFinite(value));
    const medianLine = median(lineValues) ?? lineValues[0] ?? 0;
    const rankedLines = [...lineGroups.entries()]
      .map(([lineKey, group]) => {
        const bookEntries = [...group.books.entries()].map(([sportsbook, americanOdds]) => ({ sportsbook, americanOdds }));
        return {
          line: Number(lineKey),
          row: group.row,
          books: group.books,
          bookEntries,
          support: bookEntries.length,
          medianOdds: median(bookEntries.map((book) => book.americanOdds).filter((odds): odds is number => odds !== null)),
        };
      })
      .sort((left, right) => right.support - left.support || Math.abs(left.line - medianLine) - Math.abs(right.line - medianLine));
    const chosen = rankedLines[0];
    const row = chosen.row;
    const bookEntries = chosen.bookEntries;
    const marketKey = id.split("|").at(-1) ?? normalizeMarketKey(asText(row.market_type));
    return {
      id: `sharpapi:${id}:${chosen.line}`,
      provider: "sharpapi",
      sport,
      eventId: asText(row.event_id),
      playerName: playerNameFromRow(row),
      team: null,
      homeTeam: asText(row.home_team),
      awayTeam: asText(row.away_team),
      gameTime: new Date(asText(row.event_start_time)).toISOString(),
      marketKey,
      statType: marketLabels[marketKey] ?? marketKey.replaceAll("_", " "),
      direction: chosen.row.selection_type && asText(chosen.row.selection_type).toLowerCase() === "under" ? "Less" : "More",
      line: chosen.line,
      books: bookEntries,
      medianAmericanOdds: chosen.medianOdds,
      rawPayload: chosen.row,
      dataQuality: "incomplete",
      limitations: ["Player team is not identified in this odds payload.", "Odds establish the available line, not a statistical projection.", "Alternate lines for the same player/market are collapsed to the consensus line before scoring."],
    };
  });

  return { candidates, rejected, sourceRecords: rows.length };
}
