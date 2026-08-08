import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { getBoardOpportunities, getCoveredPicksOfTheDay, getCoveredPickDetails, getParlayOptions } from "./read-service.ts";
import { collectPublicSnapshotPublicationSummaries } from "./public-snapshots.ts";
import { createSupabaseFixture, type FixtureRow } from "./supabase-fixture-harness.ts";
import { STRICT_ELIGIBILITY_CONTRACT_VERSION } from "./eligibility-contract.ts";

/**
 * Session 99 (owner-directed): reproduces, then proves fixed, the real production
 * defect Session 98's snapshot-envelope guard alone did not catch.
 *
 * Controlling invariant: NO PUBLIC SCORE MAY BE EXPOSED UNLESS THE SCORE ROW
 * ITSELF WAS PRODUCED OR AUTHORITATIVELY REVALIDATED UNDER THE CURRENT
 * ELIGIBILITY CONTRACT. A freshly-built, correctly-stamped `strict-v1`
 * snapshot ENVELOPE is not sufficient on its own -- it says nothing about
 * whether the individual SCORE ROWS copied into it were ever evaluated under
 * strict-v1's blocker set.
 *
 * Real production example this suite is modeled on (2026-08-01, candidate
 * run 30718468891): Payton Tolle, MLB pitcher_strikeouts, line 5.5 More,
 * `covered_score: 61`, stored `publishable: true` with empty
 * `publishability_reasons`, scored under the live pin's 9-blocker rule set
 * (missing `pitcher_matchup_missing`/`ballpark_missing`, which do not exist
 * in that rule set at all), surfaced live via the Manual Analyzer inside a
 * snapshot whose OWN envelope was correctly stamped `eligibilityContractVersion:
 * "strict-v1"`.
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

function mlbProp(id: string, futureStart: string): FixtureRow {
  return {
    id, latest_snapshot_id: `snapshot-${id}`, sport_id: "baseball", league_id: "mlb", sportsbook_id: "sportsbook-1",
    market_id: "market-1", market_instance_key: null, participant_id: `participant-${id}`, participant_type: "pitcher",
    player_id: `player-${id}`, team_id: "team-1", opponent_id: `participant-opp-${id}`, opponent_team_id: "team-2",
    event_id: "event-1", market_type: "pitcher_strikeouts", player_name: `Pitcher ${id}`, team_name: "Boston Red Sox",
    opponent_name: "Los Angeles Dodgers", line: 5.5, direction: "More", side: "over", over_price: 122, under_price: -156,
    match_confidence: 0.78, match_status: "matched", match_quality_flags: [], start_time: futureStart, updated_at: futureStart, active: true,
  };
}

function wnbaProp(id: string, futureStart: string): FixtureRow {
  return {
    id, latest_snapshot_id: `snapshot-${id}`, sport_id: "basketball", league_id: "wnba", sportsbook_id: "sportsbook-1",
    market_id: "market-2", market_instance_key: null, participant_id: `participant-${id}`, participant_type: "player",
    player_id: `player-${id}`, team_id: "team-1", opponent_id: `participant-opp-${id}`, opponent_team_id: "team-2",
    event_id: "event-1", market_type: "player_points", player_name: `Player ${id}`, team_name: "Washington Mystics",
    opponent_name: "Atlanta Dream", line: 15.5, direction: "More", side: "over", over_price: -110, under_price: -110,
    match_confidence: 0.9, match_status: "matched", match_quality_flags: [], start_time: futureStart, updated_at: futureStart, active: true,
  };
}

function sharedFixtureTables() {
  return {
    events: [{ id: "event-1", display_name: "Boston Red Sox at Los Angeles Dodgers", scheduled_date: null, start_time: null, status: "scheduled", home_team_id: "team-2", away_team_id: "team-1" }],
    teams: [
      { id: "team-1", name: "Boston Red Sox", abbreviation: "BOS", logo_url: null, external_ids: {} },
      { id: "team-2", name: "Los Angeles Dodgers", abbreviation: "LAD", logo_url: null, external_ids: {} },
    ],
    markets: [
      { id: "market-1", market_type: "pitcher_strikeouts", display_name: "Pitcher Strikeouts" },
      { id: "market-2", market_type: "player_points", display_name: "Points" },
    ],
    sportsbooks: [{ id: "sportsbook-1", code: "fanduel", display_name: "FanDuel" }],
  };
}

// Old-contract (pre-strict-v1) scored_props row, shaped exactly like the real
// production Payton Tolle row: publishable=true, empty reasons, no
// score_input_id linkage at all (the shape a row written before Phase 16's
// score_inputs linkage even existed would have -- the most common real form
// of "old" in this codebase's actual history).
function oldContractScoredRow(id: string, propId: string, score: number, updatedAt: string, overrides: Record<string, unknown> = {}) {
  return {
    id, current_prop_id: propId, score_input_id: null, sport_id: overrides.sport_id ?? "baseball", league_id: overrides.league_id ?? "mlb",
    covered_score: score, confidence_score: 65, data_quality_score: 70, recommendation: "Playable",
    risk_flags: [], prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: updatedAt,
    ...overrides,
  };
}

function currentContractScoreInput(id: string) {
  return { id, feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } };
}

const futureStart = () => new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

async function assertExcludedEverywhere(propId: string, scoredPropId: string, league: "mlb" | "wnba") {
  const picks = await getCoveredPicksOfTheDay({ league, includeVariantBooks: true });
  assert.ok(!picks.rows.some((r) => r.current_prop_id === propId), `${propId} must never reach Covered Picks`);

  const parlay = await getParlayOptions({ league, includeVariantBooks: true });
  assert.ok(!parlay.rows.some((r) => r.current_prop_id === propId), `${propId} must never reach the Manual Analyzer`);

  const board = await getBoardOpportunities({ league });
  assert.ok(!board.some((r) => r.id === scoredPropId), `${scoredPropId} must never reach the board`);

  const details = await getCoveredPickDetails(scoredPropId);
  assert.equal(details, null, `${scoredPropId} must not be directly fetchable by id either`);
}

// --- Section 2: the 8 required reproduction scenarios ---------------------

test("score-contract defect reproduction #1 (real production shape): a Payton-Tolle-like MLB pitcher prop, old-contract, missing pitcher-matchup context, is excluded from every public surface", async () => {
  await withE2eEnv(async () => {
    const start = futureStart();
    createSupabaseFixture({
      current_props: [mlbProp("prop-tolle", start)],
      participants: [
        { id: "participant-prop-tolle", display_name: "Payton Tolle", participant_type: "pitcher", player_id: "player-prop-tolle", team_id: "team-1", image_url: null, external_ids: {} },
      ],
      players: [{ id: "player-prop-tolle", display_name: "Payton Tolle", canonical_name: "Payton Tolle", headshot_url: null, external_ids: {} }],
      // Real shape: risk_flags DOES record the missing context (as the live row's
      // own commentary disclosed), yet publishable/reasons were never updated to
      // reflect a strict blocker that did not exist in the rules this row was
      // scored under -- proving the defect is specifically about the CONTRACT
      // VERSION, not about risk_flags being silently dropped.
      scored_props: [oldContractScoredRow("scored-tolle", "prop-tolle", 61, start, { risk_flags: ["pitcher_matchup_missing", "ballpark_missing"] })],
      ...sharedFixtureTables(),
    });
    await assertExcludedEverywhere("prop-tolle", "scored-tolle", "mlb");
  });
});

test("score-contract defect reproduction #2: an old-contract MLB prop missing ballpark context is excluded from every public surface", async () => {
  await withE2eEnv(async () => {
    const start = futureStart();
    createSupabaseFixture({
      current_props: [mlbProp("prop-ballpark", start)],
      participants: [{ id: "participant-prop-ballpark", display_name: "Pitcher B", participant_type: "pitcher", player_id: "player-prop-ballpark", team_id: "team-1", image_url: null, external_ids: {} }],
      players: [{ id: "player-prop-ballpark", display_name: "Pitcher B", canonical_name: "Pitcher B", headshot_url: null, external_ids: {} }],
      scored_props: [oldContractScoredRow("scored-ballpark", "prop-ballpark", 72, start, { risk_flags: ["ballpark_missing"] })],
      ...sharedFixtureTables(),
    });
    await assertExcludedEverywhere("prop-ballpark", "scored-ballpark", "mlb");
  });
});

test("score-contract defect reproduction #3: an old-contract MLB prop missing handedness context is excluded from every public surface", async () => {
  await withE2eEnv(async () => {
    const start = futureStart();
    createSupabaseFixture({
      current_props: [mlbProp("prop-handedness", start)],
      participants: [{ id: "participant-prop-handedness", display_name: "Pitcher C", participant_type: "pitcher", player_id: "player-prop-handedness", team_id: "team-1", image_url: null, external_ids: {} }],
      players: [{ id: "player-prop-handedness", display_name: "Pitcher C", canonical_name: "Pitcher C", headshot_url: null, external_ids: {} }],
      scored_props: [oldContractScoredRow("scored-handedness", "prop-handedness", 80, start, { risk_flags: ["handedness_missing"] })],
      ...sharedFixtureTables(),
    });
    await assertExcludedEverywhere("prop-handedness", "scored-handedness", "mlb");
  });
});

test("score-contract defect reproduction #4: an old-contract WNBA prop with no injury-check marker is excluded from every public surface", async () => {
  await withE2eEnv(async () => {
    const start = futureStart();
    createSupabaseFixture({
      current_props: [wnbaProp("prop-injury", start)],
      participants: [{ id: "participant-prop-injury", display_name: "Player Injury", participant_type: "player", player_id: "player-prop-injury", team_id: "team-1", image_url: null, external_ids: {} }],
      players: [{ id: "player-prop-injury", display_name: "Player Injury", canonical_name: "Player Injury", headshot_url: null, external_ids: {} }],
      scored_props: [oldContractScoredRow("scored-injury", "prop-injury", 75, start, { sport_id: "basketball", league_id: "wnba", risk_flags: ["injury_context_unavailable"] })],
      ...sharedFixtureTables(),
    });
    await assertExcludedEverywhere("prop-injury", "scored-injury", "wnba");
  });
});

test("score-contract defect reproduction #5: an old-contract WNBA prop with stale minutes is excluded from every public surface", async () => {
  await withE2eEnv(async () => {
    const start = futureStart();
    createSupabaseFixture({
      current_props: [wnbaProp("prop-minutes", start)],
      participants: [{ id: "participant-prop-minutes", display_name: "Player Minutes", participant_type: "player", player_id: "player-prop-minutes", team_id: "team-1", image_url: null, external_ids: {} }],
      players: [{ id: "player-prop-minutes", display_name: "Player Minutes", canonical_name: "Player Minutes", headshot_url: null, external_ids: {} }],
      scored_props: [oldContractScoredRow("scored-minutes", "prop-minutes", 70, start, { sport_id: "basketball", league_id: "wnba", risk_flags: ["minutes_stale"] })],
      ...sharedFixtureTables(),
    });
    await assertExcludedEverywhere("prop-minutes", "scored-minutes", "wnba");
  });
});

test("score-contract defect reproduction #6: an old score row with NO contract metadata at all (score_input_id present but its score_inputs row predates this field) is excluded", async () => {
  await withE2eEnv(async () => {
    const start = futureStart();
    createSupabaseFixture({
      current_props: [mlbProp("prop-no-metadata", start)],
      participants: [{ id: "participant-prop-no-metadata", display_name: "Pitcher D", participant_type: "pitcher", player_id: "player-prop-no-metadata", team_id: "team-1", image_url: null, external_ids: {} }],
      players: [{ id: "player-prop-no-metadata", display_name: "Pitcher D", canonical_name: "Pitcher D", headshot_url: null, external_ids: {} }],
      scored_props: [{ ...oldContractScoredRow("scored-no-metadata", "prop-no-metadata", 74, start), score_input_id: "input-no-metadata" }],
      // Real score_inputs row exists (Phase 16 linkage present), but its
      // feature_payload predates this session's field entirely -- no
      // scoreEligibilityContractVersion key at all, not merely a falsy value.
      score_inputs: [{ id: "input-no-metadata", feature_payload: { completenessState: "complete" } }],
      ...sharedFixtureTables(),
    });
    await assertExcludedEverywhere("prop-no-metadata", "scored-no-metadata", "mlb");
  });
});

test("score-contract defect reproduction #7: an old score row explicitly claiming an UNKNOWN/weaker contract version is excluded", async () => {
  await withE2eEnv(async () => {
    const start = futureStart();
    createSupabaseFixture({
      current_props: [mlbProp("prop-unknown-contract", start)],
      participants: [{ id: "participant-prop-unknown-contract", display_name: "Pitcher E", participant_type: "pitcher", player_id: "player-prop-unknown-contract", team_id: "team-1", image_url: null, external_ids: {} }],
      players: [{ id: "player-prop-unknown-contract", display_name: "Pitcher E", canonical_name: "Pitcher E", headshot_url: null, external_ids: {} }],
      scored_props: [{ ...oldContractScoredRow("scored-unknown-contract", "prop-unknown-contract", 77, start), score_input_id: "input-unknown-contract" }],
      score_inputs: [{ id: "input-unknown-contract", feature_payload: { scoreEligibilityContractVersion: "legacy-v0-live-pin" } }],
      ...sharedFixtureTables(),
    });
    await assertExcludedEverywhere("prop-unknown-contract", "scored-unknown-contract", "mlb");
  });
});

test("score-contract defect reproduction #8 (positive control): a CURRENT strict-v1 score row, otherwise complete, IS eligible on every public surface", async () => {
  await withE2eEnv(async () => {
    const start = futureStart();
    createSupabaseFixture({
      current_props: [mlbProp("prop-current", start)],
      participants: [{ id: "participant-prop-current", display_name: "Pitcher F", participant_type: "pitcher", player_id: "player-prop-current", team_id: "team-1", image_url: null, external_ids: {} }],
      players: [{ id: "player-prop-current", display_name: "Pitcher F", canonical_name: "Pitcher F", headshot_url: null, external_ids: {} }],
      scored_props: [{
        id: "scored-current", current_prop_id: "prop-current", score_input_id: "input-current", sport_id: "baseball", league_id: "mlb",
        covered_score: 82, confidence_score: 80, data_quality_score: 85, recommendation: "Elite", risk_flags: [],
        prop_state: "publishable", publishable: true, publishability_reasons: [], updated_at: start,
      }],
      score_inputs: [currentContractScoreInput("input-current")],
      ...sharedFixtureTables(),
    });

    const picks = await getCoveredPicksOfTheDay({ league: "mlb", includeVariantBooks: true });
    assert.ok(picks.rows.some((r) => r.current_prop_id === "prop-current"), "a genuinely current, complete score must still reach Covered Picks");

    const parlay = await getParlayOptions({ league: "mlb", includeVariantBooks: true });
    assert.ok(parlay.rows.some((r) => r.current_prop_id === "prop-current"), "a genuinely current, complete score must still reach the Manual Analyzer");

    const board = await getBoardOpportunities({ league: "mlb" });
    assert.ok(board.some((r) => r.id === "scored-current"), "a genuinely current, complete score must still reach the board");

    const details = await getCoveredPickDetails("scored-current");
    assert.ok(details, "a genuinely current, complete score must still be directly fetchable by id");
    assert.equal(details!.covered_score, 82);
  });
});

test("WNBA strict read contract: every supported completeness blocker removes score-derived output from relational, detail, and snapshot reads", async () => {
  const blockers = [
    "low_match_confidence",
    "unmatched_player",
    "unmatched_event",
    "missing_team",
    "missing_opponent",
    "team_equals_opponent",
    "event_not_scheduled",
    "missing_recent_logs",
    "missing_team_context",
    "missing_matchup_context",
    "stale_features",
    "stale_market",
    "minutes_missing",
    "minutes_stale",
    "injury_context_unavailable",
  ];

  for (const blocker of blockers) {
    await withE2eEnv(async () => {
      const start = futureStart();
      const propId = `prop-${blocker}`;
      const scoredId = `scored-${blocker}`;
      const scoreInputId = `input-${blocker}`;
      createSupabaseFixture({
        current_props: [wnbaProp(propId, start)],
        participants: [{ id: `participant-${propId}`, display_name: "Angel Reese", participant_type: "player", player_id: `player-${propId}`, team_id: "team-1", image_url: null, external_ids: {} }],
        players: [{ id: `player-${propId}`, display_name: "Angel Reese", canonical_name: "Angel Reese", headshot_url: null, external_ids: {} }],
        scored_props: [{
          id: scoredId, current_prop_id: propId, score_input_id: scoreInputId,
          sport_id: "basketball", league_id: "wnba", covered_score: 84, confidence_score: 79, data_quality_score: 85,
          recommendation: "Strong", risk_flags: [blocker], prop_state: "candidate", publishable: false,
          publishability_reasons: [blocker], updated_at: start,
        }],
        score_inputs: [currentContractScoreInput(scoreInputId)],
        ...sharedFixtureTables(),
      });

      await assertExcludedEverywhere(propId, scoredId, "wnba");
      const snapshots = await collectPublicSnapshotPublicationSummaries({ publish: false });
      assert.equal(snapshots["covered-picks"].rowCount, 0, `${blocker}: must not enter a Covered Picks snapshot`);
      assert.equal(snapshots["parlay-options"].rowCount, 0, `${blocker}: must not enter a Manual Analyzer snapshot`);
    });
  }
});
