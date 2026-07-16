import assert from "node:assert/strict";
import test from "node:test";

import { mock } from "node:test";
import {
  buildModelPerformanceSnapshotResponse,
  collectPublicSnapshotPublicationSummaries,
  PUBLIC_SNAPSHOT_FILTER_SCOPES,
  PUBLIC_SNAPSHOT_LIMITS,
  PUBLIC_SNAPSHOT_LATEST_RETENTION_DAYS,
  filterCoveredPicksSnapshotRows,
  filterModelPerformanceFacts,
  filterParlayOptionsSnapshotRows,
  publicSnapshotCacheProfile,
  publicSnapshotFallbackEnabled,
  publishPublicSnapshot,
  resolvePublicSnapshotRoute,
} from "@/lib/knowledge/public-snapshots";
import type { CoveredPickRow } from "@/lib/knowledge/read-types";
import type {
  PublicCoveredPickSnapshotRow,
  PublicModelPerformanceSnapshotRow,
  PublicParlayOptionSnapshotRow,
  PublicSnapshotEnvelope,
} from "@/lib/knowledge/public-snapshot-types";

test("public snapshot cache profile distinguishes latest, versioned, and fallback", () => {
  assert.equal(publicSnapshotCacheProfile({ snapshotVersion: null }), "public-snapshot-latest");
  assert.equal(publicSnapshotCacheProfile({ snapshotVersion: "covered-picks:v1" }), "public-snapshot-versioned");
  assert.equal(publicSnapshotCacheProfile({ snapshotVersion: null, fallback: true }), "public-snapshot-fallback");
});

test("public snapshot filter scopes are bounded and route-specific", () => {
  assert.deepEqual(PUBLIC_SNAPSHOT_FILTER_SCOPES["covered-picks"].supportedFilters, [
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
  ]);
  assert.deepEqual(PUBLIC_SNAPSHOT_FILTER_SCOPES["parlay-options"].supportedFilters, [
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
  ]);
  assert.deepEqual(PUBLIC_SNAPSHOT_FILTER_SCOPES["model-performance"].supportedFilters, ["league", "marketType", "dateFrom", "dateTo"]);
  assert.ok(PUBLIC_SNAPSHOT_LIMITS["covered-picks"] > 0);
  assert.ok(PUBLIC_SNAPSHOT_LIMITS["parlay-options"] > PUBLIC_SNAPSHOT_LIMITS["covered-picks"]);
  assert.ok(PUBLIC_SNAPSHOT_LATEST_RETENTION_DAYS >= 30);
});

test("snapshot hit reads only the published snapshot and skips fallback", async () => {
  let snapshotReads = 0;
  let fallbackReads = 0;
  const snapshot: PublicSnapshotEnvelope<PublicCoveredPickSnapshotRow> = {
    schemaVersion: 1,
    snapshotVersion: "covered-picks:test",
    publishedAt: "2026-07-13T00:00:00.000Z",
    dataThrough: "2026-07-13T00:00:00.000Z",
    sourceRefreshedAt: "2026-07-13T00:00:00.000Z",
    count: 1,
    rows: [{
      scored_prop_id: "score-1",
      current_prop_id: "current-1",
      odds_snapshot_id: null,
      market_instance_key: null,
      event_id: null,
      participant_id: null,
      participant_type: null,
      player_display_name: "Player One",
      participant_image_url: null,
      player_headshot_url: null,
      team_display_name: null,
      team_logo_url: null,
      opponent_display_name: null,
      opponent_logo_url: null,
      event_display_name: null,
      sport: "basketball",
      league: "WNBA",
      market_type: "player_points",
      market_display_label: "Player Points",
      sportsbook_id: null,
      sportsbook: null,
      sportsbooks: [],
      sportsbook_count: 0,
      grouped_variant_count: 1,
      side: "More",
      line: 12.5,
      over_price: null,
      under_price: null,
      start_time: "2026-07-13T18:00:00.000Z",
      covered_score: 72,
      edge_score: 4,
      confidence_score: 81,
      data_quality_score: 88,
      recommendation: "Elite",
      score_label: "Elite",
      confidence_label: "High Confidence",
      risk_label: "Low Risk",
      explanation_summary: null,
      risk_flags: [],
      last_updated: "2026-07-13T00:00:00.000Z",
    }],
    effectiveFilterScope: { route: "covered-picks", boundedVariant: "latest", supportedFilters: [], fallbackOnlyFilters: [] },
    pipelineRunId: "run-1",
    status: "published",
  };

  const result = await resolvePublicSnapshotRoute<{ snapshotVersion: string; snapshot_source: string }>({
    route: "covered-picks",
    snapshotVersion: null,
    canUseSnapshot: true,
    readSnapshot: async () => {
      snapshotReads += 1;
      return snapshot;
    },
    buildSnapshotResponse: (value) => ({ snapshotVersion: value.snapshotVersion, snapshot_source: "published" }),
    buildFallbackResponse: async () => {
      fallbackReads += 1;
      return { snapshotVersion: "fallback", snapshot_source: "relational-fallback" };
    },
    buildUnavailableResponse: () => ({ snapshotVersion: "unavailable", snapshot_source: "unavailable" }),
  });

  assert.equal(snapshotReads, 1);
  assert.equal(fallbackReads, 0);
  assert.equal(result.cacheProfile, "public-snapshot-latest");
  assert.equal(result.cacheStatus, "snapshot-hit");
  assert.equal(result.snapshotSource, "published");
  assert.equal(result.payload.snapshot_source, "published");
});

