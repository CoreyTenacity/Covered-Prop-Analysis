import { selectRows, type SupabaseFilter } from "@/lib/db/supabase-server";
import { clampCoveredPicksFloor } from "@/lib/knowledge/pipeline/board-invariant";
import { confidenceLabelFor, riskLabelFor } from "@/lib/knowledge/adapters/base";
import { buildParlayCommentary } from "@/lib/knowledge/commentary";
import { derivePlayerHeadshotUrl, deriveTeamLogoUrl } from "@/lib/knowledge/media";
import { calculateEdge } from "@/lib/scoring/covered-score";
import { preparedSlateEventWindow } from "@/lib/knowledge/prepared-slate-window";
import { classifyMarketFreshness } from "@/lib/knowledge/market-freshness";
import { STRICT_ELIGIBILITY_CONTRACT_VERSION } from "@/lib/knowledge/eligibility-contract";
import type { Confidence, Direction, Opportunity, Sport } from "@/lib/types";
import type { ParlayOptionEvidence } from "@/lib/knowledge/read-types";

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
  | "score_input_id"
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
  | "score_input_id"
  | "covered_score"
  | "confidence_score"
  | "data_quality_score"
  | "recommendation"
  | "risk_flags"
  | "prop_state"
  | "publishable"
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

/**
 * Public pregame output must never surface an event at day-after-tomorrow or
 * later, Eastern -- isFutureStartTime above only proves a game hasn't
 * started yet, with no upper bound at all. A scored_props/current_props row
 * for a far-future event can genuinely exist (e.g. from a manual/diagnostic
 * scoring dispatch that didn't pass eventIds, or simply persisting from an
 * earlier day) and, without this check, would be picked up by any of
 * getCoveredPicksOfTheDay/getBoardOpportunities/getParlayOptions --
 * including their public snapshot-build and relational-fallback callers --
 * regardless of what the private pipeline scoped THIS run to.
 *
 * Deliberately narrow: only rejects a row that HAS a start_time beyond the
 * boundary. A null/unparseable start_time is left to isFutureStartTime's
 * existing (unchanged) handling -- this function does not alter that
 * behavior, only adds the missing upper bound.
 */
function isBeforePreparedSlateUpperBound(isoTime: string | null | undefined, now: Date = new Date()) {
  if (!isoTime) return true;
  const timestamp = new Date(isoTime).getTime();
  if (!Number.isFinite(timestamp)) return true;
  return timestamp < preparedSlateEventWindow(now).endMs;
}

function parseIdList(rows: Array<{ id: string | null | undefined }>) {
  return [...new Set(rows.map((row) => row.id).filter((value): value is string => Boolean(value)))];
}

function teamById(id: string | null | undefined, teams: Map<string, TeamRow>) {
  if (!id) return null;
  return teams.get(id) ?? null;
}

function collectTeamIdsFromCurrentProps(
  rows: CurrentPropRow[],
  events: Map<string, EventRow>,
  participants: Map<string, ParticipantRow>,
) {
  const teamIds = new Set<string>();
  for (const current of rows) {
    if (current.team_id) teamIds.add(current.team_id);
    if (current.opponent_team_id) teamIds.add(current.opponent_team_id);

    const participant = current.participant_id ? participants.get(current.participant_id) : null;
    if (participant?.team_id) teamIds.add(participant.team_id);

    const event = current.event_id ? events.get(current.event_id) : null;
    if (event?.home_team_id) teamIds.add(event.home_team_id);
    if (event?.away_team_id) teamIds.add(event.away_team_id);
  }

  return [...teamIds];
}

