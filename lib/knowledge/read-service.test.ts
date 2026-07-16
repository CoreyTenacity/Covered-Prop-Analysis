import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { getParlayOptions } from "./read-service.ts";
import { createSupabaseFixture, type FixtureRow } from "./supabase-fixture-harness.ts";

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

test("getParlayOptions batches scored_props lookups into bounded in.(...) requests instead of one unbounded request", async () => {
  await withE2eEnv(async () => {
    const futureIso = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const currentProps: FixtureRow[] = [];
    const participants: FixtureRow[] = [];
    const players: FixtureRow[] = [];
    const scoredProps: FixtureRow[] = [];
    for (let i = 0; i < 250; i += 1) {
      currentProps.push(buildProp(i, futureIso));
      participants.push({ id: `participant-${i}`, display_name: `Player ${i}`, participant_type: "player", player_id: `player-${i}`, team_id: "team-1", image_url: null, external_ids: {} });
      players.push({ id: `player-${i}`, display_name: `Player ${i}`, canonical_name: `Player ${i}`, headshot_url: null, external_ids: {} });
      scoredProps.push({ id: `scored-${i}`, current_prop_id: `prop-${i}`, covered_score: 50 + (i % 40), confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishability_reasons: [], updated_at: futureIso });
    }

    const { calls } = createSupabaseFixture({
      current_props: currentProps,
      participants,
      players,
      scored_props: scoredProps,
      ...sharedFixtureTables(),
    });

    const result = await getParlayOptions({ limit: 250, includeVariantBooks: true });

    const scoredPropsCalls = calls.filter((c) => c.table === "scored_props");
    assert.ok(scoredPropsCalls.length > 1, `expected the 250-id lookup to be split into multiple bounded requests, got ${scoredPropsCalls.length}`);
    assert.equal(result.rows.length, 250, "no eligible prop should be dropped by batching");
    assert.ok(result.rows.every((row) => row.latest_scored_prop_id), "every row's scored_props batch lookup must have resolved");
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
        { id: "scored-1", current_prop_id: "prop-1", covered_score: 70, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishability_reasons: [], updated_at: futureIso },
        { id: "scored-2", current_prop_id: "prop-2", covered_score: 65, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishability_reasons: [], updated_at: futureIso },
      ],
      ...sharedFixtureTables(),
    };

    // The generic fixture harness matches every filter it recognizes (eq./in./gte./lte./is.null)
    // but silently ignores an unrecognized `or=(...)` param, which would hide a regression where
    // the future-start-time filter is accidentally dropped. Wrap fetch to enforce it for real.
    createSupabaseFixture(seed);
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
    const scoredProps = futureProps.map((_, i) => ({ id: `scored-${i}`, current_prop_id: `prop-${i}`, covered_score: 40 + (i % 50), confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishability_reasons: [], updated_at: futureIso }));

    createSupabaseFixture({
      current_props: [...staleProps, ...futureProps],
      participants: [{ id: "participant-1", display_name: "Player One", participant_type: "player", player_id: "player-1", team_id: "team-1", image_url: null, external_ids: {} }],
      players: [{ id: "player-1", display_name: "Player One", canonical_name: "Player One", headshot_url: null, external_ids: {} }],
      scored_props: scoredProps,
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