test("an explicitly versioned snapshot uses the immutable cache profile", async () => {
  const snapshot: PublicSnapshotEnvelope<unknown> = {
    schemaVersion: 1,
    snapshotVersion: "covered-picks:v1",
    publishedAt: "2026-07-13T00:00:00.000Z",
    dataThrough: null,
    sourceRefreshedAt: null,
    count: 0,
    rows: [],
    effectiveFilterScope: { route: "covered-picks", boundedVariant: "latest", supportedFilters: [], fallbackOnlyFilters: [] },
    pipelineRunId: "run-v1",
    status: "published",
  };
  const result = await resolvePublicSnapshotRoute<{ snapshot_source: string }>({
    route: "covered-picks",
    snapshotVersion: "covered-picks:v1",
    canUseSnapshot: true,
    readSnapshot: async () => snapshot,
    buildSnapshotResponse: () => ({ snapshot_source: "published" }),
    buildFallbackResponse: async () => ({ snapshot_source: "relational-fallback" }),
    buildUnavailableResponse: () => ({ snapshot_source: "unavailable" }),
  });
  assert.equal(result.cacheProfile, "public-snapshot-versioned");
});

test("snapshot miss falls back exactly once and marks the response as fallback", async () => {
  let snapshotReads = 0;
  let fallbackReads = 0;

  const result = await resolvePublicSnapshotRoute<{ snapshotVersion: string; snapshot_source: string }>({
    route: "parlay-options",
    snapshotVersion: "parlay-options:test",
    canUseSnapshot: true,
    readSnapshot: async () => {
      snapshotReads += 1;
      return null;
    },
    buildSnapshotResponse: () => ({ snapshotVersion: "snapshot-hit", snapshot_source: "published" }),
    buildFallbackResponse: async () => {
      fallbackReads += 1;
    return { snapshotVersion: "fallback", snapshot_source: "relational-fallback" };
    },
    buildUnavailableResponse: () => ({ snapshotVersion: "unavailable", snapshot_source: "unavailable" }),
  });

  assert.equal(snapshotReads, 1);
  assert.equal(fallbackReads, 1);
  assert.equal(result.cacheProfile, "public-snapshot-fallback");
  assert.equal(result.cacheStatus, "snapshot-fallback");
  assert.equal(result.snapshotSource, "relational-fallback");
  assert.equal(result.payload.snapshot_source, "relational-fallback");
});

test("route build failure: reported clearly, no write attempted for that route, other routes stay isolated and can complete", async () => {
  const errorSpy = mock.method(console, "error", () => {});
  const publishCalls: string[] = [];
  try {
    const result = await collectPublicSnapshotPublicationSummaries({
      publish: true,
      dependencies: {
        coveredPicks: async () => {
          throw new Error("covered-picks build blew up");
        },
        parlayOptions: async () => ({ rows: [{ start_time: "2026-07-16T23:00:00.000Z" }] } as any),
        modelPerformance: async () => ({ rows: [{ graded_at: "2026-07-16T00:00:00.000Z" }], count: 1 } as any),
        publishPublicSnapshot: async (input) => {
          publishCalls.push(input.route);
          return {
            route: input.route,
            snapshotVersion: `${input.route}:test`,
            snapshotKey: `public-snapshot:${input.route}:v${input.route}:test`,
            rowCount: input.rows.length,
            serializedBytes: 12,
            maxBytes: input.maxBytes ?? 256 * 1024,
            status: input.rows.length ? ("published" as const) : ("fallback" as const),
            publishedAt: "2026-07-16T00:00:00.000Z",
            publicationAttempted: true,
            publicationCompleted: true,
            errorStage: null,
            priorLatestSnapshotRetained: false,
          };
        },
      },
    });

    assert.equal(result["covered-picks"].status, "degraded");
    assert.equal(result["covered-picks"].publicationAttempted, false, "a build failure must never reach the write step");
    assert.equal(result["covered-picks"].publicationCompleted, false);
    assert.equal(result["covered-picks"].errorStage, "build");
    assert.equal(result["covered-picks"].priorLatestSnapshotRetained, true);
    assert.match(result["covered-picks"].fallbackReason ?? "", /covered-picks/i);
    assert.deepEqual(publishCalls.sort(), ["model-performance", "parlay-options"], "the failing route's publish function must never be invoked");

    assert.equal(result["parlay-options"].status, "published");
    assert.equal(result["parlay-options"].publicationCompleted, true);
    assert.equal(result["model-performance"].status, "published");
    assert.equal(result["model-performance"].publicationCompleted, true);

    assert.equal(result.overallStatus, "partial");

    assert.equal(errorSpy.mock.callCount(), 1, "exactly one server-side log for the one route failure");
    const loggedLine = String(errorSpy.mock.calls[0]?.arguments[0] ?? "");
    assert.match(loggedLine, /route=covered-picks/);
    assert.match(loggedLine, /stage=build/);
  } finally {
    mock.restoreAll();
  }
});

