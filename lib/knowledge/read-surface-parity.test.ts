import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { getCoveredPicksOfTheDay, getParlayOptions } from "./read-service.ts";
import {
  collectPublicSnapshotPublicationSummaries,
  readPublicSnapshot,
  resolvePublicSnapshotRoute,
  publicSnapshotLatestKey,
  publicSnapshotCacheKey,
} from "./public-snapshots.ts";
import { createSupabaseFixture, type FixtureRow } from "./supabase-fixture-harness.ts";
import { STRICT_ELIGIBILITY_CONTRACT_VERSION } from "./public-snapshot-types.ts";

/**
 * Phase 18 continuation (owner-directed): direct public-read-surface parity --
 * Manual Analyzer, Covered Picks (relational), the versioned/`:latest` snapshot,
 * and the resolvePublicSnapshotRoute dispatcher that both API routes share --
 * proven against the SAME source rows rather than trusting "uses the same
 * helper" claims. Also covers the snapshot/fallback failure-behavior gaps
 * identified this pass (malformed snapshot, explicit-version-miss, and the
 * structural proof that a snapshot hit never ALSO invokes the relational
 * fallback, so a prop present in both sources can never be double-counted).
 */

function withE2eEnv(run: () => Promise<void>) {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJtest";
  return run().finally(() => {
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
    mock.restoreAll();
  });
}

function buildProp(index: number, startTimeIso: string): FixtureRow {
  return {
    id: `prop-${index}`,
    latest_snapshot_id: `snapshot-${index}`,
    sport_id: "basketball",
    league_id: "wnba",
    sportsbook_id: "sportsbook-1",
    market_id: "market-1",
    market_instance_key: null,
    participant_id: `participant-${index}`,
    participant_type: "player",
    player_id: `player-${index}`,
    team_id: "team-1",
    opponent_id: `participant-${index}`,
    opponent_team_id: "team-2",
    event_id: "event-1",
    market_type: "player_points",
    player_name: `Player ${index}`,
    team_name: "Washington Mystics",
    opponent_name: "Atlanta Dream",
    line: 15.5,
    direction: "More",
    side: "over",
    over_price: -110,
    under_price: -110,
    match_confidence: 0.9,
    match_status: "matched",
    match_quality_flags: [],
    start_time: startTimeIso,
    updated_at: startTimeIso,
    active: true,
  };
}

function sharedFixtureTables() {
  return {
    events: [{ id: "event-1", display_name: "Washington Mystics at Atlanta Dream", scheduled_date: null, start_time: null, status: "scheduled", home_team_id: "team-2", away_team_id: "team-1" }],
    teams: [
      { id: "team-1", name: "Washington Mystics", abbreviation: "WAS", logo_url: null, external_ids: {} },
      { id: "team-2", name: "Atlanta Dream", abbreviation: "ATL", logo_url: null, external_ids: {} },
    ],
    markets: [{ id: "market-1", market_type: "player_points", display_name: "Points" }],
    sportsbooks: [{ id: "sportsbook-1", code: "draftkings", display_name: "DraftKings" }],
  };
}

// Session 99: every scored_props fixture row representing a CURRENTLY-VALID
// (not stale-contract) score must carry a score_input_id pointing at a real
// score_inputs row stamped with STRICT_ELIGIBILITY_CONTRACT_VERSION -- see
// filterRowsWithCurrentScoreContract's own doc comment in read-service.ts.
// scoredRow/identityFixtureSeed default to the CURRENT contract so every
// existing test in this file (which is testing OTHER behavior, not the
// contract check itself) keeps exercising the real, now-gated path rather
// than being silently filtered out.
function scoredRow(id: string, propId: string, score: number, observedAt: string, scoreInputId: string | null = `${id}-input`) {
  return {
    id,
    current_prop_id: propId,
    score_input_id: scoreInputId,
    sport_id: "basketball",
    league_id: "wnba",
    covered_score: score,
    confidence_score: 70,
    data_quality_score: 80,
    recommendation: score >= 70 ? "Strong" : "Lean",
    risk_flags: [],
    prop_state: "publishable",
    publishable: true,
    publishability_reasons: [],
    updated_at: observedAt,
  };
}

function currentContractScoreInput(id: string) {
  return { id, feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } };
}

