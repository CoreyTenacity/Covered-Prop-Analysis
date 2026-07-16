import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { providerDisplayNames, type ProviderId, type ProviderStatus } from "./provider-contracts.ts";

const genericProviderModules = [
  "./provider-contracts.ts",
  "../db/provider-cache.ts",
  "../knowledge/public-snapshots.ts",
  "./provider-pull-audit.ts",
];

test("public provider contracts retain stable identifiers and display labels", () => {
  const ids: ProviderId[] = [
    "highlightly",
    "api-sports",
    "big-balls-data",
    "the-odds-api",
    "sports-game-odds",
    "sharpapi",
    "official-injuries",
    "mlb-stats-api",
    "nba-com-stats",
    "statcast-savant",
    "open-meteo",
  ];

  assert.deepEqual(Object.keys(providerDisplayNames).sort(), ids.sort());
  assert.equal(providerDisplayNames.sharpapi, "SharpAPI");
  assert.equal(providerDisplayNames["the-odds-api"], "The Odds API");

  const statuses: ProviderStatus[] = ["configured", "limited", "unavailable", "disabled"];
  assert.deepEqual(statuses, ["configured", "limited", "unavailable", "disabled"]);
});

test("public provider modules do not import private request policy values", () => {
  for (const modulePath of genericProviderModules) {
    const source = readFileSync(new URL(modulePath, import.meta.url), "utf8");
    assert.doesNotMatch(source, /(?:import|export)[^\n]*request-policy/);
    assert.doesNotMatch(source, /\b(?:ProviderRequestPolicy|providerRequestPolicies|hardDailyBudget|publishedDailyLimit|scheduledIntervalMinutes|liveIntervalMinutes|completedTtlMinutes|sharpApiRequestsPerRefresh)\b/);
  }
});
