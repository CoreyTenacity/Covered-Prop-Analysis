import { jsonRouteResponse } from "@/lib/api/route-response";
import { getCoveredPicksOfTheDay } from "@/lib/knowledge/read-service";
import {
  canUseCoveredPicksSnapshot,
  parsePublicSnapshotVersion,
  readPublicSnapshot,
  resolvePublicSnapshotRoute,
} from "@/lib/knowledge/public-snapshots";
import type { CoveredPicksResponse } from "@/lib/knowledge/read-types";
import type { PublicCoveredPickSnapshotRow } from "@/lib/knowledge/public-snapshot-types";

export const runtime = "nodejs";

function parseBoolean(value: string | null) {
  if (!value) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function parseNumber(value: string | null) {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hydrateCoveredPickSnapshotRow(row: PublicCoveredPickSnapshotRow) {
  return {
    ...row,
    factor_breakdown: [],
    grading_result: null,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const snapshotVersion = parsePublicSnapshotVersion(url.searchParams.get("snapshotVersion"));
  const query = {
    date: url.searchParams.get("date"),
    sport: url.searchParams.get("sport"),
    league: url.searchParams.get("league"),
    marketType: url.searchParams.get("marketType"),
    sportsbook: url.searchParams.get("sportsbook"),
    minimumCoveredScore: parseNumber(url.searchParams.get("minimumCoveredScore")),
    minimumConfidenceScore: parseNumber(url.searchParams.get("minimumConfidenceScore")),
    scoreLabel: url.searchParams.get("scoreLabel"),
    confidenceLabel: url.searchParams.get("confidenceLabel"),
    riskLabel: url.searchParams.get("riskLabel"),
    excludeHighRisk: parseBoolean(url.searchParams.get("excludeHighRisk")),
    excludeUnsupportedMarkets: parseBoolean(url.searchParams.get("excludeUnsupportedMarkets")),
    startTimeFrom: url.searchParams.get("startTimeFrom"),
    startTimeTo: url.searchParams.get("startTimeTo"),
    limit: parseNumber(url.searchParams.get("limit")),
    includeDetails: parseBoolean(url.searchParams.get("includeDetails")) ?? false,
    includeGrading: parseBoolean(url.searchParams.get("includeGrading")) ?? false,
    includeVariantBooks: parseBoolean(url.searchParams.get("includeVariantBooks")) ?? false,
  };

  const resolution = await resolvePublicSnapshotRoute<CoveredPicksResponse>({
    route: "covered-picks",
    snapshotVersion,
    canUseSnapshot: canUseCoveredPicksSnapshot(query),
    readSnapshot: () => readPublicSnapshot<PublicCoveredPickSnapshotRow>("covered-picks", snapshotVersion),
    buildSnapshotResponse: (snapshot) => {
      const rows = (snapshot.rows as PublicCoveredPickSnapshotRow[]).map(hydrateCoveredPickSnapshotRow);
      return {
        schemaVersion: snapshot.schemaVersion,
        snapshotVersion: snapshot.snapshotVersion,
        publishedAt: snapshot.publishedAt,
        dataThrough: snapshot.dataThrough,
        sourceRefreshedAt: snapshot.sourceRefreshedAt,
        effectiveFilterScope: snapshot.effectiveFilterScope,
        pipelineRunId: snapshot.pipelineRunId,
        status: snapshot.status,
        snapshot_source: "published" as const,
        product_mode: "Covered Picks of the Day",
        count: rows.length,
        rows,
      } satisfies CoveredPicksResponse;
    },
    buildFallbackResponse: async () => {
      const payload = await getCoveredPicksOfTheDay({
        limit: 100,
        includeDetails: false,
        includeGrading: false,
        includeVariantBooks: true,
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
        product_mode: "Covered Picks of the Day",
        count: payload.rows.length,
        rows: payload.rows,
      } satisfies CoveredPicksResponse;
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
      product_mode: "Covered Picks of the Day",
      count: 0,
      rows: [],
    } satisfies CoveredPicksResponse),
    fallbackReason: canUseCoveredPicksSnapshot(query) ? null : "includeDetails/includeGrading requires the relational fallback.",
  });

  return jsonRouteResponse("/api/knowledge/covered-picks", resolution.payload, {
    cacheProfile: resolution.cacheProfile,
    cacheStatus: resolution.cacheStatus,
    snapshotSource: resolution.snapshotSource,
    rowsReturned: resolution.payload.rows.length,
  });
}