function identityFixtureSeed(propId: string, score: number) {
  const futureStart = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const observed = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  return {
    current_props: [{ ...buildProp(1, futureStart), id: propId, updated_at: observed }],
    participants: [{ id: "participant-1", display_name: "Player 1", participant_type: "player", player_id: "player-1", team_id: "team-1", image_url: null, external_ids: {} }],
    players: [{ id: "player-1", display_name: "Player 1", canonical_name: "Player 1", headshot_url: null, external_ids: {} }],
    scored_props: [scoredRow("scored-1", propId, score, observed)],
    score_inputs: [currentContractScoreInput("scored-1-input")],
    ...sharedFixtureTables(),
  };
}

// Required invariant: "A valid score of exactly 70 is eligible." (69 excluded is
// already proven in read-service.test.ts -- this pins the other side of the
// boundary, on both public read surfaces.)
test("read-surface parity: a publishable score-EXACTLY-70 row is eligible on both Covered Picks and the Manual Analyzer", async () => {
  await withE2eEnv(async () => {
    createSupabaseFixture(identityFixtureSeed("prop-70", 70));
    const pickIds = (await getCoveredPicksOfTheDay({ limit: 25, includeVariantBooks: true })).rows.map((r) => r.current_prop_id);
    assert.ok(pickIds.includes("prop-70"), "score exactly 70 must clear the Covered Picks floor (>= 70, not > 70)");

    createSupabaseFixture(identityFixtureSeed("prop-70", 70));
    const parlayIds = (await getParlayOptions({ limit: 25, includeVariantBooks: true })).rows.map((r) => r.current_prop_id);
    assert.ok(parlayIds.includes("prop-70"), "score exactly 70 must also appear in the Manual Analyzer");
  });
});

// 2026-08-07 (Analyzer/Covered Picks evidence parity, Part 20): a qualified
// >=70 prop must expose the IDENTICAL evidence object -- projection, edge,
// last-5/last-10 average and exact-line hit counts, minutes, matchup/injury
// notes, freshness -- and the identical commentary (positive factors, risks)
// on both surfaces. Not "the same shape", the same VALUES, proven via
// deepEqual against the shared buildScoreEvidence source.
test("read-surface parity: a qualified >=70 row exposes IDENTICAL evidence and commentary on both Covered Picks and the Manual Analyzer", async () => {
  await withE2eEnv(async () => {
    const futureStart = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const observed = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const seed = {
      current_props: [{ ...buildProp(1, futureStart), id: "prop-parity-evidence", market_type: "player_assists", line: 8.5, direction: "More", side: "More", updated_at: observed }],
      participants: [{ id: "participant-1", display_name: "Player 1", participant_type: "player", player_id: "player-1", team_id: "team-1", image_url: null, external_ids: {} }],
      players: [{ id: "player-1", display_name: "Player 1", canonical_name: "Player 1", headshot_url: null, external_ids: {} }],
      scored_props: [scoredRow("scored-parity", "prop-parity-evidence", 82, observed)],
      score_inputs: [{
        id: "scored-parity-input",
        feature_payload: {
          scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION,
          projection: 10.1,
          edge_value: 1.6,
          last_5_avg: 9.8,
          last_10_avg: 9.2,
          minutes_last_5_avg: 34.2,
          minutes_trend: 0.3,
          usage_trend: 0.1,
          data_freshness: { oddsPulledAt: observed },
        },
      }],
      score_explanations: [{ scored_prop_id: "scored-parity", summary: "Player 1 projects above the line.", reasoning_block: "Favorable matchup and stable minutes.", factors: [{ name: "Matchup", label: "Favorable", impact: "positive", description: "Opponent allows above-average assist production in this matchup profile." }] }],
      player_game_logs: Array.from({ length: 10 }, (_, i) => ({
        player_id: "player-1", game_date: `2026-07-${String(31 - i).padStart(2, "0")}`, points: 10, rebounds: 4, assists: 9 + (i % 2), hits: null, total_bases: null, runs: null, rbis: null, strikeouts: null,
      })),
      ...sharedFixtureTables(),
    };

    createSupabaseFixture(seed);
    const pick = (await getCoveredPicksOfTheDay({ limit: 25, includeVariantBooks: true })).rows.find((r) => r.current_prop_id === "prop-parity-evidence");
    assert.ok(pick, "the fixture row must be Covered-Picks eligible (score 82 >= 70)");

    createSupabaseFixture(seed);
    const leg = (await getParlayOptions({ limit: 25, includeVariantBooks: true })).rows.find((r) => r.current_prop_id === "prop-parity-evidence");
    assert.ok(leg, "the same fixture row must also appear in the Manual Analyzer");

    assert.deepEqual(pick!.evidence, leg!.evidence, "Covered Picks and the Manual Analyzer must expose the identical evidence object for the same prop");
    assert.deepEqual(pick!.commentary, leg!.commentary, "Covered Picks and the Manual Analyzer must expose the identical commentary for the same prop");
    assert.equal(pick!.evidence?.recentMinutesAvg, 34.2, "the raw last-5 minutes average must be exposed, not only a trend label");
    assert.equal(pick!.evidence?.last5HitCount, 5, "exact-line last-5 hit count must be computed against THIS prop's own line (8.5, More)");
  });
});

