import { insertRows, selectRows } from "@/lib/db/supabase-server";

type GradeResult = "win" | "loss" | "push" | "no_grade";

type ScoredPropForGrading = {
  id: string;
  current_prop_id: string;
  model_version_id: string | null;
  participant_id: string | null;
  participant_type: string | null;
  player_id: string | null;
  event_id: string | null;
  game_id: string | null;
  market_id: string | null;
  line: number;
  risk_flags: string[];
  league_id: string;
  sport_id: string;
  created_at: string;
};

type CurrentPropForGrading = {
  id: string;
  latest_snapshot_id: string;
  market_type: string;
  side: "More" | "Less" | null;
  direction: "More" | "Less";
  event_id: string | null;
  game_id: string | null;
  player_id: string | null;
  participant_id: string | null;
  participant_type: string | null;
  league_id: string;
  sport_id: string;
};

type EventRow = {
  id: string;
  status: string;
  scheduled_date: string;
  start_time: string;
};

type PlayerGameLog = {
  id: string;
  points: number | null;
  rebounds: number | null;
  assists: number | null;
  fantasy_score: number | null;
  threes_made?: number | null;
  hits: number | null;
  total_bases: number | null;
  runs: number | null;
  rbis: number | null;
  strikeouts: number | null;
  earned_runs: number | null;
  hits_allowed: number | null;
  walks_allowed: number | null;
  outs_recorded: number | null;
  stat_line?: Record<string, unknown>;
};

export type GradeCompletedScoredPropsOptions = {
  sport?: "baseball" | "basketball";
  league?: "mlb" | "nba" | "wnba";
  eventId?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  deps?: {
    selectRows?: typeof selectRows;
    insertRows?: typeof insertRows;
  };
};

type GradeOutput = {
  scoredPropId: string;
  currentPropId: string;
  eventId: string | null;
  marketType: string;
  result: GradeResult;
  // "deferred" = the event is complete but the final stat is not yet stored; we write NOTHING and retry on a
  // later cycle (a terminal `no_grade` row would be blocked forever by the grading_results unique(scored_prop_id)).
  gradeStatus: "graded" | "no_grade" | "already_graded" | "deferred";
  finalStat: number | null;
  gradeReason: string;
  gradingFlags: string[];
};

function buildDeferredResult(input: { scoredPropId: string; currentPropId: string; eventId: string | null; marketType: string; reason: string }): GradeOutput {
  return {
    scoredPropId: input.scoredPropId,
    currentPropId: input.currentPropId,
    eventId: input.eventId,
    marketType: input.marketType,
    result: "no_grade",
    gradeStatus: "deferred",
    finalStat: null,
    gradeReason: input.reason,
    gradingFlags: [input.reason, "deferred"],
  };
}

const SUPPORTED_BASKETBALL_MARKETS = new Set([
  "player_points",
  "player_rebounds",
  "player_assists",
  "player_pra",
  "player_threes",
]);

const SUPPORTED_MLB_MARKETS = new Set([
  "batter_hits",
  "batter_total_bases",
  "pitcher_strikeouts",
  "batter_runs",
  "batter_rbis",
]);

export function isCompletedStatus(status: string | null | undefined) {
  const normalized = String(status ?? "").toLowerCase();
  return ["completed", "final", "closed"].includes(normalized);
}

export function normalizeMarketType(marketType: string) {
  if (marketType === "player_points_rebounds_assists") return "player_pra";
  if (marketType === "player_strikeouts") return "pitcher_strikeouts";
  if (marketType === "player_hits") return "batter_hits";
  if (marketType === "player_total_bases") return "batter_total_bases";
  if (marketType === "player_runs") return "batter_runs";
  if (marketType === "player_rbis") return "batter_rbis";
  return marketType;
}

function statLineNumber(log: PlayerGameLog, ...keys: string[]) {
  const statLine = log.stat_line && typeof log.stat_line === "object" ? log.stat_line : {};
  for (const key of keys) {
    const direct = (log as Record<string, unknown>)[key];
    const directNumber = Number(direct);
    if (Number.isFinite(directNumber)) return directNumber;
    const nested = (statLine as Record<string, unknown>)[key];
    const nestedNumber = Number(nested);
    if (Number.isFinite(nestedNumber)) return nestedNumber;
  }
  return null;
}

