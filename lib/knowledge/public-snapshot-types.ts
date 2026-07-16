import type { CoveredPickRow, ModelPerformanceFactRow, ModelPerformanceResponse, ParlayOptionRow } from "@/lib/knowledge/read-types";

export const PUBLIC_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type PublicSnapshotRouteName = "covered-picks" | "parlay-options" | "model-performance";

export type PublicSnapshotStatus = "published" | "degraded" | "fallback";

export type PublicSnapshotSource = "published" | "relational-fallback" | "unavailable";

export type PublicSnapshotFilterScope = {
  route: PublicSnapshotRouteName;
  boundedVariant: "latest";
  supportedFilters: string[];
  fallbackOnlyFilters: string[];
};

export type PublicSnapshotEnvelope<TRow> = {
  schemaVersion: typeof PUBLIC_SNAPSHOT_SCHEMA_VERSION;
  snapshotVersion: string;
  publishedAt: string;
  dataThrough: string | null;
  sourceRefreshedAt: string | null;
  count: number;
  rows: TRow[];
  effectiveFilterScope: PublicSnapshotFilterScope;
  pipelineRunId: string | null;
  status: PublicSnapshotStatus;
};

/** Which stage a route's publication failed at, when determinable. */
export type PublicSnapshotPublicationErrorStage = "build" | "write" | "size-limit";

export type PublicSnapshotPublicationSummary = {
  route: PublicSnapshotRouteName;
  snapshotVersion: string;
  snapshotKey: string;
  rowCount: number;
  serializedBytes: number;
  maxBytes: number;
  status: PublicSnapshotStatus;
  publishedAt: string;
  fallbackReason?: string | null;
  /** True when this summary describes what publication would do without writing provider_cache. */
  dryRun?: boolean;
  /**
   * True once a real write to provider_cache was actually attempted for this route (publish:true
   * was requested and the route's build step succeeded). False for preview/dry-run calls and for
   * build failures that never reached the write step.
   */
  publicationAttempted?: boolean;
  /** True only when the write(s) to provider_cache actually completed (both the versioned and :latest keys were written). */
  publicationCompleted?: boolean;
  /** Which stage failed, when determinable. Absent/null on success or when publication was never attempted. */
  errorStage?: PublicSnapshotPublicationErrorStage | null;
  /**
   * True when the previously published `:latest` snapshot for this route (if any) remains what
   * public routes serve -- i.e. this attempt did not overwrite it. False only once a new payload
   * has actually replaced it.
   */
  priorLatestSnapshotRetained?: boolean;
};

/** Aggregate outcome across all routes for one `collectPublicSnapshotPublicationSummaries()` call. */
export type PublicSnapshotPublicationOverallStatus = "disabled" | "complete" | "partial" | "failed";

export type PublicSnapshotResponseMeta = {
  schemaVersion: typeof PUBLIC_SNAPSHOT_SCHEMA_VERSION | null;
  snapshotVersion: string | null;
  publishedAt: string | null;
  dataThrough: string | null;
  sourceRefreshedAt: string | null;
  effectiveFilterScope: PublicSnapshotFilterScope | null;
  pipelineRunId: string | null;
  status: PublicSnapshotStatus | null;
  snapshot_source: PublicSnapshotSource;
};

export type PublicCoveredPickSnapshotRow = Omit<CoveredPickRow, "factor_breakdown" | "grading_result">;

export type PublicParlayOptionSnapshotRow = ParlayOptionRow;

export type PublicModelPerformanceSnapshotRow = ModelPerformanceFactRow;

export type PublicSnapshotResponseEnvelope<TResponse> = PublicSnapshotResponseMeta & TResponse;

export type PublicCoveredPicksSnapshotResponse = PublicSnapshotResponseEnvelope<{
  product_mode: string;
  count: number;
  rows: CoveredPickRow[];
}>;

export type PublicParlayOptionsSnapshotResponse = PublicSnapshotResponseEnvelope<{
  count: number;
  rows: ParlayOptionRow[];
}>;

export type PublicModelPerformanceSnapshotResponse = PublicSnapshotResponseEnvelope<ModelPerformanceResponse>;

export const PUBLIC_SNAPSHOT_LIMITS: Record<PublicSnapshotRouteName, number> = {
  "covered-picks": 256 * 1024,
  "parlay-options": 384 * 1024,
  "model-performance": 256 * 1024,
};

export const PUBLIC_SNAPSHOT_FILTER_SCOPES: Record<PublicSnapshotRouteName, PublicSnapshotFilterScope> = {
  "covered-picks": {
    route: "covered-picks",
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
  },
  "parlay-options": {
    route: "parlay-options",
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
  },
  "model-performance": {
    route: "model-performance",
    boundedVariant: "latest",
    supportedFilters: [
      "league",
      "marketType",
      "dateFrom",
      "dateTo",
    ],
    fallbackOnlyFilters: [
      "sport",
      "sportsbook",
      "scoreLabel",
      "confidenceLabel",
      "riskLabel",
      "recommendation",
      "minimumCoveredScore",
      "modelVersion",
      "result",
    ],
  },
};
