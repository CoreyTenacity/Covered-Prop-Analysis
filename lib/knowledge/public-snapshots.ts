import { selectRows } from "@/lib/db/supabase-server";
import { getProviderCache, putProviderCache } from "@/lib/db/provider-cache";
import {
  getCoveredPicksOfTheDay,
  getModelPerformance,
  getParlayOptions,
} from "@/lib/knowledge/read-service";
import type {
  CoveredPickRow,
  CoveredPicksResponse,
  ModelPerformanceBucket,
  ModelPerformanceSummary,
  ParlayOptionRow,
  ParlayOptionsResponse,
} from "@/lib/knowledge/read-types";
import {
  type PublicSnapshotEnvelope,
  type PublicSnapshotFilterScope,
  type PublicSnapshotPublicationSummary,
  type PublicSnapshotRouteName,
  type PublicSnapshotSource,
  type PublicSnapshotStatus,
  type PublicCoveredPickSnapshotRow,
  type PublicModelPerformanceSnapshotRow,
  type PublicParlayOptionSnapshotRow,
} from "@/lib/knowledge/public-snapshot-types";
import { PUBLIC_SNAPSHOT_FILTER_SCOPES, PUBLIC_SNAPSHOT_LIMITS } from "@/lib/knowledge/public-snapshot-types";
export { PUBLIC_SNAPSHOT_FILTER_SCOPES, PUBLIC_SNAPSHOT_LIMITS } from "@/lib/knowledge/public-snapshot-types";
import type { ProviderId } from "@/lib/providers/provider-contracts";

const PUBLIC_SNAPSHOT_PROVIDER: ProviderId = "the-odds-api";
const DEFAULT_MODEL_PERFORMANCE_DATE_FROM = "2026-01-01";
export const PUBLIC_SNAPSHOT_LATEST_RETENTION_DAYS = 365;

function snapshotTraceId() {
  const runId = process.env.GITHUB_RUN_ID?.trim();
  const attempt = process.env.GITHUB_RUN_ATTEMPT?.trim();
  if (runId) return attempt ? `${runId}.${attempt}` : runId;
  return `local-${new Date().toISOString().replace(/[-:.TZ]/g, "")}`;
}

function snapshotVersionFromTrace(route: PublicSnapshotRouteName) {
  return `${route}:${snapshotTraceId()}`;
}

