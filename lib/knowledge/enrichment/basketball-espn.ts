/**
 * ESPN-backed WNBA schedule refresh - the replacement for the broken
 * stats.nba.com path in basketball.ts's refreshBasketballSchedulesLiveGate.
 *
 * This is a NEW, separate module. It does not modify basketball.ts, the
 * existing WeHoopWnbaAdapter, or NBA/MLB/NFL/Tennis behavior in any way.
 * It is the DEFAULT WNBA path - invoked whenever resolveWnbaDataProvider()
 * resolves to "espn-sportsdataverse" (unset WNBA_DATA_PROVIDER included;
 * see lib/knowledge/enrichment/shared.ts and jobs.ts's refreshSchedulesLiveGateJob).
 *
 * Source verification: docs/WNBA_PROVIDER_EVIDENCE_AUDIT.md Section 4 -
 * ESPN scoreboard responded in 88ms from GitHub Actions, 200 OK, on the
 * same runner where stats.nba.com fully timed out on both endpoints tested.
 *
 * Ownership per the architecture decision: ESPN owns today's schedule,
 * near-term scheduled games, game status, current score, current matchup
 * identity. It does not touch SharpAPI market data.
 */

import { deleteRows, insertRows, selectRows } from "@/lib/db/supabase-server";
import { ACTIVE_LEAGUES, easternDate, ensureEvent, ensureTeam, getLiveRefreshDateRange } from "@/lib/knowledge/enrichment/shared";
import { SPORTSDATAVERSE_WNBA_PROVIDER } from "@/lib/knowledge/ingestion/sportsdataverse-wnba";
import { EspnWnbaAdapter, type EspnWnbaGameStatus, type EspnWnbaScheduledGame } from "@/lib/providers/espn-wnba";

export const ESPN_WNBA_PROVIDER = "espn-wnba";

function mapStatusToEventStatus(status: EspnWnbaGameStatus): string {
  switch (status) {
    case "final": return "completed";
    case "in_progress": return "live";
    case "postponed": return "postponed";
    case "canceled": return "canceled";
    case "scheduled": return "scheduled";
    default: return "scheduled";
  }
}

async function writeScheduledGame(game: EspnWnbaScheduledGame, scheduledDate: string, season: string) {
  if (!game.gameId || !game.homeTeamName || !game.awayTeamName) return false;
  const homeTeamId = await ensureTeam({
    league: "WNBA",
    provider: ESPN_WNBA_PROVIDER,
    externalId: game.homeTeamId || null,
    name: game.homeTeamName,
    abbreviation: game.homeTeamAbbreviation || null,
    metadata: { from: "espn_scoreboard" },
  });
  const awayTeamId = await ensureTeam({
    league: "WNBA",
    provider: ESPN_WNBA_PROVIDER,
    externalId: game.awayTeamId || null,
    name: game.awayTeamName,
    abbreviation: game.awayTeamAbbreviation || null,
    metadata: { from: "espn_scoreboard" },
  });
  await ensureEvent({
    league: "WNBA",
    provider: ESPN_WNBA_PROVIDER,
    externalId: game.gameId,
    season,
    scheduledDate,
    startTime: game.startTimeUtc,
    status: mapStatusToEventStatus(game.status),
    displayName: `${game.awayTeamName} at ${game.homeTeamName}`,
    homeTeamId,
    awayTeamId,
    venue: game.venueName,
    venueCity: game.venueCity,
    venueState: game.venueState,
    metadata: {
      espn_status: game.status,
      espn_status_detail: game.statusDetail,
      home_score: game.homeScore,
      away_score: game.awayScore,
      source: ESPN_WNBA_PROVIDER,
    },
  });
  return true;
}