function resolveTeamDisplayContext(input: {
  current: CurrentPropRow;
  event?: EventRow;
  participant?: ParticipantRow;
  teams: Map<string, TeamRow>;
}) {
  const participantTeamId = input.participant?.team_id ?? null;
  const eventHomeTeam = teamById(input.event?.home_team_id, input.teams);
  const eventAwayTeam = teamById(input.event?.away_team_id, input.teams);

  let team = teamById(input.current.team_id ?? participantTeamId, input.teams);
  let opponentTeam = teamById(input.current.opponent_team_id, input.teams);

  if (!team && input.current.opponent_team_id && input.event) {
    if (input.current.opponent_team_id === input.event.home_team_id) team = eventAwayTeam;
    else if (input.current.opponent_team_id === input.event.away_team_id) team = eventHomeTeam;
  }

  if (!team && participantTeamId && input.event) {
    if (participantTeamId === input.event.home_team_id) team = eventHomeTeam;
    else if (participantTeamId === input.event.away_team_id) team = eventAwayTeam;
  }

  if (!opponentTeam && team && input.event) {
    if (team.id === input.event.home_team_id) opponentTeam = eventAwayTeam;
    else if (team.id === input.event.away_team_id) opponentTeam = eventHomeTeam;
  }

  if (!team && opponentTeam && input.event) {
    if (opponentTeam.id === input.event.home_team_id) team = eventAwayTeam;
    else if (opponentTeam.id === input.event.away_team_id) team = eventHomeTeam;
  }

  return {
    team,
    opponentTeam,
    teamDisplayName: team?.name ?? input.current.team_name ?? null,
    opponentDisplayName: opponentTeam?.name ?? input.current.opponent_name ?? null,
    eventDisplayName:
      input.event?.display_name
      ?? (eventAwayTeam?.name && eventHomeTeam?.name ? `${eventAwayTeam.name} at ${eventHomeTeam.name}` : null)
      ?? input.current.opponent_name
      ?? null,
  };
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

/**
 * Session 99 (owner-directed): the controlling invariant is "no public score
 * may be exposed unless the score ROW ITSELF was produced or authoritatively
 * revalidated under the current eligibility contract" -- a freshly-built
 * strict-v1 SNAPSHOT envelope (Session 98) is not sufficient on its own,
 * because it says nothing about whether the individual score rows copied
 * into it were ever actually evaluated under strict-v1's blocker set. A row
 * scored under an older, weaker rule set (or never stamped at all) can still
 * carry `publishable: true` with empty `publishability_reasons` --
 * `scoreCurrentProps` only re-evaluates a prop's completeness when that prop
 * actually gets rescored, which does not happen automatically just because
 * the code's own rules changed.
 *
 * This is the ONE shared enforcement point every public-facing read (Covered
 * Picks, Manual Analyzer, board, single-prop detail lookup) funnels through:
 * given a batch of already-fetched scored-prop rows (each carrying its own
 * `score_input_id`), returns only the subset whose linked `score_inputs` row
 * is present AND stamped with the exact current
 * `STRICT_ELIGIBILITY_CONTRACT_VERSION` in
 * `feature_payload.scoreEligibilityContractVersion`, AND whose current
 * scored-prop state is `publishable`. Provenance alone is deliberately not
 * enough: a score can have been produced under strict-v1 and still be blocked
 * now (for example, stale features or unavailable injury context). A row with no
 * `score_input_id` at all (never had a score_inputs row written, or the
 * link itself is missing) fails closed -- excluded, not assumed valid.
 *
 * One bounded batched query (`score_inputs.id IN (...)`), never N+1 -- the
 * same pattern already used by `loadMap` above and
 * `explanationsByScoredProp` below.
 */
export async function filterRowsWithCurrentScoreContract<T extends {
  score_input_id?: string | null;
  prop_state?: string | null;
  publishable?: boolean | null;
}>(rows: T[]): Promise<T[]> {
  const scoreInputIds = [...new Set(rows.map((row) => row.score_input_id).filter((value): value is string => Boolean(value)))];
  if (!scoreInputIds.length) return [];
  // Batched the same way every other bounded id-list lookup in this file is
  // (see SCORED_PROPS_LOOKUP_BATCH_SIZE/chunkIds below) -- an unbounded
  // `id IN (...)` list here would risk the exact UND_ERR_HEADERS_OVERFLOW
  // shape this codebase has already hit and fixed for scored_props/
  // score_explanations lookups.
  const scoreInputs = (
    await Promise.all(
      chunkIds(scoreInputIds, SCORED_PROPS_LOOKUP_BATCH_SIZE).map((batch) =>
        selectRows<{ id: string; feature_payload: unknown }>("score_inputs", {
          select: "id,feature_payload",
          filters: [{ column: "id", operator: "in", value: batch }],
          limit: batch.length,
        }).catch(() => []),
      ),
    )
  ).flat();
  const currentContractIds = new Set(
    scoreInputs
      .filter((row) => {
        const payload = row.feature_payload;
        return Boolean(payload && typeof payload === "object" && (payload as Record<string, unknown>).scoreEligibilityContractVersion === STRICT_ELIGIBILITY_CONTRACT_VERSION);
      })
      .map((row) => row.id),
  );
  return rows.filter((row) =>
    row.score_input_id
    && currentContractIds.has(row.score_input_id)
    && row.prop_state === "publishable"
    && row.publishable !== false,
  );
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
  const map = new Map<string, ScoreExplanationSummary>();
  for (const batch of chunkIds(scoredPropIds, SCORED_PROPS_LOOKUP_BATCH_SIZE)) {
    const rows = await selectRows<ScoreExplanationSummary>("score_explanations", {
      select: "scored_prop_id,summary,score_label,confidence_label,risk_label",
      filters: [{ column: "scored_prop_id", operator: "in", value: batch }],
      limit: batch.length,
    });
    for (const row of rows) map.set(row.scored_prop_id, row);
  }
  return map;
}

async function explanationsByScoredProp(scoredPropIds: string[], options?: { compact?: boolean }) {
  if (!scoredPropIds.length) return new Map<string, ScoreExplanation>();
  if (options?.compact) {
    return explanationSummariesByScoredProp(scoredPropIds) as Promise<Map<string, ScoreExplanation>>;
  }
  const map = new Map<string, ScoreExplanation>();
  for (const batch of chunkIds(scoredPropIds, SCORED_PROPS_LOOKUP_BATCH_SIZE)) {
    const rows = await selectRows<ScoreExplanation>("score_explanations", {
      select: "scored_prop_id,summary,score_label,confidence_label,risk_label,explanation,reasoning_block,factor_notes,factors,risk_notes,recent_values",
      filters: [{ column: "scored_prop_id", operator: "in", value: batch }],
      limit: batch.length,
    });
    for (const row of rows) map.set(row.scored_prop_id, row);
  }
  return map;
}

/**
 * Batched reader for the ONE authoritative "this sportsbook market/price was
 * genuinely re-observed at this time" signal: odds_snapshots.pulled_at,
 * reached via current_props.latest_snapshot_id. latest_snapshot_id is set
 * ONLY by ingestSharpApiMarketCandidates (sharp-odds-ingestion.ts), and ONLY
 * on a genuine isMeaningfulChange price/line observation -- every other
 * current_props writer (repairSharpCurrentPropIdentities identity repair,
 * team/opponent/event repair, cancellation/status repair) leaves it
 * untouched. current_props.updated_at is NOT safe to use for freshness: it is
 * a generic mutation timestamp bumped by those same identity/status-only
 * writers, which was proven live (production run 31129018935) to let a
 * stale-priced prop (Kelsey Mitchell, hours-old odds) pass the freshness gate
 * merely because an identity-repair pass happened to touch the row.
 */
async function loadOddsSnapshotPulledAt(snapshotIds: string[]) {
  const map = new Map<string, string | null>();
  const ids = [...new Set(snapshotIds.filter((value): value is string => Boolean(value)))];
  if (!ids.length) return map;
  for (const batch of chunkIds(ids, SCORED_PROPS_LOOKUP_BATCH_SIZE)) {
    const rows = await selectRows<{ id: string; pulled_at: string | null }>("odds_snapshots", {
      select: "id,pulled_at",
      filters: [{ column: "id", operator: "in", value: batch }],
      limit: batch.length,
    }).catch(() => []);
    for (const row of rows) map.set(row.id, row.pulled_at);
  }
  return map;
}

/**
 * 2026-08-07 (shared-quality-contract consolidation): the ONE read-time
 * market-freshness re-check, used identically by every public-facing surface
 * that exposes score-derived output (Covered Picks, Parlay Builder/Analyzer,
 * single-prop detail). A stored `publishable` row was evaluated at the LAST
 * scoring pass, which can be hours stale by the time a page is read -- see
 * loadOddsSnapshotPulledAt's doc comment for why `current.updated_at` is not
 * a safe freshness proxy. Extracted so no surface can independently omit this
 * check (getBoardOpportunities previously did, a proven drift -- an unused
 * board/Analyzer export with a weaker gate than the two callers that share
 * its role).
 */
function passesReadTimeMarketFreshness(input: {
  latestSnapshotId: string | null | undefined;
  leagueId: string;
  pulledAtBySnapshotId: Map<string, string | null>;
}): boolean {
  const observedAtIso = input.latestSnapshotId ? input.pulledAtBySnapshotId.get(input.latestSnapshotId) ?? null : null;
  return classifyMarketFreshness({ observedAtIso, leagueId: input.leagueId }) === "fresh";
}

/**
 * Batched reader for score_inputs.feature_payload (structuredInputs),
 * keyed by score_input_id -- the exact numeric evidence
 * (last_5_avg/last_10_avg/projection/edge_value/minutes_trend/usage_trend/
 * match_confidence/data_freshness) every scoring adapter already writes
 * once at scoring time. Never recomputed here; a second bounded batched
 * query against the same table filterRowsWithCurrentScoreContract already
 * reads (kept separate rather than changing that widely-used function's
 * return shape, since it is also called from saved-picks/board/auth paths
 * this feature does not touch).
 */
async function loadScoreInputFeaturePayloads(scoreInputIds: string[]) {
  const map = new Map<string, Record<string, unknown>>();
  const ids = [...new Set(scoreInputIds.filter((value): value is string => Boolean(value)))];
  if (!ids.length) return map;
  for (const batch of chunkIds(ids, SCORED_PROPS_LOOKUP_BATCH_SIZE)) {
    const rows = await selectRows<{ id: string; feature_payload: unknown }>("score_inputs", {
      select: "id,feature_payload",
      filters: [{ column: "id", operator: "in", value: batch }],
      limit: batch.length,
    }).catch(() => []);
    for (const row of rows) {
      if (row.feature_payload && typeof row.feature_payload === "object") {
        map.set(row.id, row.feature_payload as Record<string, unknown>);
      }
    }
  }
  return map;
}

type GameLogRow = {
  player_id: string;
  game_date: string;
  points: number | null;
  rebounds: number | null;
  assists: number | null;
  hits: number | null;
  total_bases: number | null;
  runs: number | null;
  rbis: number | null;
  strikeouts: number | null;
};

function statValueForMarket(row: GameLogRow, marketType: string): number | null {
  switch (marketType) {
    case "player_points": return row.points;
    case "player_rebounds": return row.rebounds;
    case "player_assists": return row.assists;
    case "player_pra":
      return row.points === null || row.rebounds === null || row.assists === null
        ? null
        : row.points + row.rebounds + row.assists;
    case "batter_hits": return row.hits;
    case "batter_total_bases": return row.total_bases;
    case "pitcher_strikeouts": return row.strikeouts;
    case "batter_runs": return row.runs;
    case "batter_rbis": return row.rbis;
    // player_threes and any other market: no stored game-log column for
    // this stat today -- genuinely unavailable, not derivable, never
    // fabricated. Callers must treat a null return as "no source", not 0.
    default: return null;
  }
}

/**
 * Deterministic last-5/last-10 hit counts against each entry's OWN exact
 * current line, counted directly from already-stored player_game_logs rows
 * -- never a per-card request (one batched query for every distinct player
 * in the current result set, reused across however many of that player's
 * markets/lines appear in it). A player with fewer than 5 (or 10) stored
 * games reports a smaller sample size rather than a fabricated count.
 */
async function loadExactLineHitCounts(entries: Array<{ playerId: string | null; marketType: string; line: number; direction: string | null }>) {
  type HitCounts = { last5HitCount: number | null; last5SampleSize: number | null; last10HitCount: number | null; last10SampleSize: number | null };
  const results = new Map<string, HitCounts>();
  const playerIds = [...new Set(entries.map((entry) => entry.playerId).filter((value): value is string => Boolean(value)))];
  if (!playerIds.length) return results;

  const logsByPlayer = new Map<string, GameLogRow[]>();
  for (const batch of chunkIds(playerIds, SCORED_PROPS_LOOKUP_BATCH_SIZE)) {
    const rows = await selectRows<GameLogRow>("player_game_logs", {
      select: "player_id,game_date,points,rebounds,assists,hits,total_bases,runs,rbis,strikeouts",
      filters: [{ column: "player_id", operator: "in", value: batch }],
      orderBy: "game_date.desc",
      limit: batch.length * 10,
    }).catch(() => []);
    for (const row of rows) {
      const list = logsByPlayer.get(row.player_id) ?? [];
      list.push(row);
      logsByPlayer.set(row.player_id, list);
    }
  }
  for (const [playerId, list] of logsByPlayer) {
    list.sort((a, b) => (a.game_date < b.game_date ? 1 : a.game_date > b.game_date ? -1 : 0));
    // player_game_logs can carry more than one stored row for the same
    // game_date (duplicate ingestion writes) -- collapse to one row per date
    // so last-5/last-10 counts reflect distinct games, never double-counted.
    const seenDates = new Set<string>();
    const deduped = list.filter((row) => {
      if (seenDates.has(row.game_date)) return false;
      seenDates.add(row.game_date);
      return true;
    });
    logsByPlayer.set(playerId, deduped);
  }

  for (const entry of entries) {
    if (!entry.playerId) continue;
    const key = `${entry.playerId}:${entry.marketType}:${entry.line}:${entry.direction ?? ""}`;
    if (results.has(key)) continue;
    const logs = logsByPlayer.get(entry.playerId) ?? [];
    const values = logs
      .map((row) => statValueForMarket(row, entry.marketType))
      .filter((value): value is number => value !== null);
    if (!values.length) {
      results.set(key, { last5HitCount: null, last5SampleSize: null, last10HitCount: null, last10SampleSize: null });
      continue;
    }
    const clears = (value: number) => (entry.direction === "Less" ? value <= entry.line : value >= entry.line);
    const last5 = values.slice(0, 5);
    const last10 = values.slice(0, 10);
    results.set(key, {
      last5HitCount: last5.length ? last5.filter(clears).length : null,
      last5SampleSize: last5.length || null,
      last10HitCount: last10.length ? last10.filter(clears).length : null,
      last10SampleSize: last10.length || null,
    });
  }
  return results;
}

/**
 * 2026-08-07 (Analyzer/Covered Picks evidence parity): the ONE evidence-
 * shaping function, used identically by getParlayOptions and
 * getCoveredPicksOfTheDay, so "Why this score?" shows the SAME evidence for
 * the same prop on either surface -- never two independent computations that
 * can drift. Every field is read directly from already-batched sources
 * (score_inputs.feature_payload, the exact-line hit-count map, the
 * explanation's own factors) -- no new query, no per-row fetch, no scoring
 * recomputation.
 */
function buildScoreEvidence(input: {
  scoreInputId: string | null | undefined;
  current: { player_id: string | null; market_type: string; line: number; side: string | null; direction: string | null; latest_snapshot_id: string | null };
  featurePayloadByScoreInputId: Map<string, Record<string, unknown>>;
  hitCountsByKey: Map<string, { last5HitCount: number | null; last5SampleSize: number | null; last10HitCount: number | null; last10SampleSize: number | null }>;
  pulledAtBySnapshotId: Map<string, string | null>;
  explanationFactors: unknown[] | null | undefined;
}): ParlayOptionEvidence | null {
  if (!input.scoreInputId) return null;
  const payload = input.featurePayloadByScoreInputId.get(input.scoreInputId) ?? null;
  const direction = input.current.side ?? input.current.direction;
  const hitCountKey = input.current.player_id ? `${input.current.player_id}:${input.current.market_type}:${input.current.line}:${direction ?? ""}` : null;
  const hitCounts = hitCountKey ? input.hitCountsByKey.get(hitCountKey) ?? null : null;
  const factorByName = new Map(
    (input.explanationFactors ?? []).map((factor) => [String((factor as { name?: unknown }).name ?? "").toLowerCase(), factor as { description?: unknown }]),
  );
  const freshness = payload?.data_freshness as Record<string, unknown> | undefined;
  const dataRefreshedAt = typeof freshness?.oddsPulledAt === "string"
    ? freshness.oddsPulledAt
    : input.pulledAtBySnapshotId.get(input.current.latest_snapshot_id ?? "") ?? null;
  return {
    projection: typeof payload?.projection === "number" ? payload.projection : null,
    edgeValue: typeof payload?.edge_value === "number" ? payload.edge_value : null,
    last5Avg: typeof payload?.last_5_avg === "number" ? payload.last_5_avg : null,
    last10Avg: typeof payload?.last_10_avg === "number" ? payload.last_10_avg : null,
    last5HitCount: hitCounts?.last5HitCount ?? null,
    last5SampleSize: hitCounts?.last5SampleSize ?? null,
    last10HitCount: hitCounts?.last10HitCount ?? null,
    last10SampleSize: hitCounts?.last10SampleSize ?? null,
    recentMinutesAvg: typeof payload?.minutes_last_5_avg === "number" ? payload.minutes_last_5_avg : null,
    minutesTrend: typeof payload?.minutes_trend === "number" ? payload.minutes_trend : null,
    usageTrend: typeof payload?.usage_trend === "number" ? payload.usage_trend : null,
    matchupNote: typeof factorByName.get("matchup")?.description === "string" ? String(factorByName.get("matchup")!.description) : null,
    injuryNote: typeof factorByName.get("injury context")?.description === "string" ? String(factorByName.get("injury context")!.description) : null,
    dataRefreshedAt,
  };
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

// Leagues Covered Picks currently draws from. When a combined (all-league) board
// is requested, the initial scored_props scan is split fairly across these
// rather than run as one query ordered by updated_at.desc -- a single combined
// scan lets whichever league's rows were touched most recently (which tracks
// each league's own, non-overlapping cron window, not score quality) fill the
// entire scanLimit and starve every other league out of the candidate pool
// before the score-based ranking below ever sees them. Each league still only
// contributes rows that pass the exact same publishable/floor gate -- this
// changes which eligible rows get *scanned*, not which rows are *eligible*.
const COVERED_PICKS_LEAGUES = ["mlb", "wnba"] as const;

export async function getCoveredPicksOfTheDay(query: CoveredPicksQuery) {
  const limit = Math.min(Math.max(query.limit ?? 250, 1), 250);
  const scanLimit = KNOWLEDGE_LOW_EGRESS_MODE
    ? Math.min(Math.max(limit * 4, 24), 250)
    : Math.min(Math.max(limit * 8, 80), 1000);
  // Covered Picks hard invariant at board candidate selection: the covered_score
  // floor is always applied and can only be raised above 70, never lowered.
  const coveredFloor = clampCoveredPicksFloor(query.minimumCoveredScore);
  const sharedFilters: SupabaseFilter[] = [
    ...(query.sport ? [{ column: "sport_id", value: query.sport }] : []),
    { column: "publishable", value: true },
    { column: "covered_score", operator: "gte" as const, value: coveredFloor },
    ...(typeof query.minimumConfidenceScore === "number" ? [{ column: "confidence_score", operator: "gte" as const, value: query.minimumConfidenceScore }] : []),
  ];

  const scoredRowsSelect = "id,current_prop_id,score_input_id,participant_id,participant_type,player_id,team_id,opponent_id,opponent_team_id,event_id,market_id,sport_id,league_id,covered_score,projection,line,edge_score,confidence_score,data_quality_score,recommendation,risk_flags,prop_state,publishable,publishability_reasons,created_at,updated_at";

  const scoredRows: ScoredPropListRow[] = query.league
    ? await selectRows<ScoredPropListRow>("scored_props", {
        select: scoredRowsSelect,
        filters: [...sharedFilters, { column: "league_id", value: query.league }],
        orderBy: "updated_at.desc",
        limit: scanLimit,
      })
    : (
        await Promise.all(
          COVERED_PICKS_LEAGUES.map((league) =>
            selectRows<ScoredPropListRow>("scored_props", {
              select: scoredRowsSelect,
              filters: [...sharedFilters, { column: "league_id", value: league }],
              orderBy: "updated_at.desc",
              limit: Math.max(Math.ceil(scanLimit / COVERED_PICKS_LEAGUES.length), 12),
            }),
          ),
        )
      ).flat();

  const latestByCurrent = new Map<string, ScoredPropListRow>();
  for (const row of scoredRows) {
    if (!latestByCurrent.has(row.current_prop_id)) latestByCurrent.set(row.current_prop_id, row);
  }
  // Session 99: a stored `publishable=true` row is not itself proof the score
  // was ever evaluated under the CURRENT strict-completeness contract -- see
  // filterRowsWithCurrentScoreContract's own doc comment for the real
  // production defect this closes.
  const latestScored = await filterRowsWithCurrentScoreContract([...latestByCurrent.values()]);

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
  const pulledAtBySnapshotId = await loadOddsSnapshotPulledAt(currentProps.map((row) => row.latest_snapshot_id));

  // 2026-08-07 Analyzer/Covered Picks evidence parity: switched from the
  // compact (summary/label-only) explanation read to the same full read
  // getParlayOptions already uses -- factors/reasoning_block are required to
  // build the same commentary + matchup/injury evidence notes on both
  // surfaces. Still one batched query for the whole result set, same row
  // count, just a few more text columns per row.
  const explanationMap = await explanationsByScoredProp(latestScored.map((row) => row.id));
  const featurePayloadByScoreInputId = await loadScoreInputFeaturePayloads(
    latestScored.map((row) => row.score_input_id).filter((value): value is string => Boolean(value)),
  );
  const hitCountsByKey = await loadExactLineHitCounts(
    currentProps.map((row) => ({ playerId: row.player_id, marketType: row.market_type, line: row.line, direction: row.side ?? row.direction })),
  );

  const eventIds = parseIdList(currentProps.map((row) => ({ id: row.event_id })));
  const participantIds = parseIdList(currentProps.map((row) => ({ id: row.participant_id })));
  const playerIds = parseIdList(currentProps.map((row) => ({ id: row.player_id })));
  const marketIds = parseIdList(currentProps.map((row) => ({ id: row.market_id })));
  const sportsbookIds = parseIdList(currentProps.map((row) => ({ id: row.sportsbook_id })));

  const [events, participants, players, markets, sportsbooks] = await Promise.all([
    loadMap<EventRow>("events", eventIds, "id,display_name,scheduled_date,start_time,status,home_team_id,away_team_id"),
    loadMap<ParticipantRow>("participants", participantIds, "id,display_name,participant_type,player_id,team_id,image_url,external_ids"),
    loadMap<PlayerRow>("players", playerIds, "id,display_name,canonical_name,headshot_url,external_ids"),
    loadMap<MarketRow>("markets", marketIds, "id,market_type,display_name"),
    loadMap<SportsbookRow>("sportsbooks", sportsbookIds, "id,code,display_name"),
  ]);
  const teams = await loadMap<TeamRow>(
    "teams",
    collectTeamIdsFromCurrentProps(currentProps, events, participants),
    "id,name,abbreviation,logo_url,external_ids",
  );

  const rows = latestScored.flatMap((score) => {
    const current = currentById.get(score.current_prop_id);
    if (!current) return [];
    if (!isFutureStartTime(current.start_time)) return [];
    if (!isBeforePreparedSlateUpperBound(current.start_time)) return [];
    // Phase 18 continuation (owner-policy re-audit) Part 1/5: `publishable`
    // was evaluated at the LAST scoring pass, which can be hours before this
    // read (scoring only runs on the pregame-gated, rotation-bottlenecked
    // pipeline cadence -- see market-freshness.ts). A page read happens far
    // more often than that. Without this re-check, a row that WAS fresh when
    // scored can sit on Covered Picks, unchanged, long after its market has
    // gone stale and before the next scoring pass ever re-evaluates it. Same
    // read-time re-check already applied to getParlayOptions. Uses
    // odds_snapshots.pulled_at (via latest_snapshot_id), NOT current.updated_at
    // -- see loadOddsSnapshotPulledAt's doc comment for why updated_at is not
    // a safe freshness proxy (production run 31129018935 finding).
    if (!passesReadTimeMarketFreshness({ latestSnapshotId: current.latest_snapshot_id, leagueId: score.league_id, pulledAtBySnapshotId })) return [];
    const explanation = explanationMap.get(score.id);
    const event = current.event_id ? events.get(current.event_id) : undefined;
    const participant = current.participant_id ? participants.get(current.participant_id) : undefined;
    const player = current.player_id ? players.get(current.player_id) : undefined;
    const { team, opponentTeam, teamDisplayName, opponentDisplayName, eventDisplayName } = resolveTeamDisplayContext({
      current,
      event,
      participant,
      teams,
    });
    const market = current.market_id ? markets.get(current.market_id) : undefined;
    const sportsbook = current.sportsbook_id ? sportsbooks.get(current.sportsbook_id) : undefined;

    // 2026-08-07 (Analyzer/Covered Picks label-parity defect found while
    // adding evidence parity coverage): these three labels used to be read
    // from the STORED score_explanations row, while getParlayOptions
    // independently derives them from the live scored_props row
    // (score.recommendation / confidenceLabelFor / riskLabelFor). The two
    // can diverge whenever score_explanations wasn't regenerated alongside a
    // rescore -- proven by a parity test with a fixture that omits
    // score_explanations.score_label. Now computed identically to
    // getParlayOptions, from the same authoritative live score row.
    const scoreLabel = score.recommendation ?? null;
    const confidenceLabel = confidenceLabelFor(Number(score.confidence_score ?? 0), Number(score.data_quality_score ?? 0));
    const riskLabel = riskLabelFor(score.risk_flags ?? [], Number(score.data_quality_score ?? 0));

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
      team_display_name: teamDisplayName,
      team_logo_url: teamLogoUrl,
      opponent_display_name: opponentDisplayName,
      opponent_logo_url: opponentLogoUrl,
      event_display_name: eventDisplayName,
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
      // Analyzer/Covered Picks parity: same evidence-building function,
      // same batched sources getParlayOptions uses -- zero extra requests
      // when a card is expanded, since it's already embedded here.
      evidence: buildScoreEvidence({
        scoreInputId: score.score_input_id,
        current,
        featurePayloadByScoreInputId,
        hitCountsByKey,
        pulledAtBySnapshotId,
        explanationFactors: explanation?.factors,
      }),
      commentary: explanation
        ? buildParlayCommentary({
            summary: explanation.summary,
            reasoningBlock: explanation.reasoning_block,
            factors: explanation.factors,
            coveredScore: score.covered_score,
            recommendation: score.recommendation,
            scoreLabel,
          })
        : null,
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
  | "score_input_id"
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
  | "prop_state"
  | "publishable"
  | "publishability_reasons"
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
    select: "id,current_prop_id,score_input_id,player_id,team_id,opponent_team_id,event_id,sport_id,league_id,covered_score,projection,line,edge_score,confidence_score,trend_score,data_quality_score,recommendation,risk_flags,prop_state,publishable,publishability_reasons",
    filters: baseFilters,
    orderBy: "updated_at.desc",
    limit: scanLimit,
  });

  const latestByCurrent = new Map<string, ScoredPropBoardRow>();
  for (const row of scoredRows) {
    if (!latestByCurrent.has(row.current_prop_id)) latestByCurrent.set(row.current_prop_id, row);
  }
  // Session 99: same score-row contract enforcement as getCoveredPicksOfTheDay --
  // see filterRowsWithCurrentScoreContract's doc comment.
  const latestScored = await filterRowsWithCurrentScoreContract([...latestByCurrent.values()]);
  if (!latestScored.length) return [];

  const currentPropIds = latestScored.map((row) => row.current_prop_id);
  const currentProps = await selectRows<CurrentPropRow>("current_props", {
    select: "id,latest_snapshot_id,player_id,team_id,opponent_team_id,event_id,market_type,player_name,team_name,opponent_name,line,direction,start_time",
    filters: [
      { column: "id", operator: "in", value: currentPropIds },
      { column: "active", value: true },
    ],
    limit: currentPropIds.length,
  });
  const currentById = new Map(currentProps.map((row) => [row.id, row]));
  // 2026-08-07 shared-quality-contract consolidation: this was the one gate
  // getCoveredPicksOfTheDay and getParlayOptions both apply that this
  // function omitted -- a stored `publishable` row can go market-stale
  // between scoring time and read time. See passesReadTimeMarketFreshness's
  // doc comment.
  const pulledAtBySnapshotId = await loadOddsSnapshotPulledAt(currentProps.map((row) => row.latest_snapshot_id));

  const activePairs = latestScored.flatMap((score) => {
    const current = currentById.get(score.current_prop_id);
    if (!current || !isFutureStartTime(current.start_time)) return [];
    if (!isBeforePreparedSlateUpperBound(current.start_time)) return [];
    if (!passesReadTimeMarketFreshness({ latestSnapshotId: current.latest_snapshot_id, leagueId: score.league_id, pulledAtBySnapshotId })) return [];
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

// Leagues the Manual Analyzer draws from when no explicit league filter is
// requested (mirrors COVERED_PICKS_LEAGUES above).
const PARLAY_OPTIONS_LEAGUES = ["mlb", "wnba"] as const;

type ParlayScanScoredPropRow = ScoredPropParlayRow & { league_id: string; event_id: string | null };
const PARLAY_SCAN_SCORED_SELECT =
  "id,current_prop_id,score_input_id,league_id,event_id,covered_score,confidence_score,data_quality_score,recommendation,risk_flags,prop_state,publishable,publishability_reasons,updated_at";

export async function getParlayOptions(query: ParlayOptionsQuery) {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 250);
  const scanLimit = KNOWLEDGE_LOW_EGRESS_MODE
    ? Math.min(Math.max(limit * 2, 60), 120)
    : 500;

  // Owner policy correction: the scan used to walk current_props ordered by
  // start_time.asc. That table has one row PER SPORTSBOOK VARIANT of a prop
  // (not one per logical prop), so a handful of early-starting games could
  // fill the entire scanLimit with sportsbook-variant rows before a later-
  // starting-but-higher-scoring prop was ever fetched from the database --
  // exactly how a valid, high-scoring relational prop (confirmed reachable
  // via the un-scan-limited single-prop lookup) was silently absent from a
  // bounded snapshot built from this same scan. Scanning scored_props instead
  // (one row per current_prop_id, already carrying covered_score) fixes both
  // causes at once: it removes the sportsbook-variant multiplication, and it
  // lets the scan itself be ordered by score instead of by start time. League
  // splitting (mirroring getCoveredPicksOfTheDay's COVERED_PICKS_LEAGUES
  // pattern) additionally prevents one league's cron cadence from starving
  // the other out of the scan window -- bounded to 2 queries, not one per
  // market/event/score-band.
  const scoredFilters: SupabaseFilter[] = [
    ...(query.sport ? [{ column: "sport_id", value: query.sport }] : []),
    ...(query.eventId ? [{ column: "event_id", value: query.eventId }] : []),
    { column: "publishable", value: true },
  ];
  const scoredRows: ParlayScanScoredPropRow[] = query.league
    ? await selectRows<ParlayScanScoredPropRow>("scored_props", {
        select: PARLAY_SCAN_SCORED_SELECT,
        filters: [...scoredFilters, { column: "league_id", value: query.league }],
        orderBy: "covered_score.desc",
        limit: scanLimit,
      })
    : (
        await Promise.all(
          PARLAY_OPTIONS_LEAGUES.map((league) =>
            selectRows<ParlayScanScoredPropRow>("scored_props", {
              select: PARLAY_SCAN_SCORED_SELECT,
              filters: [...scoredFilters, { column: "league_id", value: league }],
              orderBy: "covered_score.desc",
              limit: Math.max(Math.ceil(scanLimit / PARLAY_OPTIONS_LEAGUES.length), 40),
            }),
          ),
        )
      ).flat();

  const latestScoredDeduped = new Map<string, ParlayScanScoredPropRow>();
  for (const row of scoredRows) {
    if (!latestScoredDeduped.has(row.current_prop_id)) latestScoredDeduped.set(row.current_prop_id, row);
  }
  // Session 99: same score-row contract enforcement as getCoveredPicksOfTheDay --
  // see filterRowsWithCurrentScoreContract's doc comment.
  const contractCurrentRows = await filterRowsWithCurrentScoreContract([...latestScoredDeduped.values()]);
  const latestScored = new Map<string, ParlayScanScoredPropRow>(contractCurrentRows.map((row) => [row.current_prop_id, row]));
  const currentPropIds = [...latestScored.keys()];

  const currentPropsSharedFilters: SupabaseFilter[] = [
    ...(query.marketType ? [{ column: "market_type", value: query.marketType }] : []),
    ...(query.onlyMatched ? [{ column: "match_status", operator: "in" as const, value: ["matched", "strongly_resolved"] }] : []),
    { column: "active", value: true },
    // Matches isFutureStartTime()'s own semantics (null start_time or strictly in the future).
    { raw: `or=(start_time.is.null,start_time.gt.${encodeURIComponent(new Date().toISOString())})` },
  ];

  // Batched the same way as latestScoredCompactByCurrentProp's current_prop_id
  // lookup, and for the identical reason: an unbounded `id=in.(...)` filter
  // over up to `scanLimit` ids is long enough to overflow undici's header
  // parser (the exact UND_ERR_HEADERS_OVERFLOW this file's regression test
  // guards against) -- this join replaced the table that filter used to run
  // against, so it inherits the same batching requirement.
  const currentProps: CurrentPropRow[] = [];
  for (const batch of chunkIds(currentPropIds, SCORED_PROPS_LOOKUP_BATCH_SIZE)) {
    const batchRows = await selectRows<CurrentPropRow>("current_props", {
      select: "id,latest_snapshot_id,sport_id,league_id,sportsbook_id,market_id,market_instance_key,participant_id,participant_type,player_id,team_id,opponent_id,opponent_team_id,event_id,market_type,player_name,team_name,opponent_name,line,direction,side,over_price,under_price,match_confidence,match_status,match_quality_flags,start_time,updated_at",
      filters: [{ column: "id", operator: "in", value: batch }, ...currentPropsSharedFilters],
      limit: batch.length,
    });
    currentProps.push(...batchRows);
  }

  const eventIds = parseIdList(currentProps.map((row) => ({ id: row.event_id })));
  const participantIds = parseIdList(currentProps.map((row) => ({ id: row.participant_id })));
  const playerIds = parseIdList(currentProps.map((row) => ({ id: row.player_id })));
  const marketIds = parseIdList(currentProps.map((row) => ({ id: row.market_id })));
  const sportsbookIds = parseIdList(currentProps.map((row) => ({ id: row.sportsbook_id })));

  const [events, participants, players, markets, sportsbooks] = await Promise.all([
    loadMap<EventRow>("events", eventIds, "id,display_name,scheduled_date,start_time,status,home_team_id,away_team_id"),
    loadMap<ParticipantRow>("participants", participantIds, "id,display_name,participant_type,player_id,team_id,image_url,external_ids"),
    loadMap<PlayerRow>("players", playerIds, "id,display_name,canonical_name,headshot_url,external_ids"),
    loadMap<MarketRow>("markets", marketIds, "id,market_type,display_name"),
    loadMap<SportsbookRow>("sportsbooks", sportsbookIds, "id,code,display_name"),
  ]);
  const teams = await loadMap<TeamRow>(
    "teams",
    collectTeamIdsFromCurrentProps(currentProps, events, participants),
    "id,name,abbreviation,logo_url,external_ids",
  );

  // Public-safe commentary is a bounded, read-time reshaping of the SAME
  // score_explanations row Covered Picks already fetches -- computed once by
  // the real adapter during scoring, never recomputed here. One batched
  // lookup for every resolved scored_prop_id, not a per-card fetch.
  const explanationByScoredPropId = await explanationsByScoredProp([...latestScored.values()].map((row) => row.id));
  // Expanded-evidence tier (Session 116): two more bounded batched reads,
  // both keyed off data already produced for this exact result set -- not
  // per-card, not a new computation, not a scoring change.
  const featurePayloadByScoreInputId = await loadScoreInputFeaturePayloads(
    [...latestScored.values()].map((row) => row.score_input_id).filter((value): value is string => Boolean(value)),
  );
  const hitCountsByKey = await loadExactLineHitCounts(
    currentProps.map((row) => ({ playerId: row.player_id, marketType: row.market_type, line: row.line, direction: row.side ?? row.direction })),
  );
  const pulledAtBySnapshotId = await loadOddsSnapshotPulledAt(currentProps.map((row) => row.latest_snapshot_id));

  const rows = currentProps.flatMap((current) => {
    if (!isFutureStartTime(current.start_time)) return [];
    if (!isBeforePreparedSlateUpperBound(current.start_time)) return [];
    const score = latestScored.get(current.id) ?? null;
    const event = current.event_id ? events.get(current.event_id) : undefined;
    // Phase 18 (continuation) owner policy #2: Manual Analyzer eligibility.
    // The Manual Analyzer may show valid props BELOW 70, but it must not show
    // a prop lacking the integrity required for a truthful numeric score.
    // "Integrity" is exactly the publishable condition -- all required
    // identity/event/context/freshness present -- MINUS the Covered Picks
    // 70-point floor (which is applied separately, only in
    // getCoveredPicksOfTheDay). So: require the latest scored row to exist and
    // be publishable (`prop_state === "publishable"`, i.e. ZERO blockers). A
    // publishable row scoring below 70 IS shown here (the deliberate
    // difference from Covered Picks); a candidate -- ANY required blocker:
    // unresolved/ambiguous identity, team==opponent, postponed/canceled/
    // started event, missing or stale required context, retry-exhausted
    // matchup, stale market, or missing weather/ballpark for a sensitive
    // market -- is excluded. Genuinely-optional missing context is a soft
    // reason (not a blocker), so a publishable row missing only optional
    // context still appears, disclosed via its labels.
    if (score?.prop_state !== "publishable") return [];
    // Owner policy #1: independently re-verify current-market freshness at
    // READ time against NOW. The stored publishable flag was evaluated at
    // scoring time, which may since have gone stale. Reads
    // odds_snapshots.pulled_at (via latest_snapshot_id) directly -- NOT
    // current.updated_at, which other writers (identity repair, team/event
    // repair, status repair) also bump without a genuine new price
    // observation; see loadOddsSnapshotPulledAt's doc comment for the
    // production defect (run 31129018935) this closes.
    if (!passesReadTimeMarketFreshness({ latestSnapshotId: current.latest_snapshot_id, leagueId: current.league_id, pulledAtBySnapshotId })) return [];
    const participant = current.participant_id ? participants.get(current.participant_id) : undefined;
    const player = current.player_id ? players.get(current.player_id) : undefined;
    const { team, opponentTeam, teamDisplayName, opponentDisplayName, eventDisplayName } = resolveTeamDisplayContext({
      current,
      event,
      participant,
      teams,
    });
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
    const explanation = score ? explanationByScoredPropId.get(score.id) ?? null : null;
    const commentary = explanation
      ? buildParlayCommentary({
          summary: explanation.summary,
          reasoningBlock: explanation.reasoning_block,
          factors: explanation.factors,
          coveredScore: score?.covered_score ?? null,
          recommendation: score?.recommendation ?? null,
          scoreLabel,
        })
      : null;
    const evidence = buildScoreEvidence({
      scoreInputId: score?.score_input_id,
      current,
      featurePayloadByScoreInputId,
      hitCountsByKey,
      pulledAtBySnapshotId,
      explanationFactors: explanation?.factors,
    });

    if (query.date && !sameDay(current.start_time, query.date)) return [];
    if (query.sportsbook) {
      const wanted = normalizeText(query.sportsbook);
      const got = normalizeText(sportsbook?.code ?? sportsbook?.display_name ?? "");
      if (wanted !== got) return [];
    }
    if (query.participantSearch && !participantDisplayName.toLowerCase().includes(query.participantSearch.toLowerCase())) return [];
    if (query.onlyScored && !score) return [];
    if (query.excludeStaleOdds) {
      const pulledAt = pulledAtBySnapshotId.get(current.latest_snapshot_id) ?? null;
      if (!pulledAt || (Date.now() - new Date(pulledAt).getTime()) > 3 * 60 * 60 * 1000) return [];
    }
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
        eventDisplayName: eventDisplayName ?? "Event TBD",
        startTime: current.start_time,
        sportsbook: sportsbook?.display_name ?? null,
      }),
      sport: current.sport_id,
      league: current.league_id,
      event_display_name: eventDisplayName,
      participant_display_name: participantDisplayName,
      participant_image_url: participantImageUrl,
      player_headshot_url: player?.headshot_url ?? participantImageUrl,
      team_display_name: teamDisplayName,
      team_logo_url: teamLogoUrl,
      opponent_display_name: opponentDisplayName,
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
      commentary,
      evidence,
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
    select: "id,current_prop_id,score_input_id,participant_id,participant_type,player_id,team_id,opponent_id,opponent_team_id,event_id,market_id,sport_id,league_id,covered_score,projection,line,edge_score,confidence_score,data_quality_score,recommendation,risk_flags,prop_state,publishable,publishability_reasons,created_at,updated_at",
    filters: [{ column: "id", value: scoredPropId }],
    limit: 1,
  });
  if (!score) return null;
  // Session 99: a direct-by-id lookup is a "selected-leg detail" route with
  // no list-level filtering of its own to inherit -- it must independently
  // prove the score row was evaluated under the current strict contract,
  // exactly like every other public surface. See
  // filterRowsWithCurrentScoreContract's doc comment for why a stored
  // `publishable=true` alone is not sufficient.
  const [contractCurrent] = await filterRowsWithCurrentScoreContract([score]);
  if (!contractCurrent) return null;

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
  // 2026-08-07 shared-quality-contract consolidation: the single-prop detail
  // lookup (the evidence panel / saved-pick hydration source) had NO
  // future-event, prepared-slate-window, or read-time market-freshness check
  // at all -- only the strict-v1 contract above. A listing surface (Covered
  // Picks/Manual Analyzer) filters a row out once it starts or its market
  // goes stale, but a user can click into detail for an id that WAS eligible
  // moments earlier; without this, that click could still render a full
  // evidence panel for a now-started or now-stale prop. Same gates, same
  // shared helper, as every other surface.
  if (!isFutureStartTime(current.start_time)) return null;
  if (!isBeforePreparedSlateUpperBound(current.start_time)) return null;
  const pulledAtForDetail = await loadOddsSnapshotPulledAt([current.latest_snapshot_id]);
  if (!passesReadTimeMarketFreshness({ latestSnapshotId: current.latest_snapshot_id, leagueId: score.league_id, pulledAtBySnapshotId: pulledAtForDetail })) return null;

  const [eventMap, participantMap, playerMap, marketMap, sportsbookMap] = await Promise.all([
    loadMap<EventRow>("events", current.event_id ? [current.event_id] : [], "id,display_name,scheduled_date,start_time,status,home_team_id,away_team_id"),
    loadMap<ParticipantRow>("participants", current.participant_id ? [current.participant_id] : [], "id,display_name,participant_type,player_id,team_id,image_url,external_ids"),
    loadMap<PlayerRow>("players", current.player_id ? [current.player_id] : [], "id,display_name,canonical_name,headshot_url,external_ids"),
    loadMap<MarketRow>("markets", current.market_id ? [current.market_id] : [], "id,market_type,display_name"),
    loadMap<SportsbookRow>("sportsbooks", current.sportsbook_id ? [current.sportsbook_id] : [], "id,code,display_name"),
  ]);
  const teamMap = await loadMap<TeamRow>(
    "teams",
    collectTeamIdsFromCurrentProps([current], eventMap, participantMap),
    "id,name,abbreviation,logo_url,external_ids",
  );

  const event = current.event_id ? eventMap.get(current.event_id) : undefined;
  const participant = current.participant_id ? participantMap.get(current.participant_id) : undefined;
  const player = current.player_id ? playerMap.get(current.player_id) : undefined;
  const { team, opponentTeam, teamDisplayName, opponentDisplayName, eventDisplayName } = resolveTeamDisplayContext({
    current,
    event,
    participant,
    teams: teamMap,
  });
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
    team_display_name: teamDisplayName,
    team_logo_url: teamLogoUrl,
    opponent_display_name: opponentDisplayName,
    opponent_logo_url: opponentLogoUrl,
    event_display_name: eventDisplayName,
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
    // Same label-parity fix as getCoveredPicksOfTheDay: derived from the
    // live score row, not the (possibly stale/regenerated-later)
    // score_explanations row.
    score_label: score.recommendation ?? null,
    confidence_label: confidenceLabelFor(Number(score.confidence_score ?? 0), Number(score.data_quality_score ?? 0)),
    risk_label: riskLabelFor(score.risk_flags ?? [], Number(score.data_quality_score ?? 0)),
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
    evidence: buildScoreEvidence({
      scoreInputId: score.score_input_id,
      current,
      featurePayloadByScoreInputId: await loadScoreInputFeaturePayloads(score.score_input_id ? [score.score_input_id] : []),
      hitCountsByKey: await loadExactLineHitCounts([{ playerId: current.player_id, marketType: current.market_type, line: current.line, direction: current.side ?? current.direction }]),
      pulledAtBySnapshotId: pulledAtForDetail,
      explanationFactors: explanation?.factors,
    }),
    commentary: explanation
      ? buildParlayCommentary({
          summary: explanation.summary,
          reasoningBlock: explanation.reasoning_block,
          factors: explanation.factors,
          coveredScore: score.covered_score,
          recommendation: score.recommendation,
          scoreLabel: score.recommendation ?? null,
        })
      : null,
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
