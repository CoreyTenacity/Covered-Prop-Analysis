import assert from "node:assert/strict";
import test from "node:test";
import { resolveActualValueFromPayload } from "./box-score-grading.ts";

test("resolves a direct player box-score stat from a nested provider payload", () => {
  const payload = [
    {
      fullName: "Aaron Judge",
      boxScore: {
        hits: { value: 2 },
        totalBases: { value: 4 },
      },
    },
  ];
  assert.equal(resolveActualValueFromPayload(payload, "Hits", "Aaron Judge"), 2);
});

test("sums combo-stat components when the provider payload exposes them separately", () => {
  const payload = [
    {
      fullName: "A'ja Wilson",
      stats: {
        points: 28,
        rebounds: 11,
        assists: 4,
      },
    },
  ];
  assert.equal(resolveActualValueFromPayload(payload, "Points + Rebounds + Assists", "A'ja Wilson"), 43);
});

test("returns null when the payload does not expose a clear stat value", () => {
  assert.equal(resolveActualValueFromPayload([{ fullName: "Unknown Player", note: "final" }], "Fantasy Score", "Unknown Player"), null);
});