// Direct parity: build once via the relational reader, publish a snapshot from
// those exact rows, and prove the snapshot-served response carries the same
// identity/score/eligibility -- not merely "uses the same row shape".
test("read-surface parity: a published Covered Picks snapshot exposes the same prop identity, score, and eligibility as the relational reader it was built from", async () => {
  await withE2eEnv(async () => {
    createSupabaseFixture(identityFixtureSeed("prop-parity", 82));
    const relational = await getCoveredPicksOfTheDay({ limit: 25, includeVariantBooks: true });
    assert.equal(relational.rows.length, 1);
    const relationalRow = relational.rows[0];

    const summaries = await collectPublicSnapshotPublicationSummaries({ publish: true });
    assert.equal(summaries["covered-picks"].rowCount, 1);

    const snapshot = await readPublicSnapshot("covered-picks", null);
    assert.ok(snapshot);
    const snapshotRows = snapshot!.rows as typeof relational.rows;
    assert.equal(snapshotRows.length, 1);
    const snapshotRow = snapshotRows[0];

    assert.equal(snapshotRow.scored_prop_id, relationalRow.scored_prop_id);
    assert.equal(snapshotRow.event_id, relationalRow.event_id);
    assert.equal(snapshotRow.participant_id, relationalRow.participant_id);
    assert.equal(snapshotRow.team_display_name, relationalRow.team_display_name);
    assert.equal(snapshotRow.opponent_display_name, relationalRow.opponent_display_name);
    assert.equal(snapshotRow.market_type, relationalRow.market_type);
    assert.equal(snapshotRow.line, relationalRow.line);
    assert.equal(snapshotRow.covered_score, relationalRow.covered_score);
    assert.equal(snapshotRow.score_label, relationalRow.score_label);
    assert.equal(snapshotRow.risk_label, relationalRow.risk_label);
  });
});

// A blocked (sub-70) prop must never appear via the snapshot path either --
// "Snapshot publication cannot bypass blockers."
test("read-surface parity: a sub-70 row is absent from the published Covered Picks snapshot, matching the relational reader", async () => {
  await withE2eEnv(async () => {
    createSupabaseFixture(identityFixtureSeed("prop-sub70", 65));
    const relational = await getCoveredPicksOfTheDay({ limit: 25, includeVariantBooks: true });
    assert.equal(relational.rows.length, 0);

    await collectPublicSnapshotPublicationSummaries({ publish: true });
    const snapshot = await readPublicSnapshot("covered-picks", null);
    // A genuinely empty published `:latest` snapshot is a real, valid state (not
    // a defect) -- resolvePublicSnapshotRoute treats it as a miss so the
    // relational fallback gets a chance, proven separately below.
    assert.ok(!snapshot || snapshot.rows.length === 0);
  });
});