test("route write failure: reported as a write-stage failure, prior latest alias is not falsely reported as newly published, other routes stay isolated", async () => {
  const errorSpy = mock.method(console, "error", () => {});
  try {
    const result = await collectPublicSnapshotPublicationSummaries({
      publish: true,
      dependencies: {
        coveredPicks: async () => ({ rows: [{ league: "wnba", start_time: "2026-07-16T23:00:00.000Z", last_updated: "2026-07-16T00:00:00.000Z" }] } as any),
        parlayOptions: async () => ({ rows: [{ start_time: "2026-07-16T23:00:00.000Z" }] } as any),
        modelPerformance: async () => ({ rows: [{ graded_at: "2026-07-16T00:00:00.000Z" }], count: 1 } as any),
        publishPublicSnapshot: async (input) => {
          if (input.route === "parlay-options") {
            throw new Error("provider_cache write failed for parlay-options");
          }
          return {
            route: input.route,
            snapshotVersion: `${input.route}:test`,
            snapshotKey: `public-snapshot:${input.route}:v${input.route}:test`,
            rowCount: input.rows.length,
            serializedBytes: 12,
            maxBytes: input.maxBytes ?? 256 * 1024,
            status: "published" as const,
            publishedAt: "2026-07-16T00:00:00.000Z",
            publicationAttempted: true,
            publicationCompleted: true,
            errorStage: null,
            priorLatestSnapshotRetained: false,
          };
        },
      },
    });

    assert.equal(result["parlay-options"].status, "degraded");
    assert.equal(result["parlay-options"].errorStage, "write");
    assert.equal(result["parlay-options"].publicationAttempted, true, "the write was genuinely attempted (build succeeded)");
    assert.equal(result["parlay-options"].publicationCompleted, false);
    assert.equal(result["parlay-options"].priorLatestSnapshotRetained, true, "the prior :latest snapshot must not be reported as replaced");
    assert.match(result["parlay-options"].fallbackReason ?? "", /parlay-options/i);

    assert.equal(result["covered-picks"].status, "published");
    assert.equal(result["covered-picks"].publicationCompleted, true);
    assert.equal(result["model-performance"].status, "published");
    assert.equal(result["model-performance"].publicationCompleted, true);

    assert.equal(result.overallStatus, "partial");

    assert.equal(errorSpy.mock.callCount(), 1);
    const loggedLine = String(errorSpy.mock.calls[0]?.arguments[0] ?? "");
    assert.match(loggedLine, /route=parlay-options/);
    assert.match(loggedLine, /stage=write/);
  } finally {
    mock.restoreAll();
  }
});

test("all routes succeed: aggregate result indicates complete success", async () => {
  const result = await collectPublicSnapshotPublicationSummaries({
    publish: true,
    dependencies: {
      coveredPicks: async () => ({ rows: [{ league: "wnba", start_time: "2026-07-16T23:00:00.000Z", last_updated: "2026-07-16T00:00:00.000Z" }] } as any),
      parlayOptions: async () => ({ rows: [{ start_time: "2026-07-16T23:00:00.000Z" }] } as any),
      modelPerformance: async () => ({ rows: [{ graded_at: "2026-07-16T00:00:00.000Z" }], count: 1 } as any),
      publishPublicSnapshot: async (input) => ({
        route: input.route,
        snapshotVersion: `${input.route}:test`,
        snapshotKey: `public-snapshot:${input.route}:v${input.route}:test`,
        rowCount: input.rows.length,
        serializedBytes: 12,
        maxBytes: input.maxBytes ?? 256 * 1024,
        status: "published" as const,
        publishedAt: "2026-07-16T00:00:00.000Z",
        publicationAttempted: true,
        publicationCompleted: true,
        errorStage: null,
        priorLatestSnapshotRetained: false,
      }),
    },
  });

  assert.equal(result.overallStatus, "complete");
  for (const route of ["covered-picks", "parlay-options", "model-performance"] as const) {
    assert.equal(result[route].status, "published");
    assert.equal(result[route].publicationCompleted, true);
    assert.equal(result[route].errorStage, null);
    assert.equal(result[route].fallbackReason ?? null, null);
  }
});

