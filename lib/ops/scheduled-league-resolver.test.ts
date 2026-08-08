import assert from "node:assert/strict";
import test from "node:test";
import { resolveScheduledLeagues } from "@/lib/ops/scheduled-league-resolver";

const resolve = (iso: string, extra = {}) => resolveScheduledLeagues({ trigger: "schedule", now: iso, schedulerEnabled: true, wnbaEnabled: true, ...extra });

test("scheduled heartbeat selects MLB, WNBA, both, or neither at exact UTC boundaries", () => {
  assert.deepEqual(resolve("2026-08-02T15:59:59Z").dueLeagues, []);
  assert.deepEqual(resolve("2026-08-02T16:00:00Z").dueLeagues, ["MLB"]);
  assert.deepEqual(resolve("2026-08-02T21:59:59Z").dueLeagues, ["MLB"]);
  assert.deepEqual(resolve("2026-08-02T22:00:00Z").dueLeagues, ["WNBA", "MLB"]);
  assert.deepEqual(resolve("2026-08-03T00:00:00Z").dueLeagues, ["WNBA", "MLB"]);
  assert.deepEqual(resolve("2026-08-03T05:00:00Z").dueLeagues, []);
});

test("WNBA remains first during overlap and can be disabled without suppressing MLB", () => {
  assert.deepEqual(resolve("2026-08-02T23:40:00Z").dueLeagues, ["WNBA", "MLB"]);
  assert.deepEqual(resolve("2026-08-02T23:40:00Z", { wnbaEnabled: false }).dueLeagues, ["MLB"]);
  assert.deepEqual(resolve("2026-08-02T23:40:00Z", { schedulerEnabled: false }).dueLeagues, []);
});

test("manual selection is unchanged", () => {
  const result = resolveScheduledLeagues({ trigger: "workflow_dispatch", now: "2026-08-02T12:00:00Z", requestedLeague: "WNBA", schedulerEnabled: false, wnbaEnabled: false });
  assert.deepEqual(result.dueLeagues, ["WNBA"]);
  assert.equal(result.leagueSelection, "WNBA");
});
