import { selectRows, type SupabaseFilter } from "@/lib/db/supabase-server";
import { confidenceLabelFor, riskLabelFor } from "@/lib/knowledge/adapters/base";
import { derivePlayerHeadshotUrl, deriveTeamLogoUrl } from "@/lib/knowledge/media";
import { calculateEdge } from "@/lib/scoring/covered-score";
import type { Confidence, Direction, Opportunity, Sport } from "@/lib/types";

type BaseRow = Record<string, unknown>;

const KNOWLEDGE_LOW_EGRESS_MODE = process.env.KNOWLEDGE_LOW_EGRESS_MODE === "true";

type CurrentPropRow = {
  id: string;
  latest_snapshot_id: string;
  prop_state: string | null;
  provider: string;
  sport_id: string;
  league_id: string;
  sportsbook_id: string | null;
  market_id: string | null;
  market_instance_key: string | null;
  provider_market_type: string | null;
  participant_id: string | null;
  participant_type: string | null;
  player_id: string | null;
  team_id: string | null;
  opponent_id: string | null;
  opponent_team_id: string | null;
  event_id: string | null;
  game_id: string | null;
  provider_event_id: string | null;
  provider_prop_key: string;
  market_type: string;
  player_name: string;
  team_name: string | null;
  opponent_name: string | null;
  line: number;
  direction: "More" | "Less";
  side: "More" | "Less" | null;
  american_odds: number | null;
  over_price: number | null;
  under_price: number | null;
  implied_probability: number | null;
  match_confidence: number | null;
  match_status: string;
  match_notes: string | null;
  match_quality_flags: string[];
  scheduled_date: string | null;
  start_time: string | null;
  game_time: string | null;
  data_quality_score: number | null;
  active: boolean;
  updated_at: string | null;
};

type ScoredPropRow = {
  id: string;
  current_prop_id: string;
  score_input_id: string | null;
  model_version_id: string | null;
  participant_id: string | null;
  participant_type: string | null;
  player_id: string | null;
  team_id: string | null;
  opponent_id: string | null;
  opponent_team_id: string | null;
  event_id: string | null;
  game_id: string | null;
  market_id: string | null;
  sport_id: string;
  league_id: string;
  covered_score: number | null;
  projection: number;
  line: number;
  edge_value: number;
  edge_score: number;
  confidence_score: number;
  trend_score: number | null;
  matchup_score: number | null;
  market_score: number | null;
  data_quality_score: number | null;
  recommendation: string;
  risk_flags: string[];
  prop_state: string | null;
  publishable: boolean | null;
  publishability_reasons: string[] | null;
  created_at: string;
  updated_at: string | null;
};

type ScoreExplanation = {
  scored_prop_id: string;
  summary: string | null;
  score_label: string | null;
  confidence_label: string | null;
  risk_label: string | null;
  explanation: string | null;
  reasoning_block: string | null;
  factor_notes: Record<string, unknown> | null;
  factors: Array<Record<string, unknown>> | null;
  risk_notes: Array<Record<string, unknown> | string> | null;
  recent_values: number[] | null;
};

type ScoreExplanationSummary = Pick<ScoreExplanation, "scored_prop_id" | "summary" | "score_label" | "confidence_label" | "risk_label">;

type ScoredPropListRow = Pick<
  ScoredPropRow,
  | "id"
  | "current_prop_id"
  | "participant_id"
  | "participant_type"
  | "player_id"
  | "team_id"
  | "opponent_id"
  | "opponent_team_id"
  | "event_id"
  | "market_id"
  | "sport_id"
  | "league_id"
  | "covered_score"
  | "projection"
  | "line"
  | "edge_score"
  | "confidence_score"
  | "data_quality_score"
  | "recommendation"
  | "risk_flags"
  | "prop_state"
  | "publishable"
  | "publishability_reasons"
  | "created_at"
  | "updated_at"
>;

type ScoredPropParlayRow = Pick<
  ScoredPropRow,
  | "id"
  | "current_prop_id"
  | "covered_score"
  | "confidence_score"
  | "data_quality_score"
  | "recommendation"
  | "risk_flags"
  | "prop_state"
  | "publishability_reasons"
  | "updated_at"
>;

type GradingResult = {
  id: string;
  scored_prop_id: string | null;
  current_prop_id: string | null;
  odds_snapshot_id: string | null;
  participant_id: string | null;
  participant_type: string | null;
  player_id: string | null;
  event_id: string | null;
  game_id: string | null;
  market_type: string;
  side: string | null;
  line: number;
  actual_value: number | null;
  final_stat: number | null;
  result: string;
  grade_status: string | null;
  grade_reason: string | null;
  grading_flags: string[] | null;
  grading_source: string;
  model_version_id: string | null;
  league_id: string | null;
  sport_id: string | null;
  notes: string | null;
  graded_at: string | null;
  created_at: string;
};

type EventRow = {
  id: string;
  display_name: string | null;
  scheduled_date: string;
  start_time: string;
  status: string;
  home_team_id: string | null;
  away_team_id: string | null;
};

type ParticipantRow = {
  id: string;
  display_name: string;
  participant_type: string;
  player_id: string | null;
  team_id: string | null;
  image_url: string | null;
  external_ids: Record<string, unknown> | null;
};

type PlayerRow = {
  id: string;
  display_name: string | null;
  canonical_name: string;
  headshot_url: string | null;
  external_ids: Record<string, unknown> | null;
};

type TeamRow = {
  id: string;
  name: string;
  abbreviation: string | null;
  logo_url: string | null;
  external_ids: Record<string, unknown> | null;
};

type MarketRow = {
  id: string;
  market_type: string;
  display_name: string;
};

type SportsbookRow = {
  id: string;
  code: string;
  display_name: string;
};

export type CoveredPicksQuery = {
  date?: string | null;
  sport?: string | null;
  league?: string | null;
  marketType?: string | null;
  sportsbook?: string | null;
  minimumCoveredScore?: number | null;
  minimumConfidenceScore?: number | null;
  scoreLabel?: string | null;
  confidenceLabel?: string | null;
  riskLabel?: string | null;
  excludeHighRisk?: boolean;
  excludeUnsupportedMarkets?: boolean;
  startTimeFrom?: string | null;
  startTimeTo?: string | null;
  limit?: number | null;
  includeDetails?: boolean;
  includeGrading?: boolean;
  includeVariantBooks?: boolean;
};

export type BoardOpportunitiesQuery = {
  sport?: string | null;
  league?: string | null;
  limit?: number | null;
};

export type ParlayOptionsQuery = {
  date?: string | null;
  sport?: string | null;
  league?: string | null;
  eventId?: string | null;
  marketType?: string | null;
  sportsbook?: string | null;
  participantSearch?: string | null;
  onlyScored?: boolean;
  onlyMatched?: boolean;
  excludeStaleOdds?: boolean;
  excludeLowConfidenceMatches?: boolean;
  limit?: number | null;
  includeVariantBooks?: boolean;
};

export type ModelPerformanceQuery = {
  dateFrom?: string | null;
  dateTo?: string | null;
  sport?: string | null;
  league?: string | null;
  marketType?: string | null;
  sportsbook?: string | null;
  scoreLabel?: string | null;
  confidenceLabel?: string | null;
  riskLabel?: string | null;
  recommendation?: string | null;
  minimumCoveredScore?: number | null;
  modelVersion?: string | null;
  result?: string | null;
};

function safeArray<T>(value: T[] | null | undefined) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "").toLowerCase().trim();
}

