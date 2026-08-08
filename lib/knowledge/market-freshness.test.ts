import assert from "node:assert/strict";
import test from "node:test";
import { classifyMarketFreshness, classifyMarketFreshnessFromAgeMinutes, isMarketFreshEnoughToPublish, marketFreshnessMaxAgeMinutes } from "./market-freshness.ts";

// Phase 18 (continuation) owner policy #1: hard current-market freshness.
// Fully time-injected; no wall-clock dependence.

const NOW = Date.parse("2026-07-30T12:00:00.000Z");
function agoIso(minutes: number): string {
  return new Date(NOW - minutes * 60 * 1000).toISOString();
}

test("threshold derivation: WNBA/NBA = 180 min, MLB = 240 min (6 and 8 missed 30-min pull cycles), unknown league defaults to the stricter 180", () => {
  assert.equal(marketFreshnessMaxAgeMinutes("wnba"), 180);
  assert.equal(marketFreshnessMaxAgeMinutes("nba"), 180);
  assert.equal(marketFreshnessMaxAgeMinutes("mlb"), 240);
  assert.equal(marketFreshnessMaxAgeMinutes("nfl"), 180, "unknown league gets the stricter default, never a more lenient gate");
});

test("boundary WNBA: exactly fresh (age 0), one unit before expiry (179), exactly at expiry (180), one unit after (181)", () => {
  assert.equal(classifyMarketFreshness({ observedAtIso: agoIso(0), leagueId: "wnba", now: NOW }), "fresh");
  assert.equal(classifyMarketFreshness({ observedAtIso: agoIso(179), leagueId: "wnba", now: NOW }), "fresh");
  assert.equal(classifyMarketFreshness({ observedAtIso: agoIso(180), leagueId: "wnba", now: NOW }), "fresh", "exactly at the limit is inclusive-fresh");
  assert.equal(classifyMarketFreshness({ observedAtIso: agoIso(181), leagueId: "wnba", now: NOW }), "stale");
});

test("boundary MLB: 240 is fresh, 241 is stale", () => {
  assert.equal(classifyMarketFreshness({ observedAtIso: agoIso(240), leagueId: "mlb", now: NOW }), "fresh");
  assert.equal(classifyMarketFreshness({ observedAtIso: agoIso(241), leagueId: "mlb", now: NOW }), "stale");
  // A WNBA market at 240 min IS stale (WNBA's window is tighter).
  assert.equal(classifyMarketFreshness({ observedAtIso: agoIso(240), leagueId: "wnba", now: NOW }), "stale");
});

test("null / invalid observation time -> never_observed (blocks)", () => {
  assert.equal(classifyMarketFreshness({ observedAtIso: null, leagueId: "mlb", now: NOW }), "never_observed");
  assert.equal(classifyMarketFreshness({ observedAtIso: undefined, leagueId: "mlb", now: NOW }), "never_observed");
  assert.equal(classifyMarketFreshness({ observedAtIso: "not-a-date", leagueId: "mlb", now: NOW }), "never_observed");
});

test("isMarketFreshEnoughToPublish: only 'fresh' publishes; 'stale' and 'never_observed' both block", () => {
  assert.equal(isMarketFreshEnoughToPublish({ observedAtIso: agoIso(10), leagueId: "mlb", now: NOW }), true);
  assert.equal(isMarketFreshEnoughToPublish({ observedAtIso: agoIso(9999), leagueId: "mlb", now: NOW }), false);
  assert.equal(isMarketFreshEnoughToPublish({ observedAtIso: null, leagueId: "mlb", now: NOW }), false);
});

test("insertion-order independence: classification depends only on age, not on any surrounding state", () => {
  const a = classifyMarketFreshness({ observedAtIso: agoIso(300), leagueId: "mlb", now: NOW });
  const b = classifyMarketFreshness({ observedAtIso: agoIso(300), leagueId: "mlb", now: NOW });
  assert.equal(a, b);
  assert.equal(a, "stale");
});

test("from-age-minutes variant: null -> never_observed, negative (future-dated fixture) -> fresh, within window -> fresh, beyond -> stale", () => {
  assert.equal(classifyMarketFreshnessFromAgeMinutes(null, "mlb"), "never_observed");
  assert.equal(classifyMarketFreshnessFromAgeMinutes(-360, "mlb"), "fresh", "a future-dated observation (negative age) is fresh, not stale");
  assert.equal(classifyMarketFreshnessFromAgeMinutes(120, "mlb"), "fresh");
  assert.equal(classifyMarketFreshnessFromAgeMinutes(300, "mlb"), "stale");
  assert.equal(classifyMarketFreshnessFromAgeMinutes(200, "wnba"), "stale");
});
