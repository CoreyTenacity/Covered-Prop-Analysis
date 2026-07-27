import assert from "node:assert/strict";
import test from "node:test";
import {
  resultFor,
  finalStatForMarket,
  normalizeMarketType,
  supportedMarket,
  isCompletedStatus,
  gradeCompletedScoredProps,
  gradeRecentCompletions,
  type GradeRecentCompletionsResult,
} from "./grading-service.ts";

// ---- pure outcome semantics ----

test("resultFor: More side = OVER wins, UNDER loses, exact line pushes", () => {
  assert.equal(resultFor("More", 1.5, 2), "win");
  assert.equal(resultFor("More", 1.5, 1), "loss");
  assert.equal(resultFor("More", 2, 2), "push");
});

test("resultFor: Less side = UNDER wins, OVER loses, exact line pushes", () => {
  assert.equal(resultFor("Less", 1.5, 1), "win");
  assert.equal(resultFor("Less", 1.5, 2), "loss");
  assert.equal(resultFor("Less", 2, 2), "push");
});

test("finalStatForMarket: MLB markets read the correct batter/pitcher stat", () => {
  const log = { hits: 2, total_bases: 4, strikeouts: 7, runs: 1, rbis: 3 } as never;
  assert.equal(finalStatForMarket("batter_hits", log), 2);
  assert.equal(finalStatForMarket("batter_total_bases", log), 4);
  assert.equal(finalStatForMarket("pitcher_strikeouts", log), 7);
  assert.equal(finalStatForMarket("batter_runs", log), 1);
  assert.equal(finalStatForMarket("batter_rbis", log), 3);
});

test("finalStatForMarket: WNBA markets incl. PRA sum and threes from stat_line", () => {
  const log = { points: 20, rebounds: 8, assists: 5, stat_line: { threes_made: 3 } } as never;
  assert.equal(finalStatForMarket("player_points", log), 20);
  assert.equal(finalStatForMarket("player_rebounds", log), 8);
  assert.equal(finalStatForMarket("player_assists", log), 5);
  assert.equal(finalStatForMarket("player_pra", log), 33);
  assert.equal(finalStatForMarket("player_threes", log), 3);
});

test("normalizeMarketType maps legacy aliases; supportedMarket gates by league", () => {
  assert.equal(normalizeMarketType("player_strikeouts"), "pitcher_strikeouts");
  assert.equal(normalizeMarketType("player_hits"), "batter_hits");
  assert.equal(normalizeMarketType("player_points_rebounds_assists"), "player_pra");
  assert.equal(supportedMarket("mlb", "batter_hits"), true);
  assert.equal(supportedMarket("mlb", "player_points"), false);
  assert.equal(supportedMarket("wnba", "player_points"), true);
  assert.equal(supportedMarket("wnba", "batter_hits"), false);
  assert.equal(supportedMarket("nfl", "anything"), false);
});

test("isCompletedStatus recognizes completed/final/closed only", () => {
  for (const s of ["completed", "final", "closed", "FINAL"]) assert.equal(isCompletedStatus(s), true);
  for (const s of ["scheduled", "in_progress", "", null, undefined]) assert.equal(isCompletedStatus(s as never), false);
});

