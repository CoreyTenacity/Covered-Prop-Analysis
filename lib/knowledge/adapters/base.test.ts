import assert from "node:assert/strict";
import test from "node:test";
import { computeDirectionalEdge, normalizePropDirection, numeric } from "./base.ts";

test("numeric: null (SQL NULL through the REST boundary) is missing, not zero", () => {
  assert.equal(numeric(null), null);
});

test("numeric: undefined (absent field/optional-chain miss) is missing, not zero", () => {
  assert.equal(numeric(undefined), null);
});

test("numeric: a genuine numeric zero is preserved as 0, not treated as missing", () => {
  assert.equal(numeric(0), 0);
});

test("numeric: a numeric string is parsed", () => {
  assert.equal(numeric("0.274"), 0.274);
});

test("numeric: non-numeric values resolve to missing", () => {
  assert.equal(numeric("n/a"), null);
  assert.equal(numeric({}), null);
  assert.equal(numeric(NaN), null);
});

// Direction normalization: cover every documented alias plus invalid/missing.
// These are pure, publicly-safe classification with no tuned scoring math.
for (const input of ["More", "more", "MORE", "Over", "over", "OVER"] as const) {
  test(`normalizePropDirection accepts ${JSON.stringify(input)} as "More"`, () => {
    assert.equal(normalizePropDirection(input), "More");
  });
}
for (const input of ["Less", "less", "LESS", "Under", "under", "UNDER"] as const) {
  test(`normalizePropDirection accepts ${JSON.stringify(input)} as "Less"`, () => {
    assert.equal(normalizePropDirection(input), "Less");
  });
}
for (const input of ["", "  ", "middle", "yes", "n/a", "0"] as const) {
  test(`normalizePropDirection rejects invalid string ${JSON.stringify(input)}`, () => {
    assert.equal(normalizePropDirection(input), null);
  });
}
for (const [label, input] of Object.entries({ null: null, undefined: undefined, number: 1, object: {}, boolean: true }) as [string, unknown][]) {
  test(`normalizePropDirection rejects non-string (${label})`, () => {
    assert.equal(normalizePropDirection(input), null);
  });
}

test("computeDirectionalEdge: More with projection above line is favorable", () => {
  const edge = computeDirectionalEdge({ projection: 5.5, line: 4.5, direction: "More" });
  assert.equal(edge.direction, "favorable");
  assert.equal(edge.signedEdge, 1);
  assert.equal(edge.absoluteMagnitude, 1);
  assert.equal(edge.normalizedDirection, "More");
});

test("computeDirectionalEdge: More with projection below line is unfavorable (Keider Montero shape)", () => {
  const edge = computeDirectionalEdge({ projection: 0.41, line: 4.5, direction: "More" });
  assert.equal(edge.direction, "unfavorable");
  assert.equal(edge.signedEdge, -4.09);
  assert.equal(edge.absoluteMagnitude, 4.09);
});

test("computeDirectionalEdge: Less with projection below line is favorable", () => {
  const edge = computeDirectionalEdge({ projection: 0.9, line: 1.5, direction: "Less" });
  assert.equal(edge.direction, "favorable");
  assert.equal(edge.signedEdge, 0.6);
});

test("computeDirectionalEdge: Less with projection above line is unfavorable (live WNBA bug row shape: 22.09 vs 16.5)", () => {
  const edge = computeDirectionalEdge({ projection: 22.09, line: 16.5, direction: "Less" });
  assert.equal(edge.direction, "unfavorable");
  assert.equal(edge.signedEdge, -5.59);
  assert.equal(edge.absoluteMagnitude, 5.59);
});

test("computeDirectionalEdge: exactly-equal projection is neutral, not favorable", () => {
  const edge = computeDirectionalEdge({ projection: 4.5, line: 4.5, direction: "More" });
  assert.equal(edge.direction, "neutral");
  assert.equal(edge.signedEdge, 0);
});

test("computeDirectionalEdge: missing projection returns unavailable, not zero", () => {
  const edge = computeDirectionalEdge({ projection: null, line: 4.5, direction: "More" });
  assert.equal(edge.direction, "unavailable");
  assert.equal(edge.signedEdge, null);
  assert.equal(edge.absoluteMagnitude, 0);
});

test("computeDirectionalEdge: missing line returns unavailable", () => {
  const edge = computeDirectionalEdge({ projection: 5, line: null, direction: "More" });
  assert.equal(edge.direction, "unavailable");
  assert.equal(edge.signedEdge, null);
});

test("computeDirectionalEdge: invalid direction returns unavailable (cannot receive positive credit)", () => {
  const edge = computeDirectionalEdge({ projection: 5, line: 4.5, direction: "middle" });
  assert.equal(edge.direction, "unavailable");
  assert.equal(edge.normalizedDirection, null);
});

test("computeDirectionalEdge: Over normalizes to More and produces the same signed edge", () => {
  const more = computeDirectionalEdge({ projection: 5.5, line: 4.5, direction: "More" });
  const over = computeDirectionalEdge({ projection: 5.5, line: 4.5, direction: "Over" });
  assert.equal(more.signedEdge, over.signedEdge);
  assert.equal(more.direction, over.direction);
});

test("computeDirectionalEdge: Under normalizes to Less and produces the same signed edge", () => {
  const less = computeDirectionalEdge({ projection: 0.9, line: 1.5, direction: "Less" });
  const under = computeDirectionalEdge({ projection: 0.9, line: 1.5, direction: "Under" });
  assert.equal(less.signedEdge, under.signedEdge);
});
