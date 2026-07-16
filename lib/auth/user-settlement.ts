import { selectRows, updateRows } from "@/lib/db/supabase-server";

type UserPickSettlementRow = {
  id: string;
  user_id: string;
  scored_prop_id: string | null;
  current_prop_id: string | null;
  odds_snapshot_id: string | null;
  event_id: string | null;
  participant_id: string | null;
  market_instance_key: string | null;
  market_type: string | null;
  side: string | null;
  line: number | null;
  odds_taken: number | null;
  sportsbook_id: string | null;
  stake_units: number | null;
  status: string;
  result: string;
  profit_units: number | null;
  settled_at: string | null;
  created_at: string;
};

type UserParlaySettlementRow = {
  id: string;
  user_id: string;
  status: string;
  total_legs: number;
  stake_units: number | null;
  combined_odds: number | null;
  result: string;
  profit_units: number | null;
  settled_at: string | null;
  created_at: string;
};

type UserParlayLegSettlementRow = {
  id: string;
  user_parlay_id: string;
  user_pick_id: string | null;
  scored_prop_id: string | null;
  current_prop_id: string | null;
  odds_snapshot_id: string | null;
  event_id: string | null;
  participant_id: string | null;
  market_instance_key: string | null;
  market_type: string | null;
  side: string | null;
  line: number | null;
  odds_taken: number | null;
  sportsbook_id: string | null;
  leg_result: string | null;
  created_at: string;
};

type GradingLookupRow = {
  id: string;
  scored_prop_id: string | null;
  current_prop_id: string | null;
  event_id: string | null;
  participant_id: string | null;
  market_type: string | null;
  side: string | null;
  line: number | null;
  result: "win" | "loss" | "push" | "no_grade";
  grade_status: string | null;
  grade_reason: string | null;
  grading_flags: string[] | null;
  final_stat: number | null;
  graded_at: string | null;
};

type TrackableIdentity = {
  scored_prop_id: string | null;
  current_prop_id: string | null;
  event_id: string | null;
  participant_id: string | null;
  market_instance_key: string | null;
  market_type: string | null;
  side: string | null;
  line: number | null;
};

type ResolvedSettlement = {
  result: "win" | "loss" | "push" | "no_grade" | "pending";
  source: "scored_prop_id" | "current_prop_id" | "fallback" | "none";
  confident: boolean;
  gradeReason: string;
  finalStat: number | null;
  gradingFlags: string[];
  gradedAt: string | null;
};

export type SettlementSummary = {
  processedPicks: number;
  settledPicks: number;
  processedParlays: number;
  settledParlays: number;
  skippedOrPending: number;
  durationMs: number;
};

export type RunUserSettlementOptions = {
  userId?: string | null;
  limit?: number;
};

type GradeIndexes = {
  byScoredPropId: Map<string, GradingLookupRow[]>;
  byCurrentPropId: Map<string, GradingLookupRow[]>;
  fallbackRows: GradingLookupRow[];
  marketInstanceKeyByCurrentPropId: Map<string, string | null>;
};

function parseIdList(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function normalizeSide(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "more" || normalized === "over") return "more";
  if (normalized === "less" || normalized === "under") return "less";
  return normalized || null;
}

function normalizeMarketType(value: string | null | undefined) {
  const marketType = String(value ?? "").trim();
  if (!marketType) return null;
  if (marketType === "player_points_rebounds_assists") return "player_pra";
  if (marketType === "player_strikeouts") return "pitcher_strikeouts";
  if (marketType === "player_hits") return "batter_hits";
  if (marketType === "player_total_bases") return "batter_total_bases";
  if (marketType === "player_runs") return "batter_runs";
  if (marketType === "player_rbis") return "batter_rbis";
  return marketType;
}

function uniqueGradeCandidates(rows: GradingLookupRow[]) {
  const seen = new Map<string, GradingLookupRow>();
  for (const row of rows) {
    const key = [
      row.result,
      normalizeSide(row.side),
      row.line ?? "line-null",
      normalizeMarketType(row.market_type),
      row.final_stat ?? "final-null",
    ].join("|");
    if (!seen.has(key)) seen.set(key, row);
  }
  return [...seen.values()];
}

