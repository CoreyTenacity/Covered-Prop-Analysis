/**
 * SportsDataverse WNBA ingestion.
 *
 * Source: sportsdataverse/wehoop-wnba-data (ESPN-backed, published parquet files).
 * Verified reachable and fresh from GitHub Actions in
 * docs/WNBA_PROVIDER_EVIDENCE_AUDIT.md (Section 4-5): 89ms download,
 * same-day freshness (a game that ended ~9 hours before the file's last
 * commit was already present with a final score).
 *
 * This module is intended to run only inside GitHub Actions (or another
 * batch/cron context), never inside the Vercel request lifecycle - it does
 * bulk historical writes that don't belong in a request-scoped handler.
 *
 * Ownership (per docs/WNBA_PROVIDER_EVIDENCE_AUDIT.md and the architecture
 * decision that followed it): SportsDataverse owns durable completed-game
 * records, historical player/team game logs. It never writes SharpAPI market
 * data and only ingests games ESPN already marked completed in this dataset
 * (status_type_completed = true) - it does not create or modify in-progress
 * or future-scheduled events; that remains ESPN's responsibility.
 *
 * Incremental by default: each run looks up the most recent game_date
 * already ingested by this provider and only processes games since then
 * (minus a small overlap window for late corrections), instead of
 * reprocessing the whole season every time. Pass forceFullBackfill: true
 * (or set WNBA_HISTORY_FORCE_FULL_BACKFILL=true for the job) for a one-off
 * full re-ingestion.
 */

import { parquetReadObjects } from "hyparquet";
import { insertRows, deleteRows, selectRows } from "@/lib/db/supabase-server";
import { ACTIVE_LEAGUES, ensureEvent, ensurePlayer, ensureTeam, easternDate, addDays } from "@/lib/knowledge/enrichment/shared";

export const SPORTSDATAVERSE_WNBA_PROVIDER = "sportsdataverse-wnba";
const WNBA_CONFIG = ACTIVE_LEAGUES.WNBA;

// How far back to re-check past the last-ingested date. Catches late
// box-score corrections without re-processing the whole season - see
// "Why incremental" thread: full re-ingestion daily cost ~9 minutes of
// GitHub Actions compute and thousands of unnecessary Supabase writes for
// rows that essentially never change once a game is final.
const INCREMENTAL_OVERLAP_DAYS = 3;

const RAW_BASE_URL = "https://raw.githubusercontent.com/sportsdataverse/wehoop-wnba-data/main/wnba";
const COMMITS_API_URL = "https://api.github.com/repos/sportsdataverse/wehoop-wnba-data/commits";
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DOWNLOAD_MAX_ATTEMPTS = 3;
const DOWNLOAD_BACKOFF_MS = 2_000;

function log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}) {
  const payload = { provider: SPORTSDATAVERSE_WNBA_PROVIDER, level, message, ...fields, timestamp: new Date().toISOString() };
  if (level === "error") console.error(JSON.stringify(payload));
  else if (level === "warn") console.warn(JSON.stringify(payload));
  else console.log(JSON.stringify(payload));
}

function safeNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  // hyparquet decodes parquet DATE/TIMESTAMP logical-type columns (e.g.
  // player_box.game_date, team_box.game_date) into native JS Date objects,
  // while other columns with the same conceptual meaning (schedules.date)
  // are plain strings in this dataset's schema. Confirmed by direct
  // inspection of both files - not documented anywhere upstream.
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return "";
}

function safeDateOnly(value: unknown): string {
  const text = safeText(value);
  return text ? text.slice(0, 10) : "";
}