test("publication disabled (no publish:true): no writes occur and the result cannot be confused with an actual publication", async () => {
  const fetchSpy = mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch must not be called when publication is disabled");
  });
  try {
    const result = await collectPublicSnapshotPublicationSummaries({
      dependencies: {
        coveredPicks: async () => ({ rows: [{ league: "wnba", start_time: "2026-07-16T23:00:00.000Z", last_updated: "2026-07-16T00:00:00.000Z" }] } as any),
        parlayOptions: async () => ({ rows: [{ start_time: "2026-07-16T23:00:00.000Z" }] } as any),
        modelPerformance: async () => ({ rows: [{ graded_at: "2026-07-16T00:00:00.000Z" }], count: 1 } as any),
      },
    });

    assert.equal(result.overallStatus, "disabled");
    for (const route of ["covered-picks", "parlay-options", "model-performance"] as const) {
      assert.equal(result[route].dryRun, true);
      assert.equal(result[route].publicationAttempted, false);
      assert.equal(result[route].publicationCompleted, false);
    }
    assert.equal(fetchSpy.mock.callCount(), 0, "no route may write provider_cache while publication is disabled");
  } finally {
    mock.restoreAll();
  }
});

test("error sanitization: secrets and sensitive raw error properties are not surfaced in the summary or the server log", async () => {
  const errorSpy = mock.method(console, "error", () => {});
  try {
    const result = await collectPublicSnapshotPublicationSummaries({
      publish: true,
      dependencies: {
        coveredPicks: async () => {
          throw new Error(
            // Short on purpose (fewer than 10 chars after the prefix): long enough to exercise
            // sanitizeSnapshotError's redaction regex, short enough to stay below the public-export
            // secret scanner's {10,}-char threshold so this fixture itself never trips that scan.
            "connect ECONNREFUSED https://abcd1234.supabase.co/rest/v1/scored_props -- key sb_secret_abc123 rejected",
          );
        },
        parlayOptions: async () => ({ rows: [] } as any),
        modelPerformance: async () => ({ rows: [], count: 0 } as any),
        publishPublicSnapshot: async (input) => ({
          route: input.route,
          snapshotVersion: `${input.route}:test`,
          snapshotKey: `public-snapshot:${input.route}:v${input.route}:test`,
          rowCount: input.rows.length,
          serializedBytes: 12,
          maxBytes: input.maxBytes ?? 256 * 1024,
          status: "fallback" as const,
          publishedAt: "2026-07-16T00:00:00.000Z",
          publicationAttempted: true,
          publicationCompleted: true,
          errorStage: null,
          priorLatestSnapshotRetained: false,
        }),
      },
    });

    const reason = result["covered-picks"].fallbackReason ?? "";
    assert.doesNotMatch(reason, /supabase\.co/i);
    assert.doesNotMatch(reason, /sb_secret_/);
    assert.match(reason, /\[redacted-url\]/);
    assert.match(reason, /\[redacted-key\]/);

    assert.equal(errorSpy.mock.callCount(), 1);
    const loggedLine = String(errorSpy.mock.calls[0]?.arguments[0] ?? "");
    assert.doesNotMatch(loggedLine, /supabase\.co/i);
    assert.doesNotMatch(loggedLine, /sb_secret_/);
  } finally {
    mock.restoreAll();
  }
});