export function finalStatForMarket(marketType: string, log: PlayerGameLog) {
  switch (normalizeMarketType(marketType)) {
    case "player_points":
      return log.points;
    case "player_rebounds":
      return log.rebounds;
    case "player_assists":
      return log.assists;
    case "player_pra":
      return (log.points ?? 0) + (log.rebounds ?? 0) + (log.assists ?? 0);
    case "player_threes":
      return statLineNumber(log, "threes_made", "three_pointers_made", "threesMade", "fg3m", "fg3M");
    case "batter_hits":
      return log.hits;
    case "batter_total_bases":
      return log.total_bases;
    case "pitcher_strikeouts":
      return log.strikeouts;
    case "batter_runs":
      return log.runs;
    case "batter_rbis":
      return log.rbis;
    default:
      return null;
  }
}

export function resultFor(side: "More" | "Less", line: number, finalStat: number): GradeResult {
  if (side === "More") {
    if (finalStat > line) return "win";
    if (finalStat < line) return "loss";
    return "push";
  }
  if (finalStat < line) return "win";
  if (finalStat > line) return "loss";
  return "push";
}

export function supportedMarket(leagueId: string, marketType: string) {
  const normalized = normalizeMarketType(marketType);
  if (leagueId === "mlb") return SUPPORTED_MLB_MARKETS.has(normalized);
  if (leagueId === "nba" || leagueId === "wnba") return SUPPORTED_BASKETBALL_MARKETS.has(normalized);
  return false;
}

function buildNoGradeResult(input: {
  scoredPropId: string;
  currentPropId: string;
  eventId: string | null;
  marketType: string;
  reason: string;
  flags: string[];
}) {
  return {
    scoredPropId: input.scoredPropId,
    currentPropId: input.currentPropId,
    eventId: input.eventId,
    marketType: input.marketType,
    result: "no_grade" as const,
    gradeStatus: "no_grade" as const,
    finalStat: null,
    gradeReason: input.reason,
    gradingFlags: [...new Set([...input.flags, "no_grade"])],
  };
}

