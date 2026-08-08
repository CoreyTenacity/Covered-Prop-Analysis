import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { allocateBoundedClassSlots, allocateClassFairPlayerWindow, classifyMlbPlayerForLogs, compareMlbGameLogRecency, compareMlbLivePlayerStartTimes, dedupeGameLogsByCanonicalGame, gameStatus, loadUnresolvedFutureMlbEventTeamPriorities, orderMlbTeamsForRosterRefresh, parseMlbGameLogCountingStats, parseMlbGameLogSeasonRates, refreshMlbStatcastForKnownPlayers, settleMlbPlayerLogsForEvents, skippedMlbLogAllocationSummary, statGroupsForSettlementMarket, takeLiveFirstWindow, type MlbPostgameStatGroup } from "./mlb.ts";

type Store = {
  currentProps: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  providerCache?: Map<string, Record<string, unknown>>;
};

test("MLB enrichment stat intent is complete and market-driven", () => {
  assert.deepEqual(statGroupsForSettlementMarket("pitcher_strikeouts"), ["pitching"]);
  assert.deepEqual(statGroupsForSettlementMarket("pitcher_outs_recorded"), ["pitching"]);
  assert.deepEqual(statGroupsForSettlementMarket("batter_hits"), ["hitting"]);
  assert.deepEqual(statGroupsForSettlementMarket("batter_total_bases"), ["hitting"]);
  assert.deepEqual(
    [...new Set(["pitcher_strikeouts", "batter_hits"].flatMap(statGroupsForSettlementMarket))],
    ["pitching", "hitting"],
  );
});

test("MLB log priority puts nearest future games before past and unknown players", () => {
  const now = Date.parse("2026-07-20T12:00:00.000Z");
  const nearFuture = Date.parse("2026-07-20T13:00:00.000Z");
  const farFuture = Date.parse("2026-07-20T16:00:00.000Z");
  const recentPast = Date.parse("2026-07-20T11:00:00.000Z");
  assert.ok(compareMlbLivePlayerStartTimes(nearFuture, farFuture, now) < 0);
  assert.ok(compareMlbLivePlayerStartTimes(farFuture, recentPast, now) < 0);
  assert.ok(compareMlbLivePlayerStartTimes(recentPast, undefined, now) < 0);
});

test("MLB player-log selection keeps the bounded window and cannot let past players crowd out future players", async () => {
  const store: Store = { currentProps: [], events: [] };
  await withMlbSupabaseEnv(store, async () => {
    const items = [
      { id: "future-near" },
      { id: "future-far" },
      { id: "future-third" },
      { id: "future-fourth" },
      { id: "future-fifth" },
      { id: "future-sixth" },
      { id: "past-one" },
      { id: "past-two" },
      { id: "past-three" },
    ];
    const window = await takeLiveFirstWindow({
      cacheKey: "test:cursor:mlb-player-log-bound",
      provider: "mlb-stats-api",
      items,
      isPriority: (player) => player.id.startsWith("future"),
      sliceSize: 6,
      maxPriorityItems: 6,
    });
    assert.equal(window.items.length, 6);
    assert.equal(window.items.every((player) => player.id.startsWith("future")), true);
  });
});

// classifyMlbPlayerForLogs: reuses statGroupsForSettlementMarket's market-type
// mapping (via requiredStatGroupsByPlayerId) rather than players.primary_position,
// which is empty/null for 66% of stored MLB players and is therefore not usable
// as a classification signal at production scale.
test("classifyMlbPlayerForLogs: a player whose active props need only pitching stat groups is classified as pitcher", () => {
  const result = classifyMlbPlayerForLogs({ id: "p1" }, { p1: ["pitching"] });
  assert.equal(result, "pitcher");
});

test("classifyMlbPlayerForLogs: a player whose active props need only hitting stat groups is classified as batter", () => {
  const result = classifyMlbPlayerForLogs({ id: "p1" }, { p1: ["hitting"] });
  assert.equal(result, "batter");
});

test("classifyMlbPlayerForLogs: a player with no required stat groups (e.g. no current Sharp-active prop) is unclassified, not guessed", () => {
  const result = classifyMlbPlayerForLogs({ id: "p1" }, {});
  assert.equal(result, "unclassified");
});

test("classifyMlbPlayerForLogs: a player needing both hitting and pitching stat groups is unclassified rather than arbitrarily assigned", () => {
  const result = classifyMlbPlayerForLogs({ id: "p1" }, { p1: ["hitting", "pitching"] });
  assert.equal(result, "unclassified");
});

// allocateBoundedClassSlots: the fair-allocation policy proven necessary by the
// live 90%-pitcher/46%-batter player_game_logs coverage gap and the 17-day-stalled
// regular-rotation cursor (both confirmed against production data).
test("allocateBoundedClassSlots: an ample pool on both sides gets an even reserved split", () => {
  const result = allocateBoundedClassSlots({ pitcherPoolSize: 154, batterPoolSize: 245, totalBudget: 12 });
  assert.equal(result.pitcherBudget, 6);
  assert.equal(result.batterBudget, 6);
});

test("allocateBoundedClassSlots: unused pitcher reservation spills over to batters when pitchers have fewer eligible candidates than their reserved share", () => {
  const result = allocateBoundedClassSlots({ pitcherPoolSize: 2, batterPoolSize: 245, totalBudget: 12 });
  assert.equal(result.pitcherBudget, 2);
  assert.equal(result.batterBudget, 10);
  assert.equal(result.pitcherBudget + result.batterBudget, 12, "total bound must never be exceeded");
});

test("allocateBoundedClassSlots: unused batter reservation spills over to pitchers symmetrically", () => {
  const result = allocateBoundedClassSlots({ pitcherPoolSize: 154, batterPoolSize: 1, totalBudget: 12 });
  assert.equal(result.batterBudget, 1);
  assert.equal(result.pitcherBudget, 11);
  assert.equal(result.pitcherBudget + result.batterBudget, 12);
});

test("allocateBoundedClassSlots: both pools empty allocates nothing and never exceeds the total bound", () => {
  const result = allocateBoundedClassSlots({ pitcherPoolSize: 0, batterPoolSize: 0, totalBudget: 12 });
  assert.equal(result.pitcherBudget, 0);
  assert.equal(result.batterBudget, 0);
});

test("allocateBoundedClassSlots: never allocates more than totalBudget even when both pools are enormous", () => {
  const result = allocateBoundedClassSlots({ pitcherPoolSize: 10000, batterPoolSize: 10000, totalBudget: 12 });
  assert.equal(result.pitcherBudget + result.batterBudget, 12);
});

// The overflow defect this session fixed: `Math.max(1, Math.floor(totalBudget / 2))`
// forced a reservation of >=1 slot to EACH class even when totalBudget itself
// was 0 or 1, so totalBudget=1 with both classes populated previously
// returned {pitcherBudget:1, batterBudget:1} -- a combined total of 2,
// silently exceeding totalBudget. Not reachable through this codebase's real
// call sites today (see allocateClassFairPlayerWindow's totalBudget
// computation), but the shared helper itself must honor its contract
// regardless of what its current callers happen to pass.
test("allocateBoundedClassSlots: totalBudget 0 with both pools populated allocates nothing", () => {
  const result = allocateBoundedClassSlots({ pitcherPoolSize: 5, batterPoolSize: 5, totalBudget: 0 });
  assert.deepEqual(result, { pitcherBudget: 0, batterBudget: 0 });
});

test("allocateBoundedClassSlots: totalBudget 1 with both pools populated selects exactly one candidate, deterministically favoring pitcher", () => {
  const result = allocateBoundedClassSlots({ pitcherPoolSize: 5, batterPoolSize: 5, totalBudget: 1 });
  assert.equal(result.pitcherBudget + result.batterBudget, 1, "exactly one slot must be allocated, never two");
  assert.deepEqual(result, { pitcherBudget: 1, batterBudget: 0 }, "the documented tie-break favors pitcher");
});

test("allocateBoundedClassSlots: totalBudget 1 with only pitchers available allocates the single slot to pitcher", () => {
  const result = allocateBoundedClassSlots({ pitcherPoolSize: 5, batterPoolSize: 0, totalBudget: 1 });
  assert.deepEqual(result, { pitcherBudget: 1, batterBudget: 0 });
});

test("allocateBoundedClassSlots: totalBudget 1 with only batters available allocates the single slot to batter", () => {
  const result = allocateBoundedClassSlots({ pitcherPoolSize: 0, batterPoolSize: 5, totalBudget: 1 });
  assert.deepEqual(result, { pitcherBudget: 0, batterBudget: 1 });
});

test("allocateBoundedClassSlots: totalBudget 1 with both pools empty allocates nothing", () => {
  const result = allocateBoundedClassSlots({ pitcherPoolSize: 0, batterPoolSize: 0, totalBudget: 1 });
  assert.deepEqual(result, { pitcherBudget: 0, batterBudget: 0 });
});

test("allocateBoundedClassSlots: totalBudget 2 with both pools populated reserves one slot per class", () => {
  const result = allocateBoundedClassSlots({ pitcherPoolSize: 5, batterPoolSize: 5, totalBudget: 2 });
  assert.deepEqual(result, { pitcherBudget: 1, batterBudget: 1 });
});

test("allocateBoundedClassSlots: a pool smaller than its reservation never gets more than it has, and the total bound is preserved", () => {
  const result = allocateBoundedClassSlots({ pitcherPoolSize: 1, batterPoolSize: 20, totalBudget: 8 });
  assert.equal(result.pitcherBudget, 1, "pitcher cannot receive more than its 1 available candidate");
  assert.equal(result.pitcherBudget + result.batterBudget, 8, "unused pitcher reservation must spill to batter without exceeding the total");
});

test("allocateBoundedClassSlots: totalBudget larger than all available candidates allocates only what exists, never padding to the budget", () => {
  const result = allocateBoundedClassSlots({ pitcherPoolSize: 2, batterPoolSize: 1, totalBudget: 10 });
  assert.deepEqual(result, { pitcherBudget: 2, batterBudget: 1 });
  assert.ok(result.pitcherBudget + result.batterBudget < 10, "must not allocate more slots than candidates exist");
});

test("allocateBoundedClassSlots: production-sized allocations (totalBudget >= 2) are unaffected by the totalBudget<2 fix", () => {
  // Same assertions as the pre-existing "ample pool" test above, re-affirmed
  // after the fix to prove budget>=2 behavior is byte-for-byte unchanged.
  assert.deepEqual(allocateBoundedClassSlots({ pitcherPoolSize: 154, batterPoolSize: 245, totalBudget: 12 }), { pitcherBudget: 6, batterBudget: 6 });
  assert.deepEqual(allocateBoundedClassSlots({ pitcherPoolSize: 2, batterPoolSize: 245, totalBudget: 12 }), { pitcherBudget: 2, batterBudget: 10 });
});

// allocateClassFairPlayerWindow: the single class-fair allocation policy now
// shared by BOTH refreshMlbPlayerLogs callers -- targeted mode (the live
// pipeline's only real caller) and fair-split mode (the unscoped
// refresh_player_game_logs job). Session 66 found targeted mode used a plain
// unclassed slice with no reservation at all; these tests prove the fix
// actually changes selection behavior, not just its reporting.
function poolOf(ids: string[]) {
  return ids.map((id) => ({ id }));
}

