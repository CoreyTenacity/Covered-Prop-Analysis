import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { getBoardOpportunities, getCoveredPicksOfTheDay, getParlayOptions } from "./read-service.ts";
import { createSupabaseFixture, type FixtureRow } from "./supabase-fixture-harness.ts";
import { preparedSlateEventWindow } from "./prepared-slate-window.ts";

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

test("getParlayOptions derives team/opponent display from participant + event context when stored team ids are missing, and stays honest when no deterministic team exists", async () => {
  await withE2eEnv(async () => {
    const futureIso = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

    createSupabaseFixture({
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
        { id: "scored-derived", current_prop_id: "prop-derived", covered_score: 74, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishability_reasons: [], updated_at: futureIso },
        { id: "scored-unresolved", current_prop_id: "prop-unresolved", covered_score: 71, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishability_reasons: [], updated_at: futureIso },
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

    createSupabaseFixture({
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
        { id: "scored-1", current_prop_id: "prop-1", sport_id: "basketball", league_id: "wnba", covered_score: 75, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: todayIso },
        { id: "scored-2", current_prop_id: "prop-2", sport_id: "basketball", league_id: "wnba", covered_score: 76, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: tomorrowLateNightIso },
        { id: "scored-3", current_prop_id: "prop-3", sport_id: "basketball", league_id: "wnba", covered_score: 90, confidence_score: 70, data_quality_score: 80, recommendation: "Elite", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: staleUpdatedAt },
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

    for (let i = 0; i < mlbCount; i += 1) {
      currentProps.push({ ...buildProp(i, futureStart), league_id: "mlb", sport_id: "baseball", market_type: "pitcher_strikeouts" });
      participants.push({ id: `participant-${i}`, display_name: `MLB Player ${i}`, participant_type: "player", player_id: `player-${i}`, team_id: "team-1", image_url: null, external_ids: {} });
      players.push({ id: `player-${i}`, display_name: `MLB Player ${i}`, canonical_name: `MLB Player ${i}`, headshot_url: null, external_ids: {} });
      scoredProps.push({ id: `scored-mlb-${i}`, current_prop_id: `prop-${i}`, sport_id: "baseball", league_id: "mlb", covered_score: 75, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: mlbUpdatedAt });
    }

    const wnbaIndex = 9000;
    currentProps.push({ ...buildProp(wnbaIndex, futureStart), league_id: "wnba" });
    participants.push({ id: `participant-${wnbaIndex}`, display_name: "WNBA Player", participant_type: "player", player_id: `player-${wnbaIndex}`, team_id: "team-1", image_url: null, external_ids: {} });
    players.push({ id: `player-${wnbaIndex}`, display_name: "WNBA Player", canonical_name: "WNBA Player", headshot_url: null, external_ids: {} });
    // Deliberately the highest score of any row in the fixture: if the WNBA row is
    // scanned at all it must rank #1 and appear in even a small top-N slice --
    // isolating "was it scanned" from "did it rank highly enough afterward".
    scoredProps.push({ id: "scored-wnba-1", current_prop_id: `prop-${wnbaIndex}`, sport_id: "basketball", league_id: "wnba", covered_score: 90, confidence_score: 70, data_quality_score: 80, recommendation: "Elite", risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: wnbaUpdatedAt });

    createSupabaseFixture({
      current_props: currentProps,
      participants,
      players,
      scored_props: scoredProps,
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

    createSupabaseFixture({
      current_props: [
        buildProp(1, todayIso),
        buildProp(2, tomorrowLateNightIso),
        buildProp(3, dayAfterTomorrowIso),
      ],
      participants: [1, 2, 3].map((i) => ({ id: `participant-${i}`, display_name: `Player ${i}`, participant_type: "player", player_id: `player-${i}`, team_id: "team-1", image_url: null, external_ids: {} })),
      players: [1, 2, 3].map((i) => ({ id: `player-${i}`, display_name: `Player ${i}`, canonical_name: `Player ${i}`, headshot_url: null, external_ids: {} })),
      scored_props: [
        { id: "scored-1", current_prop_id: "prop-1", covered_score: 75, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishability_reasons: [], updated_at: todayIso },
        { id: "scored-2", current_prop_id: "prop-2", covered_score: 76, confidence_score: 70, data_quality_score: 80, recommendation: "Playable", risk_flags: [], prop_state: "publishable", publishability_reasons: [], updated_at: tomorrowLateNightIso },
        { id: "scored-3", current_prop_id: "prop-3", covered_score: 90, confidence_score: 70, data_quality_score: 80, recommendation: "Elite", risk_flags: [], prop_state: "publishable", publishability_reasons: [], updated_at: dayAfterTomorrowIso },
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

    createSupabaseFixture({
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
        { id: "scored-1", current_prop_id: "prop-1", player_id: "player-1", team_id: "team-1", opponent_team_id: "team-2", event_id: "event-1", sport_id: "basketball", league_id: "wnba", covered_score: 75, projection: 20, line: 18.5, edge_score: 5, confidence_score: 70, trend_score: 0, data_quality_score: 80, recommendation: "Playable", risk_flags: [] },
        { id: "scored-2", current_prop_id: "prop-2", player_id: "player-2", team_id: "team-1", opponent_team_id: "team-2", event_id: "event-1", sport_id: "basketball", league_id: "wnba", covered_score: 76, projection: 20, line: 18.5, edge_score: 5, confidence_score: 70, trend_score: 0, data_quality_score: 80, recommendation: "Playable", risk_flags: [] },
        { id: "scored-3", current_prop_id: "prop-3", player_id: "player-3", team_id: "team-1", opponent_team_id: "team-2", event_id: "event-1", sport_id: "basketball", league_id: "wnba", covered_score: 90, projection: 20, line: 18.5, edge_score: 5, confidence_score: 70, trend_score: 0, data_quality_score: 80, recommendation: "Elite", risk_flags: [] },
      ],
    });

    const result = await getBoardOpportunities({ limit: 25 });
    const ids = result.map((row) => row.id);
    assert.ok(ids.includes("scored-1"), "today's event must be included");
    assert.ok(ids.includes("scored-2"), "tomorrow 11:59pm Eastern event must be included");
    assert.ok(!ids.includes("scored-3"), "a day-after-tomorrow event must be excluded");
  });
});
