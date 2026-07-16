import assert from "node:assert/strict";
import test from "node:test";
import type { PickRecord, PickResult } from "../types/index.ts";
import { currentStreak, groupPerformance, scoreBucket, summarize } from "./analytics.ts";

function pick(id: string, result: PickResult, score: number, sport = "NBA", daysAgo = 0): PickRecord {
  const date = new Date("2026-07-03T12:00:00Z"); date.setDate(date.getDate() - daysAgo);
  return { id, opportunityId: id, savedAt: date.toISOString(), sport: sport as PickRecord["sport"], playerName: id, team: "A", opponent: "B", statType: "Points", line: 10, direction: "More", coveredScore: score, recommendationLabel: "Good Play", result, notes: "", source: "top-board" };
}

test("excludes pending picks and pushes from hit rate", () => {
  const result = summarize([pick("a", "hit", 85), pick("b", "miss", 80), pick("c", "push", 90), pick("d", "pending", 75)]);
  assert.equal(result.hitRate, 50);
  assert.equal(result.total, 2);
  assert.equal(result.pushes, 1);
  assert.equal(result.pending, 1);
});

test("uses the documented score buckets", () => {
  assert.deepEqual([90, 84, 70, 55, 40].map(scoreBucket), ["85–100", "75–84", "65–74", "50–64", "Under 50"]);
});

test("groups results independently", () => {
  const groups = groupPerformance([pick("a", "hit", 85, "NBA"), pick("b", "miss", 80, "MLB"), pick("c", "hit", 88, "NBA")], (item) => item.sport);
  assert.equal(groups.find((group) => group.label === "NBA")?.hitRate, 100);
  assert.equal(groups.find((group) => group.label === "MLB")?.hitRate, 0);
});

test("calculates the latest hit or miss streak", () => {
  const streak = currentStreak([pick("today", "hit", 85, "NBA", 0), pick("yesterday", "hit", 82, "NBA", 1), pick("older", "miss", 78, "NBA", 2)]);
  assert.deepEqual(streak, { result: "hit", count: 2 });
});
