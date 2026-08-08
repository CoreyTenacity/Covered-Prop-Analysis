import assert from "node:assert/strict";
import test from "node:test";

import { buildParlayCommentary } from "./commentary.ts";

const mlbFactors = [
  { name: "Recent Form", label: "Improving", impact: "positive", description: "Test Player is at 1.80 over the last 5 and 1.50 over the last 10 for this stat family against a line of 1.5." },
  { name: "Pitcher Matchup", label: "Favorable", impact: "positive", description: "Opposing pitcher K-rate/whiff context favors this batter." },
  { name: "Line Value", label: "Strong Value", impact: "positive", description: "The stored edge favors the More side of this line." },
  { name: "Lineup Context", label: "Strong", impact: "positive", description: "Test Player is in the order around spot 2." },
  { name: "Weather", label: "Favorable", impact: "neutral", description: "Clear conditions, minimal wind effect." },
  { name: "Handedness Split", label: "Unfavorable", impact: "negative", description: "This batter's platoon split is weaker against this pitcher's handedness." },
];

test("buildParlayCommentary (session 89 compact shape): maps stored factor descriptions into positive_factors/risks, reusing existing text verbatim", () => {
  const commentary = buildParlayCommentary({
    summary: "Test Player projects over the line tonight.",
    reasoningBlock: "Recent form and a favorable matchup both point over.",
    factors: mlbFactors,
    coveredScore: 78,
    recommendation: "Strong",
    scoreLabel: "Strong",
  });
  assert.equal(commentary.summary, "Recent form and a favorable matchup both point over.", "reasoning_block is preferred over summary -- never both stored");
  assert.equal(commentary.positive_factors.length, 3, "bounded to the top 3 positive factors even though 4 are positive in this fixture");
  assert.ok(commentary.positive_factors.some((entry) => entry.startsWith("Recent Form:")));
  assert.ok(commentary.risks.some((entry) => entry.startsWith("Handedness Split:")));
  assert.match(commentary.status, /78/);
  assert.match(commentary.status, /meets Covered Picks/);
});

test("buildParlayCommentary: a sub-70 prop's status explains why it did not qualify, not that data is missing", () => {
  const commentary = buildParlayCommentary({
    summary: "Modest projection.",
    reasoningBlock: null,
    factors: mlbFactors,
    coveredScore: 55,
    recommendation: "Lean",
    scoreLabel: "Lean",
  });
  assert.match(commentary.status, /below Covered Picks/);
  assert.doesNotMatch(commentary.status, /missing/i);
});

test("buildParlayCommentary: no factors stored -- positive_factors/risks are empty arrays, never a fabricated placeholder", () => {
  const commentary = buildParlayCommentary({
    summary: "Summary only.",
    reasoningBlock: null,
    factors: null,
    coveredScore: 60,
    recommendation: "Lean",
    scoreLabel: null,
  });
  assert.deepEqual(commentary.positive_factors, []);
  assert.deepEqual(commentary.risks, []);
  assert.equal(commentary.summary, "Summary only.", "falls back to summary when no reasoning_block is stored");
});

test("buildParlayCommentary: basketball's 'Usage or Minutes' and 'Matchup' factors surface through positive_factors the same as MLB's named factors (league-neutral)", () => {
  const commentary = buildParlayCommentary({
    summary: "WNBA prop summary.",
    reasoningBlock: "Reasoning.",
    factors: [
      { name: "Usage or Minutes", label: "High", impact: "positive", description: "This player's minutes and usage trend support the projection." },
      { name: "Matchup", label: "Favorable", impact: "positive", description: "Opponent defensive rating context favors this player." },
    ],
    coveredScore: 82,
    recommendation: "Elite",
    scoreLabel: "Elite",
  });
  assert.ok(commentary.positive_factors.some((entry) => entry.includes("minutes and usage")));
  assert.ok(commentary.positive_factors.some((entry) => entry.includes("defensive rating")));
});

test("buildParlayCommentary: positive_factors and risks are bounded to 3 and 2 respectively even with many factors", () => {
  const manyFactors = Array.from({ length: 10 }, (_, i) => ({ name: `Factor ${i}`, label: "X", impact: "positive", description: "d" }));
  const commentary = buildParlayCommentary({ summary: "s", reasoningBlock: "r", factors: manyFactors, coveredScore: 80, recommendation: "Strong", scoreLabel: "Strong" });
  assert.ok(commentary.positive_factors.length <= 3, "must stay bounded regardless of how many positive factors exist");
});

test("buildParlayCommentary: every field respects its length bound even against deliberately oversized synthetic input", () => {
  const longFactors = [
    { name: "Recent Form", label: "X", impact: "positive", description: "A".repeat(200) },
    { name: "Line Value", label: "Y".repeat(100), impact: "negative", description: "B".repeat(200) },
  ];
  const commentary = buildParlayCommentary({ summary: "C".repeat(300), reasoningBlock: null, factors: longFactors, coveredScore: 75, recommendation: "Strong", scoreLabel: "Strong" });
  assert.ok(commentary.summary.length <= 80);
  for (const entry of [...commentary.positive_factors, ...commentary.risks]) {
    assert.ok(entry.length <= 70, `entry "${entry}" exceeds the 70-char bound`);
  }
});

// 2026-08-07 (WNBA Analyzer explanation UX, Part 11): Covered Score is a
// relative evidence/quality score, never a calibrated win probability -- the
// UI must never phrase it as one. Proven across the full realistic score
// range that the deterministic `status` line this function generates never
// contains percentage or probability language.
test("buildParlayCommentary: status line never phrases Covered Score as a win probability/percentage, at any score", () => {
  for (const score of [0, 1, 45, 55, 69, 70, 71, 85, 99, 100]) {
    const commentary = buildParlayCommentary({ summary: "s", reasoningBlock: "r", factors: [], coveredScore: score, recommendation: "Strong", scoreLabel: "Strong" });
    const lowered = commentary.status.toLowerCase();
    assert.ok(!lowered.includes("%"), `status "${commentary.status}" must not contain a percent sign`);
    assert.ok(!lowered.includes("chance"), `status "${commentary.status}" must not use "chance" language`);
    assert.ok(!lowered.includes("probability"), `status "${commentary.status}" must not use "probability" language`);
  }
  const unscored = buildParlayCommentary({ summary: "s", reasoningBlock: "r", factors: [], coveredScore: null, recommendation: null, scoreLabel: null });
  assert.ok(!unscored.status.toLowerCase().includes("%"));
});