function easternDateKey(value: string | Date | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function sameDay(isoTime: string | null | undefined, date: string | null | undefined) {
  if (!isoTime || !date) return true;
  return easternDateKey(isoTime) === date;
}

function withinTimeRange(isoTime: string | null | undefined, from: string | null | undefined, to: string | null | undefined) {
  if (!isoTime) return false;
  const timestamp = new Date(isoTime).getTime();
  if (!Number.isFinite(timestamp)) return false;
  if (from && timestamp < new Date(from).getTime()) return false;
  if (to && timestamp > new Date(to).getTime()) return false;
  return true;
}

function isFutureStartTime(isoTime: string | null | undefined) {
  if (!isoTime) return true;
  const timestamp = new Date(isoTime).getTime();
  if (!Number.isFinite(timestamp)) return true;
  return timestamp > Date.now();
}

function parseIdList(rows: Array<{ id: string | null | undefined }>) {
  return [...new Set(rows.map((row) => row.id).filter((value): value is string => Boolean(value)))];
}

async function loadMap<T extends { id: string }>(table: string, ids: string[], select: string) {
  if (!ids.length) return new Map<string, T>();
  const rows = await selectRows<T>(table, {
    select,
    filters: [{ column: "id", operator: "in", value: ids }],
    limit: ids.length,
  });
  return new Map(rows.map((row) => [row.id, row]));
}

async function latestScoredPropsByCurrentProp(currentPropIds: string[]) {
  if (!currentPropIds.length) return new Map<string, ScoredPropRow>();
  const rows = await selectRows<ScoredPropRow>("scored_props", {
    select: "id,current_prop_id,score_input_id,model_version_id,participant_id,participant_type,player_id,team_id,opponent_id,opponent_team_id,event_id,game_id,market_id,sport_id,league_id,covered_score,projection,line,edge_value,edge_score,confidence_score,trend_score,matchup_score,market_score,data_quality_score,recommendation,risk_flags,prop_state,publishable,publishability_reasons,created_at,updated_at",
    filters: [{ column: "current_prop_id", operator: "in", value: currentPropIds }],
    orderBy: "updated_at.desc",
    limit: Math.min(currentPropIds.length * 10, 2000),
  });
  const map = new Map<string, ScoredPropRow>();
  for (const row of rows) {
    if (!map.has(row.current_prop_id)) map.set(row.current_prop_id, row);
  }
  return map;
}

async function latestScoredLiteByCurrentProp(currentPropIds: string[]) {
  if (!currentPropIds.length) return new Map<string, ScoredPropListRow>();
  const rows = await selectRows<ScoredPropListRow>("scored_props", {
    select: "id,current_prop_id,participant_id,participant_type,player_id,team_id,opponent_id,opponent_team_id,event_id,market_id,sport_id,league_id,covered_score,projection,line,edge_score,confidence_score,data_quality_score,recommendation,risk_flags,prop_state,publishable,publishability_reasons,created_at,updated_at",
    filters: [{ column: "current_prop_id", operator: "in", value: currentPropIds }],
    orderBy: "updated_at.desc",
    limit: Math.min(currentPropIds.length * 4, 1000),
  });
  const map = new Map<string, ScoredPropListRow>();
  for (const row of rows) {
    if (!map.has(row.current_prop_id)) map.set(row.current_prop_id, row);
  }
  return map;
}

// PostgREST encodes an `in.(...)` filter as literal UUIDs in the request URL/header line. An
// unbounded id list here (getParlayOptions can pass up to ~500 current_prop_ids when no
// league/sport filter narrows the base current_props read) produces a request undici's HTTP
// client cannot parse, which surfaces only as a generic `TypeError: fetch failed` -- the real
// cause (`UND_ERR_HEADERS_OVERFLOW`) is in `error.cause`, one layer deeper than callers read.
// Batching keeps every request comfortably bounded regardless of how many ids are passed in.
const SCORED_PROPS_LOOKUP_BATCH_SIZE = 100;

function chunkIds(ids: string[], size: number) {
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    batches.push(ids.slice(index, index + size));
  }
  return batches;
}

async function latestScoredCompactByCurrentProp(currentPropIds: string[]) {
  if (!currentPropIds.length) return new Map<string, ScoredPropParlayRow>();
  const map = new Map<string, ScoredPropParlayRow>();
  for (const batch of chunkIds(currentPropIds, SCORED_PROPS_LOOKUP_BATCH_SIZE)) {
    const rows = await selectRows<ScoredPropParlayRow>("scored_props", {
      select: "id,current_prop_id,covered_score,confidence_score,data_quality_score,recommendation,risk_flags,prop_state,publishability_reasons,updated_at",
      filters: [{ column: "current_prop_id", operator: "in", value: batch }],
      orderBy: "updated_at.desc",
      limit: Math.min(batch.length * 4, 1000),
    });
    for (const row of rows) {
      if (!map.has(row.current_prop_id)) map.set(row.current_prop_id, row);
    }
  }
  return map;
}

async function explanationSummariesByScoredProp(scoredPropIds: string[]) {
  if (!scoredPropIds.length) return new Map<string, ScoreExplanationSummary>();
  const rows = await selectRows<ScoreExplanationSummary>("score_explanations", {
    select: "scored_prop_id,summary,score_label,confidence_label,risk_label",
    filters: [{ column: "scored_prop_id", operator: "in", value: scoredPropIds }],
    limit: scoredPropIds.length,
  });
  return new Map(rows.map((row) => [row.scored_prop_id, row]));
}

async function explanationsByScoredProp(scoredPropIds: string[], options?: { compact?: boolean }) {
  if (!scoredPropIds.length) return new Map<string, ScoreExplanation>();
  if (options?.compact) {
    return explanationSummariesByScoredProp(scoredPropIds) as Promise<Map<string, ScoreExplanation>>;
  }
  const rows = await selectRows<ScoreExplanation>("score_explanations", {
    select: "scored_prop_id,summary,score_label,confidence_label,risk_label,explanation,reasoning_block,factor_notes,factors,risk_notes,recent_values",
    filters: [{ column: "scored_prop_id", operator: "in", value: scoredPropIds }],
    limit: scoredPropIds.length,
  });
  return new Map(rows.map((row) => [row.scored_prop_id, row]));
}

async function latestGradingsByScoredProp(scoredPropIds: string[]) {
  if (!scoredPropIds.length) return new Map<string, GradingResult>();
  const rows = await selectRows<GradingResult>("grading_results", {
    select: "id,scored_prop_id,current_prop_id,odds_snapshot_id,participant_id,participant_type,player_id,event_id,game_id,market_type,side,line,actual_value,final_stat,result,grade_status,grade_reason,grading_flags,grading_source,model_version_id,league_id,sport_id,notes,graded_at,created_at",
    filters: [{ column: "scored_prop_id", operator: "in", value: scoredPropIds }],
    orderBy: "graded_at.desc",
    limit: Math.min(scoredPropIds.length * 5, 2000),
  });
  const map = new Map<string, GradingResult>();
  for (const row of rows) {
    if (row.scored_prop_id && !map.has(row.scored_prop_id)) map.set(row.scored_prop_id, row);
  }
  return map;
}

function coveredPickRank(left: {
  coveredScore: number;
  confidenceScore: number;
  dataQualityScore: number;
  startTime: string | null;
}, right: {
  coveredScore: number;
  confidenceScore: number;
  dataQualityScore: number;
  startTime: string | null;
}) {
  return (
    right.coveredScore - left.coveredScore ||
    right.confidenceScore - left.confidenceScore ||
    right.dataQualityScore - left.dataQualityScore ||
    new Date(left.startTime ?? 0).getTime() - new Date(right.startTime ?? 0).getTime()
  );
}

function dropdownLabel(input: {
  participantDisplayName: string;
  marketDisplayName: string;
  side: string | null;
  line: number;
  eventDisplayName: string;
  startTime: string | null;
  sportsbook: string | null;
}) {
  const when = input.startTime
    ? new Date(input.startTime).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/New_York",
      })
    : "TBD";
  return `${input.participantDisplayName} — ${input.side ?? "Side TBD"} ${input.line} ${input.marketDisplayName} · ${input.eventDisplayName} · ${when}${input.sportsbook ? ` · ${input.sportsbook}` : ""}`;
}

