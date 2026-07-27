import assert from "node:assert/strict";
import test from "node:test";
import { listPullStrategies } from "./pull-strategy.ts";

// A bounded, authorized live diagnostic (2 physical SharpAPI requests) confirmed
// player_pra and player_threes return a well-formed but genuinely empty response
// for WNBA -- a provider-catalog gap, not a normalization defect. This is WNBA-
// specific; NBA's own market list is untouched since it was not diagnosed.
test("WNBA player_pra and player_threes are disabled in the fallback pull strategy (live-diagnosed provider gap)", () => {
  const strategies = listPullStrategies("sharpapi").filter((row) => row.league === "WNBA");
  const pra = strategies.filter((row) => row.marketType === "player_pra");
  const threes = strategies.filter((row) => row.marketType === "player_threes");
  assert.ok(pra.length > 0, "expected WNBA player_pra rows to exist in the fallback strategy");
  assert.ok(threes.length > 0, "expected WNBA player_threes rows to exist in the fallback strategy");
  assert.ok(pra.every((row) => row.enabled === false), "WNBA player_pra must be disabled");
  assert.ok(threes.every((row) => row.enabled === false), "WNBA player_threes must be disabled");
});

test("WNBA's other core markets remain enabled (the disable is scoped to exactly the two diagnosed markets)", () => {
  const strategies = listPullStrategies("sharpapi").filter((row) => row.league === "WNBA");
  for (const marketType of ["player_points", "player_rebounds", "player_assists"]) {
    const rows = strategies.filter((row) => row.marketType === marketType);
    assert.ok(rows.length > 0, `expected WNBA ${marketType} rows to exist`);
    assert.ok(rows.every((row) => row.enabled === true), `WNBA ${marketType} must remain enabled`);
  }
});

test("NBA's player_pra/player_threes remain enabled at the market level -- the WNBA finding is not applied basketball-wide without its own diagnostic", () => {
  // NBA's overall `enabled` flag is separately gated off by default
  // (SHARPAPI_NBA_ENABLED), independent of any single market's flag, so it
  // must be forced on here to observe the market-level flag this test is
  // actually about.
  const previous = process.env.SHARPAPI_NBA_ENABLED;
  process.env.SHARPAPI_NBA_ENABLED = "true";
  try {
    const strategies = listPullStrategies("sharpapi").filter((row) => row.league === "NBA");
    const pra = strategies.filter((row) => row.marketType === "player_pra");
    const threes = strategies.filter((row) => row.marketType === "player_threes");
    assert.ok(pra.length > 0 && pra.every((row) => row.enabled === true), "NBA player_pra should be unaffected by the WNBA-specific diagnostic");
    assert.ok(threes.length > 0 && threes.every((row) => row.enabled === true), "NBA player_threes should be unaffected by the WNBA-specific diagnostic");
  } finally {
    if (previous === undefined) delete process.env.SHARPAPI_NBA_ENABLED;
    else process.env.SHARPAPI_NBA_ENABLED = previous;
  }
});