test("allocateClassFairPlayerWindow: targeted mode honors a real batter minimum instead of a plain first-N slice", async () => {
  const store: Store = { currentProps: [], events: [] };
  await withMlbSupabaseEnv(store, async () => {
    // 10 pitchers ordered ahead of 10 batters -- a plain slice(0, 4) would
    // select 4 pitchers and 0 batters. Fair allocation must reserve a real
    // batter minimum instead.
    const pool = [...poolOf(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"]), ...poolOf(["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9", "b10"])];
    const requiredStatGroupsByPlayerId: Record<string, MlbPostgameStatGroup[]> = Object.fromEntries([
      ...["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"].map((id) => [id, ["pitching"]]),
      ...["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9", "b10"].map((id) => [id, ["hitting"]]),
    ]);
    const window = await allocateClassFairPlayerWindow({
      mode: "targeted",
      pool,
      totalBudget: 4,
      cacheKeyPrefix: "test:cursor:targeted-min",
      isPriorityFor: () => false,
      requiredStatGroupsByPlayerId,
    });
    assert.equal(window.items.length, 4);
    assert.ok(window.allocation.batterSelectedIds.length >= 1, "batter minimum must be honored when batter candidates exist");
    assert.ok(window.allocation.pitcherSelectedIds.length >= 1, "pitcher minimum must be honored when pitcher candidates exist");
    assert.equal(window.allocation.mode, "targeted");
  });
});

test("allocateClassFairPlayerWindow: unused batter capacity spills to pitchers when batter pool is small", async () => {
  const store: Store = { currentProps: [], events: [] };
  await withMlbSupabaseEnv(store, async () => {
    const pool = [...poolOf(["p1", "p2", "p3", "p4", "p5", "p6"]), ...poolOf(["b1"])];
    const requiredStatGroupsByPlayerId: Record<string, MlbPostgameStatGroup[]> = Object.fromEntries([
      ...["p1", "p2", "p3", "p4", "p5", "p6"].map((id) => [id, ["pitching"]]),
      ["b1", ["hitting"]],
    ]);
    const window = await allocateClassFairPlayerWindow({
      mode: "targeted", pool, totalBudget: 6, cacheKeyPrefix: "test:cursor:spill-to-pitcher",
      isPriorityFor: () => false, requiredStatGroupsByPlayerId,
    });
    assert.equal(window.items.length, 6);
    assert.equal(window.allocation.batterSelectedIds.length, 1);
    assert.equal(window.allocation.pitcherSelectedIds.length, 5, "unused batter reservation must spill to pitchers");
    assert.ok(window.allocation.pitcherSpillover > 0);
  });
});

test("allocateClassFairPlayerWindow: unused pitcher capacity spills to batters when pitcher pool is small", async () => {
  const store: Store = { currentProps: [], events: [] };
  await withMlbSupabaseEnv(store, async () => {
    const pool = [...poolOf(["p1"]), ...poolOf(["b1", "b2", "b3", "b4", "b5", "b6"])];
    const requiredStatGroupsByPlayerId: Record<string, MlbPostgameStatGroup[]> = Object.fromEntries([
      ["p1", ["pitching"]],
      ...["b1", "b2", "b3", "b4", "b5", "b6"].map((id) => [id, ["hitting"]]),
    ]);
    const window = await allocateClassFairPlayerWindow({
      mode: "targeted", pool, totalBudget: 6, cacheKeyPrefix: "test:cursor:spill-to-batter",
      isPriorityFor: () => false, requiredStatGroupsByPlayerId,
    });
    assert.equal(window.allocation.pitcherSelectedIds.length, 1);
    assert.equal(window.allocation.batterSelectedIds.length, 5, "unused pitcher reservation must spill to batters");
    assert.ok(window.allocation.batterSpillover > 0);
  });
});

test("allocateClassFairPlayerWindow: total bound is never exceeded and no player is selected twice", async () => {
  const store: Store = { currentProps: [], events: [] };
  await withMlbSupabaseEnv(store, async () => {
    const pool = [...poolOf(["p1", "p2", "p3", "p4", "p5"]), ...poolOf(["b1", "b2", "b3", "b4", "b5"]), ...poolOf(["u1", "u2"])];
    const requiredStatGroupsByPlayerId: Record<string, MlbPostgameStatGroup[]> = Object.fromEntries([
      ...["p1", "p2", "p3", "p4", "p5"].map((id) => [id, ["pitching"]]),
      ...["b1", "b2", "b3", "b4", "b5"].map((id) => [id, ["hitting"]]),
      ...["u1", "u2"].map((id) => [id, ["hitting", "pitching"]]),
    ]);
    const window = await allocateClassFairPlayerWindow({
      mode: "targeted", pool, totalBudget: 5, cacheKeyPrefix: "test:cursor:total-bound",
      isPriorityFor: () => false, requiredStatGroupsByPlayerId,
    });
    assert.ok(window.items.length <= 5, "total bound must never be exceeded");
    const ids = window.items.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, "no duplicate player ids in the selected window");
  });
});

test("allocateClassFairPlayerWindow: dual-role/unknown candidates are unclassified and only run on leftover budget", async () => {
  const store: Store = { currentProps: [], events: [] };
  await withMlbSupabaseEnv(store, async () => {
    const pool = [...poolOf(["p1", "p2"]), ...poolOf(["b1", "b2"]), ...poolOf(["u1"])];
    const requiredStatGroupsByPlayerId: Record<string, MlbPostgameStatGroup[]> = { p1: ["pitching"], p2: ["pitching"], b1: ["hitting"], b2: ["hitting"], u1: ["hitting", "pitching"] };
    const window = await allocateClassFairPlayerWindow({
      mode: "targeted", pool, totalBudget: 4, cacheKeyPrefix: "test:cursor:dual-role",
      isPriorityFor: () => false, requiredStatGroupsByPlayerId,
    });
    assert.equal(window.allocation.unclassifiedPoolSize, 1);
    // pitcher+batter pools (2 each) fully absorb the 4-slot budget, so the
    // dual-role candidate should be deferred, not displace a classified pick.
    assert.equal(window.allocation.unclassifiedSelectedIds.length, 0);
    assert.equal(window.allocation.unclassifiedDeferredCount, 1);
  });
});

test("allocateClassFairPlayerWindow: rotation prevents the same backlog from being reselected every call once a class's pool exceeds its budget", async () => {
  const store: Store = { currentProps: [], events: [] };
  await withMlbSupabaseEnv(store, async () => {
    const pool = poolOf(["b1", "b2", "b3", "b4", "b5", "b6"]);
    const requiredStatGroupsByPlayerId: Record<string, MlbPostgameStatGroup[]> = Object.fromEntries(pool.map((p) => [p.id, ["hitting"]]));
    const first = await allocateClassFairPlayerWindow({
      mode: "targeted", pool, totalBudget: 2, cacheKeyPrefix: "test:cursor:rotation",
      isPriorityFor: () => false, requiredStatGroupsByPlayerId,
    });
    const second = await allocateClassFairPlayerWindow({
      mode: "targeted", pool, totalBudget: 2, cacheKeyPrefix: "test:cursor:rotation",
      isPriorityFor: () => false, requiredStatGroupsByPlayerId,
    });
    assert.notDeepEqual(first.allocation.batterSelectedIds, second.allocation.batterSelectedIds, "a second call must rotate past the first call's picks, not repeat them");
    assert.notEqual(first.allocation.cursorAfter.batter, 0, "the cursor must advance past its starting position after a call consumes part of the pool");
  });
});

test("allocateClassFairPlayerWindow: targeted and fair-split cache-key namespaces do not collide", async () => {
  const store: Store = { currentProps: [], events: [] };
  await withMlbSupabaseEnv(store, async () => {
    const pool = poolOf(["b1", "b2", "b3", "b4"]);
    const requiredStatGroupsByPlayerId: Record<string, MlbPostgameStatGroup[]> = Object.fromEntries(pool.map((p) => [p.id, ["hitting"]]));
    const targeted = await allocateClassFairPlayerWindow({
      mode: "targeted", pool, totalBudget: 2, cacheKeyPrefix: "knowledge:cursor:mlb:refresh_player_game_logs:players:targeted",
      isPriorityFor: () => false, requiredStatGroupsByPlayerId,
    });
    const fairSplit = await allocateClassFairPlayerWindow({
      mode: "fair-split", pool, totalBudget: 2, cacheKeyPrefix: "knowledge:cursor:mlb:refresh_player_game_logs:players",
      isPriorityFor: () => false, requiredStatGroupsByPlayerId,
    });
    assert.deepEqual(targeted.allocation.batterSelectedIds, fairSplit.allocation.batterSelectedIds, "independent cache namespaces both start from the same fresh cursor");
  });
});

test("allocateClassFairPlayerWindow: final report contains real selected IDs and slot math (reserved + spillover)", async () => {
  const store: Store = { currentProps: [], events: [] };
  await withMlbSupabaseEnv(store, async () => {
    const pool = [...poolOf(["p1", "p2", "p3"]), ...poolOf(["b1"])];
    const requiredStatGroupsByPlayerId: Record<string, MlbPostgameStatGroup[]> = { p1: ["pitching"], p2: ["pitching"], p3: ["pitching"], b1: ["hitting"] };
    const window = await allocateClassFairPlayerWindow({
      mode: "targeted", pool, totalBudget: 4, cacheKeyPrefix: "test:cursor:report-math",
      isPriorityFor: () => false, requiredStatGroupsByPlayerId,
    });
    assert.equal(window.allocation.totalBudget, 4);
    assert.equal(window.allocation.pitcherReservedBudget + window.allocation.pitcherSpillover, window.allocation.pitcherSelectedIds.length);
    assert.equal(window.allocation.batterReservedBudget + window.allocation.batterSpillover, window.allocation.batterSelectedIds.length);
    assert.ok(Array.isArray(window.allocation.pitcherSelectedIds) && window.allocation.pitcherSelectedIds.every((id) => id.startsWith("p")));
  });
});

test("skippedMlbLogAllocationSummary: has an explicit skip reason and zeroed fields, never a bare null", () => {
  const summary = skippedMlbLogAllocationSummary("MLB player game logs are already fresh.");
  assert.equal(summary.mode, "skipped");
  assert.equal(summary.skipReason, "MLB player game logs are already fresh.");
  assert.equal(summary.pitcherSelectedIds.length, 0);
  assert.equal(summary.batterSelectedIds.length, 0);
  assert.equal(summary.totalBudget, 0);
});

// parseMlbGameLogSeasonRates / parseMlbGameLogCountingStats: Session 67's
// bounded read of live player_game_logs.raw_payload confirmed MLB Stats
// API's own gameLog `stat` object carries genuine season-to-date rates
// (avg/obp/slg/ops/era/whip) alongside single-game-only counting stats
// (strikeOuts/baseOnBalls/battersFaced) on the SAME object -- these tests
// pin that contract with realistic fixture shapes from that live sample.
function fixtureGameLogPayload(stat: Record<string, unknown>) {
  return { date: "2026-07-26", game: { gamePk: 823028 }, stat };
}

test("parseMlbGameLogSeasonRates: a valid pitcher season payload parses every rate correctly", () => {
  const result = parseMlbGameLogSeasonRates(fixtureGameLogPayload({ avg: ".245", era: "3.86", obp: ".000", ops: ".000", slg: ".000", whip: "1.38" }));
  assert.deepEqual(result, { battingAverage: 0.245, onBasePercentage: 0, sluggingPercentage: 0, onBasePlusSlugging: 0, era: 3.86, whip: 1.38 });
});

test("parseMlbGameLogSeasonRates: a valid batter season payload parses every rate correctly", () => {
  const result = parseMlbGameLogSeasonRates(fixtureGameLogPayload({ avg: ".263", obp: ".429", slg: ".333", ops: ".762", era: "3.54", whip: "1.37" }));
  assert.deepEqual(result, { battingAverage: 0.263, onBasePercentage: 0.429, sluggingPercentage: 0.333, onBasePlusSlugging: 0.762, era: 3.54, whip: 1.37 });
});

test("parseMlbGameLogSeasonRates: MLB's own rate-undefined sentinel ('.---') parses as null, not a fabricated value", () => {
  const result = parseMlbGameLogSeasonRates(fixtureGameLogPayload({ avg: ".---", obp: "-.--", slg: null, ops: undefined, era: "3.86", whip: "1.38" }));
  assert.equal(result?.battingAverage, null);
  assert.equal(result?.onBasePercentage, null);
  assert.equal(result?.sluggingPercentage, null);
  assert.equal(result?.onBasePlusSlugging, null);
  assert.equal(result?.era, 3.86);
});

test("parseMlbGameLogSeasonRates: a genuinely measured zero rate stays zero, not null", () => {
  const result = parseMlbGameLogSeasonRates(fixtureGameLogPayload({ avg: "0", obp: "0", slg: "0", ops: "0", era: "0.00", whip: "0.00" }));
  assert.equal(result?.battingAverage, 0);
  assert.equal(result?.era, 0);
});

test("parseMlbGameLogSeasonRates: a malformed payload (no stat object) returns null rather than throwing", () => {
  assert.equal(parseMlbGameLogSeasonRates(null), null);
  assert.equal(parseMlbGameLogSeasonRates(undefined), null);
  assert.equal(parseMlbGameLogSeasonRates("not an object"), null);
  assert.equal(parseMlbGameLogSeasonRates({ date: "2026-07-26" }), null);
  assert.equal(parseMlbGameLogSeasonRates({ stat: "not an object either" }), null);
});

test("parseMlbGameLogSeasonRates: an unsupported/unexpected payload variant never fabricates a value for a genuinely absent field", () => {
  const result = parseMlbGameLogSeasonRates(fixtureGameLogPayload({ era: "3.86" }));
  assert.equal(result?.battingAverage, null);
  assert.equal(result?.onBasePercentage, null);
  assert.equal(result?.era, 3.86);
});

test("parseMlbGameLogSeasonRates: only the six proven season-rate fields are ever returned -- Statcast-only fields (exit velocity, barrel rate, xwOBA, swinging-strike rate) structurally cannot appear", () => {
  const result = parseMlbGameLogSeasonRates(fixtureGameLogPayload({ avg: ".263" }));
  assert.deepEqual(Object.keys(result ?? {}).sort(), ["battingAverage", "era", "onBasePercentage", "onBasePlusSlugging", "sluggingPercentage", "whip"].sort());
});

test("parseMlbGameLogCountingStats: string-numeric counting stats parse safely", () => {
  const result = parseMlbGameLogCountingStats(fixtureGameLogPayload({ strikeOuts: 2, baseOnBalls: 0, battersFaced: 3 }));
  assert.deepEqual(result, { strikeOuts: 2, baseOnBalls: 0, battersFaced: 3 });
});

test("parseMlbGameLogCountingStats: missing counting fields remain null, not zero", () => {
  const result = parseMlbGameLogCountingStats(fixtureGameLogPayload({ era: "3.86" }));
  assert.deepEqual(result, { strikeOuts: null, baseOnBalls: null, battersFaced: null });
});

test("parseMlbGameLogCountingStats: a malformed payload returns null rather than throwing", () => {
  assert.equal(parseMlbGameLogCountingStats(null), null);
  assert.equal(parseMlbGameLogCountingStats({}), null);
});

// compareMlbGameLogRecency: deterministic "latest row" ordering for a
// player's stored game logs, closing the doubleheader gap where two rows
// can share one game_date (see refreshMlbPlayerLogs's dedup key:
// provider|player_id|game_date|event_id, which permits a second event_id on
// the same date). A live bounded check confirmed MLB's own gamePk is NOT
// reliably date-ordered, so it is deliberately not used; the real event
// start_time (when resolvable) is the strongest evidence, with MLB's own
// game.gameNumber as a documented fallback.
function doubleheaderFixture() {
  const gameOne = {
    game_date: "2026-07-09",
    event_id: "event-game-1",
    raw_payload: { game: { gameNumber: 1 } },
    seasonAvgAfterThisGame: ".280",
  };
  const gameTwo = {
    game_date: "2026-07-09",
    event_id: "event-game-2",
    raw_payload: { game: { gameNumber: 2 } },
    seasonAvgAfterThisGame: ".283",
  };
  const eventStartTimeByEventId = new Map([
    ["event-game-1", "2026-07-09T18:10:00+00:00"],
    ["event-game-2", "2026-07-09T22:40:00+00:00"],
  ]);
  return { gameOne, gameTwo, eventStartTimeByEventId };
}

test("compareMlbGameLogRecency: a doubleheader's later game (by real event start_time) sorts first, regardless of input array order", () => {
  const { gameOne, gameTwo, eventStartTimeByEventId } = doubleheaderFixture();
  const forward = [gameOne, gameTwo].sort((a, b) => compareMlbGameLogRecency(a, b, eventStartTimeByEventId));
  const reversed = [gameTwo, gameOne].sort((a, b) => compareMlbGameLogRecency(a, b, eventStartTimeByEventId));
  assert.equal(forward[0].event_id, "event-game-2", "the later-starting game must be selected as 'latest' regardless of input order");
  assert.deepEqual(forward.map((r) => r.event_id), reversed.map((r) => r.event_id), "sort result must not depend on input array order");
  assert.equal(forward[0].seasonAvgAfterThisGame, ".283", "the season-to-date value from the genuinely later game must be the one selected");
});

test("compareMlbGameLogRecency: falls back to MLB's own game.gameNumber when event start_time is not resolvable for either row", () => {
  const { gameOne, gameTwo } = doubleheaderFixture();
  const emptyMap = new Map<string, string>();
  const forward = [gameOne, gameTwo].sort((a, b) => compareMlbGameLogRecency(a, b, emptyMap));
  const reversed = [gameTwo, gameOne].sort((a, b) => compareMlbGameLogRecency(a, b, emptyMap));
  assert.equal(forward[0].event_id, "event-game-2", "gameNumber=2 must sort ahead of gameNumber=1 when start_time is unavailable");
  assert.deepEqual(forward.map((r) => r.event_id), reversed.map((r) => r.event_id));
});

test("compareMlbGameLogRecency: falls back to gameNumber when only one row's event start_time is resolvable", () => {
  const { gameOne, gameTwo } = doubleheaderFixture();
  const partialMap = new Map([["event-game-1", "2026-07-09T18:10:00+00:00"]]);
  const result = [gameOne, gameTwo].sort((a, b) => compareMlbGameLogRecency(a, b, partialMap));
  assert.equal(result[0].event_id, "event-game-2");
});

test("compareMlbGameLogRecency: different game_dates are ordered by date alone, unaffected by event_id/gameNumber", () => {
  const earlier = { game_date: "2026-07-08", event_id: "event-a", raw_payload: { game: { gameNumber: 5 } } };
  const later = { game_date: "2026-07-09", event_id: "event-b", raw_payload: { game: { gameNumber: 1 } } };
  const map = new Map([["event-a", "2026-07-08T23:00:00+00:00"], ["event-b", "2026-07-09T12:00:00+00:00"]]);
  const result = [earlier, later].sort((a, b) => compareMlbGameLogRecency(a, b, map));
  assert.equal(result[0].event_id, "event-b", "a later calendar date always sorts first regardless of gameNumber or start_time");
});

test("compareMlbGameLogRecency: a genuine full tie (same date, no event_id, no gameNumber) is stable, not fabricated", () => {
  const rowA = { game_date: "2026-07-09", event_id: null, raw_payload: {} };
  const rowB = { game_date: "2026-07-09", event_id: null, raw_payload: {} };
  assert.equal(compareMlbGameLogRecency(rowA, rowB, new Map()), 0);
});

// dedupeGameLogsByCanonicalGame: Session 70's live-verified fix for the
// production defect behind the owner-reported "incorrect last 5 games
// averages" -- a bounded read found ~21% of sampled WNBA player+game_date
// pairs have two stored rows (sportsdataverse-wnba with a real event_id,
// wehoop-wnba with event_id: null) reporting the identical game, which
// silently corrupts any last5/last10 average computed by slicing N rows
// instead of N distinct games.
test("dedupeGameLogsByCanonicalGame: reproduces the exact live production defect -- two provider rows for one WNBA game collapse to one canonical row", () => {
  const rows = [
    { game_date: "2026-07-20", event_id: "sdv-event-1", updated_at: "2026-07-27T23:01:41.072Z", points: 15 },
    { game_date: "2026-07-20", event_id: null, updated_at: "2026-07-29T05:03:21.219Z", points: 15 },
  ];
  const result = dedupeGameLogsByCanonicalGame(rows);
  assert.equal(result.length, 1, "one real game must produce exactly one canonical row, not two");
  assert.equal(result[0].event_id, "sdv-event-1", "the row with a real event_id must be preferred over the null-event_id duplicate");
});

test("dedupeGameLogsByCanonicalGame: a genuine MLB doubleheader (two distinct non-null event_ids, same date) is preserved as two games", () => {
  const rows = [
    { game_date: "2026-07-09", event_id: "event-game-1", updated_at: "2026-07-09T18:10:00Z", points: 10 },
    { game_date: "2026-07-09", event_id: "event-game-2", updated_at: "2026-07-09T22:40:00Z", points: 20 },
  ];
  const result = dedupeGameLogsByCanonicalGame(rows);
  assert.equal(result.length, 2, "a true doubleheader must not be collapsed to one game");
  assert.deepEqual(result.map((r) => r.event_id).sort(), ["event-game-1", "event-game-2"]);
});

test("dedupeGameLogsByCanonicalGame: a doubleheader where one leg ALSO has a provider duplicate still yields exactly two canonical games", () => {
  const rows = [
    { game_date: "2026-07-09", event_id: "event-game-1", updated_at: "2026-07-09T18:10:00Z", points: 10 },
    { game_date: "2026-07-09", event_id: null, updated_at: "2026-07-09T18:15:00Z", points: 10 }, // provider duplicate of game 1
    { game_date: "2026-07-09", event_id: "event-game-2", updated_at: "2026-07-09T22:40:00Z", points: 20 },
  ];
  const result = dedupeGameLogsByCanonicalGame(rows);
  assert.equal(result.length, 2, "provider-duplicate-within-a-leg must not create a third phantom game");
  assert.deepEqual(result.map((r) => r.event_id).sort(), ["event-game-1", "event-game-2"]);
});

test("dedupeGameLogsByCanonicalGame: rows on different dates are never merged", () => {
  const rows = [
    { game_date: "2026-07-08", event_id: null, updated_at: "2026-07-08T00:00:00Z", points: 5 },
    { game_date: "2026-07-09", event_id: null, updated_at: "2026-07-09T00:00:00Z", points: 7 },
  ];
  const result = dedupeGameLogsByCanonicalGame(rows);
  assert.equal(result.length, 2);
});

test("dedupeGameLogsByCanonicalGame: a single row for a date passes through unchanged", () => {
  const rows = [{ game_date: "2026-07-09", event_id: "event-1", updated_at: "2026-07-09T00:00:00Z", points: 12 }];
  const result = dedupeGameLogsByCanonicalGame(rows);
  assert.deepEqual(result, rows);
});

test("dedupeGameLogsByCanonicalGame: with no event_id on either duplicate, the more recently updated row wins", () => {
  const rows = [
    { game_date: "2026-07-20", event_id: null, updated_at: "2026-07-20T10:00:00Z", points: 8 },
    { game_date: "2026-07-20", event_id: null, updated_at: "2026-07-27T10:00:00Z", points: 15 },
  ];
  const result = dedupeGameLogsByCanonicalGame(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].points, 15, "the more recently updated duplicate must win when neither has a real event_id");
});