function safeBool(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

async function downloadParquetFile(datasetPath: string): Promise<ArrayBuffer> {
  const url = `${RAW_BASE_URL}/${datasetPath}`;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    try {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      } finally {
        clearTimeout(timeoutHandle);
      }
      const durationMs = Date.now() - startedAt;
      if (!response.ok) throw new Error(`SportsDataverse file download failed with status ${response.status}.`);
      const buf = await response.arrayBuffer();
      log("info", "Downloaded SportsDataverse parquet file", { url, bytes: buf.byteLength, durationMs, attempt });
      return buf;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      log("warn", "SportsDataverse download attempt failed", { url, attempt, errorName: lastError.name, errorMessage: lastError.message });
      if (attempt < DOWNLOAD_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_BACKOFF_MS * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastError ?? new Error("SportsDataverse download failed for an unknown reason.");
}

/**
 * Looks up the last commit timestamp for a specific file in the source repo.
 * Used as source_updated_at for the whole ingested batch - a reasonable
 * proxy since the repo commits schedules/player_box/team_box together in
 * one daily workflow run (confirmed in the evidence audit: both files had
 * an identical last-commit timestamp).
 */
async function fetchFileSourceUpdatedAt(datasetPath: string): Promise<string | null> {
  const url = `${COMMITS_API_URL}?path=wnba/${datasetPath}&per_page=1`;
  try {
    const response = await fetch(url, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10_000), cache: "no-store" });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!Array.isArray(payload) || !payload[0]) return null;
    const date = payload[0]?.commit?.committer?.date;
    return typeof date === "string" ? date : null;
  } catch (error) {
    log("warn", "Could not resolve SportsDataverse source_updated_at (non-fatal)", {
      datasetPath,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }
}

type ScheduleRow = {
  id: number;
  date: string;
  status_type_completed: boolean;
  home_id: number;
  home_display_name: string;
  home_abbreviation: string;
  home_score: number | string | null;
  away_id: number;
  away_display_name: string;
  away_abbreviation: string;
  away_score: number | string | null;
  venue_full_name: string | null;
  venue_address_city: string | null;
  venue_address_state: string | null;
  season: number;
};

type PlayerBoxRow = {
  game_id: number;
  game_date: string;
  athlete_id: number;
  athlete_display_name: string;
  team_id: number;
  minutes: number | string | null;
  points: number | string | null;
  rebounds: number | string | null;
  assists: number | string | null;
  steals: number | string | null;
  blocks: number | string | null;
  turnovers: number | string | null;
  field_goals_made: number | string | null;
  field_goals_attempted: number | string | null;
  three_point_field_goals_made: number | string | null;
  three_point_field_goals_attempted: number | string | null;
  free_throws_made: number | string | null;
  free_throws_attempted: number | string | null;
  starter: boolean;
};

type TeamBoxRow = {
  game_id: number;
  game_date: string;
  team_id: number;
  team_display_name: string;
  team_score: number | string | null;
  opponent_team_id: number;
  opponent_team_score: number | string | null;
  rebounds: number | string | null;
  offensive_rebounds: number | string | null;
  defensive_rebounds: number | string | null;
  assists: number | string | null;
  steals: number | string | null;
  blocks: number | string | null;
  turnovers: number | string | null;
  total_turnovers: number | string | null;
  field_goals_made: number | string | null;
  field_goals_attempted: number | string | null;
  free_throws_attempted: number | string | null;
};

/**
 * Estimated possessions for one team in one game, using the standard
 * simplified single-team formula (FGA - OREB + TOV + 0.44*FTA). WNBA games
 * are 40 minutes (not 48 like the NBA), so pace here is a raw per-game
 * possession count, not normalized to an NBA-style "per-48" figure - it is
 * still directly comparable team-to-team and game-to-game since every WNBA
 * regulation game is the same length.
 */
function estimatePossessions(row: TeamBoxRow): number | null {
  const fga = safeNumber(row.field_goals_attempted);
  const oreb = safeNumber(row.offensive_rebounds);
  const tov = safeNumber(row.total_turnovers ?? row.turnovers);
  const fta = safeNumber(row.free_throws_attempted);
  if (fga === null || tov === null) return null;
  return fga - (oreb ?? 0) + tov + 0.44 * (fta ?? 0);
}

export type ScheduleIngestResult = {
  rowsRead: number;
  completedGames: number;
  skippedIncomplete: number;
  skippedMalformed: number;
  skippedOutsideWindow: number;
  eventsUpserted: number;
  sourceUpdatedAt: string | null;
  watermark: string | null;
  eventIdByExternalId: Map<string, string>;
  teamIdByExternalId: Map<string, string>;
};

/**
 * Finds the most recent game_date already ingested by this provider, so a
 * daily run only needs to process games since then (plus a small overlap
 * window for late corrections) instead of the whole season every time.
 * Returns null on the very first run (nothing ingested yet -> full backfill).
 */
async function getIncrementalWatermark(): Promise<string | null> {
  const rows = await selectRows<{ game_date: string }>("player_game_logs", {
    select: "game_date",
    filters: [
      { column: "provider", value: SPORTSDATAVERSE_WNBA_PROVIDER },
      { column: "league_id", value: WNBA_CONFIG.leagueId },
    ],
    orderBy: "game_date.desc",
    limit: 1,
  }).catch(() => []);
  const lastDate = rows[0]?.game_date ?? null;
  if (!lastDate) return null;
  return easternDate(addDays(new Date(`${lastDate}T12:00:00Z`), -INCREMENTAL_OVERLAP_DAYS));
}

export async function ingestSportsDataverseWnbaSchedules(season: number, options: { forceFullBackfill?: boolean } = {}): Promise<ScheduleIngestResult> {
  const datasetPath = `schedules/parquet/wnba_schedule_${season}.parquet`;
  const [buffer, sourceUpdatedAt, watermark] = await Promise.all([
    downloadParquetFile(datasetPath),
    fetchFileSourceUpdatedAt(datasetPath),
    options.forceFullBackfill ? Promise.resolve(null) : getIncrementalWatermark(),
  ]);

  const rows = await parquetReadObjects({
    file: buffer,
    columns: [
      "id", "date", "status_type_completed",
      "home_id", "home_display_name", "home_abbreviation", "home_score",
      "away_id", "away_display_name", "away_abbreviation", "away_score",
      "venue_full_name", "venue_address_city", "venue_address_state", "season",
    ],
  }) as ScheduleRow[];

  const eventIdByExternalId = new Map<string, string>();
  const teamIdByExternalId = new Map<string, string>();
  let completedGames = 0;
  let skippedIncomplete = 0;
  let skippedMalformed = 0;
  let skippedOutsideWindow = 0;
  let eventsUpserted = 0;

  for (const row of rows) {
    if (!safeBool(row.status_type_completed)) {
      skippedIncomplete += 1;
      continue;
    }
    const gameId = safeText(row.id);
    const homeName = safeText(row.home_display_name);
    const awayName = safeText(row.away_display_name);
    const isoDate = safeText(row.date);
    if (!gameId || !homeName || !awayName || !isoDate) {
      skippedMalformed += 1;
      continue;
    }
    if (watermark && easternDate(new Date(isoDate)) < watermark) {
      skippedOutsideWindow += 1;
      continue;
    }
    completedGames += 1;

    const scheduledDate = easternDate(new Date(isoDate));
    const homeTeamId = await ensureTeam({
      league: "WNBA",
      provider: SPORTSDATAVERSE_WNBA_PROVIDER,
      externalId: safeText(row.home_id),
      name: homeName,
      abbreviation: safeText(row.home_abbreviation) || null,
      metadata: { from: "sportsdataverse_schedule" },
    });
    const awayTeamId = await ensureTeam({
      league: "WNBA",
      provider: SPORTSDATAVERSE_WNBA_PROVIDER,
      externalId: safeText(row.away_id),
      name: awayName,
      abbreviation: safeText(row.away_abbreviation) || null,
      metadata: { from: "sportsdataverse_schedule" },
    });
    if (row.home_id !== undefined) teamIdByExternalId.set(safeText(row.home_id), homeTeamId);
    if (row.away_id !== undefined) teamIdByExternalId.set(safeText(row.away_id), awayTeamId);

    // Cross-provider dedup: ensureEvent falls back to matching on
    // (league_id, scheduled_date, home_team_id, away_team_id) when no
    // source_mapping exists yet for this specific provider, so a game
    // ESPN already created (via espn-wnba) is reused here rather than
    // duplicated - it just gains an additional source_mappings row for
    // sportsdataverse-wnba.
    const eventId = await ensureEvent({
      league: "WNBA",
      provider: SPORTSDATAVERSE_WNBA_PROVIDER,
      externalId: gameId,
      season: safeText(row.season) || String(season),
      scheduledDate,
      startTime: isoDate,
      status: "completed",
      displayName: `${awayName} at ${homeName}`,
      homeTeamId,
      awayTeamId,
      venue: safeText(row.venue_full_name) || null,
      venueCity: safeText(row.venue_address_city) || null,
      venueState: safeText(row.venue_address_state) || null,
      metadata: {
        home_score: safeNumber(row.home_score),
        away_score: safeNumber(row.away_score),
        source: SPORTSDATAVERSE_WNBA_PROVIDER,
      },
    });
    eventIdByExternalId.set(gameId, eventId);
    eventsUpserted += 1;
  }

  log("info", "SportsDataverse WNBA schedule ingestion complete", {
    season, rowsRead: rows.length, completedGames, skippedIncomplete, skippedMalformed, skippedOutsideWindow, eventsUpserted, watermark,
  });

  return { rowsRead: rows.length, completedGames, skippedIncomplete, skippedMalformed, skippedOutsideWindow, eventsUpserted, sourceUpdatedAt, watermark, eventIdByExternalId, teamIdByExternalId };
}

export type PlayerBoxIngestResult = {
  rowsRead: number;
  skippedNoEvent: number;
  skippedMalformed: number;
  playersUpserted: number;
  gameLogsInserted: number;
};

export async function ingestSportsDataverseWnbaPlayerBox(
  season: number,
  schedule: Pick<ScheduleIngestResult, "eventIdByExternalId" | "teamIdByExternalId" | "sourceUpdatedAt">,
): Promise<PlayerBoxIngestResult> {
  const datasetPath = `player_box/parquet/player_box_${season}.parquet`;
  const buffer = await downloadParquetFile(datasetPath);
  const rows = await parquetReadObjects({
    file: buffer,
    columns: [
      "game_id", "game_date", "athlete_id", "athlete_display_name", "team_id",
      "minutes", "points", "rebounds", "assists", "steals", "blocks", "turnovers",
      "field_goals_made", "field_goals_attempted",
      "three_point_field_goals_made", "three_point_field_goals_attempted",
      "free_throws_made", "free_throws_attempted", "starter",
    ],
  }) as PlayerBoxRow[];

  let skippedNoEvent = 0;
  let skippedMalformed = 0;
  let playersUpserted = 0;
  const recordsByPlayerAndDate = new Map<string, Record<string, unknown>>();
  const playerIdCache = new Map<number, string>();

  for (const row of rows) {
    const gameId = safeText(row.game_id);
    const eventId = schedule.eventIdByExternalId.get(gameId);
    if (!eventId) {
      skippedNoEvent += 1;
      continue;
    }
    const athleteId = row.athlete_id;
    const athleteName = safeText(row.athlete_display_name);
    const gameDate = safeDateOnly(row.game_date);
    if (athleteId === undefined || athleteId === null || !athleteName || !gameDate) {
      skippedMalformed += 1;
      continue;
    }

    const currentTeamId = schedule.teamIdByExternalId.get(safeText(row.team_id)) ?? null;
    let playerId = playerIdCache.get(athleteId);
    if (!playerId) {
      playerId = await ensurePlayer({
        league: "WNBA",
        provider: SPORTSDATAVERSE_WNBA_PROVIDER,
        externalId: safeText(athleteId),
        canonicalName: athleteName,
        displayName: athleteName,
        currentTeamId,
        active: true,
        metadata: { from: "sportsdataverse_player_box" },
      });
      playerIdCache.set(athleteId, playerId);
      playersUpserted += 1;
    }

    const key = `${playerId}|${gameDate}`;
    recordsByPlayerAndDate.set(key, {
      sport_id: WNBA_CONFIG.sportId,
      league_id: WNBA_CONFIG.leagueId,
      player_id: playerId,
      team_id: currentTeamId,
      opponent_team_id: null,
      event_id: eventId,
      game_id: eventId,
      game_date: gameDate,
      season: String(season),
      provider: SPORTSDATAVERSE_WNBA_PROVIDER,
      minutes: safeNumber(row.minutes),
      points: safeNumber(row.points),
      rebounds: safeNumber(row.rebounds),
      assists: safeNumber(row.assists),
      steals: safeNumber(row.steals),
      blocks: safeNumber(row.blocks),
      turnovers: safeNumber(row.turnovers),
      stat_line: {
        starter: safeBool(row.starter),
        field_goals_made: safeNumber(row.field_goals_made),
        field_goals_attempted: safeNumber(row.field_goals_attempted),
        three_pointers_made: safeNumber(row.three_point_field_goals_made),
        three_pointers_attempted: safeNumber(row.three_point_field_goals_attempted),
        free_throws_made: safeNumber(row.free_throws_made),
        free_throws_attempted: safeNumber(row.free_throws_attempted),
      },
      raw_payload: row as unknown as Record<string, unknown>,
      source_updated_at: schedule.sourceUpdatedAt,
    });
  }

  const records = [...recordsByPlayerAndDate.values()];
  let gameLogsInserted = 0;
  if (records.length) {
    // Delete-then-insert on the exact (provider, player_id, game_date) keys
    // in this batch only - matches the existing pattern used elsewhere in
    // the enrichment layer (see basketball.ts refreshBasketballPlayerLogs)
    // and avoids the ON CONFLICT limitation of the expression-based unique
    // index on player_game_logs, while not touching rows outside this batch.
    for (const record of records) {
      await deleteRows("player_game_logs", [
        { column: "provider", value: SPORTSDATAVERSE_WNBA_PROVIDER },
        { column: "player_id", value: record.player_id as string },
        { column: "game_date", value: record.game_date as string },
      ]).catch(() => {});
    }
    await insertRows("player_game_logs", records, { returning: "minimal" });
    gameLogsInserted = records.length;
  }

  log("info", "SportsDataverse WNBA player box ingestion complete", {
    season, rowsRead: rows.length, skippedNoEvent, skippedMalformed, playersUpserted, gameLogsInserted,
  });

  return { rowsRead: rows.length, skippedNoEvent, skippedMalformed, playersUpserted, gameLogsInserted };
}

export type TeamBoxIngestResult = {
  rowsRead: number;
  skippedNoEvent: number;
  skippedMalformed: number;
  teamLogsInserted: number;
};

export async function ingestSportsDataverseWnbaTeamBox(
  season: number,
  schedule: Pick<ScheduleIngestResult, "eventIdByExternalId" | "teamIdByExternalId" | "sourceUpdatedAt">,
): Promise<TeamBoxIngestResult> {
  const datasetPath = `team_box/parquet/team_box_${season}.parquet`;
  const buffer = await downloadParquetFile(datasetPath);
  const rows = await parquetReadObjects({
    file: buffer,
    columns: [
      "game_id", "game_date", "team_id", "team_display_name", "team_score", "opponent_team_id", "opponent_team_score",
      "rebounds", "offensive_rebounds", "defensive_rebounds", "assists", "steals", "blocks", "turnovers", "total_turnovers",
      "field_goals_made", "field_goals_attempted", "free_throws_attempted",
    ],
  }) as TeamBoxRow[];

  // Both teams' rows for a given game are in this same file, so the
  // opponent's box stats needed to estimate that team's own possessions
  // (for a two-sided pace average) are available without a second request.
  const rowsByGameId = new Map<string, TeamBoxRow[]>();
  for (const row of rows) {
    const gameId = safeText(row.game_id);
    if (!gameId) continue;
    const bucket = rowsByGameId.get(gameId) ?? [];
    bucket.push(row);
    rowsByGameId.set(gameId, bucket);
  }

  let skippedNoEvent = 0;
  let skippedMalformed = 0;
  const records: Record<string, unknown>[] = [];

  for (const row of rows) {
    const gameId = safeText(row.game_id);
    const eventId = schedule.eventIdByExternalId.get(gameId);
    if (!eventId) {
      skippedNoEvent += 1;
      continue;
    }
    const teamId = schedule.teamIdByExternalId.get(safeText(row.team_id));
    const gameDate = safeDateOnly(row.game_date);
    if (!teamId || !gameDate) {
      skippedMalformed += 1;
      continue;
    }
    const opponentTeamId = schedule.teamIdByExternalId.get(safeText(row.opponent_team_id)) ?? null;

    const opponentRow = (rowsByGameId.get(gameId) ?? []).find((r) => safeText(r.team_id) === safeText(row.opponent_team_id));
    const ownPoss = estimatePossessions(row);
    const oppPoss = opponentRow ? estimatePossessions(opponentRow) : null;
    const gamePace = ownPoss !== null && oppPoss !== null ? (ownPoss + oppPoss) / 2 : ownPoss;
    const teamScore = safeNumber(row.team_score);
    const opponentScore = safeNumber(row.opponent_team_score);
    const offensiveRating = gamePace && teamScore !== null ? (100 * teamScore) / gamePace : null;
    const defensiveRating = gamePace && opponentScore !== null ? (100 * opponentScore) / gamePace : null;

    records.push({
      sport_id: WNBA_CONFIG.sportId,
      league_id: WNBA_CONFIG.leagueId,
      team_id: teamId,
      opponent_team_id: opponentTeamId,
      event_id: eventId,
      game_id: eventId,
      game_date: gameDate,
      season: String(season),
      provider: SPORTSDATAVERSE_WNBA_PROVIDER,
      team_total: teamScore,
      pace: gamePace,
      offensive_rating: offensiveRating,
      defensive_rating: defensiveRating,
      possessions: ownPoss,
      implied_total: null,
      stat_line: {
        rebounds: safeNumber(row.rebounds),
        offensive_rebounds: safeNumber(row.offensive_rebounds),
        defensive_rebounds: safeNumber(row.defensive_rebounds),
        assists: safeNumber(row.assists),
        steals: safeNumber(row.steals),
        blocks: safeNumber(row.blocks),
        turnovers: safeNumber(row.total_turnovers ?? row.turnovers),
        field_goals_made: safeNumber(row.field_goals_made),
        field_goals_attempted: safeNumber(row.field_goals_attempted),
        opponent_score: opponentScore,
      },
      raw_payload: row as unknown as Record<string, unknown>,
      source_updated_at: schedule.sourceUpdatedAt,
    });
  }

  let teamLogsInserted = 0;
  if (records.length) {
    for (const record of records) {
      await deleteRows("team_game_logs", [
        { column: "provider", value: SPORTSDATAVERSE_WNBA_PROVIDER },
        { column: "team_id", value: record.team_id as string },
        { column: "game_date", value: record.game_date as string },
      ]).catch(() => {});
    }
    await insertRows("team_game_logs", records, { returning: "minimal" });
    teamLogsInserted = records.length;
  }

  log("info", "SportsDataverse WNBA team box ingestion complete", {
    season, rowsRead: rows.length, skippedNoEvent, skippedMalformed, teamLogsInserted,
  });

  return { rowsRead: rows.length, skippedNoEvent, skippedMalformed, teamLogsInserted };
}

export type SportsDataverseWnbaIngestSummary = {
  season: number;
  schedules: ScheduleIngestResult;
  playerBox: PlayerBoxIngestResult;
  teamBox: TeamBoxIngestResult;
};

/**
 * Orchestrates the full ingestion for a single season: schedules first
 * (to build the event/team id maps), then player and team box scores.
 * Bounded to one season per call - no unbounded backfill.
 */
export async function ingestSportsDataverseWnbaSeason(season: number, options: { forceFullBackfill?: boolean } = {}): Promise<SportsDataverseWnbaIngestSummary> {
  const schedules = await ingestSportsDataverseWnbaSchedules(season, options);
  // player_box/team_box rows for games outside the incremental window
  // naturally fall out via the eventIdByExternalId map (only populated for
  // games the schedule step processed this run), so no separate date
  // filter is needed here - their skippedNoEvent count is dominated by
  // "already ingested in an earlier run", not a real matching failure,
  // on any run after the first.
  const [playerBox, teamBox] = await Promise.all([
    ingestSportsDataverseWnbaPlayerBox(season, schedules),
    ingestSportsDataverseWnbaTeamBox(season, schedules),
  ]);
  return { season, schedules, playerBox, teamBox };
}
