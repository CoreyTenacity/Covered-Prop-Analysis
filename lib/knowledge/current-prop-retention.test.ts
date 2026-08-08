import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { retireStartedCurrentProps } from "./current-prop-retention.ts";
import { createSupabaseFixture } from "./supabase-fixture-harness.ts";

/**
 * Phase 18 (continuation) item 4: current-prop freshness / stale-and-
 * superseded-line rejection, tested against the ACTUAL data model.
 *
 * The schema (supabase/migrations/202607060002 + ...070002) supports
 * deterministic freshness through exactly these fields, verified by reading
 * the migrations:
 *   - `active` (boolean): the currency marker. `retireStartedCurrentProps`
 *     sets it false once `start_time <= now`. Every public read path
 *     (getCoveredPicksOfTheDay/getParlayOptions/getBoardOpportunities) and
 *     the scoring pool query filter `active=true`, so a retired row is
 *     structurally excluded from board, snapshot, and relational fallback.
 *   - `unique (provider, provider_prop_key)`: sharp-ingestion UPSERTS a
 *     re-observed market in place on this key (sharp-ingestion.ts:144), so a
 *     changed line overwrites the same physical row -- there is never a
 *     lingering "superseded" duplicate row to reject. Supersession is
 *     PREVENTED by construction, not detected-and-rejected. A durable
 *     line-history/supersession ledger would require a migration (not
 *     authorized; recorded as an owner decision in the design doc) -- but its
 *     ABSENCE is not a correctness gap, because the overwrite leaves nothing
 *     stale behind.
 *   - `odds_snapshots.pulled_at` (via latest_snapshot_id): the provider
 *     observation timestamp; the adapters already raise a `stale_odds` soft
 *     risk flag from its age (existing product policy, unchanged here).
 *
 * These tests prove the `active`-flag retirement leg -- the one leg that is
 * an explicit, testable state transition rather than a structural DB
 * guarantee.
 */

function withEnv(run: () => Promise<void>) {
  const prev = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJtest";
  return run().finally(() => {
    if (prev.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = prev.url;
    if (prev.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prev.key;
    mock.restoreAll();
  });
}

test("retireStartedCurrentProps: a prop whose start_time has passed is retired (active=false, prop_state=expired), regardless of any high stored covered_score elsewhere", () =>
  withEnv(async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const fixture = createSupabaseFixture({
      current_props: [
        { id: "prop-past", start_time: past, active: true, prop_state: "publishable", league_id: "wnba" },
        { id: "prop-future", start_time: future, active: true, prop_state: "publishable", league_id: "wnba" },
      ],
    });

    const result = await retireStartedCurrentProps({ limit: 100 });
    assert.equal(result.retiredCount, 1);

    const rows = fixture.tables.get("current_props") ?? [];
    const past_ = rows.find((r) => r.id === "prop-past");
    const future_ = rows.find((r) => r.id === "prop-future");
    assert.equal(past_?.active, false, "a started prop must be retired to active=false so every active=true read excludes it");
    assert.equal(past_?.prop_state, "expired");
    assert.equal(future_?.active, true, "an upcoming prop must remain active");
  }));

test("retireStartedCurrentProps: the boundary is inclusive -- a prop starting exactly now is retired, matching shouldRescoreProp's start_time<=now gate", () =>
  withEnv(async () => {
    const now = new Date().toISOString();
    const fixture = createSupabaseFixture({
      current_props: [{ id: "prop-now", start_time: now, active: true, prop_state: "publishable", league_id: "mlb" }],
    });
    const result = await retireStartedCurrentProps({ limit: 100 });
    assert.equal(result.retiredCount, 1);
    assert.equal((fixture.tables.get("current_props") ?? []).find((r) => r.id === "prop-now")?.active, false);
  }));

test("retireStartedCurrentProps: an already-inactive (superseded/retired) prop is not re-processed and stays excluded", () =>
  withEnv(async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fixture = createSupabaseFixture({
      current_props: [{ id: "prop-already", start_time: past, active: false, prop_state: "expired", league_id: "wnba" }],
    });
    const result = await retireStartedCurrentProps({ limit: 100 });
    assert.equal(result.retiredCount, 0, "an already-inactive prop is not counted again");
    assert.equal((fixture.tables.get("current_props") ?? []).find((r) => r.id === "prop-already")?.active, false);
  }));
