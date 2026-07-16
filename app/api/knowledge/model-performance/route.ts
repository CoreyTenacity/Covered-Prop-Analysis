import { jsonRouteResponse } from "@/lib/api/route-response";
import { getModelPerformance } from "@/lib/knowledge/read-service";
import {
  buildModelPerformanceSnapshotResponse,
  parsePublicSnapshotVersion,
  readPublicSnapshot,
  resolvePublicSnapshotRoute,
} from "@/lib/knowledge/public-snapshots";
import type { ModelPerformanceResponse } from "@/lib/knowledge/read-types";
import type { PublicModelPerformanceSnapshotRow } from "@/lib/knowledge/public-snapshot-types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const snapshotVersion = parsePublicSnapshotVersion(url.searchParams.get("snapshotVersion"));
  const resolution = await resolvePublicSnapshotRoute<ModelPerformanceResponse>({
    route: "model-performance",
    snapshotVersion,
    canUseSnapshot: true,
    readSnapshot: () => readPublicSnapshot<PublicModelPerformanceSnapshotRow>("model-performance", snapshotVersion),
    buildSnapshotResponse: (snapshot) => ({
      schemaVersion: snapshot.schemaVersion,
      snapshotVersion: snapshot.snapshotVersion,
      publishedAt: snapshot.publishedAt,
      dataThrough: snapshot.dataThrough,
      sourceRefreshedAt: snapshot.sourceRefreshedAt,
      effectiveFilterScope: snapshot.effectiveFilterScope,
      pipelineRunId: snapshot.pipelineRunId,
      status: snapshot.status,
      snapshot_source: "published" as const,
      ...buildModelPerformanceSnapshotResponse(snapshot.rows as PublicModelPerformanceSnapshotRow[]),
    } satisfies ModelPerformanceResponse),
    buildFallbackResponse: async () => {
      const payload = await getModelPerformance({
        dateFrom: "2026-01-01",
        dateTo: new Date().toISOString().slice(0, 10),
      });
      return {
        schemaVersion: null,
        snapshotVersion: null,
        publishedAt: null,
        dataThrough: null,
        sourceRefreshedAt: null,
        effectiveFilterScope: null,
        pipelineRunId: null,
        status: "fallback" as const,
        snapshot_source: "relational-fallback" as const,
        ...payload,
      } satisfies ModelPerformanceResponse;
    },
    buildUnavailableResponse: () => ({
      schemaVersion: null,
      snapshotVersion: null,
      publishedAt: null,
      dataThrough: null,
      sourceRefreshedAt: null,
      effectiveFilterScope: null,
      pipelineRunId: null,
      status: "degraded" as const,
      snapshot_source: "unavailable" as const,
      summary: {
        total_graded: 0,
        wins: 0,
        losses: 0,
        pushes: 0,
        no_grades: 0,
        hit_rate_excluding_pushes_no_grades: null,
        push_rate: null,
        no_grade_rate: null,
        average_covered_score: null,
        average_confidence_score: null,
      },
      performance_by_sport: [],
      performance_by_league: [],
      performance_by_market_type: [],
      performance_by_score_label: [],
      performance_by_confidence_label: [],
      performance_by_risk_label: [],
      count: 0,
      rows: [],
    } satisfies ModelPerformanceResponse),
  });

  return jsonRouteResponse("/api/knowledge/model-performance", resolution.payload, {
    cacheProfile: resolution.cacheProfile,
    cacheStatus: resolution.cacheStatus,
    snapshotSource: resolution.snapshotSource,
    rowsReturned: resolution.payload.rows.length,
  });
}