export async function refreshWnbaScheduleEspn(now = new Date()) {
  const adapter = new EspnWnbaAdapter();
  const dateRange = getLiveRefreshDateRange(now);
  const season = String(now.getFullYear());

  let count = 0;
  let processedDates = 0;

  for (const date of dateRange.dates) {
    let games: EspnWnbaScheduledGame[];
    try {
      games = await adapter.fetchScheduleForDate(date);
    } catch (error) {
      const errorDetails = {
        league: "WNBA",
        provider: ESPN_WNBA_PROVIDER,
        stage: "provider_fetch",
        requestedDate: date,
        requestedDates: dateRange.dates,
        processedDates,
        processedCount: count,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      const wrapped = new Error(JSON.stringify(errorDetails));
      Object.assign(wrapped, errorDetails);
      throw wrapped;
    }

    for (const game of games) {
      const wrote = await writeScheduledGame(game, date, season);
      if (wrote) count += 1;
    }
    processedDates += 1;
  }

  const futureEventRows = await selectRows<{ id: string }>("events", {
    select: "id",
    filters: [
      { column: "league_id", value: ACTIVE_LEAGUES.WNBA.leagueId },
      { column: "start_time", operator: "gte", value: now.toISOString() },
    ],
    limit: 1,
  });

  if (count === 0) {
    const errorDetails = {
      league: "WNBA",
      provider: ESPN_WNBA_PROVIDER,
      stage: "event_processing",
      requestedDates: dateRange.dates,
      processedDates,
      normalizedEvents: count,
      errorName: "ProcessingError",
      errorMessage: `No events found in ${processedDates} date(s) processed`,
    };
    const error = new Error(JSON.stringify(errorDetails));
    Object.assign(error, errorDetails);
    throw error;
  }

  if (futureEventRows.length === 0) {
    const errorDetails = {
      league: "WNBA",
      provider: ESPN_WNBA_PROVIDER,
      stage: "future_event_verification",
      requestedDates: dateRange.dates,
      processedDates,
      normalizedEvents: count,
      futureEventsVerified: futureEventRows.length,
      errorName: "VerificationError",
      errorMessage: `No future events visible after refresh (${count} events processed)`,
    };
    const error = new Error(JSON.stringify(errorDetails));
    Object.assign(error, errorDetails);
    throw error;
  }

  return {
    league: "WNBA" as const,
    provider: ESPN_WNBA_PROVIDER,
    events: count,
    dates: dateRange.dates,
    futureEventsVerified: futureEventRows.length,
  };
}

/**
 * WNBA team context / matchup features (pace, offensive/defensive rating,
 * W-L record), sourced from team_game_logs rows the SportsDataverse
 * ingestion writes (lib/knowledge/ingestion/sportsdataverse-wnba.ts), not
 * from stats.nba.com.
 *
 * This is the DEFAULT WNBA path for matchup features - active whenever
 * resolveWnbaDataProvider() resolves to "espn-sportsdataverse" (unset
 * WNBA_DATA_PROVIDER included). basketball.ts's refreshBasketballMatchupFeatures
 * is untouched and still runs as-is for NBA unconditionally, and for WNBA
 * only when WNBA_DATA_PROVIDER=legacy-stats-nba is explicitly set - in
 * that legacy path it always attempts a stats.nba.com call first
 * (leagueAdapter() is unconditional), which is confirmed unreachable from
 * GitHub Actions (docs/WNBA_PROVIDER_EVIDENCE_AUDIT.md), so it burns an
 * 18-second timeout before falling through to its own team_game_logs
 * fallback. This function skips straight to the correct data source.
 *
 * Writes the exact same tables/fields refreshBasketballMatchupFeatures
 * writes (basketball_team_context, basketball_opponent_context,
 * matchup_features), so the scoring adapter (lib/knowledge/adapters/basketball.ts)
 * needs no changes - it already reads .pace and .opponent_defensive_rating
 * from these tables regardless of which job populated them.
 */
export async function refreshWnbaMatchupFeatures(now = new Date()) {
  const config = ACTIVE_LEAGUES.WNBA;
  const contextDate = easternDate(now);

  // W-L record: derived from team_game_logs' own team_total vs the
  // opponent's team_total for the same event, rather than a second events
  // query - team_game_logs already has both, one row per team per game.
  const recentLogs = await selectRows<{
    team_id: string;
    event_id: string | null;
    game_date: string;
    team_total: number | null;
    pace: number | null;
    offensive_rating: number | null;
    defensive_rating: number | null;
  }>("team_game_logs", {
    select: "team_id,event_id,game_date,team_total,pace,offensive_rating,defensive_rating",
    filters: [
      { column: "league_id", value: config.leagueId },
      { column: "provider", value: SPORTSDATAVERSE_WNBA_PROVIDER },
    ],
    orderBy: "game_date.desc",
    limit: 500,
  }).catch(() => []);

  const logsByEvent = new Map<string, typeof recentLogs>();
  for (const row of recentLogs) {
    if (!row.event_id) continue;
    const bucket = logsByEvent.get(row.event_id) ?? [];
    bucket.push(row);
    logsByEvent.set(row.event_id, bucket);
  }

  const wins = new Map<string, number>();
  const losses = new Map<string, number>();
  for (const [, pair] of logsByEvent) {
    if (pair.length !== 2) continue;
    const [a, b] = pair;
    if (a.team_total === null || b.team_total === null) continue;
    const winner = a.team_total > b.team_total ? a : b;
    const loser = a.team_total > b.team_total ? b : a;
    wins.set(winner.team_id, (wins.get(winner.team_id) ?? 0) + 1);
    losses.set(loser.team_id, (losses.get(loser.team_id) ?? 0) + 1);
  }

  const logsByTeam = new Map<string, typeof recentLogs>();
  for (const row of recentLogs) {
    const bucket = logsByTeam.get(row.team_id) ?? [];
    bucket.push(row);
    logsByTeam.set(row.team_id, bucket);
  }

  const teamContextMap = new Map<string, { pace: number | null; defensiveRating: number | null; recordSummary: string | null }>();
  let teamContexts = 0;
  for (const [teamId, rowsForTeam] of logsByTeam) {
    const latest = rowsForTeam[0];
    const recordSummary = `${wins.get(teamId) ?? 0}-${losses.get(teamId) ?? 0}`;
    teamContextMap.set(teamId, { pace: latest.pace, defensiveRating: latest.defensive_rating, recordSummary });

    await deleteRows("basketball_team_context", [
      { column: "team_id", value: teamId },
      { column: "context_date", value: contextDate },
    ]).catch(() => {});
    await insertRows("basketball_team_context", [{
      league_id: config.leagueId,
      team_id: teamId,
      game_id: null,
      event_id: null,
      context_date: contextDate,
      pace: latest.pace,
      offensive_rating: latest.offensive_rating,
      defensive_rating: latest.defensive_rating,
      standing: null,
      record_summary: recordSummary,
      context_payload: {
        source: SPORTSDATAVERSE_WNBA_PROVIDER,
        sample_size: rowsForTeam.length,
        latest_game_date: latest.game_date,
      },
    }], { returning: "minimal" });
    teamContexts += 1;
  }

  const upcoming = await selectRows<{ id: string; home_team_id: string | null; away_team_id: string | null; scheduled_date: string }>("events", {
    select: "id,home_team_id,away_team_id,scheduled_date",
    filters: [
      { column: "league_id", value: config.leagueId },
      { column: "start_time", operator: "gte", value: now.toISOString() },
    ],
    orderBy: "start_time.asc",
    limit: 30,
  }).catch(() => []);

  let matchupRows = 0;
  for (const event of upcoming) {
    if (!event.home_team_id || !event.away_team_id) continue;
    const homeContext = teamContextMap.get(event.home_team_id) ?? null;
    const awayContext = teamContextMap.get(event.away_team_id) ?? null;
    for (const [teamId, opponentTeamId, opponent] of [
      [event.home_team_id, event.away_team_id, awayContext],
      [event.away_team_id, event.home_team_id, homeContext],
    ] as const) {
      await deleteRows("basketball_opponent_context", [
        { column: "event_id", value: event.id },
        { column: "team_id", value: teamId },
        { column: "opponent_team_id", value: opponentTeamId },
      ]).catch(() => {});
      await insertRows("basketball_opponent_context", [{
        league_id: config.leagueId,
        team_id: teamId,
        opponent_team_id: opponentTeamId,
        game_id: event.id,
        event_id: event.id,
        context_date: event.scheduled_date,
        opponent_pace: opponent?.pace ?? null,
        opponent_defensive_rating: opponent?.defensiveRating ?? null,
        opponent_record_summary: opponent?.recordSummary ?? null,
        context_payload: { source: SPORTSDATAVERSE_WNBA_PROVIDER },
      }], { returning: "minimal" });

      await deleteRows("matchup_features", [
        { column: "event_id", value: event.id },
        { column: "team_id", value: teamId },
        { column: "opponent_team_id", value: opponentTeamId },
        { column: "feature_date", value: event.scheduled_date },
        { column: "matchup_type", value: "basketball-general" },
      ]).catch(() => {});
      await insertRows("matchup_features", [{
        sport_id: config.sportId,
        league_id: config.leagueId,
        team_id: teamId,
        opponent_team_id: opponentTeamId,
        event_id: event.id,
        game_id: event.id,
        feature_date: event.scheduled_date,
        matchup_type: "basketball-general",
        feature_payload: {
          opponent_pace: opponent?.pace ?? null,
          opponent_defensive_rating: opponent?.defensiveRating ?? null,
          opponent_record_summary: opponent?.recordSummary ?? null,
        },
        data_quality_score: 0.72,
      }], { returning: "minimal" });
      matchupRows += 1;
    }
  }

  return {
    league: "WNBA" as const,
    provider: SPORTSDATAVERSE_WNBA_PROVIDER,
    teamContexts,
    matchupRows,
  };
}
