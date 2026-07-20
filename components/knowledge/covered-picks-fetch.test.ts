import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { filterCoveredPicksSnapshotRows } from "@/lib/knowledge/public-snapshots";
import { filterParlayOptionsSnapshotRows } from "@/lib/knowledge/public-snapshots";
import type { CoveredPickRow, CoveredPicksResponse, ParlayOptionRow } from "@/lib/knowledge/read-types";

const shellSource = readFileSync(fileURLToPath(new URL("./covered-picks-shell.tsx", import.meta.url)), "utf8");

function coveredRow(score: number, startTime: string): CoveredPickRow {
  return {
    scored_prop_id: `scored-${score}`,
    current_prop_id: `current-${score}`,
    odds_snapshot_id: null,
    market_instance_key: null,
    event_id: "event-1",
    participant_id: `participant-${score}`,
    participant_type: "player",
    player_display_name: "Freddy Peralta",
    participant_image_url: null,
    player_headshot_url: null,
    team_display_name: "Milwaukee Brewers",
    team_logo_url: null,
    opponent_display_name: "New York Mets",
    opponent_logo_url: null,
    event_display_name: "New York Mets at Milwaukee Brewers",
    sport: "baseball",
    league: "mlb",
    market_type: "pitcher_strikeouts",
    market_display_label: "Pitcher Strikeouts",
    sportsbook_id: null,
    sportsbook: null,
    sportsbooks: [],
    sportsbook_count: 0,
    grouped_variant_count: 1,
    side: "More",
    line: 5.5,
    over_price: -110,
    under_price: -110,
    start_time: startTime,
    covered_score: score,
    edge_score: 75,
    data_quality_score: 85,
    score_label: "Strong",
    confidence_score: 80,
    confidence_label: "High Confidence",
    risk_label: "Low Risk",
    recommendation: "Strong",
    explanation_summary: null,
    risk_flags: [],
    factor_breakdown: [],
    grading_result: null,
    last_updated: "2026-07-19T22:39:27.040Z",
  };
}

test("Covered Picks fetch uses no-store, not force-cache, and stays credential-free", () => {
  assert.match(shellSource, /fetch\("\/api\/knowledge\/covered-picks",\s*\{[\s\S]*?cache:\s*"no-store"[\s\S]*?credentials:\s*"omit"/);
  assert.doesNotMatch(shellSource, /covered-picks[\s\S]*?cache:\s*"force-cache"/);
});

test("a newer published Covered Picks payload is not hidden by a client cache policy", () => {
  const freshRow = coveredRow(73, "2026-07-20T23:40:00.000Z");
  const stale = {
    snapshotVersion: "covered-picks:old",
    rows: [] as CoveredPicksResponse["rows"],
  };
  const fresh = {
    snapshotVersion: "covered-picks:29706587780.1",
    rows: [freshRow],
  };
  assert.equal(stale.rows.length, 0);
  assert.equal(fresh.snapshotVersion, "covered-picks:29706587780.1");
  assert.equal(fresh.rows.length, 1);
  assert.equal(fresh.rows[0]?.covered_score, 73);
  assert.doesNotMatch(shellSource, /cache:\s*"force-cache"/);
});

test("default date and score filters keep the current MLB 73 pick and exclude sub-70 rows", () => {
  const todayEastern = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const rows = [
    coveredRow(73, `${todayEastern}T23:40:00.000Z`),
    coveredRow(69, `${todayEastern}T23:40:00.000Z`),
  ];

  const filtered = filterCoveredPicksSnapshotRows(rows, {
    date: todayEastern,
    sport: null,
    league: null,
    marketType: null,
    sportsbook: null,
    minimumCoveredScore: 70,
    minimumConfidenceScore: undefined,
    scoreLabel: null,
    confidenceLabel: null,
    riskLabel: null,
    excludeHighRisk: false,
    excludeUnsupportedMarkets: false,
    startTimeFrom: null,
    startTimeTo: null,
    limit: 6,
    includeVariantBooks: false,
  });

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.covered_score, 73);
});

test("Parlay Options remains broader and preserves legitimate sub-70 scored rows", () => {
  const row = {
    current_prop_id: "parlay-current-1",
    latest_scored_prop_id: "parlay-scored-1",
    start_time: "2026-07-20T23:40:00.000Z",
    covered_score: 69,
    league: "mlb",
    sport: "baseball",
  } as ParlayOptionRow;
  const filtered = filterParlayOptionsSnapshotRows([row], {
    date: null,
    sport: null,
    league: null,
    eventId: null,
    marketType: null,
    sportsbook: null,
    participantSearch: null,
    onlyScored: true,
    onlyMatched: false,
    excludeStaleOdds: false,
    excludeLowConfidenceMatches: false,
    limit: 100,
    includeVariantBooks: false,
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.covered_score, 69);
});