test("a native fetch TypeError with an UND_ERR_HEADERS_OVERFLOW cause (the exact 2026-07-16 parlay-options failure shape) is reported as a clean build-stage failure, not a generic unclassifiable error", async () => {
  const errorSpy = mock.method(console, "error", () => {});
  try {
    const result = await collectPublicSnapshotPublicationSummaries({
      publish: true,
      dependencies: {
        coveredPicks: async () => ({ rows: [{ league: "wnba", start_time: "2026-07-16T23:00:00.000Z", last_updated: "2026-07-16T00:00:00.000Z" }] } as any),
        parlayOptions: async () => {
          // Mirrors the real error shape observed live: selectRows()/fetch() throws a native
          // TypeError("fetch failed") whose real diagnostic detail lives one layer deeper, in
          // `.cause`, exactly as Node's undici surfaces an oversized-request header failure.
          const cause = new Error("Headers Overflow Error");
          (cause as unknown as { code: string }).code = "UND_ERR_HEADERS_OVERFLOW";
          throw new TypeError("fetch failed", { cause });
        },
        modelPerformance: async () => ({ rows: [{ graded_at: "2026-07-16T00:00:00.000Z" }], count: 1 } as any),
        publishPublicSnapshot: async (input) => ({
          route: input.route,
          snapshotVersion: `${input.route}:test`,
          snapshotKey: `public-snapshot:${input.route}:v${input.route}:test`,
          rowCount: input.rows.length,
          serializedBytes: 12,
          maxBytes: input.maxBytes ?? 256 * 1024,
          status: "published" as const,
          publishedAt: "2026-07-16T00:00:00.000Z",
          publicationAttempted: true,
          publicationCompleted: true,
          errorStage: null,
          priorLatestSnapshotRetained: false,
        }),
      },
    });

    assert.equal(result["parlay-options"].status, "degraded");
    assert.equal(result["parlay-options"].errorStage, "build");
    assert.equal(result["parlay-options"].publicationAttempted, false);
    assert.equal(result["parlay-options"].publicationCompleted, false);
    assert.equal(result["parlay-options"].priorLatestSnapshotRetained, true, "the stale prior :latest alias must not be falsely reported as replaced");
    assert.match(result["parlay-options"].fallbackReason ?? "", /parlay-options/i);
    assert.match(result["parlay-options"].fallbackReason ?? "", /fetch failed/);

    assert.equal(result["covered-picks"].status, "published");
    assert.equal(result["model-performance"].status, "published");
    assert.equal(result.overallStatus, "partial");

    assert.equal(errorSpy.mock.callCount(), 1);
    const loggedLine = String(errorSpy.mock.calls[0]?.arguments[0] ?? "");
    assert.match(loggedLine, /route=parlay-options/);
    assert.match(loggedLine, /stage=build/);
    assert.match(loggedLine, /fetch failed/);
  } finally {
    mock.restoreAll();
  }
});

test("public snapshot collection isolates route failures and preserves successful routes", async () => {
  const publishSummary = async (route: "covered-picks" | "parlay-options" | "model-performance", rows: unknown[], maxBytes: number) => ({
    route,
    snapshotVersion: `${route}:test`,
    snapshotKey: `public-snapshot:${route}:v${route}:test`,
    rowCount: rows.length,
    serializedBytes: 1234,
    maxBytes,
    status: "published" as const,
    publishedAt: "2026-07-14T00:00:00.000Z",
  });

  const result = await collectPublicSnapshotPublicationSummaries({
    dependencies: {
      coveredPicks: async () => {
        throw new Error("covered-picks fetch failed");
      },
      parlayOptions: async () => ({
        rows: [{
          start_time: "2026-07-14T18:00:00.000Z",
        }],
      } as any),
      modelPerformance: async () => ({
        rows: [{
          graded_at: "2026-07-14T18:00:00.000Z",
        }],
        count: 1,
      } as any),
      publishPublicSnapshot: async (input) => publishSummary(
        input.route as "covered-picks" | "parlay-options" | "model-performance",
        input.rows,
        input.maxBytes ?? 256 * 1024,
      ) as any,
    },
  });

  assert.equal(result["covered-picks"].status, "degraded");
  assert.match(result["covered-picks"].fallbackReason ?? "", /covered-picks/i);
  assert.match(result["covered-picks"].fallbackReason ?? "", /collection/i);
  assert.equal(result["parlay-options"].status, "published");
  assert.equal(result["model-performance"].status, "published");
});

test("publishPublicSnapshot requires explicit publish:true to write -- omitting it never writes provider_cache", async () => {
  // No NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SECRET_KEY is set for this test on purpose: if the
  // no-write default ever regresses into actually calling putProviderCache, this would fail
  // loudly with "Supabase server cache is not configured" instead of silently passing.
  const fetchSpy = mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch must not be called unless publish: true is explicitly passed");
  });
  try {
    const summary = await publishPublicSnapshot({
      route: "covered-picks",
      rows: [{ id: "prop-1" }],
      status: "published",
      // publish intentionally omitted
    });
    assert.equal(summary.dryRun, true, "omitting publish must mark the result as a preview");
    assert.equal(summary.rowCount, 1);
    assert.equal(summary.status, "published");
    assert.equal(fetchSpy.mock.callCount(), 0);
  } finally {
    mock.restoreAll();
  }
});

test("publishPublicSnapshot treats publish:false the same as omitting it -- still no write", async () => {
  const fetchSpy = mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch must not be called when publish is false");
  });
  try {
    const summary = await publishPublicSnapshot({
      route: "covered-picks",
      rows: [{ id: "prop-1" }],
      status: "published",
      publish: false,
    });
    assert.equal(summary.dryRun, true);
    assert.equal(fetchSpy.mock.callCount(), 0);
  } finally {
    mock.restoreAll();
  }
});

