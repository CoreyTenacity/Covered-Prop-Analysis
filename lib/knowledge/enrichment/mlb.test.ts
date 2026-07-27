import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { allocateBoundedClassSlots, classifyMlbPlayerForLogs, compareMlbLivePlayerStartTimes, loadUnresolvedFutureMlbEventTeamPriorities, orderMlbTeamsForRosterRefresh, settleMlbPlayerLogsForEvents, statGroupsForSettlementMarket, takeLiveFirstWindow } from "./mlb.ts";

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