// Structural proof that a snapshot hit and the relational fallback are mutually
// exclusive for a single request -- resolvePublicSnapshotRoute never calls
// buildFallbackResponse once readSnapshot has returned a usable (non-empty, or
// explicitly versioned) snapshot. This is the direct answer to "duplicate prop
// appearing in snapshot and relational data": the route architecture makes
// double-counting structurally impossible, because only one path ever executes.
test("read-surface parity: resolvePublicSnapshotRoute never invokes the relational fallback when the snapshot read is a hit (no double-counting possible)", async () => {
  await withE2eEnv(async () => {
    const fallbackCalls: number[] = [];
    const resolution = await resolvePublicSnapshotRoute({
      route: "covered-picks",
      snapshotVersion: null,
      canUseSnapshot: true,
      readSnapshot: async () => ({
        schemaVersion: 1,
        snapshotVersion: "covered-picks:test-1",
        publishedAt: new Date().toISOString(),
        dataThrough: null,
        sourceRefreshedAt: null,
        count: 1,
        rows: [{ current_prop_id: "prop-dup" }],
        effectiveFilterScope: { route: "covered-picks", boundedVariant: "latest", supportedFilters: [] } as never,
        pipelineRunId: "run-1",
        status: "published",
        eligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION,
      }),
      buildSnapshotResponse: (snapshot) => ({ rows: snapshot.rows }),
      buildFallbackResponse: async () => {
        fallbackCalls.push(1);
        return { rows: [{ current_prop_id: "prop-dup" }] };
      },
      buildUnavailableResponse: () => ({ rows: [] }),
    });
    assert.equal(fallbackCalls.length, 0, "the relational fallback builder must never run alongside a snapshot hit");
    assert.equal((resolution.payload as { rows: unknown[] }).rows.length, 1);
  });
});

// Snapshot/fallback failure behavior: an explicit snapshotVersion that has no
// corresponding versioned provider_cache row is a genuine miss -- proving there
// is no accidental fallthrough to the mutable `:latest` alias for a pinned,
// explicitly-requested historical version.
test("snapshot failure: an explicit snapshotVersion with no matching versioned key is a miss, not a silent fallthrough to :latest", async () => {
  await withE2eEnv(async () => {
    createSupabaseFixture({
      provider_cache: [
        { cache_key: publicSnapshotLatestKey("covered-picks"), provider: "the-odds-api", payload: { schemaVersion: 1, snapshotVersion: "covered-picks:real", publishedAt: new Date().toISOString(), dataThrough: null, sourceRefreshedAt: null, count: 1, rows: [{ current_prop_id: "prop-latest-only" }], effectiveFilterScope: null, pipelineRunId: "run-1", status: "published" }, fetched_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), source_updated_at: null, is_stale: false },
      ],
    });
    const missing = await readPublicSnapshot("covered-picks", "does-not-exist");
    assert.equal(missing, null, "requesting a specific version that was never published must not silently resolve to :latest's data");
  });
});

// Snapshot failure: a malformed snapshot payload (rows not an array) must not
// crash the route -- readPublicSnapshot/resolvePublicSnapshotRoute must treat
// it as unusable and fall back, the same as a genuine miss.
test("snapshot failure: a malformed snapshot payload (rows is not an array) is treated as unusable, not trusted as-is", async () => {
  await withE2eEnv(async () => {
    createSupabaseFixture({
      provider_cache: [
        { cache_key: publicSnapshotLatestKey("covered-picks"), provider: "the-odds-api", payload: { schemaVersion: 1, snapshotVersion: "covered-picks:corrupt", publishedAt: new Date().toISOString(), dataThrough: null, sourceRefreshedAt: null, count: 0, rows: null, effectiveFilterScope: null, pipelineRunId: "run-1", status: "published" }, fetched_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), source_updated_at: null, is_stale: false },
      ],
      ...identityFixtureSeed("prop-fallback-after-corrupt", 82),
    });
    const resolution = await resolvePublicSnapshotRoute<{ source: "snapshot" | "fallback" | "unavailable"; rows: unknown[] }>({
      route: "covered-picks",
      snapshotVersion: null,
      canUseSnapshot: true,
      readSnapshot: () => readPublicSnapshot<unknown>("covered-picks", null),
      buildSnapshotResponse: (snapshot) => ({ source: "snapshot", rows: snapshot.rows }),
      buildFallbackResponse: async () => {
        const relational = await getCoveredPicksOfTheDay({ limit: 25, includeVariantBooks: true });
        return { source: "fallback", rows: relational.rows };
      },
      buildUnavailableResponse: () => ({ source: "unavailable", rows: [] }),
    });
    assert.equal(resolution.snapshotSource, "relational-fallback", "a malformed snapshot payload must not be served as a snapshot hit");
  });
});

// Phase 18 continuation (owner-directed): complete snapshot/fallback matrix.
// Items already covered above or in lib/ops/public-snapshots.test.ts are not
// duplicated -- cited in the final report instead.