function displayGroupingKey(row: {
  event_id: string | null;
  participant_id: string | null;
  participant_name?: string | null;
  team_name?: string | null;
  opponent_name?: string | null;
  scheduled_date?: string | null;
  start_time?: string | null;
  market_type: string;
  side: string | null;
  line: number;
  includeLine?: boolean;
  includeSide?: boolean;
}) {
  const dateKey = row.scheduled_date
    ?? easternDateKey(row.start_time)
    ?? "date:unknown";
  const participantKey = normalizeText(row.participant_name) || (row.participant_id ? `participant:${row.participant_id}` : "participant:unknown");
  const eventNameKey = `${normalizeText(row.team_name)}|${normalizeText(row.opponent_name)}`;
  const eventKey = eventNameKey.replace(/\|/g, "").trim()
    ? `${dateKey}|${eventNameKey}`
    : row.event_id
      ? `${dateKey}|event:${row.event_id}`
      : `${dateKey}|event:unknown`;
  return [
    eventKey,
    participantKey,
    row.market_type,
    row.includeSide === false ? "side:any" : normalizeText(row.side ?? "unknown"),
    row.includeLine === false ? "line:any" : Number(row.line).toFixed(2),
  ].join("|");
}

function uniqueSportsbooks(rows: Array<{ sportsbook: { id: string; code: string; display_name: string } | null }>) {
  const seen = new Map<string, { id: string; code: string; display_name: string }>();
  for (const row of rows) {
    if (!row.sportsbook?.id) continue;
    if (!seen.has(row.sportsbook.id)) seen.set(row.sportsbook.id, row.sportsbook);
  }
  return [...seen.values()];
}

export async function getCoveredPicksOfTheDay(query: CoveredPicksQuery) {
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
  const scanLimit = KNOWLEDGE_LOW_EGRESS_MODE
    ? Math.min(Math.max(limit * 4, 24), 80)
    : Math.min(Math.max(limit * 8, 80), 500);
  const baseFilters: SupabaseFilter[] = [
    ...(query.sport ? [{ column: "sport_id", value: query.sport }] : []),
    ...(query.league ? [{ column: "league_id", value: query.league }] : []),
    { column: "publishable", value: true },
    ...(typeof query.minimumCoveredScore === "number" ? [{ column: "covered_score", operator: "gte" as const, value: query.minimumCoveredScore }] : []),
    ...(typeof query.minimumConfidenceScore === "number" ? [{ column: "confidence_score", operator: "gte" as const, value: query.minimumConfidenceScore }] : []),
  ];

  const scoredRows = await selectRows<ScoredPropListRow>("scored_props", {
    select: "id,current_prop_id,participant_id,participant_type,player_id,team_id,opponent_id,opponent_team_id,event_id,market_id,sport_id,league_id,covered_score,projection,line,edge_score,confidence_score,data_quality_score,recommendation,risk_flags,prop_state,publishable,publishability_reasons,created_at,updated_at",
    filters: baseFilters,
    orderBy: "updated_at.desc",
    limit: scanLimit,
  });

  const latestByCurrent = new Map<string, ScoredPropListRow>();
  for (const row of scoredRows) {
    if (!latestByCurrent.has(row.current_prop_id)) latestByCurrent.set(row.current_prop_id, row);
  }
  const latestScored = [...latestByCurrent.values()];

  const currentPropIds = latestScored.map((row) => row.current_prop_id);
  const currentProps = await selectRows<CurrentPropRow>("current_props", {
    select: "id,latest_snapshot_id,sportsbook_id,market_id,market_instance_key,participant_id,participant_type,player_id,team_id,opponent_id,opponent_team_id,event_id,market_type,player_name,team_name,opponent_name,line,direction,side,over_price,under_price,start_time,updated_at",
    filters: [
      { column: "id", operator: "in", value: currentPropIds },
      { column: "active", value: true },
    ],
    limit: currentPropIds.length,
  });
  const currentById = new Map(currentProps.map((row) => [row.id, row]));

  const explanationMap = await explanationsByScoredProp(latestScored.map((row) => row.id), { compact: true });

  const eventIds = parseIdList(currentProps.map((row) => ({ id: row.event_id })));
  const participantIds = parseIdList(currentProps.map((row) => ({ id: row.participant_id })));
  const playerIds = parseIdList(currentProps.map((row) => ({ id: row.player_id })));
  const teamIds = parseIdList(currentProps.flatMap((row) => [{ id: row.team_id }, { id: row.opponent_team_id }]));
  const marketIds = parseIdList(currentProps.map((row) => ({ id: row.market_id })));
  const sportsbookIds = parseIdList(currentProps.map((row) => ({ id: row.sportsbook_id })));

  const [events, participants, players, teams, markets, sportsbooks] = await Promise.all([
    loadMap<EventRow>("events", eventIds, "id,display_name,scheduled_date,start_time,status,home_team_id,away_team_id"),
    loadMap<ParticipantRow>("participants", participantIds, "id,display_name,participant_type,player_id,team_id,image_url,external_ids"),
    loadMap<PlayerRow>("players", playerIds, "id,display_name,canonical_name,headshot_url,external_ids"),
    loadMap<TeamRow>("teams", teamIds, "id,name,abbreviation,logo_url,external_ids"),
    loadMap<MarketRow>("markets", marketIds, "id,market_type,display_name"),
    loadMap<SportsbookRow>("sportsbooks", sportsbookIds, "id,code,display_name"),
  ]);

  const rows = latestScored.flatMap((score) => {
    const current = currentById.get(score.current_prop_id);
    if (!current) return [];
    if (!isFutureStartTime(current.start_time)) return [];
    const explanation = explanationMap.get(score.id);
    const event = current.event_id ? events.get(current.event_id) : undefined;
    const participant = current.participant_id ? participants.get(current.participant_id) : undefined;
    const player = current.player_id ? players.get(current.player_id) : undefined;
    const team = current.team_id ? teams.get(current.team_id) : undefined;
    const opponentTeam = current.opponent_team_id ? teams.get(current.opponent_team_id) : undefined;
    const market = current.market_id ? markets.get(current.market_id) : undefined;
    const sportsbook = current.sportsbook_id ? sportsbooks.get(current.sportsbook_id) : undefined;

    const scoreLabel = explanation?.score_label ?? null;
    const confidenceLabel = explanation?.confidence_label ?? null;
    const riskLabel = explanation?.risk_label ?? null;

    if (query.marketType && current.market_type !== query.marketType) return [];
    if (query.sportsbook) {
      const wanted = normalizeText(query.sportsbook);
      const got = normalizeText(sportsbook?.code ?? sportsbook?.display_name ?? "");
      if (wanted !== got) return [];
    }
    if (query.date && !sameDay(current.start_time, query.date)) return [];
    if ((query.startTimeFrom || query.startTimeTo) && !withinTimeRange(current.start_time, query.startTimeFrom, query.startTimeTo)) return [];
    if (query.scoreLabel && scoreLabel !== query.scoreLabel) return [];
    if (query.confidenceLabel && confidenceLabel !== query.confidenceLabel) return [];
    if (query.riskLabel && riskLabel !== query.riskLabel) return [];
    if (query.excludeHighRisk && riskLabel === "High Risk") return [];
    if (query.excludeUnsupportedMarkets && safeArray(score.risk_flags).includes("unsupported_market")) return [];

    const participantDisplayName = participant?.display_name ?? player?.display_name ?? player?.canonical_name ?? current.player_name;
    const participantImageUrl = derivePlayerHeadshotUrl({
      leagueId: score.league_id.toUpperCase() as "MLB" | "NBA" | "WNBA",
      participantImageUrl: participant?.image_url ?? null,
      storedHeadshotUrl: player?.headshot_url ?? null,
      externalIds: player?.external_ids ?? participant?.external_ids ?? null,
    });
    const teamLogoUrl = deriveTeamLogoUrl({
      leagueId: score.league_id.toUpperCase() as "MLB" | "NBA" | "WNBA",
      storedLogoUrl: team?.logo_url ?? null,
      externalIds: team?.external_ids ?? null,
      abbreviation: team?.abbreviation ?? current.team_name ?? null,
    });
    const opponentLogoUrl = deriveTeamLogoUrl({
      leagueId: score.league_id.toUpperCase() as "MLB" | "NBA" | "WNBA",
      storedLogoUrl: opponentTeam?.logo_url ?? null,
      externalIds: opponentTeam?.external_ids ?? null,
      abbreviation: opponentTeam?.abbreviation ?? current.opponent_name ?? null,
    });
    return [{
      scored_prop_id: score.id,
      current_prop_id: current.id,
      odds_snapshot_id: current.latest_snapshot_id,
      market_instance_key: current.market_instance_key,
      event_id: current.event_id,
      participant_id: current.participant_id,
      participant_type: current.participant_type,
      player_display_name: participantDisplayName,
      participant_image_url: participantImageUrl,
      player_headshot_url: player?.headshot_url ?? participantImageUrl,
      team_display_name: team?.name ?? current.team_name,
      team_logo_url: teamLogoUrl,
      opponent_display_name: opponentTeam?.name ?? current.opponent_name,
      opponent_logo_url: opponentLogoUrl,
      event_display_name: event?.display_name ?? current.opponent_name,
      sport: score.sport_id,
      league: score.league_id,
      market_type: current.market_type,
      market_display_label: market?.display_name ?? current.market_type,
      sportsbook_id: sportsbook?.id ?? current.sportsbook_id ?? null,
      sportsbook: sportsbook ? { id: sportsbook.id, code: sportsbook.code, display_name: sportsbook.display_name } : null,
      side: current.side ?? current.direction,
      line: current.line,
      over_price: current.over_price,
      under_price: current.under_price,
      start_time: current.start_time,
      covered_score: score.covered_score,
      edge_score: score.edge_score,
      confidence_score: score.confidence_score,
      data_quality_score: score.data_quality_score,
      recommendation: score.recommendation,
      score_label: scoreLabel,
      confidence_label: confidenceLabel,
      risk_label: riskLabel,
      explanation_summary: explanation?.summary ?? null,
      factor_breakdown: [],
      risk_flags: score.risk_flags,
      grading_result: null,
      last_updated: current.updated_at ?? score.created_at,
    }];
  });

  const groupedRows = [...rows.reduce((accumulator, row) => {
    const key = displayGroupingKey({
      event_id: row.event_id,
      participant_id: row.participant_id,
      participant_name: row.player_display_name,
      team_name: row.team_display_name,
      opponent_name: row.opponent_display_name,
      scheduled_date: row.start_time ? easternDateKey(row.start_time) : null,
      start_time: row.start_time,
      market_type: row.market_type,
      side: row.side,
      line: row.line,
      includeLine: false,
      includeSide: false,
    });
    const bucket = accumulator.get(key) ?? [];
    bucket.push(row);
    accumulator.set(key, bucket);
    return accumulator;
  }, new Map<string, typeof rows>()).values()].map((bucket) => {
    const representative = [...bucket].sort((left, right) =>
      coveredPickRank(
        {
          coveredScore: Number(left.covered_score ?? 0),
          confidenceScore: Number(left.confidence_score ?? 0),
          dataQualityScore: Number(left.data_quality_score ?? 0),
          startTime: String(left.start_time ?? ""),
        },
        {
          coveredScore: Number(right.covered_score ?? 0),
          confidenceScore: Number(right.confidence_score ?? 0),
          dataQualityScore: Number(right.data_quality_score ?? 0),
          startTime: String(right.start_time ?? ""),
        },
      ),
    )[0];
    const sportsbooks = uniqueSportsbooks(bucket);
    return {
      ...representative,
      sportsbooks: query.includeVariantBooks === false ? undefined : sportsbooks,
      sportsbook_count: sportsbooks.length,
      grouped_variant_count: bucket.length,
    };
  });

  groupedRows.sort((left, right) =>
    coveredPickRank(
      {
        coveredScore: Number(left.covered_score ?? 0),
        confidenceScore: Number(left.confidence_score ?? 0),
        dataQualityScore: Number(left.data_quality_score ?? 0),
        startTime: String(left.start_time ?? ""),
      },
      {
        coveredScore: Number(right.covered_score ?? 0),
        confidenceScore: Number(right.confidence_score ?? 0),
        dataQualityScore: Number(right.data_quality_score ?? 0),
        startTime: String(right.start_time ?? ""),
      },
    ),
  );

  const finalRows = groupedRows.slice(0, limit);
  const finalScoredPropIds = finalRows.map((row) => row.scored_prop_id);
  const fullExplanationMap = query.includeDetails !== false && finalScoredPropIds.length
    ? await explanationsByScoredProp(finalScoredPropIds)
    : new Map<string, ScoreExplanation>();
  const gradingMap = query.includeGrading !== false && finalScoredPropIds.length
    ? await latestGradingsByScoredProp(finalScoredPropIds)
    : new Map<string, GradingResult>();

  const hydratedRows = finalRows.map((row) => {
    const fullExplanation = fullExplanationMap.get(row.scored_prop_id);
    return {
      ...row,
      explanation_summary: fullExplanation?.summary ?? row.explanation_summary,
      factor_breakdown: fullExplanation?.factors ?? row.factor_breakdown,
      grading_result: gradingMap.get(row.scored_prop_id) ?? null,
    };
  });

  return {
    count: Math.min(groupedRows.length, limit),
    rows: hydratedRows,
  };
}

