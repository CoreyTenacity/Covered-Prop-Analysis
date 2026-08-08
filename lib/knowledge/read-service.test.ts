import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { getBoardOpportunities, getCoveredPicksOfTheDay, getModelPerformance, getParlayOptions } from "./read-service.ts";
import { createSupabaseFixture, type FixtureRow } from "./supabase-fixture-harness.ts";
import { preparedSlateEventWindow } from "./prepared-slate-window.ts";
import { STRICT_ELIGIBILITY_CONTRACT_VERSION } from "./eligibility-contract.ts";

/**
 * Regression coverage for the 2026-07-16 parlay-options publication failure: the unfiltered
 * getParlayOptions({ limit: 250, includeVariantBooks: true }) call (no league/sport filter)
 * scans up to 500 active current_props ordered by start_time.asc, then looks up scored_props
 * for every scanned id in one unbounded `current_prop_id=in.(...)` request. Two compounding
 * defects were found, both reproduced here and fixed in read-service.ts:
 *   1. Stale `active=true` rows with a start_time days in the past sort first under
 *      start_time.asc with no lower bound, so they can consume the entire scanLimit before any
 *      genuinely future row is ever scanned -- silently returning zero eligible rows.
 *   2. Once genuinely eligible rows ARE scanned, passing all of their ids into one unbounded
 *      `in.(...)` filter produces a request line long enough to overflow undici's header parser
 *      (observed live as `TypeError: fetch failed`, cause `UND_ERR_HEADERS_OVERFLOW`) -- a
 *      failure the previous sanitized logging couldn't distinguish from a generic network blip.
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

/**
 * Market freshness now reads odds_snapshots.pulled_at via
 * current_props.latest_snapshot_id (loadOddsSnapshotPulledAt in
 * read-service.ts), NOT current_props.updated_at -- see market-freshness.ts's
 * doc comment for the production defect (run 31129018935) this closes. Every
 * pre-existing test in this file built its current_props fixture rows
 * assuming updated_at alone controlled freshness. Rather than hand-edit every
 * one of those fixtures, this wrapper auto-derives a matching odds_snapshots
 * row (pulled_at = that prop's own updated_at) for every current_props row
 * that doesn't already have an explicit odds_snapshots entry for its
 * latest_snapshot_id -- reproducing the OLD (correct-for-those-tests)
 * behavior automatically. Tests that need to prove the fix itself (a
 * genuinely stale pulled_at coexisting with a fresh updated_at, e.g. an
 * identity-repair shape) pass their own explicit `odds_snapshots` array,
 * which this wrapper never overrides.
 */
function withFixture(seed: Record<string, FixtureRow[]>) {
  const currentProps = (seed.current_props ?? []) as Array<FixtureRow & { latest_snapshot_id?: unknown; updated_at?: unknown }>;
  const explicitSnapshotIds = new Set((seed.odds_snapshots ?? []).map((row) => String((row as FixtureRow & { id?: unknown }).id)));
  const derivedSnapshots: FixtureRow[] = [];
  const seenIds = new Set<string>();
  for (const prop of currentProps) {
    const snapshotId = typeof prop.latest_snapshot_id === "string" ? prop.latest_snapshot_id : null;
    if (!snapshotId || explicitSnapshotIds.has(snapshotId) || seenIds.has(snapshotId)) continue;
    seenIds.add(snapshotId);
    derivedSnapshots.push({ id: snapshotId, pulled_at: (prop.updated_at as string | null) ?? null });
  }
  return createSupabaseFixture({
    ...seed,
    odds_snapshots: [...(seed.odds_snapshots ?? []), ...derivedSnapshots],
  });
}

test("getParlayOptions batches scored_props lookups into bounded in.(...) requests instead of one unbounded request", async () => {
  await withE2eEnv(async () => {
    const futureIso = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const currentProps: FixtureRow[] = [];
    const participants: FixtureRow[] = [];
    const players: FixtureRow[] = [];
    const scoredProps: FixtureRow[] = [];
    const scoreInputs: FixtureRow[] = [];
    for (let i = 0; i < 250; i += 1) {
      currentProps.push(buildProp(i, futureIso));
      participants.push({ id: `participant-${i}`, display_name: `Player ${i}`, participant_type: "player", player_id: `player-${i}`, team_id: "team-1", image_url: null, external_ids: {} });
      players.push({ id: `player-${i}`, display_name: `Player ${i}`, canonical_name: `Player ${i}`, headshot_url: null, external_ids: {} });
      scoredProps.push({ id: `scored-${i}`, score_input_id: `scored-${i}__strict`, current_prop_id: `prop-${i}`, league_id: "wnba", covered_score: 50 + (i % 40), confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: futureIso });
      scoreInputs.push({ id: `scored-${i}__strict`, feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } });
    }

    const { calls } = withFixture({
      current_props: currentProps,
      participants,
      players,
      scored_props: scoredProps,
      score_inputs: scoreInputs,
      ...sharedFixtureTables(),
    });

    const result = await getParlayOptions({ limit: 250, includeVariantBooks: true });

    const scoredPropsCalls = calls.filter((c) => c.table === "scored_props");
    assert.ok(scoredPropsCalls.length > 1, `expected the 250-id lookup to be split into multiple bounded requests, got ${scoredPropsCalls.length}`);
    assert.equal(result.rows.length, 250, "no eligible prop should be dropped by batching");
    assert.ok(result.rows.every((row) => row.latest_scored_prop_id), "every row's scored_props batch lookup must have resolved");
  });
});

test("session 89: getParlayOptions batches score_explanations lookups into bounded in.(...) requests instead of one unbounded request -- the same UND_ERR_HEADERS_OVERFLOW shape as the scored_props fix above, reproduced live against real production data via explanationsByScoredProp/explanationSummariesByScoredProp, which were missed when the scored_props lookup was first batched", async () => {
  await withE2eEnv(async () => {
    const futureIso = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const currentProps: FixtureRow[] = [];
    const participants: FixtureRow[] = [];
    const players: FixtureRow[] = [];
    const scoredProps: FixtureRow[] = [];
    const scoreInputs: FixtureRow[] = [];
    const scoreExplanations: FixtureRow[] = [];
    for (let i = 0; i < 250; i += 1) {
      currentProps.push(buildProp(i, futureIso));
      participants.push({ id: `participant-${i}`, display_name: `Player ${i}`, participant_type: "player", player_id: `player-${i}`, team_id: "team-1", image_url: null, external_ids: {} });
      players.push({ id: `player-${i}`, display_name: `Player ${i}`, canonical_name: `Player ${i}`, headshot_url: null, external_ids: {} });
      scoredProps.push({ id: `scored-${i}`, score_input_id: `scored-${i}__strict`, current_prop_id: `prop-${i}`, league_id: "wnba", covered_score: 50 + (i % 40), confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: futureIso });
      scoreInputs.push({ id: `scored-${i}__strict`, feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } });
      scoreExplanations.push({ scored_prop_id: `scored-${i}`, summary: `Summary ${i}`, reasoning_block: `Reasoning ${i}`, factors: [], score_label: "Playable", confidence_label: "High Confidence", risk_label: "Low Risk", explanation: null, factor_notes: null, risk_notes: null, recent_values: null });
    }

    const { calls } = withFixture({
      current_props: currentProps,
      participants,
      players,
      scored_props: scoredProps,
      score_inputs: scoreInputs,
      score_explanations: scoreExplanations,
      ...sharedFixtureTables(),
    });

    const result = await getParlayOptions({ limit: 250, includeVariantBooks: true });

    const explanationCalls = calls.filter((c) => c.table === "score_explanations");
    assert.ok(explanationCalls.length > 1, `expected the 250-id score_explanations lookup to be split into multiple bounded requests, got ${explanationCalls.length}`);
    assert.equal(result.rows.length, 250, "no eligible prop should be dropped by batching");
    assert.ok(result.rows.every((row) => row.commentary?.summary === `Reasoning ${row.current_prop_id.replace("prop-", "")}`), "every row's score_explanations batch lookup must have resolved to its own commentary, not been dropped by the unbounded-request failure");
  });
});

test("getParlayOptions restricts the base current_props scan to future-or-null start times", async () => {
  await withE2eEnv(async () => {
    const pastIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const futureIso = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

    // Far more stale (`active:true`, days-past start_time) rows than genuinely eligible ones --
    // reproduces the shape that starved the real scan under start_time.asc with no lower bound.
    const staleProps = Array.from({ length: 40 }, (_, i) => buildProp(1000 + i, pastIso));
    const futureProps = [buildProp(1, futureIso), buildProp(2, futureIso)];

    const seed: Record<string, FixtureRow[]> = {
      current_props: [...staleProps, ...futureProps],
      participants: [
        { id: "participant-1", display_name: "Player 1", participant_type: "player", player_id: "player-1", team_id: "team-1", image_url: null, external_ids: {} },
        { id: "participant-2", display_name: "Player 2", participant_type: "player", player_id: "player-2", team_id: "team-1", image_url: null, external_ids: {} },
      ],
      players: [
        { id: "player-1", display_name: "Player 1", canonical_name: "Player 1", headshot_url: null, external_ids: {} },
        { id: "player-2", display_name: "Player 2", canonical_name: "Player 2", headshot_url: null, external_ids: {} },
      ],
      scored_props: [
        { id: "scored-1", score_input_id: "scored-1__strict", current_prop_id: "prop-1", league_id: "wnba", covered_score: 70, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: futureIso },
        { id: "scored-2", score_input_id: "scored-2__strict", current_prop_id: "prop-2", league_id: "wnba", covered_score: 65, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: futureIso },
      ],
    score_inputs: [
      { id: "scored-1__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
      { id: "scored-2__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
    ],
      ...sharedFixtureTables(),
    };

    // The generic fixture harness matches every filter it recognizes (eq./in./gte./lte./is.null)
    // but silently ignores an unrecognized `or=(...)` param, which would hide a regression where
    // the future-start-time filter is accidentally dropped. Wrap fetch to enforce it for real.
    withFixture(seed);
    const baseFetch = globalThis.fetch;
    mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/rest/v1/current_props")) {
        const orParam = url.searchParams.get("or");
        assert.ok(orParam, "current_props scan must send an explicit start_time lower-bound filter");
        assert.match(orParam!, /start_time\.is\.null/);
        assert.match(orParam!, /start_time\.gt\./);
      }
      return baseFetch(input, init);
    });

    const result = await getParlayOptions({ limit: 250, includeVariantBooks: true });
    assert.equal(result.rows.length, 2, "only the two future props should survive the scan, none of the 40 stale rows");
    assert.deepEqual(result.rows.map((r) => r.current_prop_id).sort(), ["prop-1", "prop-2"]);
  });
});