export async function gradeCompletedScoredProps(options: GradeCompletedScoredPropsOptions = {}) {
  const select = options.deps?.selectRows ?? selectRows;
  const insert = options.deps?.insertRows ?? insertRows;
  const filters: Array<{ column: string; value: string } | { raw: string }> = [];
  if (options.league) filters.push({ column: "league_id", value: options.league });
  if (options.sport) filters.push({ column: "sport_id", value: options.sport });
  if (options.eventId) filters.push({ column: "event_id", value: options.eventId });
  if (options.dateFrom) filters.push({ raw: `created_at=gte.${encodeURIComponent(`${options.dateFrom}T00:00:00Z`)}` });
  if (options.dateTo) filters.push({ raw: `created_at=lte.${encodeURIComponent(`${options.dateTo}T23:59:59Z`)}` });

  const props = await select<ScoredPropForGrading>("scored_props", {
    select: "id,current_prop_id,model_version_id,participant_id,participant_type,player_id,event_id,game_id,market_id,line,risk_flags,league_id,sport_id,created_at",
    filters,
    orderBy: "created_at.desc",
    limit: options.limit ?? 250,
  });

  const outputs: GradeOutput[] = [];

  for (const prop of props) {
    const existing = await select<{ id: string }>("grading_results", {
      select: "id",
      filters: [{ column: "scored_prop_id", value: prop.id }],
      limit: 1,
    });
    if (existing.length) {
      outputs.push({
        scoredPropId: prop.id,
        currentPropId: prop.current_prop_id,
        eventId: prop.event_id,
        marketType: "unknown",
        result: "no_grade",
        gradeStatus: "already_graded",
        finalStat: null,
        gradeReason: "already_graded",
        gradingFlags: ["already_graded"],
      });
      continue;
    }

    const [currentProp] = await select<CurrentPropForGrading>("current_props", {
      select: "id,latest_snapshot_id,market_type,side,direction,event_id,game_id,player_id,participant_id,participant_type,league_id,sport_id",
      filters: [{ column: "id", value: prop.current_prop_id }],
      limit: 1,
    });

    if (!currentProp) {
      const noGrade = buildNoGradeResult({
        scoredPropId: prop.id,
        currentPropId: prop.current_prop_id,
        eventId: prop.event_id,
        marketType: "unknown",
        reason: "missing_current_prop",
        flags: ["missing_event"],
      });
      await insert("grading_results", [{
        scored_prop_id: prop.id,
        current_prop_id: prop.current_prop_id,
        odds_snapshot_id: null,
        participant_id: prop.participant_id,
        participant_type: prop.participant_type,
        player_id: prop.player_id,
        event_id: prop.event_id,
        game_id: prop.game_id,
        market_type: noGrade.marketType,
        stat_type: noGrade.marketType,
        side: null,
        line: prop.line,
        actual_value: null,
        final_stat: null,
        result: "no_grade",
        grade_status: "no_grade",
        grade_reason: noGrade.gradeReason,
        grading_flags: noGrade.gradingFlags,
        grading_source: "knowledge-db",
        model_version_id: prop.model_version_id,
        league_id: prop.league_id,
        sport_id: prop.sport_id,
        notes: "No current prop row was available during grading.",
        factor_snapshot: { scored_risk_flags: prop.risk_flags },
        graded_at: new Date().toISOString(),
      }], { returning: "minimal" });
      outputs.push(noGrade);
      continue;
    }

    const eventId = currentProp.event_id ?? prop.event_id;
    const [event] = eventId
      ? await select<EventRow>("events", {
          select: "id,status,scheduled_date,start_time",
          filters: [{ column: "id", value: eventId }],
          limit: 1,
        })
      : [];

    if (!event) {
      const noGrade = buildNoGradeResult({
        scoredPropId: prop.id,
        currentPropId: prop.current_prop_id,
        eventId,
        marketType: normalizeMarketType(currentProp.market_type),
        reason: "missing_event",
        flags: ["missing_event"],
      });
      await insert("grading_results", [{
        scored_prop_id: prop.id,
        current_prop_id: prop.current_prop_id,
        odds_snapshot_id: currentProp.latest_snapshot_id,
        participant_id: currentProp.participant_id,
        participant_type: currentProp.participant_type,
        player_id: currentProp.player_id,
        event_id: eventId,
        game_id: currentProp.game_id,
        market_type: noGrade.marketType,
        stat_type: noGrade.marketType,
        side: currentProp.side ?? currentProp.direction,
        line: prop.line,
        actual_value: null,
        final_stat: null,
        result: "no_grade",
        grade_status: "no_grade",
        grade_reason: noGrade.gradeReason,
        grading_flags: noGrade.gradingFlags,
        grading_source: "knowledge-db",
        model_version_id: prop.model_version_id,
        league_id: currentProp.league_id,
        sport_id: currentProp.sport_id,
        notes: "No canonical event row was available during grading.",
        factor_snapshot: { scored_risk_flags: prop.risk_flags },
        graded_at: new Date().toISOString(),
      }], { returning: "minimal" });
      outputs.push(noGrade);
      continue;
    }

    if (!isCompletedStatus(event.status)) continue;

    const normalizedMarketType = normalizeMarketType(currentProp.market_type);
    if (!supportedMarket(currentProp.league_id, normalizedMarketType)) {
      const noGrade = buildNoGradeResult({
        scoredPropId: prop.id,
        currentPropId: prop.current_prop_id,
        eventId,
        marketType: normalizedMarketType,
        reason: "unsupported_market",
        flags: ["unsupported_market"],
      });
      await insert("grading_results", [{
        scored_prop_id: prop.id,
        current_prop_id: prop.current_prop_id,
        odds_snapshot_id: currentProp.latest_snapshot_id,
        participant_id: currentProp.participant_id,
        participant_type: currentProp.participant_type,
        player_id: currentProp.player_id,
        event_id: eventId,
        game_id: currentProp.game_id,
        market_type: normalizedMarketType,
        stat_type: normalizedMarketType,
        side: currentProp.side ?? currentProp.direction,
        line: prop.line,
        actual_value: null,
        final_stat: null,
        result: "no_grade",
        grade_status: "no_grade",
        grade_reason: noGrade.gradeReason,
        grading_flags: noGrade.gradingFlags,
        grading_source: "knowledge-db",
        model_version_id: prop.model_version_id,
        league_id: currentProp.league_id,
        sport_id: currentProp.sport_id,
        notes: "This market is not yet supported by model grading.",
        factor_snapshot: { scored_risk_flags: prop.risk_flags },
        graded_at: new Date().toISOString(),
      }], { returning: "minimal" });
      outputs.push(noGrade);
      continue;
    }

    const playerId = currentProp.player_id ?? prop.player_id;
    if (!playerId) {
      const noGrade = buildNoGradeResult({
        scoredPropId: prop.id,
        currentPropId: prop.current_prop_id,
        eventId,
        marketType: normalizedMarketType,
        reason: "missing_participant",
        flags: ["missing_participant"],
      });
      await insertRows("grading_results", [{
        scored_prop_id: prop.id,
        current_prop_id: prop.current_prop_id,
        odds_snapshot_id: currentProp.latest_snapshot_id,
        participant_id: currentProp.participant_id,
        participant_type: currentProp.participant_type,
        player_id: playerId,
        event_id: eventId,
        game_id: currentProp.game_id,
        market_type: normalizedMarketType,
        stat_type: normalizedMarketType,
        side: currentProp.side ?? currentProp.direction,
        line: prop.line,
        actual_value: null,
        final_stat: null,
        result: "no_grade",
        grade_status: "no_grade",
        grade_reason: noGrade.gradeReason,
        grading_flags: noGrade.gradingFlags,
        grading_source: "knowledge-db",
        model_version_id: prop.model_version_id,
        league_id: currentProp.league_id,
        sport_id: currentProp.sport_id,
        notes: "The prop did not resolve to a stored participant/player for grading.",
        factor_snapshot: { scored_risk_flags: prop.risk_flags },
        graded_at: new Date().toISOString(),
      }], { returning: "minimal" });
      outputs.push(noGrade);
      continue;
    }

    const [gameLog] = await select<PlayerGameLog>("player_game_logs", {
      select: "id,points,rebounds,assists,fantasy_score,hits,total_bases,runs,rbis,strikeouts,earned_runs,hits_allowed,walks_allowed,outs_recorded,stat_line",
      filters: [
        { column: "player_id", value: playerId },
        ...(eventId ? [{ column: "event_id", value: eventId }] : []),
        ...(!eventId && currentProp.game_id ? [{ column: "game_id", value: currentProp.game_id }] : []),
      ],
      limit: 1,
    });

    if (!gameLog) {
      // DEFER (no write): the event is complete but no player game log is stored yet. Enrichment lands the log
      // on a later cycle; writing a terminal no_grade here would be permanent (unique(scored_prop_id)) and block
      // the eventual grade. Retried next cycle; if the log never lands the prop simply ages out of the window.
      outputs.push(buildDeferredResult({
        scoredPropId: prop.id,
        currentPropId: prop.current_prop_id,
        eventId,
        marketType: normalizedMarketType,
        reason: "stat_source_missing",
      }));
      continue;
    }

    const finalStat = finalStatForMarket(normalizedMarketType, gameLog);
    if (finalStat === null) {
      // DEFER (no write): the stored log does not yet carry the final stat for this market. Same reasoning as
      // above — retry on a later cycle rather than writing a permanent no_grade.
      outputs.push(buildDeferredResult({
        scoredPropId: prop.id,
        currentPropId: prop.current_prop_id,
        eventId,
        marketType: normalizedMarketType,
        reason: "missing_final_stat",
      }));
      continue;
    }

    const side = currentProp.side ?? currentProp.direction;
    const result = resultFor(side, prop.line, finalStat);
    const gradingFlags = [...new Set(prop.risk_flags)];
    await insert("grading_results", [{
      scored_prop_id: prop.id,
      current_prop_id: prop.current_prop_id,
      odds_snapshot_id: currentProp.latest_snapshot_id,
      participant_id: currentProp.participant_id,
      participant_type: currentProp.participant_type,
      player_id: playerId,
      event_id: eventId,
      game_id: currentProp.game_id,
      market_type: normalizedMarketType,
      stat_type: normalizedMarketType,
      side,
      line: prop.line,
      actual_value: finalStat,
      final_stat: finalStat,
      result,
      grade_status: "graded",
      grade_reason: "graded_from_stored_player_logs",
      grading_flags: gradingFlags,
      grading_source: "knowledge-db",
      model_version_id: prop.model_version_id,
      league_id: currentProp.league_id,
      sport_id: currentProp.sport_id,
      notes: `Graded from stored player_game_logs for ${normalizedMarketType}.`,
      factor_snapshot: {
        scored_risk_flags: prop.risk_flags,
        event_status: event.status,
      },
      graded_at: new Date().toISOString(),
    }], { returning: "minimal" });

    outputs.push({
      scoredPropId: prop.id,
      currentPropId: prop.current_prop_id,
      eventId,
      marketType: normalizedMarketType,
      result,
      gradeStatus: "graded",
      finalStat,
      gradeReason: "graded_from_stored_player_logs",
      gradingFlags,
    });
  }

  return outputs;
}