test("snapshot matrix: an explicit versioned snapshot hit is served directly, not recomputed", async () => {
  await withE2eEnv(async () => {
    createSupabaseFixture({
      provider_cache: [{
        cache_key: publicSnapshotCacheKey("covered-picks", "test-version-1"),
        provider: "the-odds-api",
        payload: { schemaVersion: 1, snapshotVersion: "test-version-1", publishedAt: new Date().toISOString(), dataThrough: null, sourceRefreshedAt: null, count: 1, rows: [{ current_prop_id: "prop-versioned" }], effectiveFilterScope: null, pipelineRunId: "run-1", status: "published" },
        fetched_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        source_updated_at: null,
        is_stale: false,
      }],
    });
    const snapshot = await readPublicSnapshot<{ current_prop_id: string }>("covered-picks", "test-version-1");
    assert.ok(snapshot);
    assert.equal(snapshot!.rows[0].current_prop_id, "prop-versioned");
  });
});

test("snapshot matrix: latest alias missing (no provider_cache row at all) is a genuine miss", async () => {
  await withE2eEnv(async () => {
    createSupabaseFixture({ provider_cache: [] });
    const snapshot = await readPublicSnapshot("covered-picks", null);
    assert.equal(snapshot, null);
  });
});

test("snapshot matrix: rows present but an object instead of an array is treated as unusable, same as rows:null", async () => {
  await withE2eEnv(async () => {
    createSupabaseFixture({
      provider_cache: [{
        cache_key: publicSnapshotLatestKey("covered-picks"),
        provider: "the-odds-api",
        payload: { schemaVersion: 1, snapshotVersion: "covered-picks:corrupt-2", publishedAt: new Date().toISOString(), dataThrough: null, sourceRefreshedAt: null, count: 0, rows: { current_prop_id: "not-an-array" }, effectiveFilterScope: null, pipelineRunId: "run-1", status: "published" },
        fetched_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        source_updated_at: null,
        is_stale: false,
      }],
      ...identityFixtureSeed("prop-fallback-after-object-rows", 82),
    });
    const resolution = await resolvePublicSnapshotRoute<{ source: "snapshot" | "fallback" | "unavailable"; rows: unknown[] }>({
      route: "covered-picks",
      snapshotVersion: null,
      canUseSnapshot: true,
      readSnapshot: () => readPublicSnapshot<unknown>("covered-picks", null),
      buildSnapshotResponse: (snapshot) => ({ source: "snapshot", rows: snapshot.rows }),
      buildFallbackResponse: async () => {
        const relational = await getCoveredPicksOfTheDay({ limit: 25, includeVariantBooks: true });
        return { source: "fallback", rows: relational.rows };
      },
      buildUnavailableResponse: () => ({ source: "unavailable", rows: [] }),
    });
    assert.equal(resolution.snapshotSource, "relational-fallback");
  });
});

// Missing envelope metadata (schemaVersion/publishedAt/etc. absent) does not
// crash the route either -- only `rows` is validated before trusting a
// snapshot; the route consumers (buildSnapshotResponse) read whichever
// metadata fields they need and tolerate undefined the same way any optional
// field would be. Proven directly: a payload with a valid rows array but no
// other fields still serves as a snapshot hit.
test("snapshot matrix: a snapshot payload missing envelope metadata (only rows present) still serves as a hit", async () => {
  await withE2eEnv(async () => {
    createSupabaseFixture({
      provider_cache: [{
        cache_key: publicSnapshotLatestKey("covered-picks"),
        provider: "the-odds-api",
        payload: { rows: [{ current_prop_id: "prop-minimal" }] },
        fetched_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        source_updated_at: null,
        is_stale: false,
      }],
    });
    const snapshot = await readPublicSnapshot<{ current_prop_id: string }>("covered-picks", null);
    assert.ok(snapshot);
    assert.equal(snapshot!.rows.length, 1);
    assert.equal(snapshot!.rows[0].current_prop_id, "prop-minimal");
  });
});

test("snapshot matrix: an empty relational fallback (genuinely zero eligible rows) returns zero rows, not an error", async () => {
  await withE2eEnv(async () => {
    createSupabaseFixture({ current_props: [], scored_props: [], events: [], teams: [], markets: [], sportsbooks: [] });
    const resolution = await resolvePublicSnapshotRoute<{ rows: unknown[] }>({
      route: "covered-picks",
      snapshotVersion: null,
      canUseSnapshot: false,
      readSnapshot: async () => null,
      buildSnapshotResponse: (snapshot) => ({ rows: snapshot.rows }),
      buildFallbackResponse: async () => {
        const relational = await getCoveredPicksOfTheDay({ limit: 25, includeVariantBooks: true });
        return { rows: relational.rows };
      },
      buildUnavailableResponse: () => ({ rows: [] }),
    });
    assert.equal(resolution.snapshotSource, "relational-fallback");
    assert.deepEqual(resolution.payload.rows, []);
  });
});