function pickBestGrade(rows: GradingLookupRow[]) {
  const eligible = rows
    .filter((row) => ["graded", "no_grade"].includes(String(row.grade_status ?? "").toLowerCase()))
    .sort((left, right) => new Date(right.graded_at ?? 0).getTime() - new Date(left.graded_at ?? 0).getTime());
  return eligible;
}

function resolveCandidateSet(
  candidates: GradingLookupRow[],
  source: ResolvedSettlement["source"],
  ambiguousReason: string,
): ResolvedSettlement {
  const eligible = pickBestGrade(candidates);
  if (!eligible.length) {
    return {
      result: "pending",
      source: "none",
      confident: false,
      gradeReason: "pending_grading",
      finalStat: null,
      gradingFlags: ["pending_grading"],
      gradedAt: null,
    };
  }

  const unique = uniqueGradeCandidates(eligible);
  if (unique.length !== 1) {
    return {
      result: "pending",
      source,
      confident: false,
      gradeReason: ambiguousReason,
      finalStat: null,
      gradingFlags: ["ambiguous_grade_match"],
      gradedAt: null,
    };
  }

  const row = unique[0];
  return {
    result: row.result,
    source,
    confident: true,
    gradeReason: row.grade_reason ?? "graded",
    finalStat: row.final_stat,
    gradingFlags: row.grading_flags ?? [],
    gradedAt: row.graded_at,
  };
}

function resolveTrackedSelection(identity: TrackableIdentity, indexes: GradeIndexes): ResolvedSettlement {
  if (identity.scored_prop_id) {
    const candidates = indexes.byScoredPropId.get(identity.scored_prop_id) ?? [];
    const resolved = resolveCandidateSet(candidates, "scored_prop_id", "ambiguous_scored_prop_grade");
    if (resolved.result !== "pending" || candidates.length) return resolved;
  }

  if (identity.current_prop_id) {
    const candidates = indexes.byCurrentPropId.get(identity.current_prop_id) ?? [];
    const resolved = resolveCandidateSet(candidates, "current_prop_id", "ambiguous_current_prop_grade");
    if (resolved.result !== "pending" || candidates.length) return resolved;
  }

  const marketType = normalizeMarketType(identity.market_type);
  const side = normalizeSide(identity.side);
  const line = identity.line;

  if (!identity.event_id || !identity.participant_id || !marketType || !side || typeof line !== "number") {
    return {
      result: "pending",
      source: "none",
      confident: false,
      gradeReason: "pending_grading",
      finalStat: null,
      gradingFlags: ["pending_grading"],
      gradedAt: null,
    };
  }

  const fallbackMatches = indexes.fallbackRows.filter((row) => (
    row.event_id === identity.event_id &&
    row.participant_id === identity.participant_id &&
    normalizeMarketType(row.market_type) === marketType &&
    normalizeSide(row.side) === side &&
    typeof row.line === "number" &&
    row.line === line &&
    (
      !identity.market_instance_key ||
      !row.current_prop_id ||
      indexes.marketInstanceKeyByCurrentPropId.get(row.current_prop_id) === identity.market_instance_key
    )
  ));

  return resolveCandidateSet(fallbackMatches, "fallback", "ambiguous_fallback_grade");
}

function americanProfit(stake: number, americanOdds: number) {
  if (!Number.isFinite(stake) || stake < 0 || !Number.isFinite(americanOdds) || americanOdds === 0) return null;
  if (americanOdds > 0) return Number(((stake * americanOdds) / 100).toFixed(4));
  return Number(((stake * 100) / Math.abs(americanOdds)).toFixed(4));
}

function decimalFromAmerican(americanOdds: number) {
  if (!Number.isFinite(americanOdds) || americanOdds === 0) return null;
  if (americanOdds > 0) return 1 + americanOdds / 100;
  return 1 + 100 / Math.abs(americanOdds);
}

function profitUnitsForSingle(result: ResolvedSettlement["result"], stakeUnits: number | null, oddsTaken: number | null) {
  const stake = stakeUnits ?? 1;
  if (result === "loss") return Number((-stake).toFixed(4));
  if (result === "push" || result === "no_grade") return 0;
  if (result !== "win") return null;
  if (typeof oddsTaken !== "number") return null;
  return americanProfit(stake, oddsTaken);
}