// Bounded, recency-scoped, incremental recurring grader for the enabled public executor.
//
// Why a wrapper: gradeCompletedScoredProps() selects the newest `limit` scored_props by created_at with NO
// completion/ungraded/recency filter, so calling it bare would (a) attempt the whole recent backlog in one run
// and (b) stall on the newest N once graded (its per-row existence check can't paginate a backlog). This wrapper
// drives grading by RECENTLY-COMPLETED EVENTS instead:
//   - only events completed within `lookbackHours` (no historical backfill; genuinely-old data is owner-gated);
//   - skip events whose scored props are already fully recorded (cheap count compare -> guarantees forward
//     progress, never re-scans a finished event);
//   - process at most `maxEvents` events per invocation (explicit per-invocation bound; the rest continue next
//     cycle) and fully drain each processed event (large per-event limit -> no intra-event stall);
//   - deferred props (event complete, stat not stored yet) keep an event "not fully recorded", so it is retried
//     until the stat lands or the event ages out of the window.
export type GradeRecentCompletionsResult = {
  league: string | null;
  eventsScanned: number;
  eventsProcessed: number;
  graded: number;
  alreadyGraded: number;
  deferred: number;
  noGrade: number;
  cappedByMaxEvents: boolean;
  changedState: boolean;
};