test("regression: getParlayOptions succeeds and returns eligible rows under the exact shape of the 2026-07-16 failure (mostly-stale scan + large eligible batch)", async () => {
  await withE2eEnv(async () => {
    const pastIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const futureIso = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

    const staleProps = Array.from({ length: 350 }, (_, i) => buildProp(2000 + i, pastIso));
    // All 300 future props share the same participant/player/team/event/market/sportsbook,
    // varying only by id and line -- displayGroupingKey includes `line` by default, so these
    // remain 300 distinct rows without growing any loadMap() table's id list past 1. This
    // isolates the test to the scored_props batching fix specifically (the defect that produced
    // the live UND_ERR_HEADERS_OVERFLOW), independent of the separate loadMap() tables.
    const futureProps = Array.from({ length: 300 }, (_, i) => ({
      ...buildProp(i, futureIso),
      participant_id: "participant-1",
      player_id: "player-1",
      opponent_id: "participant-1",
      line: 10 + i * 0.5,
    }));
    const scoredProps = futureProps.map((_, i) => ({ id: `scored-${i}`, score_input_id: `scored-${i}__strict`, current_prop_id: `prop-${i}`, league_id: "wnba", covered_score: 40 + (i % 50), confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: futureIso }));
    const scoreInputs = futureProps.map((_, i) => ({ id: `scored-${i}__strict`, feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } }));

    withFixture({
      current_props: [...staleProps, ...futureProps],
      participants: [{ id: "participant-1", display_name: "Player One", participant_type: "player", player_id: "player-1", team_id: "team-1", image_url: null, external_ids: {} }],
      players: [{ id: "player-1", display_name: "Player One", canonical_name: "Player One", headshot_url: null, external_ids: {} }],
      scored_props: scoredProps,
      score_inputs: scoreInputs,
      ...sharedFixtureTables(),
    });

    const baseFetch = globalThis.fetch;
    let maxRequestLength = 0;
    // Simulates undici's real UND_ERR_HEADERS_OVERFLOW behavior observed in production (a GET
    // request whose full URL exceeds the client's header-size budget fails exactly this way). At
    // 300 ids, one unbounded `current_prop_id=in.(...)` request would be ~11-12KB -- comfortably
    // over this threshold -- while the fixed code's 100-id batches stay well under it.
    const HEADERS_OVERFLOW_THRESHOLD = 8000;
    mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      maxRequestLength = Math.max(maxRequestLength, url.length);
      if (url.length > HEADERS_OVERFLOW_THRESHOLD) {
        const cause = new Error("Headers Overflow Error");
        (cause as unknown as { code: string }).code = "UND_ERR_HEADERS_OVERFLOW";
        throw new TypeError("fetch failed", { cause });
      }
      assert.ok(new URL(url).pathname.includes("/rest/v1/"), "no non-Supabase (provider) request may occur in this path");
      return baseFetch(input, init);
    });

    const result = await getParlayOptions({ limit: 250, includeVariantBooks: true });
    assert.equal(result.rows.length, 250, "the 300 eligible props must survive both defects and be capped only by the requested `limit`, not silently dropped");
    assert.ok(maxRequestLength < HEADERS_OVERFLOW_THRESHOLD, "the fix must keep every request comfortably under the observed overflow threshold");
  });
});