test("gradeCompletedScoredProps resolves market and outcomes from current_props without requesting scored_props.market_type", async () => {
  const calls: Array<{ table: string; options: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; rows: Array<Record<string, unknown>> }> = [];
  const props = [
    { id: "scored-over", current_prop_id: "prop-over", model_version_id: null, participant_id: null, participant_type: null, player_id: "player-over", event_id: "event-824657", game_id: null, market_id: null, line: 1.5, risk_flags: [], league_id: "mlb", sport_id: "baseball", created_at: "2026-07-18T01:00:00.000Z" },
    { id: "scored-under", current_prop_id: "prop-under", model_version_id: null, participant_id: null, participant_type: null, player_id: "player-under", event_id: "event-824657", game_id: null, market_id: null, line: 1.5, risk_flags: [], league_id: "mlb", sport_id: "baseball", created_at: "2026-07-18T01:00:00.000Z" },
    { id: "scored-push", current_prop_id: "prop-push", model_version_id: null, participant_id: null, participant_type: null, player_id: "player-push", event_id: "event-824657", game_id: null, market_id: null, line: 2, risk_flags: [], league_id: "mlb", sport_id: "baseball", created_at: "2026-07-18T01:00:00.000Z" },
  ];
  const currentProps = [
    { id: "prop-over", latest_snapshot_id: "snapshot-1", market_type: "batter_hits", side: "More", direction: "More", event_id: "event-824657", game_id: null, player_id: "player-over", participant_id: null, participant_type: null, league_id: "mlb", sport_id: "baseball" },
    { id: "prop-under", latest_snapshot_id: "snapshot-1", market_type: "batter_runs", side: "Less", direction: "Less", event_id: "event-824657", game_id: null, player_id: "player-under", participant_id: null, participant_type: null, league_id: "mlb", sport_id: "baseball" },
    { id: "prop-push", latest_snapshot_id: "snapshot-1", market_type: "batter_rbis", side: "More", direction: "More", event_id: "event-824657", game_id: null, player_id: "player-push", participant_id: null, participant_type: null, league_id: "mlb", sport_id: "baseball" },
  ];
  const logs = [
    { id: "log-over", hits: 2, total_bases: null, runs: null, rbis: null, strikeouts: null, stat_line: {} },
    { id: "log-under", hits: null, total_bases: null, runs: 2, rbis: null, strikeouts: null, stat_line: {} },
    { id: "log-push", hits: null, total_bases: null, runs: null, rbis: 2, strikeouts: null, stat_line: {} },
  ];
  const result = await gradeCompletedScoredProps({
    league: "mlb",
    eventId: "event-824657",
    deps: {
      selectRows: async <T>(table: string, options: Record<string, unknown> = {}) => {
        calls.push({ table, options });
        if (table === "scored_props") return props as T[];
        if (table === "grading_results") return [] as T[];
        if (table === "current_props") return currentProps.filter((row) => String((options.filters as Array<{ value?: unknown }> | undefined)?.[0]?.value) === row.id) as T[];
        if (table === "events") return [{ id: "event-824657", status: "completed", scheduled_date: "2026-07-18", start_time: "2026-07-18T01:00:00.000Z" }] as T[];
        if (table === "player_game_logs") return logs.filter((row) => String((options.filters as Array<{ value?: unknown }> | undefined)?.[0]?.value) === `player-${row.id.slice(4)}`) as T[];
        return [] as T[];
      },
      insertRows: async <T extends Record<string, unknown>>(table: string, rows: T[]) => {
        inserts.push({ table, rows });
        return [];
      },
    },
  });
  const scoredQuery = calls.find((call) => call.table === "scored_props");
  assert.equal(scoredQuery?.options.select, "id,current_prop_id,model_version_id,participant_id,participant_type,player_id,event_id,game_id,market_id,line,risk_flags,league_id,sport_id,created_at");
  assert.deepEqual(result.map((row) => row.result), ["win", "loss", "push"]);
  assert.deepEqual(inserts.map((entry) => entry.rows[0]?.market_type), ["batter_hits", "batter_runs", "batter_rbis"]);
});

test("gradeCompletedScoredProps defers a missing final stat without writing a terminal result", async () => {
  let insertCount = 0;
  const result = await gradeCompletedScoredProps({
    league: "mlb",
    eventId: "event-824657",
    deps: {
      selectRows: async <T>(table: string) => {
        if (table === "scored_props") return [{ id: "scored-1", current_prop_id: "prop-1", model_version_id: null, participant_id: null, participant_type: null, player_id: "player-1", event_id: "event-824657", game_id: null, market_id: null, line: 1.5, risk_flags: [], league_id: "mlb", sport_id: "baseball", created_at: "2026-07-18T01:00:00.000Z" }] as T[];
        if (table === "current_props") return [{ id: "prop-1", latest_snapshot_id: "snapshot-1", market_type: "batter_hits", side: "More", direction: "More", event_id: "event-824657", game_id: null, player_id: "player-1", participant_id: null, participant_type: null, league_id: "mlb", sport_id: "baseball" }] as T[];
        if (table === "events") return [{ id: "event-824657", status: "final", scheduled_date: "2026-07-18", start_time: "2026-07-18T01:00:00.000Z" }] as T[];
        if (table === "grading_results") return [] as T[];
        if (table === "player_game_logs") return [{ id: "log-1", hits: null, total_bases: null, runs: null, rbis: null, strikeouts: null, stat_line: {} }] as T[];
        return [] as T[];
      },
      insertRows: async () => { insertCount += 1; return []; },
    },
  });
  assert.equal(result[0]?.gradeStatus, "deferred");
  assert.equal(result[0]?.gradeReason, "missing_final_stat");
  assert.equal(insertCount, 0);
});