type ScoredPropBoardRow = Pick<
  ScoredPropRow,
  | "id"
  | "current_prop_id"
  | "player_id"
  | "team_id"
  | "opponent_team_id"
  | "event_id"
  | "sport_id"
  | "league_id"
  | "covered_score"
  | "projection"
  | "line"
  | "edge_score"
  | "confidence_score"
  | "trend_score"
  | "data_quality_score"
  | "recommendation"
  | "risk_flags"
>;

export async function getBoardOpportunities(query: BoardOpportunitiesQuery): Promise<Opportunity[]> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const scanLimit = KNOWLEDGE_LOW_EGRESS_MODE
    ? Math.min(limit * 3, 150)
    : Math.min(limit * 6, 600);

  const baseFilters: SupabaseFilter[] = [
    ...(query.sport ? [{ column: "sport_id", value: query.sport }] : []),
    ...(query.league ? [{ column: "league_id", value: query.league }] : []),
  ];

  const scoredRows = await selectRows<ScoredPropBoardRow>("scored_props", {
    select: "id,current_prop_id,player_id,team_id,opponent_team_id,event_id,sport_id,league_id,covered_score,projection,line,edge_score,confidence_score,trend_score,data_quality_score,recommendation,risk_flags",
    filters: baseFilters,
    orderBy: "updated_at.desc",
    limit: scanLimit,
  });

  const latestByCurrent = new Map<string, ScoredPropBoardRow>();
  for (const row of scoredRows) {
    if (!latestByCurrent.has(row.current_prop_id)) latestByCurrent.set(row.current_prop_id, row);
  }
  const latestScored = [...latestByCurrent.values()];
  if (!latestScored.length) return [];

  const currentPropIds = latestScored.map((row) => row.current_prop_id);
  const currentProps = await selectRows<CurrentPropRow>("current_props", {
    select: "id,player_id,team_id,opponent_team_id,event_id,market_type,player_name,team_name,opponent_name,line,direction,start_time",
    filters: [
      { column: "id", operator: "in", value: currentPropIds },
      { column: "active", value: true },
    ],
    limit: currentPropIds.length,
  });
  const currentById = new Map(currentProps.map((row) => [row.id, row]));

  const activePairs = latestScored.flatMap((score) => {
    const current = currentById.get(score.current_prop_id);
    if (!current || !isFutureStartTime(current.start_time)) return [];
    return [{ score, current }];
  });
  if (!activePairs.length) return [];

  const scoredPropIds = activePairs.map((p) => p.score.id);
  const playerIds = parseIdList(activePairs.map((p) => ({ id: p.current.player_id })));
  const teamIds = parseIdList(activePairs.flatMap((p) => [{ id: p.current.team_id }, { id: p.current.opponent_team_id }]));

  const [explanationMap, players, teams] = await Promise.all([
    explanationsByScoredProp(scoredPropIds),
    loadMap<PlayerRow>("players", playerIds, "id,display_name,canonical_name,headshot_url,external_ids"),
    loadMap<TeamRow>("teams", teamIds, "id,name,abbreviation,logo_url,external_ids"),
  ]);

  const opportunities: Opportunity[] = activePairs.slice(0, limit).flatMap(({ score, current }, index) => {
    const explanation = explanationMap.get(score.id);
    const player = current.player_id ? players.get(current.player_id) : undefined;
    const team = current.team_id ? teams.get(current.team_id) : undefined;
    const opponentTeam = current.opponent_team_id ? teams.get(current.opponent_team_id) : undefined;

    const playerName = player?.display_name ?? player?.canonical_name ?? current.player_name;
    const teamName = team?.name ?? current.team_name ?? "";
    const opponentName = opponentTeam?.name ?? current.opponent_name ?? "";
    const coveredScore = score.covered_score ?? 0;
    const direction: Direction = current.direction;
    const line = current.line;
    const projection = score.projection;

    const edgePercent = calculateEdge(line, projection, direction);
    const rawEdge = direction === "More" ? projection - line : line - projection;
    const adjustedEdge = rawEdge;
    const valueRating = Math.max(-5, Math.min(5,
      Math.round(Math.min(5, Math.abs(edgePercent) / 4)) * (rawEdge >= 0 ? 1 : -1),
    ));

    const dqs = score.data_quality_score ?? 0;
    const confLabel = confidenceLabelFor(score.confidence_score, dqs);
    const confidence: Confidence =
      confLabel === "High Confidence" ? "High" :
      confLabel === "Medium Confidence" ? "Medium-High" :
      confLabel === "Low Confidence" ? "Medium" : "Low";
    const dataQuality: "High" | "Medium" | "Low" = dqs >= 16 ? "High" : dqs >= 8 ? "Medium" : "Low";

    const factors = (explanation?.factors ?? []) as Array<{ impact?: string; description?: string }>;
    const reasons = factors.filter((f) => f.impact === "positive").map((f) => f.description).filter((d): d is string => Boolean(d));
    const risks = factors.filter((f) => f.impact === "negative" || f.impact === "caution").map((f) => f.description).filter((d): d is string => Boolean(d));

    const rawNotes = (explanation?.factor_notes ?? {}) as Record<string, unknown>;
    const factorNotes: Record<string, string> = {};
    for (const [key, val] of Object.entries(rawNotes)) {
      if (typeof val === "string") factorNotes[key] = val;
    }

    const headshotUrl = player ? derivePlayerHeadshotUrl({
      leagueId: score.league_id.toUpperCase() as "MLB" | "NBA" | "WNBA",
      participantImageUrl: null,
      storedHeadshotUrl: player.headshot_url ?? null,
      externalIds: player.external_ids ?? null,
    }) : undefined;

    return [{
      id: score.id,
      eventId: current.event_id ?? undefined,
      playerId: current.player_id ?? undefined,
      rank: index + 1,
      sport: score.sport_id as Sport,
      matchup: teamName && opponentName ? `${teamName} vs ${opponentName}` : undefined,
      playerName,
      team: teamName,
      opponent: opponentName,
      statType: current.market_type,
      line,
      direction,
      projection,
      rawEdge,
      adjustedEdge,
      edgePercent,
      valueRating,
      coveredScore,
      recommendationLabel: score.recommendation,
      confidence,
      confidenceScore: score.confidence_score,
      reasons: reasons.length ? reasons : [`${playerName} projects at ${projection} vs line ${line}.`],
      risks,
      riskFlags: score.risk_flags ?? [],
      plainEnglishSummary: explanation?.summary ?? "",
      modelNotes: [],
      factorNotes,
      gameTime: current.start_time ?? "",
      headshotUrl: headshotUrl ?? undefined,
      recentValues: explanation?.recent_values ?? [],
      dataQuality,
      trendScore: score.trend_score ?? undefined,
    }];
  });

  return opportunities;
}