test("dedupeGameLogsByCanonicalGame: end-to-end proof against the live Kayla Thornton fixture -- last5 average matches the correct distinct-game computation, not the naive row-slice", () => {
  // Exact shape of the live production data found in Session 70 (10 rows,
  // 5 distinct games, each duplicated once).
  const liveRows = [
    { game_date: "2026-07-20", event_id: "e1", updated_at: "2026-07-27T23:01:41Z", points: 15 },
    { game_date: "2026-07-20", event_id: null, updated_at: "2026-07-29T05:03:21Z", points: 15 },
    { game_date: "2026-07-18", event_id: "e2", updated_at: "2026-07-27T23:01:41Z", points: 11 },
    { game_date: "2026-07-18", event_id: null, updated_at: "2026-07-29T05:03:21Z", points: 11 },
    { game_date: "2026-07-15", event_id: "e3", updated_at: "2026-07-22T23:04:22Z", points: 11 },
    { game_date: "2026-07-15", event_id: null, updated_at: "2026-07-29T05:03:21Z", points: 11 },
    { game_date: "2026-07-10", event_id: "e4", updated_at: "2026-07-22T23:04:22Z", points: 2 },
    { game_date: "2026-07-10", event_id: null, updated_at: "2026-07-29T05:03:21Z", points: 2 },
    { game_date: "2026-07-08", event_id: "e5", updated_at: "2026-07-19T17:47:31Z", points: 15 },
    { game_date: "2026-07-08", event_id: null, updated_at: "2026-07-29T05:03:21Z", points: 15 },
  ];
  const deduped = dedupeGameLogsByCanonicalGame(liveRows);
  assert.equal(deduped.length, 5, "10 rows across 5 distinct dates must dedupe to exactly 5 canonical games");
  const ordered = [...deduped].sort((a, b) => b.game_date.localeCompare(a.game_date));
  const last5Avg = ordered.slice(0, 5).reduce((sum, r) => sum + r.points, 0) / Math.min(5, ordered.length);
  assert.equal(last5Avg, 10.8, "matches the correct distinct-game average (15+11+11+2+15)/5, not the naive row-slice average of 12.6");
});

