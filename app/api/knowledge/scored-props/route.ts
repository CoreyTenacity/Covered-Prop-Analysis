import { jsonRouteResponse } from "@/lib/api/route-response";
import { selectRows } from "@/lib/db/supabase-server";

export const runtime = "nodejs";

type MinimalScoredProp = {
  id: string;
  current_prop_id: string;
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
  risk_flags: string[] | null;
  prop_state: string | null;
  publishable: boolean | null;
  publishability_reasons: string[] | null;
  created_at: string;
};

type MinimalCurrentProp = {
  id: string;
  provider: string;
  sportsbook_id: string | null;
  provider_prop_key: string;
  provider_event_id: string | null;
  player_name: string;
  market_type: string;
  line: number;
  direction: string | null;
  match_status: string;
  match_confidence: number | null;
  event_id: string | null;
  participant_id: string | null;
  participant_type: string | null;
};

type SportsbookRow = { id: string; code: string; display_name: string };
type ExplanationRow = {
  scored_prop_id: string;
  summary: string | null;
  explanation: string | null;
  reasoning_block: string | null;
  factor_notes: Record<string, unknown> | null;
  risk_notes: Array<Record<string, unknown> | string> | null;
};
type SnapshotRow = { provider_prop_key: string; line: number; pulled_at: string; provider_event_id: string | null; event_id: string | null };
type GradingRow = { scored_prop_id: string; result: string | null; actual_value: number | null; grading_source: string | null; created_at: string | null; event_id: string | null; participant_id: string | null };

async function loadMap<T extends { id: string }>(table: string, ids: string[], select: string) {
  if (!ids.length) return new Map<string, T>();
  const rows = await selectRows<T>(table, {
    select,
    filters: [{ column: "id", operator: "in", value: ids }],
    limit: ids.length,
  });
  return new Map(rows.map((row) => [row.id, row]));
}