export async function getParlayOptions(query: ParlayOptionsQuery) {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 250);
  const scanLimit = KNOWLEDGE_LOW_EGRESS_MODE
    ? Math.min(Math.max(limit * 2, 60), 120)
    : 500;
  const filters: SupabaseFilter[] = [
    ...(query.sport ? [{ column: "sport_id", value: query.sport }] : []),
    ...(query.league ? [{ column: "league_id", value: query.league }] : []),
    ...(query.eventId ? [{ column: "event_id", value: query.eventId }] : []),
    ...(query.marketType ? [{ column: "market_type", value: query.marketType }] : []),
    ...(query.onlyMatched ? [{ column: "match_status", operator: "in" as const, value: ["matched", "strongly_resolved"] }] : []),
    { column: "active", value: true },
    // Matches isFutureStartTime()'s own semantics (null start_time or strictly in the future).
    // Without this, `active=true` rows that are days past their start_time (never deactivated)
    // sort first under start_time.asc and can consume the entire scanLimit budget, starving out
    // every genuinely-eligible future row before the JS-level isFutureStartTime() filter below
    // ever sees them -- this is a query-bound fix, not a change to which props are eligible.
    { raw: `or=(start_time.is.null,start_time.gt.${encodeURIComponent(new Date().toISOString())})` },
  ];

  const currentProps = await selectRows<CurrentPropRow>("current_props", {
    select: "id,latest_snapshot_id,sport_id,league_id,sportsbook_id,market_id,market_instance_key,participant_id,participant_type,player_id,team_id,opponent_id,opponent_team_id,event_id,market_type,player_name,team_name,opponent_name,line,direction,side,over_price,under_price,match_confidence,match_status,match_quality_flags,start_time,updated_at",
    filters,
    orderBy: "start_time.asc",
    limit: scanLimit,
  });

  const currentPropIds = currentProps.map((row) => row.id);
  const latestScored = await latestScoredCompactByCurrentProp(currentPropIds);

  const eventIds = parseIdList(currentProps.map((row) => ({ id: row.event_id })));
  const participantIds = parseIdList(currentProps.map((row) => ({ id: row.participant_id })));
  const playerIds = parseIdList(currentProps.map((row) => ({ id: row.player_id })));
  const teamIds = parseIdList(currentProps.flatMap((row) => [{ id: row.team_id }, { id: row.opponent_team_id }]));
  const marketIds = parseIdList(currentProps.map((row) => ({ id: row.market_id })));
  const sportsbookIds = parseIdList(currentProps.map((row) => ({ id: row.sportsbook_id })));

  const [events, participants, players, teams, markets, sportsbooks] = await Promise.all([
    loadMap<EventRow>("events", eventIds, "id,display_name,scheduled_date,start_time,status,home_team_id,away_team_id"),
    loadMap<ParticipantRow>("participants", participantIds, "id,display_name,participant_type,player_id,team_id,image_url,external_ids"),
    loadMap<PlayerRow>("players", playerIds, "id,display_name,canonical_name,headshot_url,external_ids"),
    loadMap<TeamRow>("teams", teamIds, "id,name,abbreviation,logo_url,external_ids"),
    loadMap<MarketRow>("markets", marketIds, "id,market_type,display_name"),
    loadMap<SportsbookRow>("sportsbooks", sportsbookIds, "id,code,display_name"),
  ]);

  const rows = currentProps.flatMap((current) => {
    if (!isFutureStartTime(current.start_time)) return [];
    const score = latestScored.get(current.id) ?? null;
    const event = current.event_id ? events.get(current.event_id) : undefined;
    const participant = current.participant_id ? participants.get(current.participant_id) : undefined;
    const player = current.player_id ? players.get(current.player_id) : undefined;
    const team = current.team_id ? teams.get(current.team_id) : undefined;
    const opponentTeam = current.opponent_team_id ? teams.get(current.opponent_team_id) : undefined;
    const market = current.market_id ? markets.get(current.market_id) : undefined;
    const sportsbook = current.sportsbook_id ? sportsbooks.get(current.sportsbook_id) : undefined;

    const participantDisplayName = participant?.display_name ?? player?.display_name ?? player?.canonical_name ?? current.player_name;
    const participantImageUrl = derivePlayerHeadshotUrl({
      leagueId: current.league_id.toUpperCase() as "MLB" | "NBA" | "WNBA",
      participantImageUrl: participant?.image_url ?? null,
      storedHeadshotUrl: player?.headshot_url ?? null,
      externalIds: player?.external_ids ?? participant?.external_ids ?? null,
    });
    const teamLogoUrl = deriveTeamLogoUrl({
      leagueId: current.league_id.toUpperCase() as "MLB" | "NBA" | "WNBA",
      storedLogoUrl: team?.logo_url ?? null,
      externalIds: team?.external_ids ?? null,
      abbreviation: team?.abbreviation ?? current.team_name ?? null,
    });
    const opponentLogoUrl = deriveTeamLogoUrl({
      leagueId: current.league_id.toUpperCase() as "MLB" | "NBA" | "WNBA",
      storedLogoUrl: opponentTeam?.logo_url ?? null,
      externalIds: opponentTeam?.external_ids ?? null,
      abbreviation: opponentTeam?.abbreviation ?? current.opponent_name ?? null,
    });
    const scoreLabel = score?.recommendation ?? null;
    const confidenceLabel = score ? confidenceLabelFor(Number(score.confidence_score ?? 0), Number(score.data_quality_score ?? 0)) : null;
    const riskLabel = score ? riskLabelFor(score.risk_flags ?? [], Number(score.data_quality_score ?? 0)) : null;

    if (query.date && !sameDay(current.start_time, query.date)) return [];
    if (query.sportsbook) {
      const wanted = normalizeText(query.sportsbook);
      const got = normalizeText(sportsbook?.code ?? sportsbook?.display_name ?? "");
      if (wanted !== got) return [];
    }
    if (query.participantSearch && !participantDisplayName.toLowerCase().includes(query.participantSearch.toLowerCase())) return [];
    if (query.onlyScored && !score) return [];
    if (query.excludeStaleOdds && current.updated_at && (Date.now() - new Date(current.updated_at).getTime()) > 3 * 60 * 60 * 1000) return [];
    if (query.excludeLowConfidenceMatches && (current.match_confidence ?? 0) < 0.75) return [];

    return [{
      current_prop_id: current.id,
      latest_scored_prop_id: score?.id ?? null,
      latest_snapshot_id: current.latest_snapshot_id,
      market_instance_key: current.market_instance_key,
      event_id: current.event_id,
      participant_id: current.participant_id,
      participant_type: current.participant_type,
      display_label: dropdownLabel({
        participantDisplayName,
        marketDisplayName: market?.display_name ?? current.market_type,
        side: current.side ?? current.direction,
        line: current.line,
        eventDisplayName: event?.display_name ?? current.opponent_name ?? "Event TBD",
        startTime: current.start_time,
        sportsbook: sportsbook?.display_name ?? null,
      }),
      sport: current.sport_id,
      league: current.league_id,
      event_display_name: event?.display_name ?? current.opponent_name,
      participant_display_name: participantDisplayName,
      participant_image_url: participantImageUrl,
      player_headshot_url: player?.headshot_url ?? participantImageUrl,
      team_display_name: team?.name ?? current.team_name,
      team_logo_url: teamLogoUrl,
      opponent_display_name: opponentTeam?.name ?? current.opponent_name,
      opponent_logo_url: opponentLogoUrl,
      market_type: current.market_type,
      sportsbook: sportsbook ? { id: sportsbook.id, code: sportsbook.code, display_name: sportsbook.display_name } : null,
      sportsbooks: sportsbook ? [{ id: sportsbook.id, code: sportsbook.code, display_name: sportsbook.display_name }] : [],
      side: current.side ?? current.direction,
      line: current.line,
      over_price: current.over_price,
      under_price: current.under_price,
      start_time: current.start_time,
      match_status: current.match_status,
      match_confidence: current.match_confidence,
      match_quality_flags: current.match_quality_flags,
      publishability_status: score?.prop_state ?? null,
      publishability_reasons: score?.publishability_reasons ?? [],
      covered_score: score?.covered_score ?? null,
      score_label: scoreLabel,
      confidence_label: confidenceLabel,
      risk_label: riskLabel,
    }];
  });

  const groupedRows = [...rows.reduce((accumulator, row) => {
    const key = displayGroupingKey({
      event_id: row.event_id,
      participant_id: row.participant_id,
      participant_name: row.participant_display_name,
      team_name: row.team_display_name,
      opponent_name: row.opponent_display_name,
      scheduled_date: row.start_time ? easternDateKey(row.start_time) : null,
      start_time: row.start_time,
      market_type: row.market_type,
      side: row.side,
      line: row.line,
      includeSide: false,
    });
    const bucket = accumulator.get(key) ?? [];
    bucket.push(row);
    accumulator.set(key, bucket);
    return accumulator;
  }, new Map<string, typeof rows>()).values()].map((bucket) => {
    const representative = [...bucket].sort((left, right) =>
      Number(right.covered_score ?? -Infinity) - Number(left.covered_score ?? -Infinity)
      || Number(right.match_confidence ?? 0) - Number(left.match_confidence ?? 0)
      || new Date(left.start_time ?? 0).getTime() - new Date(right.start_time ?? 0).getTime(),
    )[0];
    const sportsbooks = uniqueSportsbooks(bucket);
    return {
      ...representative,
      display_label: dropdownLabel({
        participantDisplayName: representative.participant_display_name,
        marketDisplayName: representative.market_type.replace(/_/g, " "),
        side: representative.side,
        line: representative.line,
        eventDisplayName: representative.event_display_name ?? "Event TBD",
        startTime: representative.start_time,
        sportsbook: sportsbooks.length <= 1 ? (sportsbooks[0]?.display_name ?? null) : `${sportsbooks.length} books`,
      }),
      sportsbooks: query.includeVariantBooks === false ? undefined : sportsbooks,
      sportsbook_count: sportsbooks.length,
      grouped_variant_count: bucket.length,
    };
  });

  const matchStatusRank = (value: string | null | undefined) => {
    switch (value) {
      case "strongly_resolved":
        return 5;
      case "matched":
        return 4;
      case "manual_selected":
      case "manual_attached":
        return 3;
      case "possible_match":
        return 2;
      default:
        return 1;
    }
  };

  groupedRows.sort((left, right) =>
    Number(right.covered_score ?? -Infinity) - Number(left.covered_score ?? -Infinity)
    || matchStatusRank(right.match_status) - matchStatusRank(left.match_status)
    || Number(right.match_confidence ?? 0) - Number(left.match_confidence ?? 0)
    || new Date(left.start_time ?? 0).getTime() - new Date(right.start_time ?? 0).getTime()
    || String(left.participant_display_name).localeCompare(String(right.participant_display_name))
  );

  return {
    count: Math.min(groupedRows.length, limit),
    rows: groupedRows.slice(0, limit),
  };
}

