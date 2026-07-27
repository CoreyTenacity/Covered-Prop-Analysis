import { jsonRouteResponse } from "@/lib/api/route-response";
import { getParlayOptions } from "@/lib/knowledge/read-service";
import {
  parsePublicSnapshotVersion,
  readPublicSnapshot,
  parlayOptionsSnapshotHasLeagueRows,
  resolvePublicSnapshotRoute,
} from "@/lib/knowledge/public-snapshots";
import type { ParlayOptionRow, ParlayOptionsResponse } from "@/lib/knowledge/read-types";
import type { PublicParlayOptionSnapshotRow } from "@/lib/knowledge/public-snapshot-types";

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

export async function GET(request: Request) {
  const url = new URL(request.url);
  const snapshotVersion = parsePublicSnapshotVersion(url.searchParams.get("snapshotVersion"));
  const query = {
    date: url.searchParams.get("date"),
    sport: url.searchParams.get("sport"),
    league: url.searchParams.get("league"),
    eventId: url.searchParams.get("eventId"),
    marketType: url.searchParams.get("marketType"),
    sportsbook: url.searchParams.get("sportsbook"),
    participantSearch: url.searchParams.get("participantSearch"),
    onlyScored: parseBoolean(url.searchParams.get("onlyScored")),
    onlyMatched: parseBoolean(url.searchParams.get("onlyMatched")),
    excludeStaleOdds: parseBoolean(url.searchParams.get("excludeStaleOdds")),
    excludeLowConfidenceMatches: parseBoolean(url.searchParams.get("excludeLowConfidenceMatches")),
    limit: parseNumber(url.searchParams.get("limit")),
    includeVariantBooks: parseBoolean(url.searchParams.get("includeVariantBooks")) ?? false,
  };
  const requiredSnapshotLeagues = query.league ? [query.league] : ["mlb", "wnba"];

  const resolution = await resolvePublicSnapshotRoute<ParlayOptionsResponse>({
    route: "parlay-options",
    snapshotVersion,
    canUseSnapshot: true,
    readSnapshot: async () => {
      const snapshot = await readPublicSnapshot<PublicParlayOptionSnapshotRow>("parlay-options", snapshotVersion);
      if (snapshot && !parlayOptionsSnapshotHasLeagueRows(snapshot.rows, requiredSnapshotLeagues)) return null;
      return snapshot;
    },
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
      count: snapshot.rows.length,
      rows: snapshot.rows as ParlayOptionRow[],
    } satisfies ParlayOptionsResponse),
    buildFallbackResponse: async () => {
      const payload = await getParlayOptions({
        date: query.date,
        sport: query.sport,
        league: query.league,
        eventId: query.eventId,
        marketType: query.marketType,
        sportsbook: query.sportsbook,
        participantSearch: query.participantSearch,
        onlyScored: query.onlyScored,
        onlyMatched: query.onlyMatched,
        excludeStaleOdds: query.excludeStaleOdds,
        excludeLowConfidenceMatches: query.excludeLowConfidenceMatches,
        limit: query.limit ?? 250,
        includeVariantBooks: query.includeVariantBooks,
      }) as ParlayOptionsResponse;
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
        count: payload.rows.length,
        rows: payload.rows,
      } satisfies ParlayOptionsResponse;
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
      count: 0,
      rows: [],
    } satisfies ParlayOptionsResponse),
  });

  return jsonRouteResponse("/api/knowledge/parlay-options", resolution.payload, {
    cacheProfile: resolution.cacheProfile,
    cacheStatus: resolution.cacheStatus,
    snapshotSource: resolution.snapshotSource,
    rowsReturned: resolution.payload.rows.length,
  });
}