// ---- bounded recurring wrapper (gradeRecentCompletions) ----

// A table-dispatching selectRows mock. `events` returns the candidate list; per-event `scored_props` and
// `grading_results` counts drive the ungraded/skip decision.
function makeSelect(config: {
  events: Array<{ id: string }>;
  scoredByEvent: Record<string, number>;
  recordedByEvent: Record<string, number>;
}) {
  return (async (table: string, opts: { filters?: Array<{ column?: string; value?: unknown } | { raw: string }> }) => {
    if (table === "events") return config.events as never;
    const eventId = String((opts.filters ?? []).map((f) => ("column" in f && f.column === "event_id" ? f.value : null)).find(Boolean) ?? "");
    if (table === "scored_props") return Array.from({ length: config.scoredByEvent[eventId] ?? 0 }, (_, i) => ({ id: `${eventId}-sp-${i}` })) as never;
    if (table === "grading_results") return Array.from({ length: config.recordedByEvent[eventId] ?? 0 }, (_, i) => ({ id: `${eventId}-gr-${i}` })) as never;
    return [] as never;
  }) as never;
}

test("gradeRecentCompletions: no completed events -> cheap no-op, no state change", async () => {
  let gradeCalls = 0;
  const out = await gradeRecentCompletions({
    league: "mlb",
    deps: { selectRows: makeSelect({ events: [], scoredByEvent: {}, recordedByEvent: {} }), grade: (async () => { gradeCalls += 1; return []; }) as never },
  });
  assert.equal(out.eventsScanned, 0);
  assert.equal(out.eventsProcessed, 0);
  assert.equal(out.changedState, false);
  assert.equal(gradeCalls, 0);
});

test("gradeRecentCompletions: caps at maxEvents per invocation (rest continue next cycle)", async () => {
  const events = Array.from({ length: 12 }, (_, i) => ({ id: `e${i}` }));
  const scoredByEvent = Object.fromEntries(events.map((e) => [e.id, 3]));
  const recordedByEvent = Object.fromEntries(events.map((e) => [e.id, 0])); // all ungraded
  let gradeCalls = 0;
  const out = await gradeRecentCompletions({
    league: "mlb",
    maxEvents: 4,
    candidateLimit: 12,
    deps: {
      selectRows: makeSelect({ events, scoredByEvent, recordedByEvent }),
      grade: (async () => { gradeCalls += 1; return [{ gradeStatus: "graded" }, { gradeStatus: "graded" }, { gradeStatus: "graded" }]; }) as never,
    },
  });
  assert.equal(out.eventsProcessed, 4, "only maxEvents events processed");
  assert.equal(gradeCalls, 4);
  assert.equal(out.graded, 12);
  assert.equal(out.cappedByMaxEvents, true);
  assert.equal(out.changedState, true);
});

test("gradeRecentCompletions: fully-recorded events are skipped (forward progress, no re-scan)", async () => {
  const events = [{ id: "done" }, { id: "todo" }];
  let gradedEventIds: string[] = [];
  const out = await gradeRecentCompletions({
    league: "wnba",
    maxEvents: 5,
    deps: {
      selectRows: makeSelect({ events, scoredByEvent: { done: 3, todo: 3 }, recordedByEvent: { done: 3, todo: 0 } }),
      grade: (async (o: { eventId: string }) => { gradedEventIds.push(o.eventId); return [{ gradeStatus: "graded" }]; }) as never,
    },
  });
  assert.deepEqual(gradedEventIds, ["todo"], "the fully-recorded event is skipped, only the ungraded one is graded");
  assert.equal(out.eventsProcessed, 1);
});

test("gradeRecentCompletions: deferred outcomes do not change state (retried next cycle)", async () => {
  const out = await gradeRecentCompletions({
    league: "mlb",
    deps: {
      selectRows: makeSelect({ events: [{ id: "e1" }], scoredByEvent: { e1: 2 }, recordedByEvent: { e1: 0 } }),
      grade: (async () => [{ gradeStatus: "deferred" }, { gradeStatus: "deferred" }]) as never,
    },
  });
  assert.equal(out.deferred, 2);
  assert.equal(out.graded, 0);
  assert.equal(out.noGrade, 0);
  assert.equal(out.changedState, false, "a run that only deferred did not change persisted state");
});