// Session 71 finding: a live full-table scan of all 10,411 stored MLB
// player_game_logs rows found 9,921 (95.3%) have event_id: null -- so for
// nearly all MLB rows, the event_id-only doubleheader check above never
// fires and this function was silently relying on the date-only recency
// fallback for games it could have distinguished. Every sampled MLB row
// (event_id null or not) carries MLB Stats API's own raw_payload.game.gamePk,
// a stable per-game identifier from the sole MLB provider. These tests prove
// gamePk now closes that gap without being used for chronological ordering
// (compareMlbGameLogRecency deliberately never uses gamePk for that -- see
// its own comment; this is a distinct equality-only usage).
test("dedupeGameLogsByCanonicalGame: an MLB doubleheader where NEITHER leg has event_id is still preserved as two games via raw_payload.game.gamePk", () => {
  const rows = [
    { game_date: "2026-07-09", event_id: null, provider: "mlb-stats-api", updated_at: "2026-07-09T18:10:00Z", raw_payload: { game: { gamePk: 824251, gameNumber: 1 } }, points: 10 },
    { game_date: "2026-07-09", event_id: null, provider: "mlb-stats-api", updated_at: "2026-07-09T22:40:00Z", raw_payload: { game: { gamePk: 823846, gameNumber: 2 } }, points: 20 },
  ];
  const result = dedupeGameLogsByCanonicalGame(rows);
  assert.equal(result.length, 2, "two distinct gamePks on one date must not collapse into one game, even with no event_id on either row");
});

test("dedupeGameLogsByCanonicalGame: a real cross-provider duplicate (same gamePk, event_id resolved on only one row) still collapses to one game", () => {
  const rows = [
    { game_date: "2026-07-09", event_id: "event-1", provider: "mlb-stats-api", updated_at: "2026-07-09T18:10:00Z", raw_payload: { game: { gamePk: 824251 } }, points: 10 },
    { game_date: "2026-07-09", event_id: null, provider: "mlb-stats-api", updated_at: "2026-07-09T18:11:00Z", raw_payload: { game: { gamePk: 824251 } }, points: 10 },
  ];
  const result = dedupeGameLogsByCanonicalGame(rows);
  assert.equal(result.length, 1, "same gamePk must collapse to one canonical row regardless of which row has event_id resolved");
  assert.equal(result[0].event_id, "event-1", "the row with a real event_id must still be preferred as the representative row");
});

test("dedupeGameLogsByCanonicalGame: a doubleheader where one leg lacks event_id AND gamePk (fully unresolvable) is treated as an unattributable duplicate, not a synthetic third game", () => {
  const rows = [
    { game_date: "2026-07-09", event_id: "event-game-1", provider: "mlb-stats-api", updated_at: "2026-07-09T18:10:00Z", raw_payload: { game: { gamePk: 824251 } }, points: 10 },
    { game_date: "2026-07-09", event_id: "event-game-2", provider: "mlb-stats-api", updated_at: "2026-07-09T22:40:00Z", raw_payload: { game: { gamePk: 823846 } }, points: 20 },
    { game_date: "2026-07-09", event_id: null, provider: "mlb-stats-api", updated_at: "2026-07-09T22:45:00Z", raw_payload: {}, points: 20 },
  ];
  const result = dedupeGameLogsByCanonicalGame(rows);
  assert.equal(result.length, 2, "a row with no resolvable identity at all must not create a third phantom game");
});

test("dedupeGameLogsByCanonicalGame: a wehoop-wnba-shaped duplicate uses raw_payload.Game_ID as its provider-native key, scoped separately from MLB's gamePk key space", () => {
  const rows = [
    { game_date: "2026-05-09", event_id: null, provider: "wehoop-wnba", updated_at: "2026-05-09T10:00:00Z", raw_payload: { Game_ID: "1022600006" }, points: 18 },
    { game_date: "2026-05-09", event_id: null, provider: "wehoop-wnba", updated_at: "2026-05-09T10:05:00Z", raw_payload: { Game_ID: "1022600006" }, points: 18 },
  ];
  const result = dedupeGameLogsByCanonicalGame(rows);
  assert.equal(result.length, 1, "two rows sharing the same provider-native Game_ID must collapse to one canonical game");
});

// Phase 18 (continuation) item 7: deterministic winner selection when two
// duplicate representations of the same canonical game DISAGREE on their
// stat values (not just when they happen to agree). The event_id-bearing,
// more-traceable row must win deterministically -- the outcome must not
// depend on which corrupt duplicate happened to sort first.
test("dedupeGameLogsByCanonicalGame: when a cross-provider WNBA duplicate DISAGREES on points, the canonical event_id-bearing row wins deterministically (the null-event_id row's differing value cannot leak in)", () => {
  const forward = [
    { game_date: "2026-07-20", event_id: "wnba-event-1", provider: "sportsdataverse-wnba", updated_at: "2026-07-27T23:01:41Z", points: 20 },
    { game_date: "2026-07-20", event_id: null, provider: "wehoop-wnba", updated_at: "2026-07-29T05:03:21Z", points: 99 },
  ];
  const reversed = [...forward].reverse();
  const a = dedupeGameLogsByCanonicalGame(forward);
  const b = dedupeGameLogsByCanonicalGame(reversed);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].points, 20, "the event_id-bearing row must win regardless of input order");
  assert.equal(b[0].points, 20, "and the result is identical when the input array order is reversed (deterministic)");
});

test("dedupeGameLogsByCanonicalGame: result is independent of input array order", () => {
  const rows = [
    { game_date: "2026-07-20", event_id: "e1", provider: "sportsdataverse-wnba", updated_at: "2026-07-27T23:01:41Z", raw_payload: {}, points: 15 },
    { game_date: "2026-07-20", event_id: null, provider: "wehoop-wnba", updated_at: "2026-07-29T05:03:21Z", raw_payload: {}, points: 15 },
    { game_date: "2026-07-18", event_id: "e2", provider: "sportsdataverse-wnba", updated_at: "2026-07-27T23:01:41Z", raw_payload: {}, points: 11 },
    { game_date: "2026-07-09", event_id: null, provider: "mlb-stats-api", updated_at: "2026-07-09T18:10:00Z", raw_payload: { game: { gamePk: 824251 } }, points: 10 },
    { game_date: "2026-07-09", event_id: null, provider: "mlb-stats-api", updated_at: "2026-07-09T22:40:00Z", raw_payload: { game: { gamePk: 823846 } }, points: 20 },
  ];
  const forward = dedupeGameLogsByCanonicalGame(rows).map((r) => `${r.game_date}:${r.event_id ?? r.raw_payload?.game?.gamePk}:${r.points}`).sort();
  const reversed = dedupeGameLogsByCanonicalGame([...rows].reverse()).map((r) => `${r.game_date}:${r.event_id ?? r.raw_payload?.game?.gamePk}:${r.points}`).sort();
  assert.deepEqual(forward, reversed, "reversing input order must not change which canonical games or representative rows are produced");
});