function profitUnitsForParlay(parlay: UserParlaySettlementRow, legs: UserParlayLegSettlementRow[], result: string) {
  const stake = parlay.stake_units ?? 1;
  if (result === "loss") return Number((-stake).toFixed(4));
  if (result === "push" || result === "no_grade") return 0;
  if (result !== "win") return null;

  if (typeof parlay.combined_odds === "number") {
    return americanProfit(stake, parlay.combined_odds);
  }

  const winningLegs = legs.filter((leg) => leg.leg_result === "win");
  if (!winningLegs.length) return 0;

  const decimalOdds = winningLegs.map((leg) => decimalFromAmerican(leg.odds_taken ?? NaN));
  if (decimalOdds.some((value) => value === null)) return null;
  const numericDecimalOdds = decimalOdds.filter((value): value is number => value !== null);
  const combinedDecimal = numericDecimalOdds.reduce((total, current) => total * current, 1);
  return Number((stake * (combinedDecimal - 1)).toFixed(4));
}

async function loadPendingUserPicks(options: RunUserSettlementOptions) {
  return selectRows<UserPickSettlementRow>("user_picks", {
    select: "id,user_id,scored_prop_id,current_prop_id,odds_snapshot_id,event_id,participant_id,market_instance_key,market_type,side,line,odds_taken,sportsbook_id,stake_units,status,result,profit_units,settled_at,created_at",
    filters: [
      ...(options.userId ? [{ column: "user_id", value: options.userId }] : []),
      { raw: "or=(status.eq.open,result.eq.pending)" },
    ],
    orderBy: "created_at.asc",
    limit: Math.max(1, Math.min(options.limit ?? 100, 250)),
  });
}

async function loadPendingParlays(options: RunUserSettlementOptions) {
  const parlays = await selectRows<UserParlaySettlementRow>("user_parlays", {
    select: "id,user_id,status,total_legs,stake_units,combined_odds,result,profit_units,settled_at,created_at",
    filters: [
      ...(options.userId ? [{ column: "user_id", value: options.userId }] : []),
      { raw: "or=(status.eq.open,result.eq.pending)" },
    ],
    orderBy: "created_at.asc",
    limit: Math.max(1, Math.min(options.limit ?? 100, 250)),
  });

  const parlayIds = parlays.map((parlay) => parlay.id);
  const legs = parlayIds.length
    ? await selectRows<UserParlayLegSettlementRow>("user_parlay_legs", {
        select: "id,user_parlay_id,user_pick_id,scored_prop_id,current_prop_id,odds_snapshot_id,event_id,participant_id,market_instance_key,market_type,side,line,odds_taken,sportsbook_id,leg_result,created_at",
        filters: [{ column: "user_parlay_id", operator: "in", value: parlayIds }],
        orderBy: "created_at.asc",
        limit: Math.min(parlayIds.length * 12, 2000),
      })
    : [];

  return { parlays, legs };
}

