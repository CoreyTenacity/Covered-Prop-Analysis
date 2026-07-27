import assert from "node:assert/strict";
import test from "node:test";
import { requireColumns, validateId, validateDate, validateWriteShape, classifyAbsence, type SourceAttempt } from "./boundary-validation.ts";
import { getFieldContract } from "./field-contracts.ts";

test("requireColumns flags a missing/renamed upstream column as ingestion_missing", () => {
  const r = requireColumns({ id: 1, date: "2026-07-14" }, ["id", "date", "status_type_completed"]);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.issues[0].cause, "ingestion_missing");
    assert.match(r.issues[0].message, /status_type_completed/);
  }
});

test("validateId accepts INT32 number, INT64 bigint, and non-empty string; rejects null/empty", () => {
  assert.equal((validateId(401700011, "id") as { value: string }).value, "401700011");
  assert.equal((validateId(BigInt("1611661330"), "id") as { value: string }).value, "1611661330");
  assert.equal((validateId("abc", "id") as { value: string }).value, "abc");
  const bad = validateId(null, "id");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.issues[0].cause, "join_failed");
});

test("validateDate accepts ISO strings and Date; rejects garbage as validation_rejected", () => {
  assert.ok(validateDate("2026-07-14", "d").ok);
  assert.ok(validateDate("2026-07-14T23:30:00Z", "d").ok);
  assert.ok(validateDate(new Date("2026-07-14"), "d").ok);
  const bad = validateDate("not-a-date", "d");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.issues[0].cause, "validation_rejected");
});

test("validateWriteShape catches a null NOT NULL column (the mlb_weather game_id defect) before the DB does", () => {
  const bad = validateWriteShape({ event_id: "e1", game_id: null, weather_date: "2026-07-14" }, ["event_id", "game_id", "weather_date"], "mlb_weather");
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.issues[0].cause, "validation_rejected");
    assert.match(bad.issues[0].message, /game_id/);
  }
  const good = validateWriteShape({ event_id: "e1", game_id: "e1", weather_date: "2026-07-14" }, ["event_id", "game_id", "weather_date"], "mlb_weather");
  assert.equal(good.ok, true);
});

// ---- provider-absent proof standard ----

const weather = getFieldContract("weather")!;
function attempt(over: Partial<SourceAttempt> & { source: string }): SourceAttempt {
  return { source: over.source, requestOk: over.requestOk ?? true, queriedCorrectTarget: over.queriedCorrectTarget ?? true, returnedApplicableValue: over.returnedApplicableValue ?? false, errorKind: over.errorKind };
}

test("provider_absent requires identity resolved first", () => {
  const r = classifyAbsence({ field: "weather", contract: weather, identityResolved: false, attempts: [] });
  assert.equal(r.classified, "identity_failed");
});

test("a request that did not complete is enrichment_error, NOT provider_absent", () => {
  const r = classifyAbsence({ field: "weather", contract: weather, identityResolved: true, attempts: [attempt({ source: "open-meteo", requestOk: false, errorKind: "request_failed" })] });
  assert.equal(r.classified, "enrichment_error");
});

test("wrong target (bad player/event/date) is join_failed, NOT provider_absent", () => {
  const r = classifyAbsence({ field: "weather", contract: weather, identityResolved: true, attempts: [attempt({ source: "open-meteo", queriedCorrectTarget: false })] });
  assert.equal(r.classified, "join_failed");
});

test("stale source data is 'stale' (a pipeline failure), NOT provider_absent", () => {
  const r = classifyAbsence({ field: "weather", contract: weather, identityResolved: true, attempts: [attempt({ source: "mlb_weather", errorKind: "stale" })] });
  assert.equal(r.classified, "stale");
});

test("not attempting every configured source cannot be provider_absent", () => {
  // weather sources: mlb_weather, open-meteo. Only one attempted.
  const r = classifyAbsence({ field: "weather", contract: weather, identityResolved: true, attempts: [attempt({ source: "mlb_weather" })] });
  assert.equal(r.classified, "enrichment_error");
});

test("provider_absent only when all sources attempted OK, none applicable, and absence permitted", () => {
  const r = classifyAbsence({
    field: "weather",
    contract: weather,
    identityResolved: true,
    attempts: [attempt({ source: "mlb_weather" }), attempt({ source: "open-meteo" })],
  });
  assert.equal(r.classified, "provider_absent");
  if (r.classified === "provider_absent") assert.equal(r.evidence.attempts.length, 2);
});

test("absence not permitted by contract -> the contract's pipeline cause, never provider_absent", () => {
  const teamContext = getFieldContract("team_context")!; // absencePermitted: false
  const r = classifyAbsence({
    field: "team_context",
    contract: teamContext,
    identityResolved: true,
    attempts: teamContext.sourcePriority.concat(teamContext.fallbackSources).map((s) => attempt({ source: s })),
  });
  assert.equal(r.classified, teamContext.pipelineFailureCause); // enrichment_error
});