test("collectPublicSnapshotPublicationSummaries defaults to preview-only across every route -- a league-scoped caller cannot silently overwrite the combined snapshot", async () => {
  const fetchSpy = mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch must not be called unless publish: true is explicitly passed");
  });
  try {
    // Simulates exactly the scenario that caused the earlier incident: a caller building a
    // single-league (WNBA-only) view of covered-picks, with no publish flag at all.
    const result = await collectPublicSnapshotPublicationSummaries({
      dependencies: {
        coveredPicks: async () => ({ rows: [{ league: "wnba", start_time: "2026-07-16T23:00:00.000Z", last_updated: "2026-07-16T00:00:00.000Z" }] } as any),
        parlayOptions: async () => ({ rows: [{ start_time: "2026-07-16T23:00:00.000Z" }] } as any),
        modelPerformance: async () => ({ rows: [{ graded_at: "2026-07-16T00:00:00.000Z" }], count: 1 } as any),
      },
    });
    assert.equal(result["covered-picks"].dryRun, true);
    assert.equal(result["covered-picks"].rowCount, 1);
    assert.equal(result["parlay-options"].dryRun, true);
    assert.equal(result["model-performance"].dryRun, true);
    assert.equal(fetchSpy.mock.callCount(), 0, "no route may write provider_cache without an explicit publish:true");
  } finally {
    mock.restoreAll();
  }
});

test("collectPublicSnapshotPublicationSummaries with publish:true writes for every route via the injected publisher", async () => {
  let publishCalls = 0;
  const result = await collectPublicSnapshotPublicationSummaries({
    publish: true,
    dependencies: {
      coveredPicks: async () => ({ rows: [] } as any),
      parlayOptions: async () => ({ rows: [] } as any),
      modelPerformance: async () => ({ rows: [], count: 0 } as any),
      publishPublicSnapshot: async (input) => {
        publishCalls += 1;
        assert.equal(input.publish, true, "publish:true must be forwarded to the real publish function");
        return {
          route: input.route,
          snapshotVersion: `${input.route}:test`,
          snapshotKey: `public-snapshot:${input.route}:v${input.route}:test`,
          rowCount: input.rows.length,
          serializedBytes: 12,
          maxBytes: input.maxBytes ?? 256 * 1024,
          status: "fallback" as const,
          publishedAt: "2026-07-16T00:00:00.000Z",
        };
      },
    },
  });
  assert.equal(publishCalls, 3, "all three routes must receive the explicit publish opt-in");
  assert.equal(result["covered-picks"].dryRun, undefined);
});

test("collectPublicSnapshotPublicationSummaries without publish preserves the injected dependency contract (dryRun/publish default to undefined)", async () => {
  let publishCalls = 0;
  const result = await collectPublicSnapshotPublicationSummaries({
    dependencies: {
      coveredPicks: async () => ({ rows: [] } as any),
      parlayOptions: async () => ({ rows: [] } as any),
      modelPerformance: async () => ({ rows: [], count: 0 } as any),
      publishPublicSnapshot: async (input) => {
        publishCalls += 1;
        assert.equal(input.publish, undefined, "publish must default to undefined when the caller doesn't opt in");
        return {
          route: input.route,
          snapshotVersion: `${input.route}:test`,
          snapshotKey: `public-snapshot:${input.route}:v${input.route}:test`,
          rowCount: input.rows.length,
          serializedBytes: 12,
          maxBytes: input.maxBytes ?? 256 * 1024,
          status: "fallback" as const,
          publishedAt: "2026-07-16T00:00:00.000Z",
        };
      },
    },
  });
  assert.equal(publishCalls, 3);
  assert.equal(result["covered-picks"].dryRun, undefined);
});

test("the latest snapshot remains readable even when its publication is older than six hours", async () => {
  const oldSnapshot: PublicSnapshotEnvelope<unknown> = {
    schemaVersion: 1,
    snapshotVersion: "covered-picks:old",
    publishedAt: "2026-07-12T00:00:00.000Z",
    dataThrough: "2026-07-12T00:00:00.000Z",
    sourceRefreshedAt: "2026-07-12T00:00:00.000Z",
    count: 0,
    rows: [],
    effectiveFilterScope: { route: "covered-picks", boundedVariant: "latest", supportedFilters: [], fallbackOnlyFilters: [] },
    pipelineRunId: "run-old",
    status: "published",
  };
  const result = await resolvePublicSnapshotRoute<{ source: string; snapshot_source: string }>({
    route: "covered-picks",
    snapshotVersion: null,
    canUseSnapshot: true,
    readSnapshot: async () => oldSnapshot,
    buildSnapshotResponse: () => ({ source: "old", snapshot_source: "published" }),
    buildFallbackResponse: async () => {
      throw new Error("fallback should not run for a readable old snapshot");
    },
    buildUnavailableResponse: () => ({ source: "unavailable", snapshot_source: "unavailable" }),
  });
  assert.equal(result.snapshotSource, "published");
  assert.equal(result.payload.source, "old");
  assert.equal(result.payload.snapshot_source, "published");
});