function sanitizeSnapshotError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  return message
    .replace(/https?:\/\/[^\s"'`]+/g, "[redacted-url]")
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[redacted-key]")
    .slice(0, 240);
}

export function publicSnapshotCacheKey(route: PublicSnapshotRouteName, snapshotVersion: string) {
  return `public-snapshot:${route}:v${snapshotVersion}`;
}

export function publicSnapshotLatestKey(route: PublicSnapshotRouteName) {
  return `public-snapshot:${route}:latest`;
}

export function publicSnapshotCacheProfile(options: { snapshotVersion: string | null; fallback?: boolean }) {
  if (options.fallback) return "public-snapshot-fallback" as const;
  return options.snapshotVersion ? "public-snapshot-versioned" as const : "public-snapshot-latest" as const;
}

export function publicSnapshotFallbackEnabled() {
  const configured = process.env.KNOWLEDGE_PUBLIC_SNAPSHOT_FALLBACK_ENABLED?.trim().toLowerCase();
  return configured !== "false" && configured !== "0" && configured !== "off";
}

export function parsePublicSnapshotVersion(value: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function measureBytes(payload: unknown) {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function currentPublishedAt() {
  return new Date().toISOString();
}

function snapshotScope(route: PublicSnapshotRouteName): PublicSnapshotFilterScope {
  if (route === "covered-picks") {
    return {
      route,
      boundedVariant: "latest",
      supportedFilters: [
        "date",
        "sport",
        "league",
        "marketType",
        "sportsbook",
        "minimumCoveredScore",
        "minimumConfidenceScore",
        "scoreLabel",
        "confidenceLabel",
        "riskLabel",
        "excludeHighRisk",
        "excludeUnsupportedMarkets",
        "startTimeFrom",
        "startTimeTo",
        "limit",
        "includeVariantBooks",
      ],
      fallbackOnlyFilters: ["includeDetails", "includeGrading"],
    };
  }
  if (route === "parlay-options") {
    return {
      route,
      boundedVariant: "latest",
      supportedFilters: [
        "date",
        "sport",
        "league",
        "eventId",
        "marketType",
        "sportsbook",
        "participantSearch",
        "onlyScored",
        "onlyMatched",
        "excludeStaleOdds",
        "excludeLowConfidenceMatches",
        "limit",
        "includeVariantBooks",
      ],
      fallbackOnlyFilters: [],
    };
  }
  return {
    route,
    boundedVariant: "latest",
    supportedFilters: [
      "league",
      "marketType",
      "dateFrom",
      "dateTo",
      "sport",
    ],
    fallbackOnlyFilters: [
      "sportsbook",
      "scoreLabel",
      "confidenceLabel",
      "riskLabel",
      "recommendation",
      "minimumCoveredScore",
      "modelVersion",
      "result",
    ],
  };
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function formatEasternDate(value: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function sameDay(value: string | null | undefined, date: string) {
  if (!value || !date) return false;
  const left = formatEasternDate(new Date(value));
  return left === date;
}

function withinTimeRange(value: string | null | undefined, from?: string | null, to?: string | null) {
  if (!value) return false;
  const start = new Date(value).getTime();
  if (!Number.isFinite(start)) return false;
  if (from) {
    const lower = new Date(from).getTime();
    if (Number.isFinite(lower) && start < lower) return false;
  }
  if (to) {
    const upper = new Date(to).getTime();
    if (Number.isFinite(upper) && start > upper) return false;
  }
  return true;
}

function defaultModelPerformanceWindow() {
  return {
    dateFrom: DEFAULT_MODEL_PERFORMANCE_DATE_FROM,
    dateTo: formatEasternDate(new Date()),
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

function uniqueIds(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))] as string[];
}

function uniqueCompositeKey(value: Record<string, unknown>) {
  return JSON.stringify(value);
}

export async function readPublicSnapshot<T>(route: PublicSnapshotRouteName, snapshotVersion: string | null) {
  const cacheKey = snapshotVersion ? publicSnapshotCacheKey(route, snapshotVersion) : publicSnapshotLatestKey(route);
  try {
    const snapshot = await getProviderCache<PublicSnapshotEnvelope<T>>(cacheKey);
    return snapshot?.payload ?? null;
  } catch {
    return null;
  }
}

export async function publishPublicSnapshot<T>(input: {
  route: PublicSnapshotRouteName;
  rows: T[];
  dataThrough?: string | null;
  sourceRefreshedAt?: string | null;
  pipelineRunId?: string | null;
  maxBytes?: number;
  status?: PublicSnapshotStatus;
  publishedAt?: string;
  /**
   * Publication is global, not per-league or per-caller-scoped: every real publish
   * recomputes and overwrites the combined, all-leagues snapshot at both the versioned
   * and `:latest` cache keys. A prior design used an opt-OUT `dryRun` flag (write unless
   * told not to), which let an ad-hoc or diagnostic caller publish live data for real
   * merely by omitting an argument -- exactly what happened once already. This is now an
   * opt-IN gate instead: nothing is written to provider_cache unless the caller passes
   * `publish: true` explicitly. Omitting this field, passing `false`, or passing any
   * other value all mean "preview only" -- the same envelope, byte-size/degraded check,
   * and row count are computed and returned (marked `dryRun: true` in the summary), but
   * `putProviderCache` is never called.
   */
  publish?: boolean;
}): Promise<PublicSnapshotPublicationSummary> {
  const route = input.route;
  const snapshotVersion = snapshotVersionFromTrace(route);
  const publishedAt = input.publishedAt ?? currentPublishedAt();
  const payload: PublicSnapshotEnvelope<T> = {
    schemaVersion: 1,
    snapshotVersion,
    publishedAt,
    dataThrough: input.dataThrough ?? null,
    sourceRefreshedAt: input.sourceRefreshedAt ?? null,
    count: input.rows.length,
    rows: input.rows,
    effectiveFilterScope: snapshotScope(route),
    pipelineRunId: input.pipelineRunId ?? snapshotTraceId(),
    status: input.status ?? "published",
  };
  const serializedBytes = measureBytes(payload);
  const maxBytes = input.maxBytes ?? 256 * 1024;
  if (serializedBytes > maxBytes) {
    return {
      route,
      snapshotVersion,
      snapshotKey: publicSnapshotCacheKey(route, snapshotVersion),
      rowCount: payload.rows.length,
      serializedBytes,
      maxBytes,
      status: "degraded" as const,
      publishedAt,
      fallbackReason: `Snapshot for ${route} exceeded ${maxBytes} bytes (${serializedBytes} bytes).`,
      ...(input.publish !== true ? { dryRun: true as const } : {}),
    } satisfies PublicSnapshotPublicationSummary;
  }

  if (input.publish !== true) {
    return {
      route,
      snapshotVersion,
      snapshotKey: publicSnapshotCacheKey(route, snapshotVersion),
      rowCount: payload.rows.length,
      serializedBytes,
      maxBytes,
      status: payload.status,
      publishedAt,
      dryRun: true,
    } satisfies PublicSnapshotPublicationSummary;
  }

  const versionedWriteSucceeded = await putProviderCache({
    cacheKey: publicSnapshotCacheKey(route, snapshotVersion),
    provider: PUBLIC_SNAPSHOT_PROVIDER,
    payload,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    sourceUpdatedAt: input.sourceRefreshedAt ?? null,
  });

  if (!versionedWriteSucceeded) {
    return {
      route,
      snapshotVersion,
      snapshotKey: publicSnapshotCacheKey(route, snapshotVersion),
      rowCount: payload.rows.length,
      serializedBytes,
      maxBytes,
      status: "degraded" as const,
      publishedAt,
      fallbackReason: `Snapshot for ${route} could not be written at versioned key ${publicSnapshotCacheKey(route, snapshotVersion)}.`,
    } satisfies PublicSnapshotPublicationSummary;
  }

  const latestWriteSucceeded = await putProviderCache({
    cacheKey: publicSnapshotLatestKey(route),
    provider: PUBLIC_SNAPSHOT_PROVIDER,
    payload,
    // Keep the last-known-good alias long enough to survive a scheduler outage.
    // Freshness is carried by the snapshot envelope, not by deleting the alias.
    expiresAt: new Date(Date.now() + PUBLIC_SNAPSHOT_LATEST_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    sourceUpdatedAt: input.sourceRefreshedAt ?? null,
  });

  if (!latestWriteSucceeded) {
    return {
      route,
      snapshotVersion,
      snapshotKey: publicSnapshotCacheKey(route, snapshotVersion),
      rowCount: payload.rows.length,
      serializedBytes,
      maxBytes,
      status: "degraded" as const,
      publishedAt,
      fallbackReason: `Snapshot for ${route} was written at the versioned key but the latest pointer could not be updated.`,
    } satisfies PublicSnapshotPublicationSummary;
  }

  return {
    route,
    snapshotVersion,
    snapshotKey: publicSnapshotCacheKey(route, snapshotVersion),
    rowCount: payload.rows.length,
    serializedBytes,
    maxBytes,
    status: payload.status,
    publishedAt,
  } satisfies PublicSnapshotPublicationSummary;
}

type PublicSnapshotPublicationDependencies = {
  coveredPicks?: typeof getCoveredPicksOfTheDay;
  parlayOptions?: typeof getParlayOptions;
  modelPerformance?: typeof getModelPerformance;
  publishPublicSnapshot?: typeof publishPublicSnapshot;
};

async function collectRoutePublicSnapshotPublication<T>(input: {
  route: PublicSnapshotRouteName;
  snapshotVersion: string;
  maxBytes: number;
  build: () => Promise<{
    rows: T[];
    dataThrough?: string | null;
    sourceRefreshedAt?: string | null;
    status?: PublicSnapshotStatus;
  }>;
  publish: typeof publishPublicSnapshot;
  /** Forwarded as the `publish` opt-in on the injected `publish` write function below; named
   * `shouldPublish` here only to avoid colliding with the callback field of the same name. */
  shouldPublish?: boolean;
}) {
  try {
    const snapshot = await input.build();
    try {
      return await input.publish({
        route: input.route,
        rows: snapshot.rows,
        dataThrough: snapshot.dataThrough ?? null,
        sourceRefreshedAt: snapshot.sourceRefreshedAt ?? null,
        status: snapshot.status ?? "published",
        maxBytes: input.maxBytes,
        publish: input.shouldPublish,
      });
    } catch (error) {
      return {
        route: input.route,
        snapshotVersion: input.snapshotVersion,
        snapshotKey: publicSnapshotCacheKey(input.route, input.snapshotVersion),
        rowCount: snapshot.rows.length,
        serializedBytes: measureBytes({
          rows: snapshot.rows,
          dataThrough: snapshot.dataThrough ?? null,
          sourceRefreshedAt: snapshot.sourceRefreshedAt ?? null,
          status: snapshot.status ?? "published",
        }),
        maxBytes: input.maxBytes,
        status: "degraded" as const,
        publishedAt: currentPublishedAt(),
        fallbackReason: `Snapshot publication for ${input.route} failed: ${sanitizeSnapshotError(error)}.`,
      } satisfies PublicSnapshotPublicationSummary;
    }
  } catch (error) {
    return {
      route: input.route,
      snapshotVersion: input.snapshotVersion,
      snapshotKey: publicSnapshotCacheKey(input.route, input.snapshotVersion),
      rowCount: 0,
      serializedBytes: 0,
      maxBytes: input.maxBytes,
      status: "degraded" as const,
      publishedAt: currentPublishedAt(),
      fallbackReason: `Snapshot collection for ${input.route} failed: ${sanitizeSnapshotError(error)}.`,
    } satisfies PublicSnapshotPublicationSummary;
  }
}

function canUseSnapshotForCoveredPicks(query: {
  includeDetails?: boolean;
  includeGrading?: boolean;
}) {
  return !query.includeDetails && !query.includeGrading;
}

function canUseSnapshotForParlayOptions(_query: {
  onlyScored?: boolean;
  onlyMatched?: boolean;
  excludeStaleOdds?: boolean;
  excludeLowConfidenceMatches?: boolean;
}) {
  return true;
}

function canUseSnapshotForModelPerformance(_query: {
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
}) {
  return true;
}

function coveredPicksSourceRow(row: CoveredPickRow) {
  const { factor_breakdown: _factor_breakdown, grading_result: _grading_result, ...compact } = row;
  return compact;
}

export function filterCoveredPicksSnapshotRows(rows: PublicCoveredPickSnapshotRow[], query: {
  date?: string | null;
  sport?: string | null;
  league?: string | null;
  marketType?: string | null;
  sportsbook?: string | null;
  minimumCoveredScore?: number;
  minimumConfidenceScore?: number;
  scoreLabel?: string | null;
  confidenceLabel?: string | null;
  riskLabel?: string | null;
  excludeHighRisk?: boolean;
  excludeUnsupportedMarkets?: boolean;
  startTimeFrom?: string | null;
  startTimeTo?: string | null;
  limit?: number;
  includeVariantBooks?: boolean;
}) {
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
  const filtered = rows.flatMap((row) => {
    if (query.sport && row.sport !== query.sport) return [];
    if (query.league && row.league !== query.league) return [];
    if (typeof query.minimumCoveredScore === "number" && Number(row.covered_score ?? -Infinity) < query.minimumCoveredScore) return [];
    if (typeof query.minimumConfidenceScore === "number" && Number(row.confidence_score ?? -Infinity) < query.minimumConfidenceScore) return [];
    if (query.marketType && row.market_type !== query.marketType) return [];
    if (query.sportsbook) {
      const wanted = normalizeText(query.sportsbook);
      const books = row.sportsbooks ?? (row.sportsbook ? [row.sportsbook] : []);
      const match = books.some((book) => wanted === normalizeText(book.code) || wanted === normalizeText(book.display_name));
      if (!match) return [];
    }
    if (query.date && !sameDay(row.start_time, query.date)) return [];
    if ((query.startTimeFrom || query.startTimeTo) && !withinTimeRange(row.start_time, query.startTimeFrom, query.startTimeTo)) return [];
    if (query.scoreLabel && row.score_label !== query.scoreLabel) return [];
    if (query.confidenceLabel && row.confidence_label !== query.confidenceLabel) return [];
    if (query.riskLabel && row.risk_label !== query.riskLabel) return [];
    if (query.excludeHighRisk && row.risk_label === "High Risk") return [];
    if (query.excludeUnsupportedMarkets && row.risk_flags?.includes("unsupported_market")) return [];

    const nextRow = {
      ...row,
      factor_breakdown: [],
      grading_result: null,
    } as CoveredPickRow;
    return [nextRow];
  });

  return filtered.slice(0, limit);
}

export function canUseCoveredPicksSnapshot(query: {
  includeDetails?: boolean;
  includeGrading?: boolean;
}) {
  return canUseSnapshotForCoveredPicks(query);
}

export function canUseParlayOptionsSnapshot(_query: {
  onlyScored?: boolean;
  onlyMatched?: boolean;
  excludeStaleOdds?: boolean;
  excludeLowConfidenceMatches?: boolean;
}) {
  return canUseSnapshotForParlayOptions(_query);
}

export function filterParlayOptionsSnapshotRows(rows: ParlayOptionRow[], query: {
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
  limit?: number;
  includeVariantBooks?: boolean;
}) {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 250);
  const filtered = rows.flatMap((row) => {
    if (query.sport && row.sport !== query.sport) return [];
    if (query.league && row.league !== query.league) return [];
    if (query.eventId && row.event_id !== query.eventId) return [];
    if (query.marketType && row.market_type !== query.marketType) return [];
    if (query.date && !sameDay(row.start_time, query.date)) return [];
    if (query.participantSearch && !row.participant_display_name.toLowerCase().includes(query.participantSearch.toLowerCase())) return [];
    if (query.onlyScored && !row.latest_scored_prop_id) return [];
    if (query.onlyMatched && !row.match_status) return [];
    if (query.excludeStaleOdds && row.start_time && (Date.now() - new Date(row.start_time).getTime()) > 3 * 60 * 60 * 1000) return [];
    if (query.excludeLowConfidenceMatches && (row.match_confidence ?? 0) < 0.75) return [];
    if (query.sportsbook) {
      const wanted = normalizeText(query.sportsbook);
      const books = row.sportsbooks ?? (row.sportsbook ? [row.sportsbook] : []);
      const match = books.some((book) => wanted === normalizeText(book.code) || wanted === normalizeText(book.display_name));
      if (!match) return [];
    }
    return [row];
  });

  return filtered.slice(0, limit);
}

export async function buildModelPerformanceFacts(query: {
  dateFrom?: string | null;
  dateTo?: string | null;
} = {}) {
  const gradingLimit = 1000;
  const filters = [
    ...(query.dateFrom ? [{ raw: `graded_at=gte.${encodeURIComponent(`${query.dateFrom}T00:00:00Z`)}` }] : []),
    ...(query.dateTo ? [{ raw: `graded_at=lte.${encodeURIComponent(`${query.dateTo}T23:59:59Z`)}` }] : []),
  ];
  const gradingRows = await selectRows<{
    id: string;
    scored_prop_id: string;
    current_prop_id: string | null;
    market_type: string;
    result: string | null;
    grade_status: string | null;
    model_version_id: string | null;
    league_id: string | null;
    sport_id: string | null;
    graded_at: string;
  }>("grading_results", {
    select: "id,scored_prop_id,current_prop_id,market_type,result,grade_status,model_version_id,league_id,sport_id,graded_at",
    filters,
    orderBy: "graded_at.desc",
    limit: gradingLimit,
  });
  const scoredIds = uniqueIds(gradingRows.map((row) => row.scored_prop_id));
  const currentIds = uniqueIds(gradingRows.map((row) => row.current_prop_id));

  const scoredRows = await selectRows<{
    id: string;
    current_prop_id: string;
    covered_score: number | null;
    confidence_score: number | null;
    recommendation: string | null;
    risk_flags: string[] | null;
  }>("scored_props", {
    select: "id,current_prop_id,covered_score,confidence_score,recommendation,risk_flags",
    filters: scoredIds.length ? [{ column: "id", operator: "in", value: scoredIds }] : [],
    limit: scoredIds.length || 1,
  });
  const currentRows = await selectRows<{
    id: string;
    sportsbook_id: string | null;
  }>("current_props", {
    select: "id,sportsbook_id",
    filters: currentIds.length ? [{ column: "id", operator: "in", value: currentIds }] : [],
    limit: currentIds.length || 1,
  });
  const sportsbookIds = uniqueIds(currentRows.map((row) => row.sportsbook_id));
  const sportsbookMap = await loadMap<{
    id: string;
    code: string;
    display_name: string;
  }>("sportsbooks", sportsbookIds, "id,code,display_name");

  const scoredMap = new Map(scoredRows.map((row) => [row.id, row]));
  const currentMap = new Map(currentRows.map((row) => [row.id, row]));
  const facts: PublicModelPerformanceSnapshotRow[] = gradingRows.flatMap((grading) => {
    const score = grading.scored_prop_id ? scoredMap.get(grading.scored_prop_id) ?? null : null;
    const current = grading.current_prop_id ? currentMap.get(grading.current_prop_id) ?? null : null;
    const sportsbook = current?.sportsbook_id ? sportsbookMap.get(current.sportsbook_id) : undefined;
    return [{
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
      score_label: null,
      confidence_label: null,
      risk_label: null,
      sportsbook_code: sportsbook?.code ?? null,
      sportsbook_display_name: sportsbook?.display_name ?? null,
    }];
  });

  return facts;
}

function scoreLabelForRecommendation(recommendation: string | null) {
  if (!recommendation) return null;
  if (recommendation === "Elite") return "Elite";
  if (recommendation === "Playable") return "Playable";
  if (recommendation === "Lean") return "Lean";
  if (recommendation === "Avoid") return "Avoid";
  return recommendation;
}

function confidenceLabelFromFact(fact: PublicModelPerformanceSnapshotRow) {
  const confidence = Number(fact.confidence_score ?? 0);
  if (confidence >= 80) return "High Confidence";
  if (confidence >= 60) return "Solid Confidence";
  if (confidence >= 40) return "Limited Confidence";
  return "Low Confidence";
}

function riskLabelFromFact(fact: PublicModelPerformanceSnapshotRow) {
  const confidence = Number(fact.confidence_score ?? 0);
  if (confidence >= 80) return "Low Risk";
  if (confidence >= 60) return "Moderate Risk";
  if (confidence >= 40) return "Elevated Risk";
  return "High Risk";
}

function summarizeModelPerformanceFacts(facts: PublicModelPerformanceSnapshotRow[]) {
  const total = facts.length;
  const wins = facts.filter((row) => row.result === "win").length;
  const losses = facts.filter((row) => row.result === "loss").length;
  const pushes = facts.filter((row) => row.result === "push").length;
  const noGrades = facts.filter((row) => row.result === "no_grade" || row.grade_status === "no_grade").length;
  const gradedExcludingPushNoGrade = wins + losses;
  const hitRate = gradedExcludingPushNoGrade ? Number((wins / gradedExcludingPushNoGrade).toFixed(4)) : null;
  const pushRate = total ? Number((pushes / total).toFixed(4)) : null;
  const noGradeRate = total ? Number((noGrades / total).toFixed(4)) : null;
  const coveredScores = facts.map((row) => Number(row.covered_score ?? NaN)).filter(Number.isFinite);
  const confidenceScores = facts.map((row) => Number(row.confidence_score ?? NaN)).filter(Number.isFinite);
  return {
    total_graded: total,
    wins,
    losses,
    pushes,
    no_grades: noGrades,
    hit_rate_excluding_pushes_no_grades: hitRate,
    push_rate: pushRate,
    no_grade_rate: noGradeRate,
    average_covered_score: coveredScores.length ? Number((coveredScores.reduce((sum, value) => sum + value, 0) / coveredScores.length).toFixed(2)) : null,
    average_confidence_score: confidenceScores.length ? Number((confidenceScores.reduce((sum, value) => sum + value, 0) / confidenceScores.length).toFixed(2)) : null,
  };
}

function groupModelPerformanceFacts<T extends string>(facts: PublicModelPerformanceSnapshotRow[], keyFn: (row: PublicModelPerformanceSnapshotRow) => T | null): ModelPerformanceBucket[] {
  const buckets = new Map<string, PublicModelPerformanceSnapshotRow[]>();
  for (const fact of facts) {
    const key = keyFn(fact) ?? "unknown";
    const bucket = buckets.get(key) ?? [];
    bucket.push(fact);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()].map(([key, bucket]) => ({
    key,
    ...summarizeModelPerformanceFacts(bucket),
  }));
}

export function filterModelPerformanceFacts(facts: PublicModelPerformanceSnapshotRow[], query: {
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
}) {
  return facts.flatMap((fact) => {
    if (query.sport && fact.sport_id !== query.sport) return [];
    if (query.league && fact.league_id !== query.league) return [];
    if (query.marketType && fact.market_type !== query.marketType) return [];
    if (query.result && fact.result !== query.result) return [];
    if (query.modelVersion && fact.model_version_id !== query.modelVersion) return [];
    if (typeof query.minimumCoveredScore === "number" && Number(fact.covered_score ?? -Infinity) < query.minimumCoveredScore) return [];
    if (query.recommendation && fact.recommendation !== query.recommendation) return [];
    const scoreLabel = scoreLabelForRecommendation(fact.recommendation);
    const confidenceLabel = confidenceLabelFromFact(fact);
    const riskLabel = riskLabelFromFact(fact);
    if (query.scoreLabel && scoreLabel !== query.scoreLabel) return [];
    if (query.confidenceLabel && confidenceLabel !== query.confidenceLabel) return [];
    if (query.riskLabel && riskLabel !== query.riskLabel) return [];
    if (query.sportsbook) {
      const wanted = normalizeText(query.sportsbook);
      const got = normalizeText(fact.sportsbook_code ?? fact.sportsbook_display_name ?? "");
      if (wanted !== got) return [];
    }
    if (query.dateFrom && query.dateTo) {
      const start = fact.graded_at ? new Date(fact.graded_at).getTime() : NaN;
      const lower = new Date(`${query.dateFrom}T00:00:00Z`).getTime();
      const upper = new Date(`${query.dateTo}T23:59:59Z`).getTime();
      if (Number.isFinite(start) && (start < lower || start > upper)) return [];
    }
    return [{
      ...fact,
      score_label: scoreLabel,
      confidence_label: confidenceLabel,
      risk_label: riskLabel,
    }];
  });
}

export function buildModelPerformanceSnapshotResponse(facts: PublicModelPerformanceSnapshotRow[]): {
  summary: ModelPerformanceSummary;
  performance_by_sport: ModelPerformanceBucket[];
  performance_by_league: ModelPerformanceBucket[];
  performance_by_market_type: ModelPerformanceBucket[];
  performance_by_score_label: ModelPerformanceBucket[];
  performance_by_confidence_label: ModelPerformanceBucket[];
  performance_by_risk_label: ModelPerformanceBucket[];
  count: number;
  rows: PublicModelPerformanceSnapshotRow[];
} {
  return {
    summary: summarizeModelPerformanceFacts(facts),
    performance_by_sport: groupModelPerformanceFacts(facts, (row) => row.sport_id ?? null),
    performance_by_league: groupModelPerformanceFacts(facts, (row) => row.league_id ?? null),
    performance_by_market_type: groupModelPerformanceFacts(facts, (row) => row.market_type ?? null),
    performance_by_score_label: groupModelPerformanceFacts(facts, (row) => scoreLabelForRecommendation(row.recommendation)),
    performance_by_confidence_label: groupModelPerformanceFacts(facts, (row) => confidenceLabelFromFact(row)),
    performance_by_risk_label: groupModelPerformanceFacts(facts, (row) => riskLabelFromFact(row)),
    count: facts.length,
    rows: facts,
  };
}

export async function collectPublicSnapshotPublicationSummaries(input: {
  modelPerformanceDateFrom?: string | null;
  modelPerformanceDateTo?: string | null;
  dependencies?: PublicSnapshotPublicationDependencies;
  /**
   * Explicit opt-in required to actually write. This function republishes ALL leagues
   * combined every time it's called for real (covered-picks/parlay-options have no
   * per-league scope), which is exactly what let a league-scoped diagnostic overwrite the
   * live public snapshot with a partial view in an earlier session. Omitting this field,
   * or passing anything other than `true`, means preview-only: the same route-by-route
   * summaries (row counts, byte size, would-be status) are computed, but nothing is
   * written to provider_cache. Only pass `publish: true` for an owner-approved, intentional
   * publish -- e.g. the real GitHub Actions pipeline's scheduled/dispatched run.
   */
  publish?: boolean;
} = {}) {
  const publishPublicSnapshotImpl = input.dependencies?.publishPublicSnapshot ?? publishPublicSnapshot;
  const coveredPicksReader = input.dependencies?.coveredPicks ?? getCoveredPicksOfTheDay;
  const parlayOptionsReader = input.dependencies?.parlayOptions ?? getParlayOptions;
  const modelPerformanceReader = input.dependencies?.modelPerformance ?? getModelPerformance;

  const [coveredPicksSnapshot, parlayOptionsSnapshot, modelPerformanceSnapshot] = await Promise.all([
    collectRoutePublicSnapshotPublication<PublicCoveredPickSnapshotRow>({
      route: "covered-picks",
      snapshotVersion: snapshotVersionFromTrace("covered-picks"),
      maxBytes: PUBLIC_SNAPSHOT_LIMITS["covered-picks"],
      publish: publishPublicSnapshotImpl,
      shouldPublish: input.publish,
      build: async () => {
        const coveredPicks = await coveredPicksReader({
          limit: 100,
          includeDetails: false,
          includeGrading: false,
          includeVariantBooks: true,
        });
        return {
          rows: coveredPicks.rows.map(coveredPicksSourceRow),
          dataThrough: coveredPicks.rows[0]?.start_time ?? null,
          sourceRefreshedAt: coveredPicks.rows[0]?.last_updated ?? null,
          status: coveredPicks.rows.length ? "published" : "fallback",
        };
      },
    }),
    collectRoutePublicSnapshotPublication<ParlayOptionRow>({
      route: "parlay-options",
      snapshotVersion: snapshotVersionFromTrace("parlay-options"),
      maxBytes: PUBLIC_SNAPSHOT_LIMITS["parlay-options"],
      publish: publishPublicSnapshotImpl,
      shouldPublish: input.publish,
      build: async () => {
        const parlayOptions = await parlayOptionsReader({
          limit: 250,
          includeVariantBooks: true,
        });
        return {
          rows: parlayOptions.rows,
          dataThrough: parlayOptions.rows[0]?.start_time ?? null,
          sourceRefreshedAt: parlayOptions.rows[0]?.start_time ?? null,
          status: parlayOptions.rows.length ? "published" : "fallback",
        };
      },
    }),
    collectRoutePublicSnapshotPublication<PublicModelPerformanceSnapshotRow>({
      route: "model-performance",
      snapshotVersion: snapshotVersionFromTrace("model-performance"),
      maxBytes: PUBLIC_SNAPSHOT_LIMITS["model-performance"],
      publish: publishPublicSnapshotImpl,
      shouldPublish: input.publish,
      build: async () => {
        const modelPerformance = await modelPerformanceReader({
          dateFrom: input.modelPerformanceDateFrom ?? DEFAULT_MODEL_PERFORMANCE_DATE_FROM,
          dateTo: input.modelPerformanceDateTo ?? formatEasternDate(new Date()),
        });
        return {
          rows: modelPerformance.rows.filter((row): row is PublicModelPerformanceSnapshotRow => Boolean(row.graded_at)),
          dataThrough: input.modelPerformanceDateTo ?? formatEasternDate(new Date()),
          sourceRefreshedAt: input.modelPerformanceDateTo ?? formatEasternDate(new Date()),
          status: modelPerformance.count ? "published" : "fallback",
        };
      },
    }),
  ]);

  return {
    "covered-picks": coveredPicksSnapshot,
    "parlay-options": parlayOptionsSnapshot,
    "model-performance": modelPerformanceSnapshot,
  } as const;
}

export async function resolvePublicSnapshotRoute<TPayload>(input: {
  route: PublicSnapshotRouteName;
  snapshotVersion: string | null;
  canUseSnapshot: boolean;
  readSnapshot: () => Promise<PublicSnapshotEnvelope<unknown> | null>;
  buildSnapshotResponse: (snapshot: PublicSnapshotEnvelope<unknown>) => TPayload;
  buildFallbackResponse: () => Promise<TPayload>;
  buildUnavailableResponse: () => TPayload;
  fallbackReason?: string | null;
}) {
  if (input.canUseSnapshot) {
    const snapshot = await input.readSnapshot();
    if (snapshot) {
      return {
        payload: input.buildSnapshotResponse(snapshot),
        cacheProfile: publicSnapshotCacheProfile({ snapshotVersion: input.snapshotVersion }),
        cacheStatus: "snapshot-hit",
        snapshotVersion: snapshot.snapshotVersion,
        sourceRefreshedAt: snapshot.sourceRefreshedAt,
        publishedAt: snapshot.publishedAt,
        status: snapshot.status,
        snapshotSource: "published" as PublicSnapshotSource,
        effectiveFilterScope: snapshot.effectiveFilterScope,
      } as const;
    }
  }

  if (!publicSnapshotFallbackEnabled()) {
    console.warn(`[public-snapshot][unavailable] route=${input.route} reason=snapshot-miss-and-fallback-disabled`);
    return {
      payload: input.buildUnavailableResponse(),
      cacheProfile: "public-snapshot-unavailable" as const,
      cacheStatus: "snapshot-unavailable",
      snapshotVersion: null,
      sourceRefreshedAt: null,
      publishedAt: null,
      status: "degraded" as const,
      snapshotSource: "unavailable" as PublicSnapshotSource,
      effectiveFilterScope: null,
    } as const;
  }

  if (input.fallbackReason) {
    console.warn(`[public-snapshot][fallback] route=${input.route} reason=${input.fallbackReason}`);
  } else {
    console.warn(`[public-snapshot][fallback] route=${input.route} reason=snapshot-miss`);
  }

  const payload = await input.buildFallbackResponse();
  return {
    payload,
    cacheProfile: publicSnapshotCacheProfile({ snapshotVersion: input.snapshotVersion, fallback: true }),
    cacheStatus: "snapshot-fallback",
    snapshotVersion: null,
    sourceRefreshedAt: null,
    publishedAt: null,
    status: "fallback" as const,
    snapshotSource: "relational-fallback" as PublicSnapshotSource,
    effectiveFilterScope: null,
  } as const;
}

export function coveredPicksSnapshotNeeded(query: {
  includeDetails?: boolean;
  includeGrading?: boolean;
}) {
  return !canUseCoveredPicksSnapshot(query);
}

export function parlayOptionsSnapshotNeeded(query: {
  onlyScored?: boolean;
  onlyMatched?: boolean;
  excludeStaleOdds?: boolean;
  excludeLowConfidenceMatches?: boolean;
}) {
  return !canUseParlayOptionsSnapshot(query);
}

export function modelPerformanceSnapshotNeeded(query: {
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
}) {
  return !canUseSnapshotForModelPerformance(query);
}