function parseNumber(value: string | null) {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const league = url.searchParams.get("league");
  const sport = url.searchParams.get("sport");
  const recommendation = url.searchParams.get("recommendation");
  const marketType = url.searchParams.get("marketType");
  const sportsbook = url.searchParams.get("sportsbook");
  const riskFlag = url.searchParams.get("riskFlag");
  const propState = url.searchParams.get("propState");
  const publishable = url.searchParams.get("publishable");
  const publishabilityReason = url.searchParams.get("publishabilityReason");
  const minimumConfidence = parseNumber(url.searchParams.get("minimumConfidence"));
  const minimumEdge = parseNumber(url.searchParams.get("minimumEdge"));
  const limit = Math.min(Math.max(parseNumber(url.searchParams.get("limit")) ?? 50, 1), 100);

  const rows = await selectRows<MinimalScoredProp>("scored_props", {
    select: "id,current_prop_id,participant_id,participant_type,player_id,team_id,opponent_id,opponent_team_id,event_id,game_id,market_id,sport_id,league_id,covered_score,projection,line,edge_value,edge_score,confidence_score,trend_score,matchup_score,market_score,data_quality_score,recommendation,risk_flags,prop_state,publishable,publishability_reasons,created_at",
    filters: [
      ...(sport ? [{ column: "sport_id", value: sport }] : []),
      ...(league ? [{ column: "league_id", value: league }] : []),
      ...(recommendation ? [{ column: "recommendation", value: recommendation }] : []),
      ...(propState ? [{ column: "prop_state", value: propState }] : []),
      ...(publishable === "true" ? [{ column: "publishable", value: true }] : []),
      ...(publishable === "false" ? [{ column: "publishable", value: false }] : []),
      ...(minimumConfidence !== undefined ? [{ column: "confidence_score", operator: "gte" as const, value: minimumConfidence }] : []),
      ...(minimumEdge !== undefined ? [{ column: "edge_value", operator: "gte" as const, value: minimumEdge }] : []),
    ],
    orderBy: "created_at.desc",
    limit,
  });

  const currentIds = [...new Set(rows.map((row) => row.current_prop_id).filter(Boolean))];
  const scoredIds = rows.map((row) => row.id);
  const providerPropKeys = new Set<string>();

  const currentProps = await selectRows<MinimalCurrentProp>("current_props", {
    select: "id,provider,sportsbook_id,provider_prop_key,provider_event_id,player_name,market_type,line,direction,match_status,match_confidence,event_id,participant_id,participant_type",
    filters: currentIds.length ? [{ column: "id", operator: "in", value: currentIds }] : [],
    limit: currentIds.length || 1,
  });
  for (const row of currentProps) providerPropKeys.add(row.provider_prop_key);

  const sportsbookIds = [...new Set(currentProps.map((row) => row.sportsbook_id).filter((value): value is string => Boolean(value)))];
  const [sportsbookMap, explanations, gradings, snapshots] = await Promise.all([
    loadMap<SportsbookRow>("sportsbooks", sportsbookIds, "id,code,display_name"),
    selectRows<ExplanationRow>("score_explanations", {
      select: "scored_prop_id,summary,explanation,reasoning_block,factor_notes,risk_notes",
      filters: scoredIds.length ? [{ column: "scored_prop_id", operator: "in", value: scoredIds }] : [],
      limit: scoredIds.length || 1,
    }),
    selectRows<GradingRow>("grading_results", {
      select: "scored_prop_id,result,actual_value,grading_source,created_at,event_id,participant_id",
      filters: scoredIds.length ? [{ column: "scored_prop_id", operator: "in", value: scoredIds }] : [],
      limit: scoredIds.length || 1,
    }),
    providerPropKeys.size
      ? selectRows<SnapshotRow>("odds_snapshots", {
          select: "provider_prop_key,line,pulled_at,provider_event_id,event_id",
          filters: [{ column: "provider_prop_key", operator: "in", value: [...providerPropKeys] }],
          orderBy: "pulled_at.desc",
          limit: Math.min(providerPropKeys.size * 2, 200),
        })
      : Promise.resolve([] as SnapshotRow[]),
  ]);

  const currentMap = new Map(currentProps.map((row) => [row.id, row]));
  const explanationMap = new Map(explanations.map((row) => [row.scored_prop_id, row]));
  const gradingMap = new Map<string, GradingRow>();
  for (const row of gradings) {
    if (!gradingMap.has(row.scored_prop_id)) gradingMap.set(row.scored_prop_id, row);
  }
  const snapshotsByKey = new Map<string, SnapshotRow[]>();
  for (const row of snapshots) {
    const bucket = snapshotsByKey.get(row.provider_prop_key) ?? [];
    if (bucket.length < 2) bucket.push(row);
    snapshotsByKey.set(row.provider_prop_key, bucket);
  }

  const enriched = rows.flatMap((row) => {
    const currentProp = currentMap.get(row.current_prop_id);
    if (!currentProp) return [];
    if (marketType && currentProp.market_type !== marketType) return [];

    const sportsbookRow = currentProp.sportsbook_id ? sportsbookMap.get(currentProp.sportsbook_id) ?? null : null;
    if (sportsbook && sportsbookRow?.code !== sportsbook && sportsbookRow?.display_name !== sportsbook) return [];

    const flags = Array.isArray(row.risk_flags) ? row.risk_flags : [];
    if (riskFlag && !flags.includes(riskFlag)) return [];
    const reasons = Array.isArray(row.publishability_reasons) ? row.publishability_reasons : [];
    if (publishabilityReason && !reasons.includes(publishabilityReason)) return [];

    const explanation = explanationMap.get(row.id) ?? null;
    const grading = gradingMap.get(row.id) ?? null;
    const recentSnapshots = snapshotsByKey.get(currentProp.provider_prop_key) ?? [];
    const lineMovement = recentSnapshots.length >= 2
      ? {
          latestLine: recentSnapshots[0].line,
          previousLine: recentSnapshots[1].line,
          delta: Number(recentSnapshots[0].line) - Number(recentSnapshots[1].line),
        }
      : null;

    return [{
      ...row,
      currentProp,
      sportsbook: sportsbookRow,
      explanation,
      lineMovement,
      grading,
      debug: {
        prop_state: row.prop_state ?? null,
        publishable: row.publishable ?? null,
        publishability_reasons: reasons,
      },
    }];
  });

  return jsonRouteResponse("/api/knowledge/scored-props", {
    count: enriched.length,
    rows: enriched,
  }, {
    cacheProfile: "private-debug",
    rowsReturned: enriched.length,
  });
}
