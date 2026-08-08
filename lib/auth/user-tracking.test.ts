import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { listUserParlays, listUserPicks } from "./user-tracking.ts";
import { createSupabaseFixture } from "@/lib/knowledge/supabase-fixture-harness";
import { STRICT_ELIGIBILITY_CONTRACT_VERSION } from "@/lib/knowledge/eligibility-contract";

/**
 * Follow-up to Session 99/100's score-eligibility-contract fix: `listUserPicks`
 * (used by the authenticated `/api/me/picks` route) re-hydrates covered_score/
 * confidence_score/score_label/etc. LIVE from the latest scored_props row on
 * every read -- `user_picks` itself stores no covered_score column at all (see
 * saveUserPick, which never writes one). That makes this an authenticated
 * current-recommendation surface, not a historical one, and it was found
 * during Session 100's bypass audit to have no score-eligibility-contract
 * check at all -- the exact same category of gap as the public routes fixed
 * in Session 99, just gated behind login instead of anonymous.
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

function baseUserPick(overrides: Record<string, unknown> = {}) {
  return {
    id: "pick-1",
    user_id: "user-1",
    scored_prop_id: null,
    current_prop_id: "prop-1",
    odds_snapshot_id: null,
    event_id: null,
    participant_id: null,
    market_instance_key: null,
    market_type: "player_points",
    side: "over",
    line: 15.5,
    odds_taken: -110,
    sportsbook_id: null,
    stake_units: 1,
    notes: null,
    status: "open",
    result: "pending",
    profit_units: null,
    placed_at: "2026-07-20T00:00:00.000Z",
    settled_at: null,
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

function baseCurrentProp(overrides: Record<string, unknown> = {}) {
  return {
    id: "prop-1",
    latest_snapshot_id: "snapshot-1",
    event_id: null,
    participant_id: null,
    participant_type: null,
    player_id: null,
    team_id: null,
    opponent_team_id: null,
    market_instance_key: null,
    market_type: "player_points",
    side: "over",
    line: 15.5,
    sportsbook_id: null,
    over_price: -110,
    under_price: -110,
    league_id: "wnba",
    sport_id: "basketball",
    ...overrides,
  };
}

test("listUserPicks: an old-contract (score_input_id: null) latest score is hidden -- covered_score/labels fall back to null instead of silently displaying a stale-rules score", async () => {
  await withE2eEnv(async () => {
    createSupabaseFixture({
      user_picks: [baseUserPick()],
      current_props: [baseCurrentProp()],
      scored_props: [{
        id: "scored-1", current_prop_id: "prop-1", score_input_id: null,
        covered_score: 91, confidence_score: 88, data_quality_score: 90, created_at: "2026-07-20T01:00:00.000Z",
      }],
      score_explanations: [{ scored_prop_id: "scored-1", score_label: "Elite", confidence_label: "High Confidence", risk_label: "Low Risk" }],
    });

    const [pick] = await listUserPicks("user-1");
    assert.ok(pick, "expected the saved pick to still be listed");
    assert.equal(pick!.covered_score, null, "an old-contract score must not be displayed as if it were current");
    assert.equal(pick!.confidence_score, null);
    assert.equal(pick!.score_label, null);
  });
});

test("listUserPicks: a score row explicitly stamped with an older/weaker contract version is also hidden", async () => {
  await withE2eEnv(async () => {
    createSupabaseFixture({
      user_picks: [baseUserPick({ id: "pick-2", current_prop_id: "prop-2" })],
      current_props: [baseCurrentProp({ id: "prop-2" })],
      scored_props: [{
        id: "scored-2", current_prop_id: "prop-2", score_input_id: "input-2",
        covered_score: 77, confidence_score: 70, data_quality_score: 80, created_at: "2026-07-20T01:00:00.000Z",
      }],
      score_inputs: [{ id: "input-2", feature_payload: { scoreEligibilityContractVersion: "legacy-v0-live-pin" } }],
    });

    const [pick] = await listUserPicks("user-1");
    assert.equal(pick!.covered_score, null, "a weaker/older contract version must be hidden identically to a missing one");
  });
});

test("listUserPicks: a genuinely current strict-v1 score is displayed normally", async () => {
  await withE2eEnv(async () => {
    createSupabaseFixture({
      user_picks: [baseUserPick({ id: "pick-3", current_prop_id: "prop-3" })],
      current_props: [baseCurrentProp({ id: "prop-3" })],
      scored_props: [{
        id: "scored-3", current_prop_id: "prop-3", score_input_id: "input-3",
        covered_score: 82, confidence_score: 79, data_quality_score: 85,
        prop_state: "publishable", publishable: true, created_at: "2026-07-20T01:00:00.000Z",
      }],
      score_inputs: [{ id: "input-3", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } }],
      score_explanations: [{ scored_prop_id: "scored-3", score_label: "Strong", confidence_label: "High Confidence", risk_label: "Low Risk" }],
    });

    const [pick] = await listUserPicks("user-1");
    assert.equal(pick!.covered_score, 82, "a genuinely current strict-v1 score must still display normally");
    assert.equal(pick!.confidence_score, 79);
    assert.equal(pick!.score_label, "Strong");
  });
});

test("listUserPicks: a current strict-v1 score that is now blocked is hidden with every score-derived field", async () => {
  await withE2eEnv(async () => {
    createSupabaseFixture({
      user_picks: [baseUserPick({ id: "pick-blocked", current_prop_id: "prop-blocked" })],
      current_props: [baseCurrentProp({ id: "prop-blocked" })],
      scored_props: [{
        id: "scored-blocked", current_prop_id: "prop-blocked", score_input_id: "input-blocked",
        covered_score: 84, confidence_score: 79, data_quality_score: 85,
        prop_state: "candidate", publishable: false, created_at: "2026-07-20T01:00:00.000Z",
      }],
      score_inputs: [{ id: "input-blocked", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } }],
      score_explanations: [{ scored_prop_id: "scored-blocked", score_label: "Strong", confidence_label: "High Confidence", risk_label: "Low Risk", summary: "Must not be exposed" }],
    });

    const [pick] = await listUserPicks("user-1");
    assert.ok(pick);
    assert.equal(pick!.covered_score, null);
    assert.equal(pick!.confidence_score, null);
    assert.equal(pick!.data_quality_score, null);
    assert.equal(pick!.score_label, null);
    assert.equal(pick!.confidence_label, null);
    assert.equal(pick!.risk_label, null);
    assert.equal(pick!.summary, null);
  });
});

test("listUserParlays: blocked strict-v1 legs are hydrated without recommendation fields", async () => {
  await withE2eEnv(async () => {
    createSupabaseFixture({
      user_parlays: [{ id: "parlay-1", user_id: "user-1", status: "open", total_legs: 1, stake_units: 1, notes: null, combined_odds: 100, result: "pending", profit_units: null, created_at: "2026-07-20T00:00:00.000Z", settled_at: null, updated_at: "2026-07-20T00:00:00.000Z" }],
      user_parlay_legs: [{ id: "leg-1", user_parlay_id: "parlay-1", user_pick_id: null, scored_prop_id: "scored-blocked", current_prop_id: "prop-blocked", odds_snapshot_id: null, event_id: null, participant_id: null, market_instance_key: null, market_type: "player_points", side: "over", line: 15.5, odds_taken: -110, sportsbook_id: null, leg_result: null, created_at: "2026-07-20T00:00:00.000Z" }],
      current_props: [baseCurrentProp({ id: "prop-blocked" })],
      scored_props: [{ id: "scored-blocked", current_prop_id: "prop-blocked", score_input_id: "input-blocked", covered_score: 84, confidence_score: 79, data_quality_score: 85, prop_state: "candidate", publishable: false, created_at: "2026-07-20T01:00:00.000Z" }],
      score_inputs: [{ id: "input-blocked", feature_payload: { scoreEligibilityContractVersion: STRICT_ELIGIBILITY_CONTRACT_VERSION } }],
      score_explanations: [{ scored_prop_id: "scored-blocked", score_label: "Strong", confidence_label: "High Confidence", risk_label: "Low Risk", summary: "Must not be exposed" }],
    });

    const [parlay] = await listUserParlays("user-1");
    const [leg] = parlay!.legs;
    assert.equal(leg!.covered_score, null);
    assert.equal(leg!.score_label, null);
    assert.equal(leg!.confidence_label, null);
    assert.equal(leg!.risk_label, null);
    assert.equal(leg!.summary, null);
  });
});