test("disabled fallback returns unavailable without relational reads", async () => {
  const previous = process.env.KNOWLEDGE_PUBLIC_SNAPSHOT_FALLBACK_ENABLED;
  process.env.KNOWLEDGE_PUBLIC_SNAPSHOT_FALLBACK_ENABLED = "false";
  let fallbackReads = 0;
  try {
    const result = await resolvePublicSnapshotRoute<{ source: string; snapshot_source: string }>({
      route: "parlay-options",
      snapshotVersion: null,
      canUseSnapshot: true,
      readSnapshot: async () => null,
      buildSnapshotResponse: () => ({ source: "published", snapshot_source: "published" }),
      buildFallbackResponse: async () => {
        fallbackReads += 1;
        return { source: "fallback", snapshot_source: "relational-fallback" };
      },
      buildUnavailableResponse: () => ({ source: "unavailable", snapshot_source: "unavailable" }),
    });
    assert.equal(fallbackReads, 0);
    assert.equal(result.snapshotSource, "unavailable");
    assert.equal(result.payload.source, "unavailable");
    assert.equal(result.payload.snapshot_source, "unavailable");
  } finally {
    if (previous === undefined) delete process.env.KNOWLEDGE_PUBLIC_SNAPSHOT_FALLBACK_ENABLED;
    else process.env.KNOWLEDGE_PUBLIC_SNAPSHOT_FALLBACK_ENABLED = previous;
  }
});

test("fallback remains bounded to one relational invocation when explicitly enabled", async () => {
  const previous = process.env.KNOWLEDGE_PUBLIC_SNAPSHOT_FALLBACK_ENABLED;
  process.env.KNOWLEDGE_PUBLIC_SNAPSHOT_FALLBACK_ENABLED = "true";
  let fallbackReads = 0;
  try {
    const result = await resolvePublicSnapshotRoute<{ source: string; snapshot_source: string }>({
      route: "model-performance",
      snapshotVersion: null,
      canUseSnapshot: true,
      readSnapshot: async () => null,
      buildSnapshotResponse: () => ({ source: "published", snapshot_source: "published" }),
      buildFallbackResponse: async () => {
        fallbackReads += 1;
        return { source: "fallback", snapshot_source: "relational-fallback" };
      },
      buildUnavailableResponse: () => ({ source: "unavailable", snapshot_source: "unavailable" }),
    });
    assert.equal(fallbackReads, 1);
    assert.equal(result.snapshotSource, "relational-fallback");
    assert.equal(result.payload.snapshot_source, "relational-fallback");
  } finally {
    if (previous === undefined) delete process.env.KNOWLEDGE_PUBLIC_SNAPSHOT_FALLBACK_ENABLED;
    else process.env.KNOWLEDGE_PUBLIC_SNAPSHOT_FALLBACK_ENABLED = previous;
  }
});

test("fallback switch defaults to enabled for the current rollout", () => {
  const previous = process.env.KNOWLEDGE_PUBLIC_SNAPSHOT_FALLBACK_ENABLED;
  delete process.env.KNOWLEDGE_PUBLIC_SNAPSHOT_FALLBACK_ENABLED;
  try {
    assert.equal(publicSnapshotFallbackEnabled(), true);
  } finally {
    if (previous !== undefined) process.env.KNOWLEDGE_PUBLIC_SNAPSHOT_FALLBACK_ENABLED = previous;
  }
});

test("model performance snapshots preserve rows and summary counts after local filtering", () => {
  const facts: PublicModelPerformanceSnapshotRow[] = [{
    graded_at: "2026-07-13T00:00:00.000Z",
    sport_id: "basketball",
    league_id: "wnba",
    market_type: "player_points",
    result: "win",
    grade_status: "graded",
    model_version_id: "model-1",
    current_prop_id: "current-1",
    scored_prop_id: "score-1",
    covered_score: 72,
    confidence_score: 81,
    recommendation: "Elite",
    score_label: "Elite",
    confidence_label: "High Confidence",
    risk_label: "Low Risk",
    sportsbook_code: "dk",
    sportsbook_display_name: "DraftKings",
  }];
  const response = buildModelPerformanceSnapshotResponse(filterModelPerformanceFacts(facts, {
    dateFrom: "2026-01-01",
    dateTo: "2026-07-13",
    sport: "basketball",
    league: "wnba",
    marketType: "player_points",
    sportsbook: "dk",
    scoreLabel: "Elite",
    confidenceLabel: "High Confidence",
    riskLabel: "Low Risk",
    recommendation: "Elite",
    minimumCoveredScore: 70,
    modelVersion: "model-1",
    result: "win",
  }));

  assert.equal(response.count, 1);
  assert.equal(response.rows.length, 1);
  assert.equal(response.summary.wins, 1);
  assert.equal(response.summary.hit_rate_excluding_pushes_no_grades, 1);
});