export async function getCoveredPickDetails(scoredPropId: string) {
  const [score] = await selectRows<ScoredPropRow>("scored_props", {
    select: "id,current_prop_id,participant_id,participant_type,player_id,team_id,opponent_id,opponent_team_id,event_id,market_id,sport_id,league_id,covered_score,projection,line,edge_score,confidence_score,data_quality_score,recommendation,risk_flags,prop_state,publishable,publishability_reasons,created_at,updated_at",
    filters: [{ column: "id", value: scoredPropId }],
    limit: 1,
  });
  if (!score) return null;

  const [current, explanation, grading] = await Promise.all([
    selectRows<CurrentPropRow>("current_props", {
      select: "id,latest_snapshot_id,sportsbook_id,market_id,market_instance_key,participant_id,participant_type,player_id,team_id,opponent_id,opponent_team_id,event_id,market_type,player_name,team_name,opponent_name,line,direction,side,over_price,under_price,start_time,updated_at",
      filters: [{ column: "id", value: score.current_prop_id }],
      limit: 1,
    }).then((rows) => rows[0] ?? null),
    selectRows<ScoreExplanation>("score_explanations", {
      select: "scored_prop_id,summary,score_label,confidence_label,risk_label,explanation,reasoning_block,factor_notes,factors,risk_notes,recent_values",
      filters: [{ column: "scored_prop_id", value: scoredPropId }],
      limit: 1,
    }).then((rows) => rows[0] ?? null),
    selectRows<GradingResult>("grading_results", {
      select: "id,scored_prop_id,current_prop_id,odds_snapshot_id,participant_id,participant_type,player_id,event_id,game_id,market_type,side,line,actual_value,final_stat,result,grade_status,grade_reason,grading_flags,grading_source,model_version_id,league_id,sport_id,notes,graded_at,created_at",
      filters: [{ column: "scored_prop_id", value: scoredPropId }],
      orderBy: "graded_at.desc",
      limit: 1,
    }).then((rows) => rows[0] ?? null),
  ]);

  if (!current) return null;

  const [eventMap, participantMap, playerMap, teamMap, marketMap, sportsbookMap] = await Promise.all([
    loadMap<EventRow>("events", current.event_id ? [current.event_id] : [], "id,display_name,scheduled_date,start_time,status,home_team_id,away_team_id"),
    loadMap<ParticipantRow>("participants", current.participant_id ? [current.participant_id] : [], "id,display_name,participant_type,player_id,team_id,image_url,external_ids"),
    loadMap<PlayerRow>("players", current.player_id ? [current.player_id] : [], "id,display_name,canonical_name,headshot_url,external_ids"),
    loadMap<TeamRow>("teams", [current.team_id, current.opponent_team_id].filter((value): value is string => Boolean(value)), "id,name,abbreviation,logo_url,external_ids"),
    loadMap<MarketRow>("markets", current.market_id ? [current.market_id] : [], "id,market_type,display_name"),
    loadMap<SportsbookRow>("sportsbooks", current.sportsbook_id ? [current.sportsbook_id] : [], "id,code,display_name"),
  ]);

  const event = current.event_id ? eventMap.get(current.event_id) : undefined;
  const participant = current.participant_id ? participantMap.get(current.participant_id) : undefined;
  const player = current.player_id ? playerMap.get(current.player_id) : undefined;
  const team = current.team_id ? teamMap.get(current.team_id) : undefined;
  const opponentTeam = current.opponent_team_id ? teamMap.get(current.opponent_team_id) : undefined;
  const market = current.market_id ? marketMap.get(current.market_id) : undefined;
  const sportsbook = current.sportsbook_id ? sportsbookMap.get(current.sportsbook_id) : undefined;

  const participantDisplayName = participant?.display_name ?? player?.display_name ?? player?.canonical_name ?? current.player_name;
  const participantImageUrl = derivePlayerHeadshotUrl({
    leagueId: score.league_id.toUpperCase() as "MLB" | "NBA" | "WNBA",
    participantImageUrl: participant?.image_url ?? null,
    storedHeadshotUrl: player?.headshot_url ?? null,
    externalIds: player?.external_ids ?? participant?.external_ids ?? null,
  });
  const teamLogoUrl = deriveTeamLogoUrl({
    leagueId: score.league_id.toUpperCase() as "MLB" | "NBA" | "WNBA",
    storedLogoUrl: team?.logo_url ?? null,
    externalIds: team?.external_ids ?? null,
    abbreviation: team?.abbreviation ?? current.team_name ?? null,
  });
  const opponentLogoUrl = deriveTeamLogoUrl({
    leagueId: score.league_id.toUpperCase() as "MLB" | "NBA" | "WNBA",
    storedLogoUrl: opponentTeam?.logo_url ?? null,
    externalIds: opponentTeam?.external_ids ?? null,
    abbreviation: opponentTeam?.abbreviation ?? current.opponent_name ?? null,
  });

  return {
    scored_prop_id: score.id,
    current_prop_id: current.id,
    odds_snapshot_id: current.latest_snapshot_id,
    market_instance_key: current.market_instance_key,
    event_id: current.event_id,
    participant_id: current.participant_id,
    participant_type: current.participant_type,
    player_display_name: participantDisplayName,
    participant_image_url: participantImageUrl,
    player_headshot_url: player?.headshot_url ?? participantImageUrl,
    team_display_name: team?.name ?? current.team_name,
    team_logo_url: teamLogoUrl,
    opponent_display_name: opponentTeam?.name ?? current.opponent_name,
    opponent_logo_url: opponentLogoUrl,
    event_display_name: event?.display_name ?? current.opponent_name,
    sport: score.sport_id,
    league: score.league_id,
    market_type: current.market_type,
    market_display_label: market?.display_name ?? current.market_type,
    sportsbook_id: sportsbook?.id ?? current.sportsbook_id ?? null,
    sportsbook: sportsbook ? { id: sportsbook.id, code: sportsbook.code, display_name: sportsbook.display_name } : null,
    side: current.side ?? current.direction,
    line: current.line,
    over_price: current.over_price,
    under_price: current.under_price,
    start_time: current.start_time,
    covered_score: score.covered_score,
    edge_score: score.edge_score,
    confidence_score: score.confidence_score,
    data_quality_score: score.data_quality_score,
    recommendation: score.recommendation,
    score_label: explanation?.score_label ?? null,
    confidence_label: explanation?.confidence_label ?? null,
    risk_label: explanation?.risk_label ?? null,
    explanation_summary: explanation?.summary ?? null,
    factor_breakdown: explanation?.factors ?? [],
    risk_flags: score.risk_flags,
    grading_result: grading ? {
      result: grading.result,
      final_stat: grading.final_stat,
      line: grading.line,
      grade_reason: grading.grade_reason,
    } : null,
    last_updated: current.updated_at ?? score.created_at,
  };
}