test("getParlayOptions derives team/opponent display from participant + event context when stored team ids are missing, and stays honest when no deterministic team exists", async () => {
  await withE2eEnv(async () => {
    const futureIso = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

    withFixture({
      current_props: [
        {
          id: "prop-derived",
          latest_snapshot_id: "snapshot-derived",
          sport_id: "basketball",
          league_id: "wnba",
          sportsbook_id: "sportsbook-1",
          market_id: "market-1",
          market_instance_key: null,
          participant_id: "participant-derived",
          participant_type: "player",
          player_id: "player-derived",
          team_id: null,
          opponent_id: null,
          opponent_team_id: null,
          event_id: "event-1",
          market_type: "player_points",
          player_name: "Player Derived",
          team_name: null,
          opponent_name: null,
          line: 15.5,
          direction: "More",
          side: "over",
          over_price: -110,
          under_price: -110,
          match_confidence: 0.9,
          match_status: "matched",
          match_quality_flags: [],
          start_time: futureIso,
          updated_at: futureIso,
          active: true,
        },
        {
          id: "prop-unresolved",
          latest_snapshot_id: "snapshot-unresolved",
          sport_id: "basketball",
          league_id: "wnba",
          sportsbook_id: "sportsbook-1",
          market_id: "market-1",
          market_instance_key: null,
          participant_id: null,
          participant_type: "player",
          player_id: null,
          team_id: null,
          opponent_id: null,
          opponent_team_id: null,
          event_id: "event-1",
          market_type: "player_points",
          player_name: "Player Unresolved",
          team_name: null,
          opponent_name: null,
          line: 12.5,
          direction: "More",
          side: "over",
          over_price: -110,
          under_price: -110,
          match_confidence: 0.9,
          match_status: "matched",
          match_quality_flags: [],
          start_time: futureIso,
          updated_at: futureIso,
          active: true,
        },
      ],
      participants: [
        { id: "participant-derived", display_name: "Player Derived", participant_type: "player", player_id: "player-derived", team_id: "team-1", image_url: null, external_ids: {} },
      ],
      players: [
        { id: "player-derived", display_name: "Player Derived", canonical_name: "Player Derived", headshot_url: null, external_ids: {} },
      ],
      ...sharedFixtureTables(),
      events: [{ id: "event-1", display_name: null, scheduled_date: null, start_time: null, status: "scheduled", home_team_id: "team-2", away_team_id: "team-1" }],
      scored_props: [
        { id: "scored-derived", score_input_id: "scored-derived__strict", current_prop_id: "prop-derived", league_id: "wnba", covered_score: 74, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: futureIso },
        { id: "scored-unresolved", score_input_id: "scored-unresolved__strict", current_prop_id: "prop-unresolved", league_id: "wnba", covered_score: 71, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: futureIso },
      ],
    score_inputs: [
      { id: "scored-derived__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
      { id: "scored-unresolved__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
    ],
    });

    const result = await getParlayOptions({ limit: 25, includeVariantBooks: true });
    const byId = new Map(result.rows.map((row) => [row.current_prop_id, row]));

    assert.equal(byId.get("prop-derived")?.team_display_name, "Washington Mystics");
    assert.equal(byId.get("prop-derived")?.opponent_display_name, "Atlanta Dream");
    assert.equal(byId.get("prop-derived")?.event_display_name, "Washington Mystics at Atlanta Dream");
    assert.equal(byId.get("prop-unresolved")?.team_display_name, null);
    assert.equal(byId.get("prop-unresolved")?.opponent_display_name, null);
    assert.equal(byId.get("prop-unresolved")?.event_display_name, "Washington Mystics at Atlanta Dream");
  });
});

// --- Prepared-slate upper bound: public pregame output must never include a
// day-after-tomorrow-or-later event, regardless of whether that row is
// freshly scored this run or an already-existing leftover from an earlier
// run (e.g. a manual/diagnostic scoring dispatch that didn't pass eventIds).
// getCoveredPicksOfTheDay/getParlayOptions/getBoardOpportunities are the
// shared choke point for the public snapshot-build AND relational-fallback
// paths -- proving it here proves both.

function preparedSlateProbeTimes() {
  const window = preparedSlateEventWindow(new Date());
  return {
    todayIso: new Date(Math.min(window.startMs + 60 * 60 * 1000, window.endMs - 5 * 60 * 1000)).toISOString(),
    tomorrowLateNightIso: new Date(window.endMs - 60 * 1000).toISOString(), // 1 min before the exclusive upper bound
    dayAfterTomorrowIso: new Date(window.endMs + 60 * 1000).toISOString(), // 1 min after -- must be excluded
  };
}

test("getCoveredPicksOfTheDay includes today/tomorrow-late-night events but excludes a day-after-tomorrow-or-later row, even if it is already scored/publishable from an earlier run", async () => {
  await withE2eEnv(async () => {
    const { todayIso, tomorrowLateNightIso, dayAfterTomorrowIso } = preparedSlateProbeTimes();
    const staleUpdatedAt = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

    withFixture({
      current_props: [
        buildProp(1, todayIso),
        buildProp(2, tomorrowLateNightIso),
        buildProp(3, dayAfterTomorrowIso),
      ],
      participants: [1, 2, 3].map((i) => ({ id: `participant-${i}`, display_name: `Player ${i}`, participant_type: "player", player_id: `player-${i}`, team_id: "team-1", image_url: null, external_ids: {} })),
      players: [1, 2, 3].map((i) => ({ id: `player-${i}`, display_name: `Player ${i}`, canonical_name: `Player ${i}`, headshot_url: null, external_ids: {} })),
      scored_props: [
        // The day-after-tomorrow row is marked as already scored/publishable
        // (>=70) with a stale updated_at, simulating a leftover from an
        // earlier run rather than something this run just produced.
        { id: "scored-1", score_input_id: "scored-1__strict", current_prop_id: "prop-1", sport_id: "basketball", league_id: "wnba", covered_score: 75, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: todayIso },
        { id: "scored-2", score_input_id: "scored-2__strict", current_prop_id: "prop-2", sport_id: "basketball", league_id: "wnba", covered_score: 76, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: tomorrowLateNightIso },
        { id: "scored-3", score_input_id: "scored-3__strict", current_prop_id: "prop-3", sport_id: "basketball", league_id: "wnba", covered_score: 90, confidence_score: 70, data_quality_score: 80, recommendation: "Elite", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: staleUpdatedAt },
      ],
    score_inputs: [
      { id: "scored-1__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
      { id: "scored-2__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
      { id: "scored-3__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
    ],
      ...sharedFixtureTables(),
    });

    const result = await getCoveredPicksOfTheDay({ limit: 25, includeVariantBooks: true, includeDetails: false, includeGrading: false });
    const ids = result.rows.map((row) => row.current_prop_id);
    assert.ok(ids.includes("prop-1"), "today's event must be included");
    assert.ok(ids.includes("prop-2"), "tomorrow 11:59pm Eastern event must be included");
    assert.ok(!ids.includes("prop-3"), "a day-after-tomorrow event must be excluded even though it is already scored >=70 and publishable");
  });
});

// Phase 18 (continuation) items 17/18/19: a scored_props row that
// publishabilityAssessment marked publishable=false (e.g. Phase 18's new
// event_not_scheduled / team_equals_opponent blockers, or any pre-existing
// blocker) must not reach the board, the published snapshot, OR the
// relational fallback. All three share the single getCoveredPicksOfTheDay
// choke point, whose query filters publishable=true at the database layer
// (read-service.ts sharedFilters) -- so a fixture that seeds a blocked row
// alongside a publishable one, and proves only the publishable one is
// returned, proves enforcement for all three surfaces at once. The snapshot
// BUILD path (public-snapshots.ts's coveredPicksReader) and the relational
// FALLBACK path (covered-picks/route.ts) both call this exact function.
test("getCoveredPicksOfTheDay: a publishable=false scored_props row (a Phase 18 blocked prop) never reaches the board/snapshot/relational-fallback choke point, even at a high covered_score", async () => {
  await withE2eEnv(async () => {
    const futureStart = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    withFixture({
      current_props: [
        buildProp(1, futureStart),
        buildProp(2, futureStart),
      ],
      participants: [1, 2].map((i) => ({ id: `participant-${i}`, display_name: `Player ${i}`, participant_type: "player", player_id: `player-${i}`, team_id: "team-1", image_url: null, external_ids: {} })),
      players: [1, 2].map((i) => ({ id: `player-${i}`, display_name: `Player ${i}`, canonical_name: `Player ${i}`, headshot_url: null, external_ids: {} })),
      scored_props: [
        // A genuinely publishable row.
        { id: "scored-ok", score_input_id: "scored-ok__strict", current_prop_id: "prop-1", sport_id: "basketball", league_id: "wnba", covered_score: 78, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: futureStart },
        // A BLOCKED row -- deliberately given the HIGHEST covered_score in the
        // fixture so that if the publishable filter were absent it would rank
        // #1 and be impossible to miss. prop_state=candidate + publishable=false
        // is exactly what publishabilityAssessment writes for a blocked prop.
        { id: "scored-blocked", score_input_id: "scored-blocked__strict", current_prop_id: "prop-2", sport_id: "basketball", league_id: "wnba", covered_score: 99, confidence_score: 70, data_quality_score: 80, recommendation: "Elite", risk_flags: ["event_not_scheduled"], prop_state: "candidate", publishable: false, publishability_reasons: ["event_not_scheduled"], updated_at: futureStart },
      ],
    score_inputs: [
      { id: "scored-ok__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
      { id: "scored-blocked__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
    ],
      ...sharedFixtureTables(),
    });

    const result = await getCoveredPicksOfTheDay({ limit: 25, includeVariantBooks: true, includeDetails: false, includeGrading: false });
    const ids = result.rows.map((row) => row.current_prop_id);
    assert.ok(ids.includes("prop-1"), "the publishable row must appear");
    assert.ok(!ids.includes("prop-2"), "the publishable=false blocked row must never appear, even at covered_score 99");
  });
});

// Phase 18 (continuation) OWNER POLICY #2 -- Manual Analyzer eligibility.
// SUPERSEDES the earlier "getParlayOptions intentionally shows any scored row"
// finding. The parlay builder still differs from Covered Picks in exactly ONE
// way -- it does NOT apply the 70-point floor, so valid rows scoring below 70
// appear here. But it must NOT display a prop that lacks the integrity needed
// for a truthful numeric score. That integrity is precisely the publishable
// condition (`prop_state === "publishable"`, zero blockers: resolved identity,
// canonical single future event, team !== opponent, current+fresh market, all
// required/conditionally-required context present, no exhausted required-
// context blocker). A `candidate` -- which carries at least one required
// blocker by construction -- is excluded here just as it is from Covered
// Picks. Genuinely-optional missing context is a soft reason (not a blocker),
// so a publishable row missing only optional context still appears.
//   - getBoardOpportunities has ZERO non-test callers (verified by grep) --
//     unwired dead code, not a live public surface today. It DOES filter
//     publishable (via filterRowsWithCurrentScoreContract, same as this
//     function); the actual drift found 2026-08-07 was that it omitted the
//     read-time market-freshness re-check getParlayOptions and
//     getCoveredPicksOfTheDay both apply -- fixed (see
//     passesReadTimeMarketFreshness and the "fixes a prior drift" regression
//     test below) so the whole shared-quality-contract family stays aligned
//     even though this particular function isn't wired to a route yet.
test("getParlayOptions (owner policy #2): shows a valid PUBLISHABLE sub-70 row but EXCLUDES a non-publishable candidate, while still omitting the Covered Picks 70-floor", async () => {
  await withE2eEnv(async () => {
    const futureStart = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    withFixture({
      current_props: [buildProp(1, futureStart), buildProp(2, futureStart)],
      participants: [1, 2].map((i) => ({ id: `participant-${i}`, display_name: `Player ${i}`, participant_type: "player", player_id: `player-${i}`, team_id: "team-1", image_url: null, external_ids: {} })),
      players: [1, 2].map((i) => ({ id: `player-${i}`, display_name: `Player ${i}`, canonical_name: `Player ${i}`, headshot_url: null, external_ids: {} })),
      scored_props: [
        // A valid, fully-resolved, PUBLISHABLE row scoring 65 -- below the
        // Covered Picks 70 floor. It MUST appear in the Manual Analyzer: that
        // sub-70 breadth is the parlay builder's whole point.
        { id: "scored-ok", score_input_id: "scored-ok__strict", current_prop_id: "prop-1", sport_id: "basketball", league_id: "wnba", covered_score: 65, confidence_score: 70, data_quality_score: 80, recommendation: "Lean", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: futureStart },
        // A candidate missing REQUIRED matchup context -- higher score (72) so
        // that if the gate were absent it would rank first. It must NOT appear:
        // a candidate lacks the integrity for a truthful score.
        { id: "scored-candidate", score_input_id: "scored-candidate__strict", current_prop_id: "prop-2", sport_id: "basketball", league_id: "wnba", covered_score: 72, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "candidate", publishable: false, publishability_reasons: ["missing_matchup_context"], updated_at: futureStart },
      ],
    score_inputs: [
      { id: "scored-ok__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
      { id: "scored-candidate__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
    ],
      ...sharedFixtureTables(),
    });
    const result = await getParlayOptions({ limit: 25, includeVariantBooks: true });
    const ids = result.rows.map((row) => row.current_prop_id);
    assert.ok(ids.includes("prop-1"), "a valid PUBLISHABLE sub-70 row must appear in the Manual Analyzer (no 70 floor here)");
    assert.ok(!ids.includes("prop-2"), "a non-publishable candidate (missing required context) must be excluded from the Manual Analyzer, even at the higher score");
  });
});

// Phase 18 (continuation Part F): the Manual Analyzer must NOT surface a
// STRUCTURALLY INVALID leg (identity contradiction / non-occurring event),
// even though it deliberately shows valid sub-70 and optional-context-missing
// rows. Each case pairs a structurally-invalid row with a valid one and
// proves only the valid one survives.
test("getParlayOptions: a team_id === opponent_team_id prop (identity contradiction) is excluded from the Manual Analyzer, while a valid row remains", async () => {
  await withE2eEnv(async () => {
    const futureStart = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const invalid = { ...buildProp(2, futureStart), opponent_team_id: "team-1" }; // team_id is "team-1"
    withFixture({
      current_props: [buildProp(1, futureStart), invalid],
      participants: [1, 2].map((i) => ({ id: `participant-${i}`, display_name: `Player ${i}`, participant_type: "player", player_id: `player-${i}`, team_id: "team-1", image_url: null, external_ids: {} })),
      players: [1, 2].map((i) => ({ id: `player-${i}`, display_name: `Player ${i}`, canonical_name: `Player ${i}`, headshot_url: null, external_ids: {} })),
      scored_props: [
        { id: "scored-ok", score_input_id: "scored-ok__strict", current_prop_id: "prop-1", sport_id: "basketball", league_id: "wnba", covered_score: 60, confidence_score: 70, data_quality_score: 80, recommendation: "Lean", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: futureStart },
        { id: "scored-bad", score_input_id: "scored-bad__strict", current_prop_id: "prop-2", sport_id: "basketball", league_id: "wnba", covered_score: 90, confidence_score: 70, data_quality_score: 80, recommendation: "Elite", risk_flags: ["team_equals_opponent"], prop_state: "candidate", publishable: false, publishability_reasons: ["team_equals_opponent"], updated_at: futureStart },
      ],
    score_inputs: [
      { id: "scored-ok__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
      { id: "scored-bad__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
    ],
      ...sharedFixtureTables(),
    });
    const ids = (await getParlayOptions({ limit: 25, includeVariantBooks: true })).rows.map((r) => r.current_prop_id);
    assert.ok(ids.includes("prop-1"), "a valid sub-70 row must still appear in the Manual Analyzer");
    assert.ok(!ids.includes("prop-2"), "a team===opponent contradiction must never appear in the Manual Analyzer, even at score 90");
  });
});

// 2026-08-07 shared-quality-contract consolidation (score-band matrix). Every
// row here is fully qualified (publishable, strict-v1, fresh market, future
// event) and differs ONLY in covered_score. Proves the ONE intended
// difference between the two surfaces is the 70-point floor -- quality does
// not change between them.
test("score-band contract: fully qualified rows at 45/69/70/85 all appear in the Manual Analyzer; only 70 and 85 clear Covered Picks", async () => {
  await withE2eEnv(async () => {
    const futureStart = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const bands = [
      { index: 1, score: 45 },
      { index: 2, score: 69 },
      { index: 3, score: 70 },
      { index: 4, score: 85 },
    ];
    withFixture({
      current_props: bands.map((b) => buildProp(b.index, futureStart)),
      participants: bands.map((b) => ({ id: `participant-${b.index}`, display_name: `Player ${b.index}`, participant_type: "player", player_id: `player-${b.index}`, team_id: "team-1", image_url: null, external_ids: {} })),
      players: bands.map((b) => ({ id: `player-${b.index}`, display_name: `Player ${b.index}`, canonical_name: `Player ${b.index}`, headshot_url: null, external_ids: {} })),
      scored_props: bands.map((b) => ({
        id: `scored-${b.index}`, score_input_id: `scored-${b.index}__strict`, current_prop_id: `prop-${b.index}`,
        sport_id: "basketball", league_id: "wnba", covered_score: b.score, confidence_score: 70, data_quality_score: 80,
        recommendation: b.score >= 70 ? "Strong" : "Lean", risk_flags: [], prop_state: "publishable", publishable: true,
        publishability_reasons: [], updated_at: futureStart,
      })),
      score_inputs: bands.map((b) => ({ id: `scored-${b.index}__strict`, feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } })),
      ...sharedFixtureTables(),
    });

    const analyzerIds = (await getParlayOptions({ limit: 25, includeVariantBooks: true })).rows.map((r) => r.current_prop_id);
    for (const b of bands) assert.ok(analyzerIds.includes(`prop-${b.index}`), `score ${b.score} (fully qualified) must appear in the Manual Analyzer`);

    const pickIds = (await getCoveredPicksOfTheDay({ limit: 25, includeVariantBooks: true })).rows.map((r) => r.current_prop_id);
    assert.ok(!pickIds.includes("prop-1"), "score 45 must not appear in Covered Picks");
    assert.ok(!pickIds.includes("prop-2"), "score 69 must not appear in Covered Picks");
    assert.ok(pickIds.includes("prop-3"), "score 70 must appear in Covered Picks");
    assert.ok(pickIds.includes("prop-4"), "score 85 must appear in Covered Picks");
  });
});

// 2026-08-07: regression for the getBoardOpportunities drift found this pass
// -- it was the one board/Analyzer-shaped function that omitted the
// read-time market-freshness re-check getParlayOptions and
// getCoveredPicksOfTheDay both already apply, so a stored `publishable` row
// whose market had since gone stale could still surface a Covered Score
// through it. Fixed by routing it through the same
// passesReadTimeMarketFreshness gate.
test("getBoardOpportunities: a fully-qualified but market-stale row is excluded, matching getParlayOptions/getCoveredPicksOfTheDay (fixes a prior drift)", async () => {
  await withE2eEnv(async () => {
    const futureStart = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const staleOddsPulledAt = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(); // WNBA fresh window is 180min
    withFixture({
      current_props: [buildProp(1, futureStart), buildProp(2, futureStart)],
      odds_snapshots: [
        { id: "snapshot-1", pulled_at: staleOddsPulledAt },
        { id: "snapshot-2", pulled_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
      ],
      participants: [1, 2].map((i) => ({ id: `participant-${i}`, display_name: `Player ${i}`, participant_type: "player", player_id: `player-${i}`, team_id: "team-1", image_url: null, external_ids: {} })),
      players: [1, 2].map((i) => ({ id: `player-${i}`, display_name: `Player ${i}`, canonical_name: `Player ${i}`, headshot_url: null, external_ids: {} })),
      scored_props: [
        { id: "scored-stale", score_input_id: "scored-stale__strict", current_prop_id: "prop-1", sport_id: "basketball", league_id: "wnba", covered_score: 85, confidence_score: 70, data_quality_score: 80, recommendation: "Strong", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: futureStart },
        { id: "scored-fresh", score_input_id: "scored-fresh__strict", current_prop_id: "prop-2", sport_id: "basketball", league_id: "wnba", covered_score: 60, confidence_score: 70, data_quality_score: 80, recommendation: "Lean", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: futureStart },
      ],
      score_inputs: [
        { id: "scored-stale__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
        { id: "scored-fresh__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
      ],
      ...sharedFixtureTables(),
    });

    const board = await getBoardOpportunities({ limit: 25 });
    const ids = board.map((r) => r.id);
    assert.ok(!ids.includes("scored-stale"), "a market-stale row must not surface a Covered Score via the board/Analyzer path, even at score 85");
    assert.ok(ids.includes("scored-fresh"), "a fresh, fully-qualified row must still appear");
  });
});

test("getParlayOptions: a prop tied to a postponed event is excluded from the Manual Analyzer", async () => {
  await withE2eEnv(async () => {
    const futureStart = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    withFixture({
      current_props: [buildProp(1, futureStart), { ...buildProp(2, futureStart), event_id: "event-postponed" }],
      participants: [1, 2].map((i) => ({ id: `participant-${i}`, display_name: `Player ${i}`, participant_type: "player", player_id: `player-${i}`, team_id: "team-1", image_url: null, external_ids: {} })),
      players: [1, 2].map((i) => ({ id: `player-${i}`, display_name: `Player ${i}`, canonical_name: `Player ${i}`, headshot_url: null, external_ids: {} })),
      events: [
        { id: "event-1", display_name: "A at B", scheduled_date: null, start_time: null, status: "scheduled", home_team_id: "team-2", away_team_id: "team-1" },
        { id: "event-postponed", display_name: "A at B (ppd)", scheduled_date: null, start_time: null, status: "postponed", home_team_id: "team-2", away_team_id: "team-1" },
      ],
      teams: [
        { id: "team-1", name: "Washington Mystics", abbreviation: "WAS", logo_url: null, external_ids: {} },
        { id: "team-2", name: "Atlanta Dream", abbreviation: "ATL", logo_url: null, external_ids: {} },
      ],
      markets: [{ id: "market-1", market_type: "player_points", display_name: "Points" }],
      sportsbooks: [{ id: "sportsbook-1", code: "draftkings", display_name: "DraftKings" }],
      scored_props: [
        { id: "scored-ok", score_input_id: "scored-ok__strict", current_prop_id: "prop-1", sport_id: "basketball", league_id: "wnba", covered_score: 60, confidence_score: 70, data_quality_score: 80, recommendation: "Lean", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: futureStart },
        { id: "scored-ppd", score_input_id: "scored-ppd__strict", current_prop_id: "prop-2", sport_id: "basketball", league_id: "wnba", covered_score: 88, confidence_score: 70, data_quality_score: 80, recommendation: "Strong", risk_flags: ["event_not_scheduled"], prop_state: "candidate", publishable: false, publishability_reasons: ["event_not_scheduled"], updated_at: futureStart },
      ],
    score_inputs: [
      { id: "scored-ok__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
      { id: "scored-ppd__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
    ],
    });
    const ids = (await getParlayOptions({ limit: 25, includeVariantBooks: true })).rows.map((r) => r.current_prop_id);
    assert.ok(ids.includes("prop-1"));
    assert.ok(!ids.includes("prop-2"), "a postponed-event prop must never appear in the Manual Analyzer");
  });
});

test("getParlayOptions: a prop with neither a resolved player nor a resolved event is excluded (nothing structurally valid to bet on)", async () => {
  await withE2eEnv(async () => {
    const futureStart = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    withFixture({
      current_props: [buildProp(1, futureStart), { ...buildProp(2, futureStart), player_id: null, event_id: null }],
      participants: [1, 2].map((i) => ({ id: `participant-${i}`, display_name: `Player ${i}`, participant_type: "player", player_id: `player-${i}`, team_id: "team-1", image_url: null, external_ids: {} })),
      players: [1, 2].map((i) => ({ id: `player-${i}`, display_name: `Player ${i}`, canonical_name: `Player ${i}`, headshot_url: null, external_ids: {} })),
      scored_props: [
        { id: "scored-ok", score_input_id: "scored-ok__strict", current_prop_id: "prop-1", sport_id: "basketball", league_id: "wnba", covered_score: 60, confidence_score: 70, data_quality_score: 80, recommendation: "Lean", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: futureStart },
        { id: "scored-noid", score_input_id: "scored-noid__strict", current_prop_id: "prop-2", sport_id: "basketball", league_id: "wnba", covered_score: 85, confidence_score: 70, data_quality_score: 80, recommendation: "Strong", risk_flags: [], prop_state: "candidate", publishable: false, publishability_reasons: ["unmatched_player", "unmatched_event"], updated_at: futureStart },
      ],
    score_inputs: [
      { id: "scored-ok__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
      { id: "scored-noid__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
    ],
      ...sharedFixtureTables(),
    });
    const ids = (await getParlayOptions({ limit: 25, includeVariantBooks: true })).rows.map((r) => r.current_prop_id);
    assert.ok(ids.includes("prop-1"));
    assert.ok(!ids.includes("prop-2"), "a fully-unresolved-identity prop must never appear in the Manual Analyzer");
  });
});

// Phase 18 (continuation) OWNER POLICY #1 at the Manual Analyzer surface: a
// prop may be `active` and attached to a FUTURE event yet still have a
// provider market that has not been observed within the hard freshness window
// (WNBA 180 min). The read-time freshness re-check in getParlayOptions must
// exclude it even though its stored scored row is publishable -- currency
// cannot be proven, so it is blocked. A genuinely-fresh publishable row in the
// same batch still appears, proving the gate is per-row, not all-or-nothing.
test("getParlayOptions (owner policy #1): excludes a scored-publishable row whose market observation is stale at READ time, while a fresh publishable row remains", async () => {
  await withE2eEnv(async () => {
    const futureStart = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const freshObserved = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago -> fresh
    const staleObserved = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5 h ago -> stale for WNBA (>180 min)
    withFixture({
      // prop-1 fresh market; prop-2 same future event but a stale (5h-old) market observation.
      current_props: [
        { ...buildProp(1, futureStart), updated_at: freshObserved },
        { ...buildProp(2, futureStart), updated_at: staleObserved },
      ],
      participants: [1, 2].map((i) => ({ id: `participant-${i}`, display_name: `Player ${i}`, participant_type: "player", player_id: `player-${i}`, team_id: "team-1", image_url: null, external_ids: {} })),
      players: [1, 2].map((i) => ({ id: `player-${i}`, display_name: `Player ${i}`, canonical_name: `Player ${i}`, headshot_url: null, external_ids: {} })),
      scored_props: [
        { id: "scored-fresh", score_input_id: "scored-fresh__strict", current_prop_id: "prop-1", sport_id: "basketball", league_id: "wnba", covered_score: 74, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: freshObserved },
        // Higher score so it would rank first if the freshness gate were absent.
        { id: "scored-stale", score_input_id: "scored-stale__strict", current_prop_id: "prop-2", sport_id: "basketball", league_id: "wnba", covered_score: 92, confidence_score: 70, data_quality_score: 80, recommendation: "Elite", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: staleObserved },
      ],
    score_inputs: [
      { id: "scored-fresh__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
      { id: "scored-stale__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
    ],
      ...sharedFixtureTables(),
    });
    const ids = (await getParlayOptions({ limit: 25, includeVariantBooks: true })).rows.map((r) => r.current_prop_id);
    assert.ok(ids.includes("prop-1"), "a fresh publishable row must appear in the Manual Analyzer");
    assert.ok(!ids.includes("prop-2"), "a stale-market row must be excluded at read time even though its stored scored row is publishable, and even at score 92");
  });
});

// Session 117 (production run 31129018935): market freshness must read
// odds_snapshots.pulled_at via latest_snapshot_id, NEVER current_props.
// updated_at. This reproduces the exact live shape that slipped through:
// repairSharpCurrentPropIdentities (an identity-only patch: player_id/
// participant_id/team_id/match_status/match_confidence -- no line/price
// fields) stamps a fresh updated_at while leaving latest_snapshot_id/
// odds_snapshots.pulled_at untouched at its genuinely-stale value. The row
// must stay excluded from both surfaces despite the fresh updated_at.
test("identity-only repair (fresh updated_at, stale pulled_at) does not refresh market freshness -- the Kelsey Mitchell production shape stays excluded from both Manual Analyzer and Covered Picks", async () => {
  await withE2eEnv(async () => {
    const futureStart = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const identityRepairedAt = new Date(Date.now() - 1 * 60 * 1000).toISOString(); // 1 min ago: fresh-looking updated_at
    const staleOddsObservedAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5h ago: genuinely stale price
    const seed = {
      // updated_at reflects the identity-repair write, NOT a genuine price observation.
      current_props: [{ ...buildProp(1, futureStart), updated_at: identityRepairedAt }],
      participants: [{ id: "participant-1", display_name: "Kelsey Mitchell", participant_type: "player", player_id: "player-1", team_id: "team-1", image_url: null, external_ids: {} }],
      players: [{ id: "player-1", display_name: "Kelsey Mitchell", canonical_name: "Kelsey Mitchell", headshot_url: null, external_ids: {} }],
      // The odds_snapshots row this prop's latest_snapshot_id actually points to was never
      // refreshed by identity repair -- its pulled_at is genuinely 5 hours old.
      odds_snapshots: [{ id: "snapshot-1", pulled_at: staleOddsObservedAt }],
      scored_props: [
        { id: "scored-identity-repaired", score_input_id: "scored-identity-repaired__strict", current_prop_id: "prop-1", sport_id: "basketball", league_id: "wnba", covered_score: 50, confidence_score: 70, data_quality_score: 80, recommendation: "Lean", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: identityRepairedAt },
      ],
      score_inputs: [
        { id: "scored-identity-repaired__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
      ],
      ...sharedFixtureTables(),
    };

    withFixture(seed);
    const parlayIds = (await getParlayOptions({ limit: 25, includeVariantBooks: true })).rows.map((r) => r.current_prop_id);
    assert.ok(!parlayIds.includes("prop-1"), "identity repair must not make a stale-priced prop appear fresh in the Manual Analyzer");

    withFixture(seed);
    const pickIds = (await getCoveredPicksOfTheDay({ limit: 25, includeVariantBooks: true, includeDetails: false, includeGrading: false })).rows.map((r) => r.current_prop_id);
    assert.ok(!pickIds.includes("prop-1"), "identity repair must not make a stale-priced prop appear fresh in Covered Picks");
  });
});

test("a genuine Sharp price re-observation (fresh odds_snapshots.pulled_at) refreshes market freshness even when current_props.updated_at is comparatively old", async () => {
  await withE2eEnv(async () => {
    const futureStart = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    // updated_at itself is old (stale by the old, now-removed proxy logic)...
    const oldUpdatedAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    // ...but the row's actual latest_snapshot_id points to a snapshot pulled moments ago.
    const freshPulledAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    withFixture({
      current_props: [{ ...buildProp(1, futureStart), updated_at: oldUpdatedAt }],
      participants: [{ id: "participant-1", display_name: "Player 1", participant_type: "player", player_id: "player-1", team_id: "team-1", image_url: null, external_ids: {} }],
      players: [{ id: "player-1", display_name: "Player 1", canonical_name: "Player 1", headshot_url: null, external_ids: {} }],
      odds_snapshots: [{ id: "snapshot-1", pulled_at: freshPulledAt }],
      scored_props: [
        { id: "scored-genuinely-fresh", score_input_id: "scored-genuinely-fresh__strict", current_prop_id: "prop-1", sport_id: "basketball", league_id: "wnba", covered_score: 75, confidence_score: 70, data_quality_score: 80, recommendation: "Strong", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: oldUpdatedAt },
      ],
      score_inputs: [
        { id: "scored-genuinely-fresh__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
      ],
      ...sharedFixtureTables(),
    });
    const parlayIds = (await getParlayOptions({ limit: 25, includeVariantBooks: true })).rows.map((r) => r.current_prop_id);
    assert.ok(parlayIds.includes("prop-1"), "a genuinely fresh price observation must be honored regardless of the row's unrelated updated_at value");
  });
});

test("a current_prop with no matching odds_snapshots row (never genuinely observed) is excluded as never_observed, even with a fresh-looking updated_at", async () => {
  await withE2eEnv(async () => {
    const futureStart = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const freshLookingUpdatedAt = new Date(Date.now() - 1 * 60 * 1000).toISOString();
    // Deliberately bypasses withFixture AND the harness's own auto-derived
    // odds_snapshots (which would otherwise synthesize a fresh snapshot for this id) by
    // passing an explicit, empty `odds_snapshots: []` -- this test's whole point is
    // proving behavior when NO odds_snapshots row exists at all.
    createSupabaseFixture({
      current_props: [{ ...buildProp(1, futureStart), updated_at: freshLookingUpdatedAt, latest_snapshot_id: "snapshot-never-observed" }],
      participants: [{ id: "participant-1", display_name: "Player 1", participant_type: "player", player_id: "player-1", team_id: "team-1", image_url: null, external_ids: {} }],
      players: [{ id: "player-1", display_name: "Player 1", canonical_name: "Player 1", headshot_url: null, external_ids: {} }],
      odds_snapshots: [],
      scored_props: [
        { id: "scored-never-observed", score_input_id: "scored-never-observed__strict", current_prop_id: "prop-1", sport_id: "basketball", league_id: "wnba", covered_score: 80, confidence_score: 70, data_quality_score: 80, recommendation: "Strong", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: freshLookingUpdatedAt },
      ],
      score_inputs: [
        { id: "scored-never-observed__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
      ],
      ...sharedFixtureTables(),
    });
    const parlayIds = (await getParlayOptions({ limit: 25, includeVariantBooks: true })).rows.map((r) => r.current_prop_id);
    assert.ok(!parlayIds.includes("prop-1"), "a prop whose latest_snapshot_id points to no real odds_snapshots row must be treated as never_observed, not fresh");
  });
});

// Phase 18 (continuation) OWNER POLICY #2 -- the ONE deliberate difference from
// Covered Picks: a valid PUBLISHABLE row scoring 69 (below the 70 floor)
// appears in the Manual Analyzer but is absent from Covered Picks. Same fixture,
// two surfaces, proving the 70 floor lives ONLY in Covered Picks.
test("getParlayOptions vs getCoveredPicksOfTheDay (owner policy #2): a valid publishable score-69 row appears in the Manual Analyzer but not in Covered Picks", async () => {
  await withE2eEnv(async () => {
    const futureStart = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const observed = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const seed = {
      current_props: [{ ...buildProp(1, futureStart), updated_at: observed }],
      participants: [{ id: "participant-1", display_name: "Player 1", participant_type: "player", player_id: "player-1", team_id: "team-1", image_url: null, external_ids: {} }],
      players: [{ id: "player-1", display_name: "Player 1", canonical_name: "Player 1", headshot_url: null, external_ids: {} }],
      scored_props: [
        { id: "scored-69", score_input_id: "scored-69__strict", current_prop_id: "prop-1", sport_id: "basketball", league_id: "wnba", covered_score: 69, confidence_score: 70, data_quality_score: 80, recommendation: "Lean", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: observed },
      ],
    score_inputs: [
      { id: "scored-69__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
    ],
      ...sharedFixtureTables(),
    };

    withFixture(seed);
    const parlayIds = (await getParlayOptions({ limit: 25, includeVariantBooks: true })).rows.map((r) => r.current_prop_id);
    assert.ok(parlayIds.includes("prop-1"), "a valid publishable score-69 row must appear in the Manual Analyzer (no 70 floor)");

    withFixture(seed);
    const pickIds = (await getCoveredPicksOfTheDay({ limit: 25, includeVariantBooks: true, includeDetails: false, includeGrading: false })).rows.map((r) => r.current_prop_id);
    assert.ok(!pickIds.includes("prop-1"), "the same score-69 row must be excluded from Covered Picks by the 70 floor");
  });
});

// Phase 18 continuation (owner-policy re-audit) Part 5: a stale-market row at
// a high score (99) must appear in NEITHER surface -- not just Covered Picks
// (already proven at line 388-ish) but the Manual Analyzer too, in the SAME
// fixture/request, so there is no possibility the two assertions drift apart
// under future edits.
test("a stale-market score-99 row appears in NEITHER getCoveredPicksOfTheDay NOR getParlayOptions", async () => {
  await withE2eEnv(async () => {
    const futureStart = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const staleObserved = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5h ago -> stale (WNBA > 180min)
    const seed = {
      current_props: [{ ...buildProp(1, futureStart), updated_at: staleObserved }],
      participants: [{ id: "participant-1", display_name: "Player 1", participant_type: "player", player_id: "player-1", team_id: "team-1", image_url: null, external_ids: {} }],
      players: [{ id: "player-1", display_name: "Player 1", canonical_name: "Player 1", headshot_url: null, external_ids: {} }],
      scored_props: [
        { id: "scored-stale-99", score_input_id: "scored-stale-99__strict", current_prop_id: "prop-1", sport_id: "basketball", league_id: "wnba", covered_score: 99, confidence_score: 70, data_quality_score: 80, recommendation: "Elite", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: staleObserved },
      ],
    score_inputs: [
      { id: "scored-stale-99__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
    ],
      ...sharedFixtureTables(),
    };

    withFixture(seed);
    const pickIds = (await getCoveredPicksOfTheDay({ limit: 25, includeVariantBooks: true, includeDetails: false, includeGrading: false })).rows.map((r) => r.current_prop_id);
    assert.ok(!pickIds.includes("prop-1"), "a stale-market score-99 row must never reach Covered Picks, however high the score");

    withFixture(seed);
    const parlayIds = (await getParlayOptions({ limit: 25, includeVariantBooks: true })).rows.map((r) => r.current_prop_id);
    assert.ok(!parlayIds.includes("prop-1"), "the same stale-market score-99 row must also never reach the Manual Analyzer -- currency cannot be proven for either surface");
  });
});

// Phase 18 continuation (owner-policy re-audit) Part 5: a publishable row
// missing only GENUINELY OPTIONAL context (a soft reason, no blocker) must
// still appear in both surfaces, and its own publishability_reasons must
// truthfully disclose the gap -- never silently omitted or fabricated as
// fully-observed.
test("a publishable row missing only genuinely-optional context (injury_uncertainty, a soft reason) appears in both surfaces with truthful disclosure", async () => {
  await withE2eEnv(async () => {
    const futureStart = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const observed = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const seed = {
      current_props: [{ ...buildProp(1, futureStart), updated_at: observed }],
      participants: [{ id: "participant-1", display_name: "Player 1", participant_type: "player", player_id: "player-1", team_id: "team-1", image_url: null, external_ids: {} }],
      players: [{ id: "player-1", display_name: "Player 1", canonical_name: "Player 1", headshot_url: null, external_ids: {} }],
      scored_props: [
        // publishable=true (zero blockers) but publishability_reasons still
        // carries the soft/optional injury_uncertainty flag -- this is the
        // exact shape publishabilityAssessment produces for a
        // scoreable_optional_context_missing prop (see scoring-service.ts
        // deriveCompletenessState / softReasons construction).
        { id: "scored-optional-only", score_input_id: "scored-optional-only__strict", current_prop_id: "prop-1", sport_id: "basketball", league_id: "wnba", covered_score: 78, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: ["injury_uncertainty"], prop_state: "publishable", publishable: true, publishability_reasons: ["injury_uncertainty"], updated_at: observed },
      ],
    score_inputs: [
      { id: "scored-optional-only__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
    ],
      ...sharedFixtureTables(),
    };

    withFixture(seed);
    const picks = await getCoveredPicksOfTheDay({ limit: 25, includeVariantBooks: true, includeDetails: false, includeGrading: false });
    const pickRow = picks.rows.find((r) => r.current_prop_id === "prop-1");
    assert.ok(pickRow, "a publishable row missing only optional context must still be eligible for Covered Picks (score-gated separately, not blocked by this)");

    withFixture(seed);
    const parlay = await getParlayOptions({ limit: 25, includeVariantBooks: true });
    const parlayRow = parlay.rows.find((r) => r.current_prop_id === "prop-1");
    assert.ok(parlayRow, "the same row must appear in the Manual Analyzer");
    assert.equal(parlayRow!.publishability_status, "publishable");
    assert.ok(parlayRow!.publishability_reasons.includes("injury_uncertainty"), "the optional gap must be truthfully disclosed in publishability_reasons, not silently omitted or presented as fully-observed");
  });
});

test("getCoveredPicksOfTheDay: a league with fewer/older-but-eligible rows is not starved out of the scan by another league's larger, more-recently-updated pool", async () => {
  await withE2eEnv(async () => {
    // Reproduces the real production shape: each league's own cron window updates its own
    // scored_props independently, so at any moment one league can have far more recently-
    // touched rows than another. A single combined scan ordered by updated_at.desc with a
    // small scanLimit would let the larger/fresher league (mlb here) fill the entire scan
    // before the smaller/older-but-still-eligible league (wnba) is ever read.
    const now = Date.now();
    const mlbUpdatedAt = new Date(now).toISOString(); // most recent
    const wnbaUpdatedAt = new Date(now - 60 * 60 * 1000).toISOString(); // an hour older, still eligible
    const futureStart = new Date(now + 6 * 60 * 60 * 1000).toISOString();

    const mlbCount = 40; // fills a small scanLimit entirely on its own
    const currentProps: FixtureRow[] = [];
    const participants: FixtureRow[] = [];
    const players: FixtureRow[] = [];
    const scoredProps: FixtureRow[] = [];
    const scoreInputs: FixtureRow[] = [];

    for (let i = 0; i < mlbCount; i += 1) {
      currentProps.push({ ...buildProp(i, futureStart), league_id: "mlb", sport_id: "baseball", market_type: "pitcher_strikeouts" });
      participants.push({ id: `participant-${i}`, display_name: `MLB Player ${i}`, participant_type: "player", player_id: `player-${i}`, team_id: "team-1", image_url: null, external_ids: {} });
      players.push({ id: `player-${i}`, display_name: `MLB Player ${i}`, canonical_name: `MLB Player ${i}`, headshot_url: null, external_ids: {} });
      scoredProps.push({ id: `scored-mlb-${i}`, score_input_id: `scored-mlb-${i}__strict`, current_prop_id: `prop-${i}`, sport_id: "baseball", league_id: "mlb", covered_score: 75, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: mlbUpdatedAt });
      scoreInputs.push({ id: `scored-mlb-${i}__strict`, feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } });
    }

    const wnbaIndex = 9000;
    currentProps.push({ ...buildProp(wnbaIndex, futureStart), league_id: "wnba" });
    participants.push({ id: `participant-${wnbaIndex}`, display_name: "WNBA Player", participant_type: "player", player_id: `player-${wnbaIndex}`, team_id: "team-1", image_url: null, external_ids: {} });
    players.push({ id: `player-${wnbaIndex}`, display_name: "WNBA Player", canonical_name: "WNBA Player", headshot_url: null, external_ids: {} });
    // Deliberately the highest score of any row in the fixture: if the WNBA row is
    // scanned at all it must rank #1 and appear in even a small top-N slice --
    // isolating "was it scanned" from "did it rank highly enough afterward".
    scoredProps.push({ id: "scored-wnba-1", score_input_id: "scored-wnba-1__strict", current_prop_id: `prop-${wnbaIndex}`, sport_id: "basketball", league_id: "wnba", covered_score: 90, confidence_score: 70, data_quality_score: 80, recommendation: "Elite", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: wnbaUpdatedAt });
    scoreInputs.push({ id: "scored-wnba-1__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } });

    withFixture({
      current_props: currentProps,
      participants,
      players,
      scored_props: scoredProps,
      score_inputs: scoreInputs,
      ...sharedFixtureTables(),
    });

    // A small explicit limit keeps scanLimit small (KNOWLEDGE_LOW_EGRESS_MODE:
    // min(max(limit*4,24),250)) so the 40 MLB rows alone would fill a single
    // combined scan before the older WNBA row is ever read.
    const result = await getCoveredPicksOfTheDay({ limit: 10, includeVariantBooks: true, includeDetails: false, includeGrading: false });
    const ids = result.rows.map((row) => row.current_prop_id);
    assert.ok(ids.includes(`prop-${wnbaIndex}`), "the WNBA row must not be starved out of the scan by MLB's larger, fresher pool");
  });
});

test("getParlayOptions includes today/tomorrow-late-night events but excludes a day-after-tomorrow-or-later row", async () => {
  await withE2eEnv(async () => {
    const { todayIso, tomorrowLateNightIso, dayAfterTomorrowIso } = preparedSlateProbeTimes();

    withFixture({
      current_props: [
        buildProp(1, todayIso),
        buildProp(2, tomorrowLateNightIso),
        buildProp(3, dayAfterTomorrowIso),
      ],
      participants: [1, 2, 3].map((i) => ({ id: `participant-${i}`, display_name: `Player ${i}`, participant_type: "player", player_id: `player-${i}`, team_id: "team-1", image_url: null, external_ids: {} })),
      players: [1, 2, 3].map((i) => ({ id: `player-${i}`, display_name: `Player ${i}`, canonical_name: `Player ${i}`, headshot_url: null, external_ids: {} })),
      scored_props: [
        { id: "scored-1", score_input_id: "scored-1__strict", current_prop_id: "prop-1", league_id: "wnba", covered_score: 75, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: todayIso },
        { id: "scored-2", score_input_id: "scored-2__strict", current_prop_id: "prop-2", league_id: "wnba", covered_score: 76, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: tomorrowLateNightIso },
        { id: "scored-3", score_input_id: "scored-3__strict", current_prop_id: "prop-3", league_id: "wnba", covered_score: 90, confidence_score: 70, data_quality_score: 80, recommendation: "Elite", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: dayAfterTomorrowIso },
      ],
    score_inputs: [
      { id: "scored-1__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
      { id: "scored-2__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
      { id: "scored-3__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
    ],
      ...sharedFixtureTables(),
    });

    const result = await getParlayOptions({ limit: 25, includeVariantBooks: true });
    const ids = result.rows.map((row) => row.current_prop_id);
    assert.ok(ids.includes("prop-1"), "today's event must be included");
    assert.ok(ids.includes("prop-2"), "tomorrow 11:59pm Eastern event must be included");
    assert.ok(!ids.includes("prop-3"), "a day-after-tomorrow event must be excluded");
  });
});

test("getBoardOpportunities includes today/tomorrow-late-night events but excludes a day-after-tomorrow-or-later row", async () => {
  await withE2eEnv(async () => {
    const { todayIso, tomorrowLateNightIso, dayAfterTomorrowIso } = preparedSlateProbeTimes();

    withFixture({
      current_props: [
        buildProp(1, todayIso),
        buildProp(2, tomorrowLateNightIso),
        buildProp(3, dayAfterTomorrowIso),
      ],
      players: [1, 2, 3].map((i) => ({ id: `player-${i}`, display_name: `Player ${i}`, canonical_name: `Player ${i}`, headshot_url: null, external_ids: {} })),
      teams: [
        { id: "team-1", name: "Washington Mystics", abbreviation: "WAS", logo_url: null, external_ids: {} },
        { id: "team-2", name: "Atlanta Dream", abbreviation: "ATL", logo_url: null, external_ids: {} },
      ],
      scored_props: [
        { id: "scored-1", score_input_id: "scored-1__strict", current_prop_id: "prop-1", player_id: "player-1", team_id: "team-1", opponent_team_id: "team-2", event_id: "event-1", sport_id: "basketball", league_id: "wnba", covered_score: 75, projection: 20, line: 18.5, edge_score: 5, confidence_score: 70, trend_score: 0, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [] },
        { id: "scored-2", score_input_id: "scored-2__strict", current_prop_id: "prop-2", player_id: "player-2", team_id: "team-1", opponent_team_id: "team-2", event_id: "event-1", sport_id: "basketball", league_id: "wnba", covered_score: 76, projection: 20, line: 18.5, edge_score: 5, confidence_score: 70, trend_score: 0, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [] },
        { id: "scored-3", score_input_id: "scored-3__strict", current_prop_id: "prop-3", player_id: "player-3", team_id: "team-1", opponent_team_id: "team-2", event_id: "event-1", sport_id: "basketball", league_id: "wnba", covered_score: 90, projection: 20, line: 18.5, edge_score: 5, confidence_score: 70, trend_score: 0, data_quality_score: 80, recommendation: "Elite", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [] },
      ],
    score_inputs: [
      { id: "scored-1__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
      { id: "scored-2__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
      { id: "scored-3__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
    ],
    });

    const result = await getBoardOpportunities({ limit: 25 });
    const ids = result.map((row) => row.id);
    assert.ok(ids.includes("scored-1"), "today's event must be included");
    assert.ok(ids.includes("scored-2"), "tomorrow 11:59pm Eastern event must be included");
    assert.ok(!ids.includes("scored-3"), "a day-after-tomorrow event must be excluded");
  });
});

test("owner policy correction: a later-starting but HIGH-scoring prop is never dropped by the scan just because many earlier-starting lower-scoring props exist -- the scan orders by covered_score, not start_time", async () => {
  await withE2eEnv(async () => {
    const earlyIso = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const lateIso = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString();

    // 260 filler props, all starting soon and all LOW-scoring -- under the
    // pre-fix code (current_props scanned by start_time.asc, scanLimit-bounded),
    // these alone would fill the per-league scan window before a later-
    // starting prop was ever fetched, regardless of that prop's score.
    const fillerCount = 260;
    const fillerProps = Array.from({ length: fillerCount }, (_, i) => ({
      ...buildProp(i, earlyIso),
      participant_id: "participant-1",
      player_id: "player-1",
      opponent_id: "participant-1",
      line: 10 + i * 0.1,
    }));
    const fillerScored = fillerProps.map((_, i) => ({
      id: `scored-filler-${i}`, score_input_id: `scored-filler-${i}__strict`, current_prop_id: `prop-${i}`, league_id: "wnba",
      covered_score: 20 + (i % 30), confidence_score: 70, data_quality_score: 80,
      recommendation: "Lean", risk_flags: [], prop_state: "publishable", publishable: true,
      publishability_reasons: [], updated_at: earlyIso,
    }));
    const fillerScoreInputs = fillerProps.map((_, i) => ({ id: `scored-filler-${i}__strict`, feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } }));

    const highValueProp = { ...buildProp(9999, lateIso), id: "prop-high-value" };
    const highValueScored = {
      id: "scored-high-value", score_input_id: "scored-high-value__strict", current_prop_id: "prop-high-value", league_id: "wnba",
      covered_score: 99, confidence_score: 90, data_quality_score: 90,
      recommendation: "Elite", risk_flags: [], prop_state: "publishable", publishable: true,
      publishability_reasons: [], updated_at: lateIso,
    };
    const highValueScoreInput = { id: "scored-high-value__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } };

    withFixture({
      current_props: [...fillerProps, highValueProp],
      participants: [
        { id: "participant-1", display_name: "Filler Player", participant_type: "player", player_id: "player-1", team_id: "team-1", image_url: null, external_ids: {} },
      ],
      players: [{ id: "player-1", display_name: "Filler Player", canonical_name: "Filler Player", headshot_url: null, external_ids: {} }],
      scored_props: [...fillerScored, highValueScored],
      score_inputs: [...fillerScoreInputs, highValueScoreInput],
      ...sharedFixtureTables(),
    });

    const result = await getParlayOptions({ limit: 25, includeVariantBooks: true });
    const ids = result.rows.map((row) => row.current_prop_id);
    assert.ok(ids.includes("prop-high-value"), "a later-starting but top-scoring prop must survive the scan regardless of how many earlier-starting lower-scoring props exist");
    assert.equal(result.rows[0]?.current_prop_id, "prop-high-value", "the highest-scoring eligible prop must rank first in the final output");
  });
});

test("getParlayOptions: attaches bounded public-safe commentary reused from the stored score_explanations row (no per-card fetch), and stays null when no explanation row exists yet", async () => {
  await withE2eEnv(async () => {
    const futureIso = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    withFixture({
      current_props: [buildProp(1, futureIso), buildProp(2, futureIso)],
      participants: [
        { id: "participant-1", display_name: "Player 1", participant_type: "player", player_id: "player-1", team_id: "team-1", image_url: null, external_ids: {} },
        { id: "participant-2", display_name: "Player 2", participant_type: "player", player_id: "player-2", team_id: "team-1", image_url: null, external_ids: {} },
      ],
      players: [
        { id: "player-1", display_name: "Player 1", canonical_name: "Player 1", headshot_url: null, external_ids: {} },
        { id: "player-2", display_name: "Player 2", canonical_name: "Player 2", headshot_url: null, external_ids: {} },
      ],
      scored_props: [
        { id: "scored-1", score_input_id: "scored-1__strict", current_prop_id: "prop-1", league_id: "wnba", covered_score: 78, confidence_score: 70, data_quality_score: 80, recommendation: "Strong", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: futureIso },
        { id: "scored-2", score_input_id: "scored-2__strict", current_prop_id: "prop-2", league_id: "wnba", covered_score: 60, confidence_score: 70, data_quality_score: 80, recommendation: "Lean", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: futureIso },
      ],
    score_inputs: [
      { id: "scored-1__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
      { id: "scored-2__strict", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } },
    ],
      score_explanations: [
        { scored_prop_id: "scored-1", summary: "Player 1 projects over.", reasoning_block: "Strong recent form and a favorable matchup.", factors: [{ name: "Recent Form", label: "Strong", impact: "positive", description: "Player 1 is trending up over the last 5." }] },
        // scored-2 deliberately has no explanation row -- simulates a legacy pre-explanation row.
      ],
      ...sharedFixtureTables(),
    });

    const result = await getParlayOptions({ limit: 25, includeVariantBooks: true });
    const withExplanation = result.rows.find((row) => row.current_prop_id === "prop-1");
    const withoutExplanation = result.rows.find((row) => row.current_prop_id === "prop-2");
    assert.equal(withExplanation?.commentary?.summary, "Strong recent form and a favorable matchup.");
    assert.ok(withExplanation?.commentary?.positive_factors.some((entry) => entry.includes("trending up")));
    assert.match(withExplanation?.commentary?.status ?? "", /meets Covered Picks/);
    assert.equal(withoutExplanation?.commentary, null, "a scored prop with no stored explanation gets null commentary, not a fabricated placeholder");
  });
});

test("getParlayOptions: attaches deterministic expanded evidence read from the stored score_inputs.feature_payload and exact-line last-5/last-10 hit counts (deduplicated by game_date) from player_game_logs, and each field independently stays null -- never fabricated -- when its own source is genuinely missing", async () => {
  await withE2eEnv(async () => {
    const futureIso = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const propWithEvidence = { ...buildProp(1, futureIso), market_type: "player_assists", line: 2.5, direction: "Less", side: "Less" };
    const propWithoutEvidence = { ...buildProp(2, futureIso), market_type: "player_assists", line: 2.5, direction: "Less", side: "Less" };
    withFixture({
      current_props: [propWithEvidence, propWithoutEvidence],
      participants: [
        { id: "participant-1", display_name: "Player 1", participant_type: "player", player_id: "player-1", team_id: "team-1", image_url: null, external_ids: {} },
        { id: "participant-2", display_name: "Player 2", participant_type: "player", player_id: "player-2", team_id: "team-1", image_url: null, external_ids: {} },
      ],
      players: [
        { id: "player-1", display_name: "Player 1", canonical_name: "Player 1", headshot_url: null, external_ids: {} },
        { id: "player-2", display_name: "Player 2", canonical_name: "Player 2", headshot_url: null, external_ids: {} },
      ],
      scored_props: [
        { id: "scored-1", score_input_id: "scored-1__strict", current_prop_id: "prop-1", league_id: "wnba", covered_score: 50, confidence_score: 70, data_quality_score: 80, recommendation: "Lean", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: futureIso },
        // scored-2 is publishable and contract-eligible, but its stored feature_payload is
        // sparse (no edge_value/minutes_trend/usage_trend, no matching factor) -- proving
        // individual evidence fields stay null rather than fabricated when a source is
        // genuinely missing, even while other fields on the same row are populated.
        { id: "scored-2", score_input_id: "scored-2__strict", current_prop_id: "prop-2", league_id: "wnba", covered_score: 50, confidence_score: 70, data_quality_score: 80, recommendation: "Lean", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: futureIso },
      ],
      score_inputs: [
        {
          id: "scored-1__strict",
          feature_payload: {
            scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION,
            projection: 1.9,
            edge_value: 0.6,
            last_5_avg: 1.8,
            last_10_avg: 2.3,
            minutes_trend: 0.1,
            usage_trend: -0.4,
            data_freshness: { oddsPulledAt: futureIso },
          },
        },
        {
          id: "scored-2__strict",
          feature_payload: {
            scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION,
            projection: 2.0,
            last_5_avg: 1.8,
          },
        },
      ],
      score_explanations: [
        { scored_prop_id: "scored-1", summary: "Player 1 assists projection is under the line.", reasoning_block: "Below-line matchup.", factors: [{ name: "Matchup", label: "Favorable", impact: "positive", description: "Opponent allows fewer assists than average." }] },
      ],
      // Two identical-stat rows share game_date "2026-07-15" -- a real duplicate-ingestion shape
      // observed live -- and must collapse to ONE game, not inflate the sample size to 6/11.
      player_game_logs: [
        { player_id: "player-1", game_date: "2026-07-31", points: 10, rebounds: 4, assists: 2, hits: null, total_bases: null, runs: null, rbis: null, strikeouts: null },
        { player_id: "player-1", game_date: "2026-07-28", points: 12, rebounds: 3, assists: 2, hits: null, total_bases: null, runs: null, rbis: null, strikeouts: null },
        { player_id: "player-1", game_date: "2026-07-25", points: 9, rebounds: 5, assists: 2, hits: null, total_bases: null, runs: null, rbis: null, strikeouts: null },
        { player_id: "player-1", game_date: "2026-07-22", points: 11, rebounds: 4, assists: 2, hits: null, total_bases: null, runs: null, rbis: null, strikeouts: null },
        { player_id: "player-1", game_date: "2026-07-18", points: 8, rebounds: 3, assists: 1, hits: null, total_bases: null, runs: null, rbis: null, strikeouts: null },
        { player_id: "player-1", game_date: "2026-07-17", points: 14, rebounds: 6, assists: 0, hits: null, total_bases: null, runs: null, rbis: null, strikeouts: null },
        { player_id: "player-1", game_date: "2026-07-15", points: 13, rebounds: 5, assists: 4, hits: null, total_bases: null, runs: null, rbis: null, strikeouts: null },
        { player_id: "player-1", game_date: "2026-07-15", points: 13, rebounds: 5, assists: 4, hits: null, total_bases: null, runs: null, rbis: null, strikeouts: null },
        { player_id: "player-1", game_date: "2026-07-12", points: 10, rebounds: 2, assists: 3, hits: null, total_bases: null, runs: null, rbis: null, strikeouts: null },
        { player_id: "player-1", game_date: "2026-07-12", points: 10, rebounds: 2, assists: 3, hits: null, total_bases: null, runs: null, rbis: null, strikeouts: null },
      ],
      ...sharedFixtureTables(),
    });

    const result = await getParlayOptions({ limit: 25, includeVariantBooks: true });
    const withEvidence = result.rows.find((row) => row.current_prop_id === "prop-1");
    const sparseEvidence = result.rows.find((row) => row.current_prop_id === "prop-2");

    assert.equal(withEvidence?.evidence?.projection, 1.9);
    assert.equal(withEvidence?.evidence?.edgeValue, 0.6);
    assert.equal(withEvidence?.evidence?.last5Avg, 1.8);
    assert.equal(withEvidence?.evidence?.last10Avg, 2.3);
    assert.equal(withEvidence?.evidence?.matchupNote, "Opponent allows fewer assists than average.");
    assert.equal(withEvidence?.evidence?.dataRefreshedAt, futureIso);
    // Direction "Less" 2.5: clears when assists <= 2.5. Last 5 distinct games: [2,2,2,2,1] -> 5/5.
    assert.equal(withEvidence?.evidence?.last5HitCount, 5);
    assert.equal(withEvidence?.evidence?.last5SampleSize, 5);
    // Last 10 distinct games (duplicates on 07-15 and 07-12 collapsed to one each -> 8 distinct
    // games): [2,2,2,2,1,0,4,3] -> clears (<=2.5): 2,2,2,2,1,0 = 6 of 8, never 6 of 10.
    assert.equal(withEvidence?.evidence?.last10HitCount, 6);
    assert.equal(withEvidence?.evidence?.last10SampleSize, 8);

    // prop-2's stored feature_payload only has projection/last_5_avg -- every other numeric
    // field, the matchup/injury notes (no factors row exists for scored-2), and the hit counts
    // (player-2 has zero stored player_game_logs rows) must stay null, never fabricated.
    assert.equal(sparseEvidence?.evidence?.projection, 2.0);
    assert.equal(sparseEvidence?.evidence?.last5Avg, 1.8);
    assert.equal(sparseEvidence?.evidence?.edgeValue, null);
    assert.equal(sparseEvidence?.evidence?.last10Avg, null);
    assert.equal(sparseEvidence?.evidence?.minutesTrend, null);
    assert.equal(sparseEvidence?.evidence?.usageTrend, null);
    assert.equal(sparseEvidence?.evidence?.matchupNote, null);
    assert.equal(sparseEvidence?.evidence?.injuryNote, null);
    assert.equal(sparseEvidence?.evidence?.last5HitCount, null);
    assert.equal(sparseEvidence?.evidence?.last5SampleSize, null);
  });
});

// Session 99 (owner-directed score-eligibility-contract fix), Section 10:
// getModelPerformance is INTENTIONALLY exempt from filterRowsWithCurrentScoreContract.
//
// Rationale: every other read-service function (getCoveredPicksOfTheDay,
// getParlayOptions, getBoardOpportunities, getCoveredPickDetails) answers "is
// this a live, currently-actionable recommendation?" -- exactly the question
// the eligibility contract protects, because a stale-rules score could
// otherwise be mistaken for one the user can act on today. getModelPerformance
// answers a different question entirely: "how did our past, ALREADY-MADE
// recommendations actually grade?" It joins from grading_results (an
// immutable historical record keyed to the exact scored_props row that
// produced that past recommendation, not "the latest score for this prop"),
// and is already gated on graded_at existing (see
// collectPublicSnapshotPublicationSummaries's model-performance route, which
// filters to `Boolean(row.graded_at)`).
//
// Applying the current strict-v1 filter retroactively here would not recover
// anything the way Section 7's natural-rescore path does -- the underlying
// game is over, so there is no future rescore that could ever "fix" an old
// grading_results row's linked score. It would instead permanently erase real
// historical accuracy data every time the blocker rule set is tightened,
// which misrepresents the model's genuine track record rather than
// protecting a live user decision. This is the smallest-scope, most accurate
// treatment: leave model-performance ungated on contract version, exactly as
// today.
test("Section 10: getModelPerformance intentionally reports a historical graded outcome even when its linked score predates (or mismatches) the current eligibility contract -- this is documented, correct behavior, not an oversight", async () => {
  await withE2eEnv(async () => {
    withFixture({
      grading_results: [{
        id: "grading-1", scored_prop_id: "scored-legacy", current_prop_id: "prop-legacy",
        market_type: "player_points", result: "win", grade_status: "graded",
        league_id: "wnba", sport_id: "basketball", graded_at: "2026-07-15T00:00:00.000Z",
      }],
      // The exact real-production old-contract shape: no score_input_id
      // linkage at all. Section 10's point is that this must NOT exclude the
      // row from model-performance the way it would from every live surface.
      scored_props: [{
        id: "scored-legacy", current_prop_id: "prop-legacy", score_input_id: null,
        sport_id: "basketball", league_id: "wnba", covered_score: 74, confidence_score: 70,
        recommendation: "Strong", risk_flags: [],
      }],
    });

    const performance = await getModelPerformance({});
    assert.equal(performance.count, 1, "a historical graded outcome must still be counted, regardless of its linked score's contract version");
    assert.equal(performance.rows[0]?.scored_prop_id, "scored-legacy");
    assert.equal(performance.rows[0]?.covered_score, 74, "the historical score value itself must still be reported, not nulled out by contract filtering");
    assert.equal(performance.rows[0]?.result, "win");
  });
});
