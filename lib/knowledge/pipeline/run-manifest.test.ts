import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRunManifest,
  selectActiveWorkSet,
  WORK_SET_SAFETY_LIMIT,
  type ManifestProp,
} from "./run-manifest.ts";

// Phase A characterization: the canonical RunManifest must fix the coverage
// truncation class and behave deterministically. These tests compare the
// manifest's selection against the old asc+limit behaviour on identical inputs.

const NOW = Date.parse("2026-07-17T18:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 60 * 60 * 1000;

function prop(overrides: Partial<ManifestProp> & { id: string }): ManifestProp {
  return {
    id: overrides.id,
    player_id: overrides.player_id ?? `pl-${overrides.id}`,
    participant_id: overrides.participant_id ?? null,
    team_id: overrides.team_id ?? `tm-${overrides.id}`,
    opponent_team_id: overrides.opponent_team_id ?? `op-${overrides.id}`,
    event_id: overrides.event_id ?? `ev-${overrides.id}`,
    start_time: "start_time" in overrides ? overrides.start_time! : iso(NOW + 3 * HOUR),
    market_type: overrides.market_type ?? "player_points",
    provider_market_type: overrides.provider_market_type ?? "player_points",
    line: overrides.line ?? 15.5,
    direction: overrides.direction ?? "over",
    side: overrides.side ?? "over",
    player_name: overrides.player_name ?? "Player",
    team_name: overrides.team_name ?? "Team",
    opponent_name: overrides.opponent_name ?? "Opp",
    match_status: overrides.match_status ?? "matched",
    match_confidence: overrides.match_confidence ?? 0.9,
    updated_at: overrides.updated_at ?? iso(NOW - HOUR),
  };
}

// A Postgres-faithful stand-in for the manifest's query: honours active +
// start_time>=earliest, orders start_time.asc, caps at the limit - exactly what
// buildRunManifest's real query does.
function pgLoader(all: ManifestProp[]) {
  return async (_league: "MLB" | "WNBA", earliestIso: string) => {
    const earliest = Date.parse(earliestIso);
    return all
      .filter((r) => r.start_time != null && Date.parse(r.start_time) >= earliest)
      .sort((a, b) => Date.parse(a.start_time as string) - Date.parse(b.start_time as string))
      .slice(0, WORK_SET_SAFETY_LIMIT);
  };
}

// The OLD loadActivePropCoverage behaviour, for contrast: fetch active rows
// ordered start_time.asc, cap at 400, THEN window-filter in JS.
function oldStyleSelection(all: ManifestProp[], now: number): ManifestProp[] {
  const page = all
    .filter((r) => r.start_time != null)
    .sort((a, b) => Date.parse(a.start_time as string) - Date.parse(b.start_time as string))
    .slice(0, 400);
  return page.filter((r) => {
    const s = Date.parse(r.start_time as string);
    return s >= now - 2 * HOUR && s <= now + 36 * HOUR;
  });
}

test("REGRESSION: a stale-active backlog truncates current props under the old asc+limit-400, but the manifest keeps them", async () => {
  // 450 past-game props still active=true (start 3-32 days ago) + 3 current.
  const backlog = Array.from({ length: 450 }, (_, i) =>
    prop({ id: `past-${i}`, start_time: iso(NOW - (3 + (i % 30)) * 24 * HOUR) }),
  );
  const current = [
    prop({ id: "cur-1", team_id: "team-H", opponent_team_id: "team-A", event_id: "event-1", player_id: "player-A" }),
    prop({ id: "cur-2", team_id: "team-H", opponent_team_id: "team-A", event_id: "event-1", player_id: "player-B" }),
    prop({ id: "cur-3", team_id: "team-A", opponent_team_id: "team-H", event_id: "event-1", player_id: "player-C" }),
  ];
  const all = [...backlog, ...current];

  // Old behaviour: the oldest 400 fill the page -> zero current props survive.
  assert.equal(oldStyleSelection(all, NOW).length, 0);

  // Manifest: current props are present, backlog is not.
  const manifest = await buildRunManifest({ league: "WNBA", now: NOW, runId: "test-run" }, { loadActiveRows: pgLoader(all) });
  assert.deepEqual(manifest.propIds.sort(), ["cur-1", "cur-2", "cur-3"]);
  assert.deepEqual(manifest.eventIds, ["event-1"]);
  assert.deepEqual(manifest.teamIds.sort(), ["team-A", "team-H"]);
  assert.deepEqual(manifest.playerIds.sort(), ["player-A", "player-B", "player-C"]);
  assert.ok(!manifest.propIds.some((id) => id.startsWith("past-")));
  assert.equal(manifest.meta.truncated, false);
});

test("includes every intended current prop across both leagues (superset of the old window, never a subset)", async () => {
  const rows = Array.from({ length: 40 }, (_, i) =>
    prop({ id: `c-${i}`, start_time: iso(NOW + (1 + (i % 30)) * HOUR), event_id: `ev-${i % 8}` }),
  );
  for (const league of ["MLB", "WNBA"] as const) {
    const manifest = await buildRunManifest({ league, now: NOW }, { loadActiveRows: pgLoader(rows) });
    assert.equal(manifest.props.length, 40);
    // no current prop the old window would have kept is missing
    const oldKept = new Set(oldStyleSelection(rows, NOW).map((r) => r.id));
    for (const id of oldKept) assert.ok(manifest.propIds.includes(id), `manifest missing ${id}`);
  }
});

test("null / non-finite start_time is excluded explicitly and counted (never silently dropped)", () => {
  const sel = selectActiveWorkSet(
    [
      prop({ id: "ok", start_time: iso(NOW + 3 * HOUR) }),
      prop({ id: "null1", start_time: null }),
      prop({ id: "bad", start_time: "not-a-date" }),
    ],
    { now: NOW },
  );
  assert.deepEqual(sel.props.map((p) => p.id), ["ok"]);
  assert.equal(sel.excludedNullStart, 2);
});

test("expired (>2h past) and distant (>36h future) props are excluded and counted", () => {
  const sel = selectActiveWorkSet(
    [
      prop({ id: "in", start_time: iso(NOW + 3 * HOUR) }),
      prop({ id: "expired", start_time: iso(NOW - 5 * HOUR) }),
      prop({ id: "distant", start_time: iso(NOW + 5 * 24 * HOUR) }),
    ],
    { now: NOW },
  );
  assert.deepEqual(sel.props.map((p) => p.id), ["in"]);
  assert.equal(sel.excludedOutOfWindow, 2);
});

test("ordering is deterministic (start_time asc, id tiebreak) regardless of input order", () => {
  const a = prop({ id: "aaa", start_time: iso(NOW + 2 * HOUR) });
  const b = prop({ id: "bbb", start_time: iso(NOW + 2 * HOUR) });
  const c = prop({ id: "ccc", start_time: iso(NOW + 1 * HOUR) });
  const forward = selectActiveWorkSet([a, b, c], { now: NOW }).props.map((p) => p.id);
  const reversed = selectActiveWorkSet([c, b, a], { now: NOW }).props.map((p) => p.id);
  assert.deepEqual(forward, ["ccc", "aaa", "bbb"]);
  assert.deepEqual(forward, reversed);
});

test("no unsafe fixed limit: exceeding the safety bound sets truncated=true instead of silently dropping", () => {
  const many = Array.from({ length: WORK_SET_SAFETY_LIMIT + 5 }, (_, i) =>
    prop({ id: `p-${String(i).padStart(5, "0")}`, start_time: iso(NOW + 1 * HOUR) }),
  );
  const sel = selectActiveWorkSet(many, { now: NOW });
  assert.equal(sel.truncated, true);
  assert.equal(sel.props.length, WORK_SET_SAFETY_LIMIT);
  // and a within-bound set never flags truncation
  const few = many.slice(0, 100);
  assert.equal(selectActiveWorkSet(few, { now: NOW }).truncated, false);
});