type PerformanceScoreRow = Pick<ScoredPropRow, "covered_score" | "confidence_score" | "recommendation" | "risk_flags"> | null;
type PerformanceExplanationRow = ScoreExplanationSummary | null;
type PerformanceCurrentRow = Pick<CurrentPropRow, "sportsbook_id"> | null;

function summarizePerformance(rows: Array<{
  grading: GradingResult;
  score: PerformanceScoreRow;
  explanation: PerformanceExplanationRow;
  current: PerformanceCurrentRow;
}>) {
  const total = rows.length;
  const wins = rows.filter((row) => row.grading.result === "win").length;
  const losses = rows.filter((row) => row.grading.result === "loss").length;
  const pushes = rows.filter((row) => row.grading.result === "push").length;
  const noGrades = rows.filter((row) => row.grading.result === "no_grade" || row.grading.grade_status === "no_grade").length;
  const gradedExcludingPushNoGrade = wins + losses;
  const hitRate = gradedExcludingPushNoGrade ? Number((wins / gradedExcludingPushNoGrade).toFixed(4)) : null;
  const pushRate = total ? Number((pushes / total).toFixed(4)) : null;
  const noGradeRate = total ? Number((noGrades / total).toFixed(4)) : null;
  const coveredScores = rows.map((row) => Number(row.score?.covered_score ?? NaN)).filter(Number.isFinite);
  const confidenceScores = rows.map((row) => Number(row.score?.confidence_score ?? NaN)).filter(Number.isFinite);
  return {
    total_graded: total,
    wins,
    losses,
    pushes,
    no_grades: noGrades,
    hit_rate_excluding_pushes_no_grades: hitRate,
    push_rate: pushRate,
    no_grade_rate: noGradeRate,
    average_covered_score: coveredScores.length ? Number((coveredScores.reduce((sum, v) => sum + v, 0) / coveredScores.length).toFixed(2)) : null,
    average_confidence_score: confidenceScores.length ? Number((confidenceScores.reduce((sum, v) => sum + v, 0) / confidenceScores.length).toFixed(2)) : null,
  };
}