// Defect fixed this pass: buildFallbackResponse previously had no
// try/catch anywhere up to the route handler -- a real Supabase read failure
// (network blip, timeout) would crash the whole route instead of degrading
// to "unavailable" the same way a disabled fallback already does.
test("snapshot matrix (regression): a fallback query that throws degrades to unavailable instead of crashing the route", async () => {
  await withE2eEnv(async () => {
    const resolution = await resolvePublicSnapshotRoute<{ rows: unknown[]; status: string }>({
      route: "covered-picks",
      snapshotVersion: null,
      canUseSnapshot: false,
      readSnapshot: async () => null,
      buildSnapshotResponse: (snapshot) => ({ rows: snapshot.rows, status: "published" }),
      buildFallbackResponse: async () => {
        throw new Error("simulated Supabase read failure");
      },
      buildUnavailableResponse: () => ({ rows: [], status: "degraded" }),
    });
    assert.equal(resolution.snapshotSource, "unavailable");
    assert.equal(resolution.payload.status, "degraded");
    assert.deepEqual(resolution.payload.rows, []);
  });
});

// Duplicate canonical prop identities inside a snapshot: characterization,
// not a route-layer concern -- the route serves whatever the snapshot
// contains verbatim (deduping, if ever needed, belongs at snapshot-BUILD
// time via the same publish path already proven to source rows from
// getCoveredPicksOfTheDay/getParlayOptions, which read `current_prop_id` as
// their identity column and cannot themselves emit true duplicates for a
// single request). Proven directly: the route does not silently collapse or
// reject duplicate rows if a snapshot payload were to contain them.
test("snapshot matrix: duplicate canonical prop identities inside a snapshot payload are served as-is (a build-time concern, not a route-time one)", async () => {
  await withE2eEnv(async () => {
    createSupabaseFixture({
      provider_cache: [{
        cache_key: publicSnapshotLatestKey("covered-picks"),
        provider: "the-odds-api",
        payload: { schemaVersion: 1, snapshotVersion: "covered-picks:dup", publishedAt: new Date().toISOString(), dataThrough: null, sourceRefreshedAt: null, count: 2, rows: [{ current_prop_id: "prop-dup" }, { current_prop_id: "prop-dup" }], effectiveFilterScope: null, pipelineRunId: "run-1", status: "published" },
        fetched_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        source_updated_at: null,
        is_stale: false,
      }],
    });
    const snapshot = await readPublicSnapshot<{ current_prop_id: string }>("covered-picks", null);
    assert.equal(snapshot!.rows.length, 2, "the route does not deduplicate at read time -- this is a build-time data-integrity concern, not a route defect");
  });
});

// Session 98 (owner-directed): snapshot eligibility-contract transition tests.
// Controlling rule: no prop that fails the current strict completeness
// contract may display a Covered Score merely because it exists in an older
// snapshot. resolvePublicSnapshotRoute now rejects a stamped-mismatched or
// unversioned snapshot the SAME way it already rejected a structurally
// malformed one (falls through to the bounded relational fallback, or to
// "unavailable" when the fallback itself is disabled/unusable) -- never
// serving the old rows as-is.
//
// Items from this session's required 20-point matrix already proven
// elsewhere and NOT duplicated here:
//   5  (relational fallback enabled)            -> lib/ops/public-snapshots.test.ts
//      ("fallback remains bounded to one relational invocation when explicitly enabled")
//   11 (relational fallback disabled)            -> lib/ops/public-snapshots.test.ts
//      ("disabled fallback returns unavailable without relational reads")
//   12 (relational fallback error)               -> this file, "a fallback query that
//      throws degrades to unavailable instead of crashing the route" (above)
//   8  (candidate run fails before publishing)    -> lib/ops/public-snapshots.test.ts
//      ("route build failure: reported clearly, no write attempted...")
//   9  (empty strict board publishes)             -> lib/ops/public-snapshots.test.ts
//      ("a published `:latest` snapshot with zero rows is treated as a miss...")
//   17 (no snapshot and no fallback)              -> lib/ops/public-snapshots.test.ts
//      ("a zero-row `:latest` snapshot with fallback disabled returns unavailable...")