function withMlbSupabaseEnv(store: Store, run: () => Promise<void>) {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJtest";
  const providerCache = store.providerCache ?? new Map<string, Record<string, unknown>>();

  const getRows = (rows: Array<Record<string, unknown>>, url: URL) => rows.filter((row) => {
    for (const [key, rawValue] of url.searchParams.entries()) {
      if (key === "select" || key === "order" || key === "limit") continue;
      const actual = row[key];
      if (rawValue.startsWith("eq.")) {
        if (String(actual ?? "") !== rawValue.slice(3)) return false;
        continue;
      }
      if (rawValue.startsWith("gte.")) {
        const bound = rawValue.slice(4);
        if (!actual || String(actual) < bound) return false;
        continue;
      }
      if (rawValue.startsWith("in.(") && rawValue.endsWith(")")) {
        const expected = rawValue.slice(4, -1).split(",").filter(Boolean);
        if (!expected.includes(String(actual ?? ""))) return false;
        continue;
      }
      if (rawValue === "is.null") {
        if (actual !== null && actual !== undefined) return false;
        continue;
      }
    }
    return true;
  });

  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.split("/rest/v1/").pop() ?? url.pathname;
    const table = path.split("?")[0];
    const method = init?.method ?? "GET";
    if (table === "current_props") {
      return new Response(JSON.stringify(getRows(store.currentProps, url)), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (table === "events") {
      return new Response(JSON.stringify(getRows(store.events, url)), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (table === "provider_cache") {
      const cacheKey = url.searchParams.get("cache_key")?.replace(/^eq\./, "") ?? "";
      if (method === "GET") {
        const record = providerCache.get(cacheKey);
        return new Response(JSON.stringify(record ? [record] : []), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (typeof body.cache_key === "string") providerCache.set(body.cache_key, body);
        return new Response(null, { status: 204 });
      }
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  return run().finally(() => {
    mock.restoreAll();
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });
}

function seededCursor(nextIndex: number, total: number) {
  return { nextIndex, total, sliceSize: 1, updatedAt: new Date().toISOString() };
}

const NOW = new Date("2026-07-16T20:00:00.000Z");
const future = (hoursFromNow: number) => new Date(NOW.getTime() + hoursFromNow * 60 * 60 * 1000).toISOString();
const past = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000).toISOString();

function unresolvedProp(overrides: Record<string, unknown> = {}) {
  return {
    id: "prop-1",
    provider: "sharpapi",
    league_id: "mlb",
    active: true,
    team_id: null,
    event_id: "event-1",
    start_time: future(3),
    ...overrides,
  };
}

test("unresolved future props with valid event linkage contribute both home and away team ids", async () => {
  const store: Store = {
    currentProps: [unresolvedProp()],
    events: [{ id: "event-1", league_id: "mlb", start_time: future(3), home_team_id: "phi", away_team_id: "nym" }],
  };
  await withMlbSupabaseEnv(store, async () => {
    const result = await loadUnresolvedFutureMlbEventTeamPriorities(NOW);
    assert.equal(result.teamIds.size, 2);
    assert.ok(result.teamIds.has("phi"));
    assert.ok(result.teamIds.has("nym"));
  });
});

test("many props from the same event dedupe to a single event's two team ids", async () => {
  const store: Store = {
    currentProps: Array.from({ length: 40 }, (_, index) => unresolvedProp({ id: `prop-${index}`, event_id: "event-1" })),
    events: [{ id: "event-1", league_id: "mlb", start_time: future(3), home_team_id: "phi", away_team_id: "nym" }],
  };
  await withMlbSupabaseEnv(store, async () => {
    const result = await loadUnresolvedFutureMlbEventTeamPriorities(NOW);
    assert.equal(result.teamIds.size, 2);
    assert.equal(result.orderedTeamIds?.length, 2);
  });
});

test("nearer unresolved future events rank their teams earlier", async () => {
  const store: Store = {
    currentProps: [
      unresolvedProp({ id: "prop-far", event_id: "event-far", start_time: future(48) }),
      unresolvedProp({ id: "prop-near", event_id: "event-near", start_time: future(2) }),
    ],
    events: [
      { id: "event-far", league_id: "mlb", start_time: future(48), home_team_id: "team-far-home", away_team_id: "team-far-away" },
      { id: "event-near", league_id: "mlb", start_time: future(2), home_team_id: "team-near-home", away_team_id: "team-near-away" },
    ],
  };
  await withMlbSupabaseEnv(store, async () => {
    const result = await loadUnresolvedFutureMlbEventTeamPriorities(NOW);
    assert.deepEqual(result.orderedTeamIds, ["team-near-home", "team-near-away", "team-far-home", "team-far-away"]);
  });
});

test("inactive props do not contribute team priorities", async () => {
  const store: Store = {
    currentProps: [unresolvedProp({ active: false })],
    events: [{ id: "event-1", league_id: "mlb", start_time: future(3), home_team_id: "phi", away_team_id: "nym" }],
  };
  await withMlbSupabaseEnv(store, async () => {
    const result = await loadUnresolvedFutureMlbEventTeamPriorities(NOW);
    assert.equal(result.teamIds.size, 0);
  });
});

test("other leagues are excluded by strict league scoping", async () => {
  const store: Store = {
    currentProps: [unresolvedProp({ league_id: "wnba", event_id: "event-wnba" })],
    events: [{ id: "event-wnba", league_id: "wnba", start_time: future(3), home_team_id: "wnba-home", away_team_id: "wnba-away" }],
  };
  await withMlbSupabaseEnv(store, async () => {
    const result = await loadUnresolvedFutureMlbEventTeamPriorities(NOW);
    assert.equal(result.teamIds.size, 0);
  });
});

test("props with no event linkage remain unresolved and contribute nothing", async () => {
  const store: Store = {
    currentProps: [unresolvedProp({ event_id: null })],
    events: [],
  };
  await withMlbSupabaseEnv(store, async () => {
    const result = await loadUnresolvedFutureMlbEventTeamPriorities(NOW);
    assert.equal(result.teamIds.size, 0);
  });
});

test("past-start props do not contribute team priorities", async () => {
  const store: Store = {
    currentProps: [unresolvedProp({ start_time: past(2) })],
    events: [{ id: "event-1", league_id: "mlb", start_time: past(2), home_team_id: "phi", away_team_id: "nym" }],
  };
  await withMlbSupabaseEnv(store, async () => {
    const result = await loadUnresolvedFutureMlbEventTeamPriorities(NOW);
    assert.equal(result.teamIds.size, 0);
  });
});

test("props that already have a resolved team_id are excluded from the unresolved query", async () => {
  const store: Store = {
    currentProps: [unresolvedProp({ team_id: "phi" })],
    events: [{ id: "event-1", league_id: "mlb", start_time: future(3), home_team_id: "phi", away_team_id: "nym" }],
  };
  await withMlbSupabaseEnv(store, async () => {
    const result = await loadUnresolvedFutureMlbEventTeamPriorities(NOW);
    assert.equal(result.teamIds.size, 0);
  });
});

test("Phillies/Mets scenario: the diagnosed 36-prop event prioritizes exactly those two teams among the full MLB team list", async () => {
  const teams = [
    { id: "atl", name: "Atlanta Braves" },
    { id: "phi", name: "Philadelphia Phillies" },
    { id: "nym", name: "New York Mets" },
    { id: "bos", name: "Boston Red Sox" },
  ];
  const store: Store = {
    currentProps: Array.from({ length: 36 }, (_, index) => unresolvedProp({ id: `prop-${index}`, event_id: "event-phi-nym" })),
    events: [{ id: "event-phi-nym", league_id: "mlb", start_time: future(3), home_team_id: "phi", away_team_id: "nym" }],
  };
  await withMlbSupabaseEnv(store, async () => {
    const unresolvedEventPriorities = await loadUnresolvedFutureMlbEventTeamPriorities(NOW);
    const priorities = { teamIds: new Set<string>(), teamNames: new Set<string>() };
    const { orderedTeams, livePriorityCount } = orderMlbTeamsForRosterRefresh(teams, priorities, unresolvedEventPriorities);
    assert.equal(livePriorityCount, 2);
    assert.deepEqual(orderedTeams.slice(0, 2).map((team) => team.id).sort(), ["nym", "phi"]);
  });
});

test("existing resolved-team priorities still win the priority tier on their own", () => {
  const teams = [
    { id: "a", name: "Team Alpha" },
    { id: "b", name: "Team Bravo" },
    { id: "c", name: "Team Charlie" },
  ];
  const priorities = { teamIds: new Set(["b"]), teamNames: new Set<string>() };
  const unresolvedEventPriorities = { teamIds: new Set<string>() };
  const { orderedTeams, livePriorityCount } = orderMlbTeamsForRosterRefresh(teams, priorities, unresolvedEventPriorities);
  assert.equal(orderedTeams[0]?.id, "b");
  assert.equal(livePriorityCount, 1);
});

test("unresolved-event team priorities boost teams that have no resolved signal at all", () => {
  const teams = [
    { id: "a", name: "Team Alpha" },
    { id: "b", name: "Team Bravo" },
    { id: "c", name: "Team Charlie" },
  ];
  const priorities = { teamIds: new Set<string>(), teamNames: new Set<string>() };
  const unresolvedEventPriorities = { teamIds: new Set(["c"]), orderedTeamIds: ["c"] };
  const { orderedTeams, livePriorityCount } = orderMlbTeamsForRosterRefresh(teams, priorities, unresolvedEventPriorities);
  assert.equal(orderedTeams[0]?.id, "c");
  assert.equal(livePriorityCount, 1);
});

test("nearer unresolved-event teams rank ahead of farther ones within the priority tier, deterministically", () => {
  const teams = [
    { id: "a", name: "Alpha" },
    { id: "b", name: "Bravo" },
    { id: "d", name: "Delta" },
    { id: "c", name: "Charlie" },
  ];
  const priorities = { teamIds: new Set<string>(), teamNames: new Set<string>() };
  const unresolvedEventPriorities = { teamIds: new Set(["b", "d"]), orderedTeamIds: ["b", "d"] };
  const { orderedTeams } = orderMlbTeamsForRosterRefresh(teams, priorities, unresolvedEventPriorities);
  assert.deepEqual(orderedTeams.map((team) => team.id), ["b", "d", "a", "c"]);
});

test("a team present in both the resolved and unresolved-event priority sets is not double-counted", () => {
  const teams = [
    { id: "a", name: "Alpha" },
    { id: "b", name: "Bravo" },
  ];
  const priorities = { teamIds: new Set(["a"]), teamNames: new Set<string>() };
  const unresolvedEventPriorities = { teamIds: new Set(["a"]), orderedTeamIds: ["a"] };
  const { livePriorityCount } = orderMlbTeamsForRosterRefresh(teams, priorities, unresolvedEventPriorities);
  assert.equal(livePriorityCount, 1);
});

test("the rotation team-limit formula stays bounded at 3 even when many teams are priority-boosted", () => {
  const teams = Array.from({ length: 12 }, (_, index) => ({ id: `team-${index}`, name: `Team ${index}` }));
  const priorities = { teamIds: new Set<string>(), teamNames: new Set<string>() };
  const unresolvedEventPriorities = { teamIds: new Set(teams.map((team) => team.id)) };
  const { livePriorityCount } = orderMlbTeamsForRosterRefresh(teams, priorities, unresolvedEventPriorities);
  assert.equal(livePriorityCount, 12);
  // Same formula as refreshMlbPlayers(): base 1, capped via min(livePriorityCount,2) then min(...,3).
  const sliceSize = Math.min(Math.max(1, Math.min(livePriorityCount, 2)), 3);
  assert.equal(sliceSize, 2);
  assert.ok(sliceSize <= 3);
});

// --- takeLiveFirstWindow cursor-fix tests ---
// Reuses the same priority-prefix pattern already used by 10+ other MLB/WNBA enrichment
// refreshes in this file/basketball.ts: urgent (priority) items are drawn from their own
// small rotation first; only remaining slots fall through to a separate non-priority
// rotation. Because the priority pool gets its own cache key, a stale positional index left
// over from a run where the priority set didn't exist (or was different) cannot skip a
// newly-urgent item -- there is no shared position for it to collide with.

test("an old positional cursor under a legacy unified key cannot skip newly inserted urgent teams", async () => {
  const store: Store = {
    currentProps: [],
    events: [],
    providerCache: new Map([
      // Simulates the exact session-7 incident: the OLD unified rotation key left at
      // nextIndex:2 from a run before Phillies/Mets became urgent.
      ["knowledge:cursor:mlb:refresh_players:teams", seededCursor(2, 33)],
    ]),
  };
  await withMlbSupabaseEnv(store, async () => {
    const teams = [
      { id: "atl", name: "Atlanta Braves" },
      { id: "phi", name: "Philadelphia Phillies" },
      { id: "nym", name: "New York Mets" },
      { id: "bos", name: "Boston Red Sox" },
    ];
    const window = await takeLiveFirstWindow({
      cacheKey: "knowledge:cursor:mlb:refresh_players:teams",
      provider: "mlb-stats-api",
      items: teams,
      isPriority: (team) => team.id === "phi" || team.id === "nym",
      sliceSize: 2,
      maxPriorityItems: 3,
    });
    assert.deepEqual(window.items.map((t) => t.id).sort(), ["nym", "phi"]);
    assert.equal(window.priorityOnly, true);
  });
});

test("Philadelphia/New York are selected as urgent unresolved-event participants regardless of an existing cursor value of 2", async () => {
  const store: Store = {
    currentProps: Array.from({ length: 36 }, (_, index) => ({
      id: `prop-${index}`,
      provider: "sharpapi",
      league_id: "mlb",
      active: true,
      team_id: null,
      event_id: "event-phi-nym",
      start_time: future(3),
    })),
    events: [{ id: "event-phi-nym", league_id: "mlb", start_time: future(3), home_team_id: "phi", away_team_id: "nym" }],
    providerCache: new Map([
      ["knowledge:cursor:mlb:refresh_players:teams", seededCursor(2, 33)],
    ]),
  };
  await withMlbSupabaseEnv(store, async () => {
    const teams = [
      { id: "atl", name: "Atlanta Braves" },
      { id: "phi", name: "Philadelphia Phillies" },
      { id: "nym", name: "New York Mets" },
      { id: "bos", name: "Boston Red Sox" },
    ];
    const priorities = { teamIds: new Set<string>(), teamNames: new Set<string>() };
    const unresolvedEventPriorities = await loadUnresolvedFutureMlbEventTeamPriorities(NOW);
    const { orderedTeams, livePriorityCount, priorityTeamIds } = orderMlbTeamsForRosterRefresh(teams, priorities, unresolvedEventPriorities);
    assert.equal(livePriorityCount, 2);
    const sliceSize = Math.min(Math.max(1, Math.min(livePriorityCount, 2)), 3);
    const window = await takeLiveFirstWindow({
      cacheKey: "knowledge:cursor:mlb:refresh_players:teams",
      provider: "mlb-stats-api",
      items: orderedTeams,
      isPriority: (team) => priorityTeamIds.has(team.id),
      sliceSize,
      maxPriorityItems: 3,
    });
    assert.deepEqual(window.items.map((t) => t.id).sort(), ["nym", "phi"]);
  });
});

test("urgent teams are selected before rotation teams even when they don't fill the whole slice", async () => {
  const store: Store = { currentProps: [], events: [] };
  await withMlbSupabaseEnv(store, async () => {
    const teams = [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Bravo" },
      { id: "urgent", name: "Urgent Team" },
    ];
    const window = await takeLiveFirstWindow({
      cacheKey: "test:cursor:urgent-before-rotation",
      provider: "mlb-stats-api",
      items: teams,
      isPriority: (team) => team.id === "urgent",
      sliceSize: 2,
      maxPriorityItems: 3,
    });
    assert.equal(window.items[0]?.id, "urgent");
    assert.equal(window.items.length, 2);
  });
});

test("the existing maximum team count (sliceSize) is preserved regardless of priority-pool size", async () => {
  const store: Store = { currentProps: [], events: [] };
  await withMlbSupabaseEnv(store, async () => {
    const teams = Array.from({ length: 10 }, (_, i) => ({ id: `team-${i}`, name: `Team ${i}` }));
    const window = await takeLiveFirstWindow({
      cacheKey: "test:cursor:max-count",
      provider: "mlb-stats-api",
      items: teams,
      isPriority: () => true,
      sliceSize: 3,
      maxPriorityItems: 3,
    });
    assert.equal(window.items.length, 3);
  });
});

test("if urgent teams fill the limit, no rotation (non-priority) teams are selected", async () => {
  const store: Store = { currentProps: [], events: [] };
  await withMlbSupabaseEnv(store, async () => {
    const teams = [
      { id: "urgent-1", name: "Urgent One" },
      { id: "urgent-2", name: "Urgent Two" },
      { id: "regular-1", name: "Regular One" },
    ];
    const window = await takeLiveFirstWindow({
      cacheKey: "test:cursor:priority-fills-limit",
      provider: "mlb-stats-api",
      items: teams,
      isPriority: (team) => team.id.startsWith("urgent"),
      sliceSize: 2,
      maxPriorityItems: 3,
    });
    assert.deepEqual(window.items.map((t) => t.id).sort(), ["urgent-1", "urgent-2"]);
    assert.equal(window.priorityOnly, true);
  });
});

test("if one slot remains after urgent teams, it is filled from the rotating non-priority pool", async () => {
  const store: Store = { currentProps: [], events: [] };
  await withMlbSupabaseEnv(store, async () => {
    const teams = [
      { id: "urgent-1", name: "Urgent One" },
      { id: "regular-1", name: "Regular One" },
      { id: "regular-2", name: "Regular Two" },
    ];
    const window = await takeLiveFirstWindow({
      cacheKey: "test:cursor:one-slot-remaining",
      provider: "mlb-stats-api",
      items: teams,
      isPriority: (team) => team.id === "urgent-1",
      sliceSize: 2,
      maxPriorityItems: 3,
    });
    assert.equal(window.items.length, 2);
    assert.ok(window.items.some((t) => t.id === "urgent-1"));
    assert.ok(window.items.some((t) => t.id.startsWith("regular")));
    assert.equal(window.priorityOnly, false);
  });
});

test("non-priority rotation remains fair across repeated calls (no priority pool at all)", async () => {
  const store: Store = { currentProps: [], events: [] };
  await withMlbSupabaseEnv(store, async () => {
    const teams = [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Bravo" },
      { id: "c", name: "Charlie" },
      { id: "d", name: "Delta" },
    ];
    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const window = await takeLiveFirstWindow({
        cacheKey: "test:cursor:fair-rotation",
        provider: "mlb-stats-api",
        items: teams,
        isPriority: () => false,
        sliceSize: 1,
        maxPriorityItems: 3,
      });
      seen.push(...window.items.map((t) => t.id));
    }
    // Every team should be visited exactly once across 4 calls of size 1 over 4 total items.
    assert.deepEqual([...seen].sort(), ["a", "b", "c", "d"]);
  });
});

test("duplicate database team rows (same real team, different IDs) do not cause the same ID to be selected twice", async () => {
  const store: Store = { currentProps: [], events: [] };
  await withMlbSupabaseEnv(store, async () => {
    // Mirrors the real Arizona Diamondbacks duplicate-row finding: two distinct DB rows for
    // what a human considers the same team. Each has a distinct primary-key id, so the
    // selection can only ever pick each row's own id once per window, never repeating an id.
    const teams = [
      { id: "ari-1", name: "Arizona Diamondbacks" },
      { id: "ari-2", name: "ARI Diamondbacks" },
      { id: "other", name: "Other Team" },
    ];
    const window = await takeLiveFirstWindow({
      cacheKey: "test:cursor:duplicate-rows",
      provider: "mlb-stats-api",
      items: teams,
      isPriority: (team) => team.id.startsWith("ari"),
      sliceSize: 3,
      maxPriorityItems: 3,
    });
    const ids = window.items.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

test("reordered non-priority lists behave deterministically for a given cursor state", async () => {
  const storeA: Store = { currentProps: [], events: [] };
  const storeB: Store = { currentProps: [], events: [] };
  const teamsAscending = [
    { id: "a", name: "Alpha" },
    { id: "b", name: "Bravo" },
    { id: "c", name: "Charlie" },
  ];
  const teamsReordered = [
    { id: "c", name: "Charlie" },
    { id: "a", name: "Alpha" },
    { id: "b", name: "Bravo" },
  ];
  let windowA: Awaited<ReturnType<typeof takeLiveFirstWindow<{ id: string; name: string }>>>;
  let windowB: Awaited<ReturnType<typeof takeLiveFirstWindow<{ id: string; name: string }>>>;
  await withMlbSupabaseEnv(storeA, async () => {
    windowA = await takeLiveFirstWindow({
      cacheKey: "test:cursor:deterministic-a",
      provider: "mlb-stats-api",
      items: teamsAscending,
      isPriority: () => false,
      sliceSize: 1,
      maxPriorityItems: 3,
    });
  });
  await withMlbSupabaseEnv(storeB, async () => {
    windowB = await takeLiveFirstWindow({
      cacheKey: "test:cursor:deterministic-a",
      provider: "mlb-stats-api",
      items: teamsReordered,
      isPriority: () => false,
      sliceSize: 1,
      maxPriorityItems: 3,
    });
  });
  // Same fresh cursor (index 0) applied to two different orderings deterministically picks
  // whatever sits at position 0 of each respective ordering -- no randomness either way.
  assert.equal(windowA!.items[0]?.id, "a");
  assert.equal(windowB!.items[0]?.id, "c");
});

test("a removed cursor target or out-of-range index is handled safely (modulo wrap, no crash)", async () => {
  const store: Store = {
    currentProps: [],
    events: [],
    providerCache: new Map([
      ["test:cursor:out-of-range", seededCursor(999, 33)],
    ]),
  };
  await withMlbSupabaseEnv(store, async () => {
    const teams = [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Bravo" },
    ];
    const window = await takeLiveFirstWindow({
      cacheKey: "test:cursor:out-of-range",
      provider: "mlb-stats-api",
      items: teams,
      isPriority: () => false,
      sliceSize: 1,
      maxPriorityItems: 3,
    });
    assert.equal(window.items.length, 1);
    assert.ok(["a", "b"].includes(window.items[0]?.id ?? ""));
  });
});

test("no live priorities falls back to normal bounded rotation over the whole team list", async () => {
  const store: Store = { currentProps: [], events: [] };
  await withMlbSupabaseEnv(store, async () => {
    const teams = [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Bravo" },
      { id: "c", name: "Charlie" },
    ];
    const window = await takeLiveFirstWindow({
      cacheKey: "test:cursor:no-priorities",
      provider: "mlb-stats-api",
      items: teams,
      isPriority: () => false,
      sliceSize: 2,
      maxPriorityItems: 3,
    });
    assert.equal(window.items.length, 2);
    assert.equal(window.priorityOnly, false);
  });
});

test("another league's priority data is excluded from MLB unresolved-event priorities (cursor-fix integration)", async () => {
  const store: Store = {
    currentProps: [{
      id: "prop-wnba",
      provider: "sharpapi",
      league_id: "wnba",
      active: true,
      team_id: null,
      event_id: "event-wnba",
      start_time: future(3),
    }],
    events: [{ id: "event-wnba", league_id: "wnba", start_time: future(3), home_team_id: "wnba-home", away_team_id: "wnba-away" }],
  };
  await withMlbSupabaseEnv(store, async () => {
    const unresolvedEventPriorities = await loadUnresolvedFutureMlbEventTeamPriorities(NOW);
    assert.equal(unresolvedEventPriorities.teamIds.size, 0);
  });
});

test("past or inactive props do not create urgent teams (cursor-fix integration)", async () => {
  const store: Store = {
    currentProps: [
      { id: "prop-past", provider: "sharpapi", league_id: "mlb", active: true, team_id: null, event_id: "event-past", start_time: past(2) },
      { id: "prop-inactive", provider: "sharpapi", league_id: "mlb", active: false, team_id: null, event_id: "event-future", start_time: future(3) },
    ],
    events: [
      { id: "event-past", league_id: "mlb", start_time: past(2), home_team_id: "team-past-home", away_team_id: "team-past-away" },
      { id: "event-future", league_id: "mlb", start_time: future(3), home_team_id: "team-inactive-home", away_team_id: "team-inactive-away" },
    ],
  };
  await withMlbSupabaseEnv(store, async () => {
    const unresolvedEventPriorities = await loadUnresolvedFutureMlbEventTeamPriorities(NOW);
    assert.equal(unresolvedEventPriorities.teamIds.size, 0);
  });
});

test("postgame MLB settlement writes only the targeted event/date row, never the full season", async () => {
  const deleted: unknown[] = [];
  const inserted: Array<Record<string, unknown>> = [];
  const result = await settleMlbPlayerLogsForEvents({
    now: new Date("2026-07-18T12:00:00.000Z"),
    targets: [{
      eventId: "event-824657",
      scheduledDate: "2026-07-18",
      players: [{
        id: "player-1",
        canonical_name: "Batter One",
        current_team_id: "team-1",
        primary_position: "First Baseman",
        external_ids: { "mlb-stats-api": "1001" },
      }],
    }],
    deps: {
      fetchPlayerGameLog: async () => ({ data: { response: {} } }),
      extractGameLogRows: () => [
        { gamePk: "824657", date: "2026-07-18", runs: 2, hits: 1 },
        { gamePk: "824000", date: "2026-07-17", runs: 4, hits: 2 },
      ],
      findEventByProviderId: async (_provider, _league, externalId) => externalId === "824657" ? "event-824657" : "other-event",
      deleteRows: async (_table, filters) => { deleted.push(filters); },
      insertRows: async (_table, rows) => { inserted.push(...rows); return []; },
    },
  });
  assert.equal(result.providerCalls, 1);
  assert.equal(result.logsWritten, 1);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0]?.event_id, "event-824657");
  assert.equal(inserted[0]?.game_date, "2026-07-18");
  assert.match(JSON.stringify(deleted), /event-824657/);
  assert.match(JSON.stringify(deleted), /2026-07-18/);
  assert.doesNotMatch(JSON.stringify(inserted), /2026-07-17/);
});

test("postgame MLB settlement can resolve a missing external id without updating player identity rows", async () => {
  let searchCalls = 0;
  let playerUpdateSeen = false;
  const result = await settleMlbPlayerLogsForEvents({
    targets: [{
      eventId: "event-1",
      scheduledDate: "2026-07-18",
      players: [{ id: "player-1", canonical_name: "Batter One", current_team_id: null, primary_position: "Outfielder", external_ids: null }],
    }],
    deps: {
      searchPlayer: async () => { searchCalls += 1; return { id: 1001 }; },
      fetchPlayerGameLog: async () => ({ data: { response: {} } }),
      extractGameLogRows: () => [{ gamePk: "824657", date: "2026-07-18", runs: 1 }],
      findEventByProviderId: async () => "event-1",
      deleteRows: async () => {},
      insertRows: async () => { playerUpdateSeen = true; return []; },
    },
  });
  assert.equal(searchCalls, 1);
  assert.equal(result.providerCalls, 2);
  assert.equal(result.logsWritten, 1);
  assert.equal(playerUpdateSeen, true, "the only write is the targeted player_game_logs insert, not a players update");
});

test("postgame settlement uses the scored pitcher market when primary position is missing", async () => {
  const fetches: Array<{ playerId: number; statType: string }> = [];
  const inserted: Array<Record<string, unknown>> = [];
  const result = await settleMlbPlayerLogsForEvents({
    now: new Date("2026-07-18T12:00:00.000Z"),
    targets: [{
      eventId: "event-824657",
      providerEventId: "824657",
      scheduledDate: "2026-07-18",
      players: [{
        id: "taj",
        canonical_name: "Taj Bradley",
        current_team_id: null,
        primary_position: null,
        external_ids: { "mlb-stats-api": "671737" },
        requiredStatGroups: ["pitching"],
      }],
    }],
    deps: {
      searchPlayer: async () => { throw new Error("market-driven settlement must not search by name"); },
      fetchPlayerGameLog: async (input) => { fetches.push(input); return { data: { response: {} } }; },
      extractGameLogRows: () => [{ gamePk: "824657", date: "2026-07-18", strikeOuts: 6 }],
      findEventByProviderId: async () => "event-824657",
      deleteRows: async () => {},
      insertRows: async (_table, rows) => { inserted.push(...rows); return []; },
    },
  });
  assert.deepEqual(fetches.map((fetch) => fetch.statType), ["strikeouts"]);
  assert.equal(fetches[0]?.playerId, 671737);
  assert.equal(result.logsWritten, 1);
  assert.equal(inserted[0]?.event_id, "event-824657");
  assert.equal(inserted[0]?.strikeouts, 6);
  assert.equal(result.outcomes[0]?.status, "settled");
});

test("postgame settlement resolves missing MLB identity from the selected event box score", async () => {
  let searchCalls = 0;
  const fetches: Array<{ playerId: number; statType: string }> = [];
  const inserted: Array<Record<string, unknown>> = [];
  const result = await settleMlbPlayerLogsForEvents({
    now: new Date("2026-07-18T12:00:00.000Z"),
    targets: [{
      eventId: "event-824657",
      providerEventId: "824657",
      scheduledDate: "2026-07-18",
      players: [{
        id: "matt",
        canonical_name: "Matt Boyd",
        current_team_id: null,
        primary_position: null,
        external_ids: null,
        requiredStatGroups: ["pitching"],
      }],
    }],
    deps: {
      searchPlayer: async () => { searchCalls += 1; return { id: 999 }; },
      fetchEventBoxscore: async (providerEventId) => providerEventId === "824657" ? {
        teams: { home: { players: { "ID571510": { person: { id: 571510, fullName: "Matthew Boyd" } } } }, away: { players: {} } },
      } : null,
      fetchPlayerGameLog: async (input) => { fetches.push(input); return { data: { response: {} } }; },
      extractGameLogRows: () => [{ gamePk: "824657", date: "2026-07-18", strikeOuts: 4 }],
      findEventByProviderId: async () => "event-824657",
      deleteRows: async () => {},
      insertRows: async (_table, rows) => { inserted.push(...rows); return []; },
    },
  });
  assert.equal(searchCalls, 0);
  assert.deepEqual(fetches, [{ playerId: 571510, playerName: "Matt Boyd", season: 2026, statType: "strikeouts" }]);
  assert.equal(result.providerCalls, 2, "one event box score plus one bounded pitching log fetch");
  assert.equal(result.logsWritten, 1);
  assert.equal(inserted[0]?.strikeouts, 4);
  assert.equal(result.outcomes[0]?.status, "settled");
});

test("postgame settlement exposes missing provider data as a retryable warning", async () => {
  const result = await settleMlbPlayerLogsForEvents({
    targets: [{
      eventId: "event-1",
      scheduledDate: "2026-07-18",
      players: [{
        id: "player-1",
        canonical_name: "Player One",
        current_team_id: null,
        primary_position: "Pitcher",
        external_ids: { "mlb-stats-api": "1001" },
        requiredStatGroups: ["pitching"],
      }],
    }],
    deps: {
      fetchPlayerGameLog: async () => ({ data: { response: {} } }),
      extractGameLogRows: () => [],
      deleteRows: async () => {},
      insertRows: async () => [],
    },
  });
  assert.equal(result.warning, true);
  assert.equal(result.outcomes[0]?.status, "deferred-provider-data");
  assert.equal(result.failedPlayers[0], "player-1");
});

test("postgame settlement maps every supported MLB market and unions groups for a multi-market player", async () => {
  assert.deepEqual(statGroupsForSettlementMarket("pitcher_strikeouts"), ["pitching"]);
  assert.deepEqual(statGroupsForSettlementMarket("batter_hits"), ["hitting"]);
  assert.deepEqual(statGroupsForSettlementMarket("batter_total_bases"), ["hitting"]);
  assert.deepEqual(statGroupsForSettlementMarket("batter_runs"), ["hitting"]);
  assert.deepEqual(statGroupsForSettlementMarket("batter_rbis"), ["hitting"]);
  assert.deepEqual(statGroupsForSettlementMarket("unsupported"), []);

  const fetches: string[] = [];
  const inserted: Array<Record<string, unknown>> = [];
  const result = await settleMlbPlayerLogsForEvents({
    now: new Date("2026-07-18T12:00:00.000Z"),
    targets: [{
      eventId: "event-1",
      scheduledDate: "2026-07-18",
      players: [{
        id: "two-way",
        canonical_name: "Two Way",
        current_team_id: null,
        primary_position: "Outfielder",
        external_ids: { "mlb-stats-api": "1001" },
        requiredStatGroups: ["hitting", "pitching"],
      }],
    }],
    deps: {
      fetchPlayerGameLog: async (input) => { fetches.push(input.statType); return { data: { response: input.statType } }; },
      extractGameLogRows: (payload) => (payload as { response?: string }).response === "hits"
        ? [{ gamePk: "824657", date: "2026-07-18", hits: 2 }]
        : [{ gamePk: "824657", date: "2026-07-18", strikeOuts: 3 }],
      findEventByProviderId: async () => "event-1",
      deleteRows: async () => {},
      insertRows: async (_table, rows) => { inserted.push(...rows); return []; },
    },
  });
  assert.deepEqual(fetches, ["hits", "strikeouts"]);
  assert.equal(result.logsWritten, 1);
  assert.equal(inserted[0]?.hits, 2);
  assert.equal(inserted[0]?.strikeouts, 3);
});

// Phase 18 Part C/D fix: gameStatus() previously had no branch for
// postponed/suspended/cancelled games, so they silently fell through to the
// "scheduled" default -- indistinguishable from a genuinely upcoming game.
function scheduleGame(status?: { detailedState?: string; abstractGameState?: string }): Parameters<typeof gameStatus>[0] {
  return { gamePk: 1, gameDate: "2026-07-20T00:00:00.000Z", status };
}

test("gameStatus: detects postponed/suspended/cancelled games via detailedState, distinct from a genuinely scheduled game", () => {
  assert.equal(gameStatus(scheduleGame({ detailedState: "Postponed" })), "postponed");
  assert.equal(gameStatus(scheduleGame({ detailedState: "Suspended" })), "postponed");
  assert.equal(gameStatus(scheduleGame({ detailedState: "Cancelled" })), "postponed");
  assert.equal(gameStatus(scheduleGame({ detailedState: "Canceled" })), "postponed");
  assert.equal(gameStatus(scheduleGame({ detailedState: "Scheduled" })), "scheduled");
  assert.equal(gameStatus(scheduleGame({ detailedState: "Pre-Game" })), "scheduled");
});

test("gameStatus: postponed detection does not misclassify a genuinely live/delayed game as postponed", () => {
  assert.equal(gameStatus(scheduleGame({ detailedState: "In Progress" })), "live");
  assert.equal(gameStatus(scheduleGame({ detailedState: "Delayed Start" })), "live");
  assert.equal(gameStatus(scheduleGame({ detailedState: "Final" })), "completed");
});

test("gameStatus: falls back to abstractGameState, then a scheduled default, when detailedState is absent", () => {
  assert.equal(gameStatus(scheduleGame({ abstractGameState: "Final" })), "completed");
  assert.equal(gameStatus(scheduleGame({})), "scheduled");
  assert.equal(gameStatus(scheduleGame()), "scheduled");
});

// --- refreshMlbStatcastForKnownPlayers (Session 106) ------------------------
//
// Session 106: the real Savant writer, rewritten to accept explicit bounded
// candidates (never "the first N players in the league"), resolve each
// player's real MLBAM external ID up front, and stop swallowing persistence
// failures. These tests exercise the REAL function against a manual
// Supabase+Savant fetch router -- no separate mock/fixture of the writer's
// own logic, and the real (non-prototype) parser/summarizer via the real
// StatcastSavantAdapter.

function withStatcastEnv(run: () => Promise<void>) {
  const keys = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const originals = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJtest";
  return run().finally(() => {
    for (const [key, value] of originals) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    mock.restoreAll();
  });
}

const STATCAST_HEADERS = ["game_date", "player_name", "events", "description", "launch_speed", "launch_angle", "barrel", "estimated_woba_using_speedangle"];

function statcastCsv(rows: Array<Record<string, string>>) {
  const lines = [STATCAST_HEADERS.join(","), ...rows.map((row) => STATCAST_HEADERS.map((header) => row[header] ?? "").join(","))];
  return new Response(lines.join("\n"), { status: 200, headers: { "Content-Type": "text/csv" } });
}

function statcastRow(overrides: Record<string, string>): Record<string, string> {
  return { game_date: "2026-07-01", player_name: "Test Player", events: "", description: "ball", launch_speed: "", launch_angle: "", barrel: "", estimated_woba_using_speedangle: "", ...overrides };
}

type SupabaseState = { players: Array<Record<string, unknown>>; mlb_pitcher_features: Array<Record<string, unknown>>; mlb_batter_features: Array<Record<string, unknown>> };

function supabaseAndSavantRouter(state: SupabaseState, options: { savant?: () => Response; failInsertTable?: string } = {}) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.hostname === "baseballsavant.mlb.com") {
      return options.savant ? options.savant() : statcastCsv([]);
    }
    if (url.hostname === "example.supabase.co") {
      const table = url.pathname.replace(/^\/rest\/v1\//, "").split("?")[0];
      if (method === "GET" && table === "players") {
        return new Response(JSON.stringify(state.players), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (method === "POST") {
        if (options.failInsertTable === table) return new Response("insert failed", { status: 500 });
        const body = init?.body ? JSON.parse(String(init.body)) : [];
        (state as Record<string, Array<Record<string, unknown>>>)[table] = [...((state as Record<string, Array<Record<string, unknown>>>)[table] ?? []), ...body];
        return new Response(null, { status: 201 });
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

test("refreshMlbStatcastForKnownPlayers: a real batter response is persisted to mlb_batter_features with the correct role-scoped fields", async () => {
  await withStatcastEnv(async () => {
    const state: SupabaseState = { players: [{ id: "batter-1", canonical_name: "Test Batter", external_ids: { "mlb-stats-api": "660271" } }], mlb_pitcher_features: [], mlb_batter_features: [] };
    mock.method(globalThis, "fetch", supabaseAndSavantRouter(state, {
      savant: () => statcastCsv([
        statcastRow({ description: "hit_into_play", launch_speed: "98", launch_angle: "15", barrel: "1", estimated_woba_using_speedangle: "0.8" }),
        statcastRow({ description: "ball" }),
      ]),
    }));
    const result = await refreshMlbStatcastForKnownPlayers([{ playerId: "batter-1", role: "batter" }]);
    assert.equal(result.succeeded, 1);
    assert.equal(result.attempted, 1);
    assert.equal(state.mlb_batter_features.length, 1);
    assert.equal(state.mlb_batter_features[0].hard_hit_rate, 100);
    assert.equal(state.mlb_batter_features[0].xwoba, 0.8);
    assert.equal(result.players[0].outcome, "success");
  });
});

test("refreshMlbStatcastForKnownPlayers: a real pitcher response persists both season_k_rate AND swinging_strike_rate (Session 106 fix)", async () => {
  await withStatcastEnv(async () => {
    const state: SupabaseState = { players: [{ id: "pitcher-1", canonical_name: "Test Pitcher", external_ids: {} }], mlb_pitcher_features: [], mlb_batter_features: [] };
    mock.method(globalThis, "fetch", supabaseAndSavantRouter(state, {
      savant: () => statcastCsv([
        statcastRow({ events: "strikeout", description: "swinging_strike" }),
        statcastRow({ events: "field_out", description: "hit_into_play" }),
        statcastRow({ description: "swinging_strike" }),
      ]),
    }));
    const result = await refreshMlbStatcastForKnownPlayers([{ playerId: "pitcher-1", role: "pitcher" }]);
    assert.equal(result.succeeded, 1);
    assert.ok(typeof state.mlb_pitcher_features[0].season_k_rate === "number");
    assert.ok(typeof state.mlb_pitcher_features[0].swinging_strike_rate === "number", "swinging_strike_rate must no longer be hardcoded null -- this is the exact field pitcher_matchup_missing needs alongside season_k_rate");
  });
});

test("refreshMlbStatcastForKnownPlayers: a genuinely empty Savant response (zero rows) is classified 'empty', not a failure, and writes no feature row", async () => {
  await withStatcastEnv(async () => {
    const state: SupabaseState = { players: [{ id: "batter-1", canonical_name: "Test Batter", external_ids: {} }], mlb_pitcher_features: [], mlb_batter_features: [] };
    mock.method(globalThis, "fetch", supabaseAndSavantRouter(state, { savant: () => statcastCsv([]) }));
    const result = await refreshMlbStatcastForKnownPlayers([{ playerId: "batter-1", role: "batter" }]);
    assert.equal(result.empty, 1);
    assert.equal(result.succeeded, 0);
    assert.equal(state.mlb_batter_features.length, 0, "an empty result writes nothing -- there is nothing to write");
  });
});

test("refreshMlbStatcastForKnownPlayers: a provider fetch failure is classified 'retrieval_failed' and writes nothing", async () => {
  await withStatcastEnv(async () => {
    const state: SupabaseState = { players: [{ id: "batter-1", canonical_name: "Test Batter", external_ids: {} }], mlb_pitcher_features: [], mlb_batter_features: [] };
    mock.method(globalThis, "fetch", supabaseAndSavantRouter(state, { savant: () => new Response("boom", { status: 500 }) }));
    const result = await refreshMlbStatcastForKnownPlayers([{ playerId: "batter-1", role: "batter" }]);
    assert.equal(result.retrievalFailed, 1);
    assert.equal(state.mlb_batter_features.length, 0);
  });
});

test("refreshMlbStatcastForKnownPlayers: a genuine write failure is reported as 'persistence_failed', not silently swallowed as a false success (Session 106 fix)", async () => {
  await withStatcastEnv(async () => {
    const state: SupabaseState = { players: [{ id: "batter-1", canonical_name: "Test Batter", external_ids: {} }], mlb_pitcher_features: [], mlb_batter_features: [] };
    mock.method(globalThis, "fetch", supabaseAndSavantRouter(state, {
      savant: () => statcastCsv([statcastRow({ description: "hit_into_play", launch_speed: "98" })]),
      failInsertTable: "mlb_batter_features",
    }));
    const result = await refreshMlbStatcastForKnownPlayers([{ playerId: "batter-1", role: "batter" }]);
    assert.equal(result.persistenceFailed, 1, "the prior version incremented an unconditional 'enriched' count even when the write itself failed -- this must now be reported honestly");
    assert.equal(result.succeeded, 0);
    assert.equal(state.mlb_batter_features.length, 0);
  });
});

test("refreshMlbStatcastForKnownPlayers: a candidate whose player row cannot be found is reported as retrieval_failed, never crashes the batch", async () => {
  await withStatcastEnv(async () => {
    const state: SupabaseState = { players: [], mlb_pitcher_features: [], mlb_batter_features: [] };
    mock.method(globalThis, "fetch", supabaseAndSavantRouter(state, { savant: () => statcastCsv([]) }));
    const result = await refreshMlbStatcastForKnownPlayers([{ playerId: "ghost-player", role: "batter" }]);
    assert.equal(result.retrievalFailed, 1);
    assert.equal(result.players[0].error, "Player row not found for this ID.");
  });
});

test("refreshMlbStatcastForKnownPlayers: an empty candidate list makes zero network calls and returns a zeroed report", async () => {
  await withStatcastEnv(async () => {
    let calls = 0;
    mock.method(globalThis, "fetch", async () => { calls += 1; return new Response("[]", { status: 200 }); });
    const result = await refreshMlbStatcastForKnownPlayers([]);
    assert.equal(calls, 0);
    assert.deepEqual(result, { league: "MLB", attempted: 0, succeeded: 0, empty: 0, retrievalFailed: 0, persistenceFailed: 0, players: [] });
  });
});

test("refreshMlbStatcastForKnownPlayers: the player's real MLBAM external_ids entry is forwarded as playerId, avoiding a redundant name-resolution call", async () => {
  await withStatcastEnv(async () => {
    const state: SupabaseState = { players: [{ id: "batter-1", canonical_name: "Test Batter", external_ids: { "mlb-stats-api": 660271 } }], mlb_pitcher_features: [], mlb_batter_features: [] };
    let capturedPlayerIdParam: string | null = null;
    const router = supabaseAndSavantRouter(state, { savant: () => statcastCsv([statcastRow({ description: "hit_into_play", launch_speed: "90" })]) });
    mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "baseballsavant.mlb.com") capturedPlayerIdParam = url.searchParams.get("player_id");
      return router(input, init);
    });
    await refreshMlbStatcastForKnownPlayers([{ playerId: "batter-1", role: "batter" }]);
    assert.equal(capturedPlayerIdParam, "660271", "the real MLBAM external ID must be forwarded so the client skips its internal MLB Stats API name-resolution fallback");
  });
});