export async function gradeRecentCompletions(options: {
  league?: "mlb" | "wnba";
  lookbackHours?: number;
  maxEvents?: number;
  candidateLimit?: number;
  now?: Date;
  deps?: {
    selectRows?: typeof selectRows;
    grade?: typeof gradeCompletedScoredProps;
  };
} = {}): Promise<GradeRecentCompletionsResult> {
  const now = options.now ?? new Date();
  const lookbackHours = options.lookbackHours ?? 36;
  const maxEvents = options.maxEvents ?? 5;
  const candidateLimit = options.candidateLimit ?? Math.max(maxEvents * 3, maxEvents);
  const select = options.deps?.selectRows ?? selectRows;
  const grade = options.deps?.grade ?? gradeCompletedScoredProps;
  const since = new Date(now.getTime() - lookbackHours * 3_600_000).toISOString();
  const leagueFilter = options.league ? [{ column: "league_id", value: options.league }] : [];

  const events = await select<{ id: string }>("events", {
    select: "id",
    filters: [
      ...leagueFilter,
      { column: "status", operator: "in" as const, value: ["completed", "final", "closed"] },
      { column: "start_time", operator: "gte" as const, value: since },
    ],
    orderBy: "start_time.desc",
    limit: candidateLimit,
  });

  let eventsProcessed = 0;
  let graded = 0;
  let alreadyGraded = 0;
  let deferred = 0;
  let noGrade = 0;

  for (const event of events) {
    if (eventsProcessed >= maxEvents) break;
    const [scored, recorded] = await Promise.all([
      select<{ id: string }>("scored_props", { select: "id", filters: [{ column: "event_id", value: event.id }, ...leagueFilter], limit: 1000 }),
      select<{ id: string }>("grading_results", { select: "id", filters: [{ column: "event_id", value: event.id }], limit: 1000 }),
    ]);
    if (scored.length === 0) continue;
    if (recorded.length >= scored.length) continue; // fully recorded (graded or terminal no_grade) -> skip

    eventsProcessed += 1;
    const out = await grade({ eventId: event.id, league: options.league, limit: 500 });
    for (const o of out) {
      if (o.gradeStatus === "graded") graded += 1;
      else if (o.gradeStatus === "already_graded") alreadyGraded += 1;
      else if (o.gradeStatus === "deferred") deferred += 1;
      else if (o.gradeStatus === "no_grade") noGrade += 1;
    }
  }

  return {
    league: options.league ?? null,
    eventsScanned: events.length,
    eventsProcessed,
    graded,
    alreadyGraded,
    deferred,
    noGrade,
    cappedByMaxEvents: eventsProcessed >= maxEvents && events.length > maxEvents,
    changedState: graded > 0 || noGrade > 0,
  };
}