const DYLAN_CEASE_SHAPED_ROW = {
  current_prop_id: "current-prop-legacy-incomplete",
  player_name: "Dylan Cease",
  market_type: "pitcher_strikeouts",
  line: 7.5,
  covered_score: 70,
  publishable: true,
  publishability_reasons: [] as string[],
};

function legacySnapshotEnvelope(overrides: { eligibilityContractVersion?: unknown; omitField?: boolean } = {}) {
  const base: Record<string, unknown> = {
    schemaVersion: 1,
    snapshotVersion: "covered-picks:legacy-run",
    publishedAt: new Date().toISOString(),
    dataThrough: null,
    sourceRefreshedAt: null,
    count: 1,
    rows: [DYLAN_CEASE_SHAPED_ROW],
    effectiveFilterScope: null,
    pipelineRunId: "legacy-run-1",
    status: "published",
  };
  if (!overrides.omitField) base.eligibilityContractVersion = overrides.eligibilityContractVersion;
  return base;
}

async function resolveWithFixedSnapshot(route: "covered-picks" | "parlay-options", snapshot: Record<string, unknown> | null) {
  let fallbackCalls = 0;
  const resolution = await resolvePublicSnapshotRoute<{ source: string; rows: unknown[] }>({
    route,
    snapshotVersion: null,
    canUseSnapshot: true,
    readSnapshot: async () => snapshot as never,
    buildSnapshotResponse: (value) => ({ source: "snapshot", rows: value.rows }),
    buildFallbackResponse: async () => {
      fallbackCalls += 1;
      return { source: "fallback", rows: [] };
    },
    buildUnavailableResponse: () => ({ source: "unavailable", rows: [] }),
  });
  return { resolution, fallbackCalls };
}

test("snapshot contract: an old UNVERSIONED snapshot (no eligibilityContractVersion field at all) containing a Dylan-Cease-shaped incomplete-under-strict-rules row is rejected, not served", async () => {
  await withE2eEnv(async () => {
    const snapshot = legacySnapshotEnvelope({ omitField: true });
    const { resolution, fallbackCalls } = await resolveWithFixedSnapshot("covered-picks", snapshot);
    assert.equal(resolution.snapshotSource, "relational-fallback", "an unversioned snapshot must never be served as a hit");
    assert.equal(fallbackCalls, 1);
    assert.deepEqual(resolution.payload.rows, [], "no row from the rejected old snapshot may leak into the fallback payload");
  });
});

test("snapshot contract: an old EXPLICITLY-VERSIONED but WEAKER-contract snapshot is rejected, not served", async () => {
  await withE2eEnv(async () => {
    const snapshot = legacySnapshotEnvelope({ eligibilityContractVersion: "legacy-v0-live-pin" });
    const { resolution, fallbackCalls } = await resolveWithFixedSnapshot("covered-picks", snapshot);
    assert.equal(resolution.snapshotSource, "relational-fallback");
    assert.equal(fallbackCalls, 1);
  });
});

test("snapshot contract: an UNKNOWN FUTURE contract version is rejected -- fail-closed applies to 'newer' values too, not just older ones", async () => {
  await withE2eEnv(async () => {
    const snapshot = legacySnapshotEnvelope({ eligibilityContractVersion: "strict-v2-not-yet-released" });
    const { resolution, fallbackCalls } = await resolveWithFixedSnapshot("covered-picks", snapshot);
    assert.equal(resolution.snapshotSource, "relational-fallback", "an unrecognized contract value must never be trusted merely because it looks newer");
    assert.equal(fallbackCalls, 1);
  });
});

test("snapshot contract: a malformed (wrong-type) contract value is rejected safely, never crashes the route", async () => {
  await withE2eEnv(async () => {
    for (const malformed of [123, { nested: "object" }, [], true]) {
      const snapshot = legacySnapshotEnvelope({ eligibilityContractVersion: malformed });
      const { resolution } = await resolveWithFixedSnapshot("covered-picks", snapshot);
      assert.equal(resolution.snapshotSource, "relational-fallback", `malformed value ${JSON.stringify(malformed)} must fail closed, not throw or pass`);
    }
  });
});