async function buildGradeIndexes(identities: TrackableIdentity[]) {
  const scoredPropIds = parseIdList(identities.map((row) => row.scored_prop_id));
  const currentPropIds = parseIdList(identities.map((row) => row.current_prop_id));
  const eventIds = parseIdList(identities.map((row) => row.event_id));
  const participantIds = parseIdList(identities.map((row) => row.participant_id));
  const marketTypes = parseIdList(identities.map((row) => normalizeMarketType(row.market_type)));

  const [byScoredRows, byCurrentRows, fallbackRows] = await Promise.all([
    scoredPropIds.length
      ? selectRows<GradingLookupRow>("grading_results", {
          select: "id,scored_prop_id,current_prop_id,event_id,participant_id,market_type,side,line,result,grade_status,grade_reason,grading_flags,final_stat,graded_at",
          filters: [{ column: "scored_prop_id", operator: "in", value: scoredPropIds }],
          orderBy: "graded_at.desc",
          limit: Math.min(scoredPropIds.length * 4, 2000),
        })
      : Promise.resolve([] as GradingLookupRow[]),
    currentPropIds.length
      ? selectRows<GradingLookupRow>("grading_results", {
          select: "id,scored_prop_id,current_prop_id,event_id,participant_id,market_type,side,line,result,grade_status,grade_reason,grading_flags,final_stat,graded_at",
          filters: [{ column: "current_prop_id", operator: "in", value: currentPropIds }],
          orderBy: "graded_at.desc",
          limit: Math.min(currentPropIds.length * 4, 2000),
        })
      : Promise.resolve([] as GradingLookupRow[]),
    eventIds.length && participantIds.length && marketTypes.length
      ? selectRows<GradingLookupRow>("grading_results", {
          select: "id,scored_prop_id,current_prop_id,event_id,participant_id,market_type,side,line,result,grade_status,grade_reason,grading_flags,final_stat,graded_at",
          filters: [
            { column: "event_id", operator: "in", value: eventIds },
            { column: "participant_id", operator: "in", value: participantIds },
            { column: "market_type", operator: "in", value: marketTypes },
          ],
          orderBy: "graded_at.desc",
          limit: 3000,
        })
      : Promise.resolve([] as GradingLookupRow[]),
  ]);

  const fallbackCurrentPropIds = parseIdList(fallbackRows.map((row) => row.current_prop_id));
  const fallbackCurrentProps = fallbackCurrentPropIds.length
    ? await selectRows<{ id: string; market_instance_key: string | null }>("current_props", {
        select: "id,market_instance_key",
        filters: [{ column: "id", operator: "in", value: fallbackCurrentPropIds }],
        limit: Math.min(fallbackCurrentPropIds.length, 2000),
      })
    : [];

  const byScoredPropId = new Map<string, GradingLookupRow[]>();
  const byCurrentPropId = new Map<string, GradingLookupRow[]>();
  const marketInstanceKeyByCurrentPropId = new Map(fallbackCurrentProps.map((row) => [row.id, row.market_instance_key]));

  for (const row of byScoredRows) {
    if (!row.scored_prop_id) continue;
    const bucket = byScoredPropId.get(row.scored_prop_id) ?? [];
    bucket.push(row);
    byScoredPropId.set(row.scored_prop_id, bucket);
  }

  for (const row of byCurrentRows) {
    if (!row.current_prop_id) continue;
    const bucket = byCurrentPropId.get(row.current_prop_id) ?? [];
    bucket.push(row);
    byCurrentPropId.set(row.current_prop_id, bucket);
  }

  return {
    byScoredPropId,
    byCurrentPropId,
    fallbackRows,
    marketInstanceKeyByCurrentPropId,
  } satisfies GradeIndexes;
}

async function settleUserPicks(options: RunUserSettlementOptions) {
  const picks = await loadPendingUserPicks(options);
  const indexes = await buildGradeIndexes(picks.map((pick) => ({
    scored_prop_id: pick.scored_prop_id,
    current_prop_id: pick.current_prop_id,
    event_id: pick.event_id,
    participant_id: pick.participant_id,
    market_instance_key: pick.market_instance_key,
    market_type: pick.market_type,
    side: pick.side,
    line: pick.line,
  })));

  let settledCount = 0;
  let skippedOrPending = 0;
  const now = new Date().toISOString();

  for (const pick of picks) {
    const resolved = resolveTrackedSelection({
      scored_prop_id: pick.scored_prop_id,
      current_prop_id: pick.current_prop_id,
      event_id: pick.event_id,
      participant_id: pick.participant_id,
      market_instance_key: pick.market_instance_key,
      market_type: pick.market_type,
      side: pick.side,
      line: pick.line,
    }, indexes);

    if (resolved.result === "pending" || !resolved.confident) {
      skippedOrPending += 1;
      continue;
    }

    const profitUnits = profitUnitsForSingle(resolved.result, pick.stake_units, pick.odds_taken);
    await updateRows("user_picks", [
      { column: "id", value: pick.id },
      ...(options.userId ? [{ column: "user_id", value: options.userId }] : []),
    ], {
      status: "settled",
      result: resolved.result,
      profit_units: profitUnits,
      settled_at: resolved.gradedAt ?? now,
    }, { returning: "minimal" });
    settledCount += 1;
  }

  return { picks, settledCount, skippedOrPending };
}