test("covered picks, parlay options, and model performance filters can be applied locally", () => {
  const coveredRows: CoveredPickRow[] = [{
    scored_prop_id: "score-1",
    current_prop_id: "current-1",
    odds_snapshot_id: null,
    market_instance_key: null,
    event_id: null,
    participant_id: null,
    participant_type: null,
    player_display_name: "Player One",
    participant_image_url: null,
    player_headshot_url: null,
    team_display_name: "Team A",
    team_logo_url: null,
    opponent_display_name: "Team B",
    opponent_logo_url: null,
    event_display_name: "Team A vs Team B",
    sport: "basketball",
    league: "WNBA",
    market_type: "player_points",
    market_display_label: "Player Points",
    sportsbook_id: null,
    sportsbook: null,
    sportsbooks: [],
    sportsbook_count: 0,
    grouped_variant_count: 1,
    side: "More",
    line: 12.5,
    over_price: null,
    under_price: null,
    start_time: "2026-07-13T18:00:00.000Z",
    covered_score: 72,
    edge_score: 4,
    confidence_score: 81,
    data_quality_score: 88,
    recommendation: "Elite",
    score_label: "Elite",
    confidence_label: "High Confidence",
    risk_label: "Low Risk",
    explanation_summary: null,
    factor_breakdown: [],
    risk_flags: [],
    grading_result: null,
    last_updated: "2026-07-13T00:00:00.000Z",
  }];
  const parlayRows: PublicParlayOptionSnapshotRow[] = [{
    current_prop_id: "current-1",
    latest_scored_prop_id: "score-1",
    latest_snapshot_id: null,
    market_instance_key: null,
    event_id: "event-1",
    participant_id: null,
    participant_type: null,
    display_label: "Player One More 12.5",
    sport: "basketball",
    league: "WNBA",
    event_display_name: "Team A vs Team B",
    participant_display_name: "Player One",
    participant_image_url: null,
    player_headshot_url: null,
    team_display_name: "Team A",
    team_logo_url: null,
    opponent_display_name: "Team B",
    opponent_logo_url: null,
    market_type: "player_points",
    sportsbook: null,
    sportsbooks: [],
    sportsbook_count: 0,
    grouped_variant_count: 1,
    side: "More",
    line: 12.5,
    over_price: null,
    under_price: null,
    start_time: "2026-07-13T18:00:00.000Z",
    match_status: "matched",
    match_confidence: 0.91,
    match_quality_flags: [],
    publishability_status: "candidate",
    publishability_reasons: [],
    covered_score: 72,
    score_label: "Elite",
    confidence_label: "High Confidence",
    risk_label: "Low Risk",
  }];
  const modelRows: PublicModelPerformanceSnapshotRow[] = [{
    graded_at: "2026-07-13T00:00:00.000Z",
    sport_id: "basketball",
    league_id: "wnba",
    market_type: "player_points",
    result: "win",
    grade_status: "graded",
    model_version_id: "model-1",
    current_prop_id: "current-1",
    scored_prop_id: "score-1",
    covered_score: 72,
    confidence_score: 81,
    recommendation: "Elite",
    score_label: "Elite",
    confidence_label: "High Confidence",
    risk_label: "Low Risk",
    sportsbook_code: "dk",
    sportsbook_display_name: "DraftKings",
  }];

  assert.equal(filterCoveredPicksSnapshotRows(coveredRows, {
    date: "2026-07-13",
    sport: "basketball",
    league: "WNBA",
    marketType: "player_points",
    sportsbook: null,
    minimumCoveredScore: 70,
    minimumConfidenceScore: 80,
    scoreLabel: "Elite",
    confidenceLabel: "High Confidence",
    riskLabel: "Low Risk",
    excludeHighRisk: false,
    excludeUnsupportedMarkets: false,
    startTimeFrom: null,
    startTimeTo: null,
    limit: 6,
    includeVariantBooks: false,
  }).length, 1);

  assert.equal(filterParlayOptionsSnapshotRows(parlayRows, {
    date: "2026-07-13",
    sport: "basketball",
    league: "WNBA",
    eventId: "event-1",
    marketType: "player_points",
    sportsbook: null,
    participantSearch: "Player",
    onlyScored: true,
    onlyMatched: true,
    excludeStaleOdds: false,
    excludeLowConfidenceMatches: false,
    limit: 10,
    includeVariantBooks: false,
  }).length, 1);

  const modelResponse = buildModelPerformanceSnapshotResponse(filterModelPerformanceFacts(modelRows, {
    dateFrom: "2026-01-01",
    dateTo: "2026-07-13",
    sport: "basketball",
    league: "wnba",
    marketType: "player_points",
    sportsbook: "dk",
    scoreLabel: "Elite",
    confidenceLabel: "High Confidence",
    riskLabel: "Low Risk",
    recommendation: "Elite",
    minimumCoveredScore: 70,
    modelVersion: "model-1",
    result: "win",
  }));
  assert.equal(modelResponse.count, 1);
  assert.equal(modelResponse.rows.length, 1);
});