test("snapshot contract: a snapshot stamped with the CURRENT strict contract is accepted and served directly, no fallback invoked", async () => {
  await withE2eEnv(async () => {
    const snapshot = legacySnapshotEnvelope({ eligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION });
    const { resolution, fallbackCalls } = await resolveWithFixedSnapshot("covered-picks", snapshot);
    assert.equal(resolution.snapshotSource, "published", "a snapshot stamped with the exact current contract must be trusted");
    assert.equal(fallbackCalls, 0);
    assert.deepEqual(resolution.payload.rows, [DYLAN_CEASE_SHAPED_ROW], "sanity check: this test's OWN fixture row is what gets served when the contract genuinely matches -- proving the rejection tests above are rejecting the CONTRACT field, not something else about the row shape");
  });
});

test("snapshot contract: rejection applies identically on the Manual Analyzer (parlay-options) route, not only Covered Picks", async () => {
  await withE2eEnv(async () => {
    const snapshot = legacySnapshotEnvelope({ omitField: true });
    const { resolution } = await resolveWithFixedSnapshot("parlay-options", snapshot);
    assert.equal(resolution.snapshotSource, "relational-fallback", "Manual Analyzer must reject an old-contract snapshot exactly like Covered Picks does");
  });
});

test("snapshot contract: one route's contract-mismatched snapshot does not affect a DIFFERENT route's valid, correctly-stamped snapshot in the same publish cycle", async () => {
  await withE2eEnv(async () => {
    const staleWnbaLikeSnapshot = legacySnapshotEnvelope({ omitField: true });
    const validMlbLikeSnapshot = legacySnapshotEnvelope({ eligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION });

    const wnbaResult = await resolveWithFixedSnapshot("covered-picks", staleWnbaLikeSnapshot);
    const mlbResult = await resolveWithFixedSnapshot("parlay-options", validMlbLikeSnapshot);

    assert.equal(wnbaResult.resolution.snapshotSource, "relational-fallback", "the stale-contract route must still reject its own snapshot");
    assert.equal(mlbResult.resolution.snapshotSource, "published", "a different route's own correctly-stamped snapshot is unaffected by another route's rejection");
  });
});

test("snapshot contract: rejection plus a DISABLED fallback returns a safe empty result, never the old row", async () => {
  const originalFallback = process.env.KNOWLEDGE_PUBLIC_SNAPSHOT_FALLBACK_ENABLED;
  process.env.KNOWLEDGE_PUBLIC_SNAPSHOT_FALLBACK_ENABLED = "false";
  try {
    await withE2eEnv(async () => {
      const snapshot = legacySnapshotEnvelope({ omitField: true });
      let fallbackCalls = 0;
      const resolution = await resolvePublicSnapshotRoute<{ rows: unknown[] }>({
        route: "covered-picks",
        snapshotVersion: null,
        canUseSnapshot: true,
        readSnapshot: async () => snapshot as never,
        buildSnapshotResponse: (value) => ({ rows: value.rows }),
        buildFallbackResponse: async () => {
          fallbackCalls += 1;
          return { rows: [] };
        },
        buildUnavailableResponse: () => ({ rows: [] }),
      });
      assert.equal(resolution.snapshotSource, "unavailable");
      assert.equal(fallbackCalls, 0, "a disabled fallback must never be invoked, contract-rejected or not");
      assert.deepEqual(resolution.payload.rows, [], "the old row must never reach the payload when the fallback is disabled");
    });
  } finally {
    if (originalFallback === undefined) delete process.env.KNOWLEDGE_PUBLIC_SNAPSHOT_FALLBACK_ENABLED;
    else process.env.KNOWLEDGE_PUBLIC_SNAPSHOT_FALLBACK_ENABLED = originalFallback;
  }
});

test("snapshot contract: publishPublicSnapshot (the real production writer) always stamps the exact current strict contract -- proven against the real function, not a re-implementation", async () => {
  await withE2eEnv(async () => {
    const { publishPublicSnapshot } = await import("./public-snapshots.ts");
    createSupabaseFixture({ provider_cache: [] });
    await publishPublicSnapshot({
      route: "covered-picks",
      rows: [{ current_prop_id: "prop-real-write" }],
      publish: true,
    });
    const written = await readPublicSnapshot<{ current_prop_id: string }>("covered-picks", null);
    assert.ok(written);
    assert.equal(written!.eligibilityContractVersion, STRICT_ELIGIBILITY_CONTRACT_VERSION);
  });
});