async function settleParlayLegs(
  legs: UserParlayLegSettlementRow[],
  options: RunUserSettlementOptions,
) {
  const indexes = await buildGradeIndexes(legs.map((leg) => ({
    scored_prop_id: leg.scored_prop_id,
    current_prop_id: leg.current_prop_id,
    event_id: leg.event_id,
    participant_id: leg.participant_id,
    market_instance_key: leg.market_instance_key,
    market_type: leg.market_type,
    side: leg.side,
    line: leg.line,
  })));

  const resultByLegId = new Map<string, string>();
  let pendingCount = 0;

  for (const leg of legs) {
    const resolved = resolveTrackedSelection({
      scored_prop_id: leg.scored_prop_id,
      current_prop_id: leg.current_prop_id,
      event_id: leg.event_id,
      participant_id: leg.participant_id,
      market_instance_key: leg.market_instance_key,
      market_type: leg.market_type,
      side: leg.side,
      line: leg.line,
    }, indexes);

    const nextResult = resolved.result;
    resultByLegId.set(leg.id, nextResult);

    if ((leg.leg_result ?? "pending") !== nextResult) {
      await updateRows("user_parlay_legs", [{ column: "id", value: leg.id }], {
        leg_result: nextResult,
      }, { returning: "minimal" });
    }

    if (nextResult === "pending") pendingCount += 1;
  }

  return { resultByLegId, pendingCount };
}

function deriveParlayResult(legs: UserParlayLegSettlementRow[]) {
  const results = legs.map((leg) => leg.leg_result ?? "pending");
  if (!results.length || results.some((result) => result === "pending")) {
    return { status: "open", result: "pending" as const };
  }
  if (results.some((result) => result === "loss")) {
    return { status: "settled", result: "loss" as const };
  }
  if (results.some((result) => result === "no_grade")) {
    return { status: "settled", result: "no_grade" as const };
  }
  const allPush = results.every((result) => result === "push");
  if (allPush) {
    return { status: "settled", result: "push" as const };
  }
  const hasPush = results.some((result) => result === "push");
  if (hasPush) {
    return { status: "settled", result: "win" as const };
  }
  return { status: "settled", result: "win" as const };
}

async function settleUserParlays(options: RunUserSettlementOptions) {
  const { parlays, legs } = await loadPendingParlays(options);
  const { resultByLegId, pendingCount } = await settleParlayLegs(legs, options);
  const legsByParlayId = new Map<string, UserParlayLegSettlementRow[]>();

  for (const leg of legs) {
    const next = resultByLegId.get(leg.id) ?? leg.leg_result ?? "pending";
    const hydrated = { ...leg, leg_result: next };
    const bucket = legsByParlayId.get(leg.user_parlay_id) ?? [];
    bucket.push(hydrated);
    legsByParlayId.set(leg.user_parlay_id, bucket);
  }

  let settledCount = 0;
  const now = new Date().toISOString();

  for (const parlay of parlays) {
    const parlayLegs = legsByParlayId.get(parlay.id) ?? [];
    const next = deriveParlayResult(parlayLegs);
    if (next.result === "pending") continue;
    const profitUnits = profitUnitsForParlay(parlay, parlayLegs, next.result);

    await updateRows("user_parlays", [
      { column: "id", value: parlay.id },
      ...(options.userId ? [{ column: "user_id", value: options.userId }] : []),
    ], {
      status: next.status,
      result: next.result,
      profit_units: profitUnits,
      settled_at: now,
    }, { returning: "minimal" });
    settledCount += 1;
  }

  return { parlays, settledCount, pendingCount };
}

export async function runAutomaticUserSettlement(options: RunUserSettlementOptions = {}): Promise<SettlementSummary> {
  const startedAt = Date.now();
  const limit = Math.max(1, Math.min(options.limit ?? 100, 250));

  const { picks, settledCount: settledPicks, skippedOrPending: skippedPickCount } = await settleUserPicks({
    ...options,
    limit,
  });

  const { parlays, settledCount: settledParlays, pendingCount: pendingParlayLegs } = await settleUserParlays({
    ...options,
    limit,
  });

  return {
    processedPicks: picks.length,
    settledPicks,
    processedParlays: parlays.length,
    settledParlays,
    skippedOrPending: skippedPickCount + pendingParlayLegs + Math.max(0, parlays.length - settledParlays),
    durationMs: Date.now() - startedAt,
  };
}