function groupPerformance<T extends string>(rows: Array<{
  grading: GradingResult;
  score: PerformanceScoreRow;
  explanation: PerformanceExplanationRow;
  current: PerformanceCurrentRow;
}>, keyFn: (row: {
  grading: GradingResult;
  score: PerformanceScoreRow;
  explanation: PerformanceExplanationRow;
  current: PerformanceCurrentRow;
}) => T | null) {
  const buckets = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = keyFn(row) ?? "unknown";
    const bucket = buckets.get(key) ?? [];
    bucket.push(row);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()].map(([key, bucket]) => ({
    key,
    ...summarizePerformance(bucket),
  }));
}

export async function getModelPerformance(query: ModelPerformanceQuery) {
  const gradingLimit = KNOWLEDGE_LOW_EGRESS_MODE ? 500 : 1000;
  const filters: SupabaseFilter[] = [
    ...(query.sport ? [{ column: "sport_id", value: query.sport }] : []),
    ...(query.league ? [{ column: "league_id", value: query.league }] : []),
    ...(query.result ? [{ column: "result", value: query.result }] : []),
    ...(query.modelVersion ? [{ column: "model_version_id", value: query.modelVersion }] : []),
    ...(query.dateFrom ? [{ raw: `graded_at=gte.${encodeURIComponent(`${query.dateFrom}T00:00:00Z`)}` }] : []),
    ...(query.dateTo ? [{ raw: `graded_at=lte.${encodeURIComponent(`${query.dateTo}T23:59:59Z`)}` }] : []),
  ];

  const gradingRows = await selectRows<GradingResult>("grading_results", {
    select: "id,scored_prop_id,current_prop_id,odds_snapshot_id,participant_id,participant_type,player_id,event_id,game_id,market_type,side,line,actual_value,final_stat,result,grade_status,grade_reason,grading_flags,grading_source,model_version_id,league_id,sport_id,notes,graded_at,created_at",
    filters,
    orderBy: "graded_at.desc",
    limit: gradingLimit,
  });

  const scoredPropIds = parseIdList(gradingRows.map((row) => ({ id: row.scored_prop_id })));
  const currentPropIds = parseIdList(gradingRows.map((row) => ({ id: row.current_prop_id })));

  const scoredRows = await selectRows<ScoredPropRow>("scored_props", {
    select: "id,current_prop_id,model_version_id,sport_id,league_id,covered_score,confidence_score,recommendation,risk_flags",
    filters: scoredPropIds.length ? [{ column: "id", operator: "in", value: scoredPropIds }] : [],
    limit: scoredPropIds.length || 1,
  });
  const currentRows = query.sportsbook
    ? await selectRows<CurrentPropRow>("current_props", {
        select: "id,sportsbook_id",
        filters: currentPropIds.length ? [{ column: "id", operator: "in", value: currentPropIds }] : [],
        limit: currentPropIds.length || 1,
      })
    : [];
  const explanationMap = await explanationSummariesByScoredProp(scoredRows.map((row) => row.id));

  const sportsbookIds = parseIdList(currentRows.map((row) => ({ id: row.sportsbook_id })));
  const sportsbookMap = sportsbookIds.length
    ? await loadMap<SportsbookRow>("sportsbooks", sportsbookIds, "id,code,display_name")
    : new Map<string, SportsbookRow>();
  const scoredMap = new Map(scoredRows.map((row) => [row.id, row]));
  const currentMap = new Map(currentRows.map((row) => [row.id, row]));

  const joined = gradingRows.flatMap((grading) => {
    const score = grading.scored_prop_id ? scoredMap.get(grading.scored_prop_id) ?? null : null;
    const current = grading.current_prop_id ? currentMap.get(grading.current_prop_id) ?? null : null;
    const explanation = grading.scored_prop_id ? explanationMap.get(grading.scored_prop_id) ?? null : null;
    const sportsbook = current?.sportsbook_id ? sportsbookMap.get(current.sportsbook_id) : undefined;

    if (query.marketType && grading.market_type !== query.marketType) return [];
    if (query.recommendation && score?.recommendation !== query.recommendation) return [];
    if (typeof query.minimumCoveredScore === "number" && Number(score?.covered_score ?? -Infinity) < query.minimumCoveredScore) return [];
    if (query.scoreLabel && explanation?.score_label !== query.scoreLabel) return [];
    if (query.confidenceLabel && explanation?.confidence_label !== query.confidenceLabel) return [];
    if (query.riskLabel && explanation?.risk_label !== query.riskLabel) return [];
    if (query.sportsbook) {
      const wanted = normalizeText(query.sportsbook);
      const got = normalizeText(sportsbook?.code ?? sportsbook?.display_name ?? "");
      if (wanted !== got) return [];
    }

    return [{ grading, score, explanation, current }];
  });

  const rows = joined.map(({ grading, score, explanation, current }) => ({
    graded_at: grading.graded_at,
    sport_id: grading.sport_id ?? null,
    league_id: grading.league_id ?? null,
    market_type: grading.market_type,
    result: grading.result ?? "no_grade",
    grade_status: grading.grade_status ?? null,
    model_version_id: grading.model_version_id ?? null,
    current_prop_id: grading.current_prop_id,
    scored_prop_id: grading.scored_prop_id,
    covered_score: score?.covered_score ?? null,
    confidence_score: score?.confidence_score ?? null,
    recommendation: score?.recommendation ?? null,
    score_label: explanation?.score_label ?? null,
    confidence_label: explanation?.confidence_label ?? null,
    risk_label: explanation?.risk_label ?? null,
    sportsbook_code: current?.sportsbook_id ? sportsbookMap.get(current.sportsbook_id)?.code ?? null : null,
    sportsbook_display_name: current?.sportsbook_id ? sportsbookMap.get(current.sportsbook_id)?.display_name ?? null : null,
  }));

  return {
    summary: summarizePerformance(joined),
    performance_by_sport: groupPerformance(joined, (row) => row.grading.sport_id ?? null),
    performance_by_league: groupPerformance(joined, (row) => row.grading.league_id ?? null),
    performance_by_market_type: groupPerformance(joined, (row) => row.grading.market_type ?? null),
    performance_by_score_label: groupPerformance(joined, (row) => row.explanation?.score_label ?? null),
    performance_by_confidence_label: groupPerformance(joined, (row) => row.explanation?.confidence_label ?? null),
    performance_by_risk_label: groupPerformance(joined, (row) => row.explanation?.risk_label ?? null),
    count: joined.length,
    rows,
  };
}
