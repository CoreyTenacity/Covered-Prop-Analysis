import assert from "node:assert/strict";
import test from "node:test";

import { fetchParlayOptions } from "./parlay-options-fetch.ts";
import { buildManualCatalogRows, manualScoreBandMatches, manualScoreBandOptions } from "./parlay-builder-catalog.ts";
import { filterParlayOptionsSnapshotRows } from "@/lib/knowledge/public-snapshots";
import type { ParlayOptionRow, ParlayOptionsResponse } from "@/lib/knowledge/read-types";

/**
 * Regression coverage for the stale-Parlay-Builder-cache defect: the client fetch previously used
 * `cache: "force-cache"`, which per the Fetch spec reuses a matching browser cache entry "no
 * matter how old it is" -- once a browser cached the pre-publication empty response, it would
 * never observe a newer published snapshot again without a hard reload. Fixed by switching to
 * `cache: "no-store"`. These tests exercise the extracted `fetchParlayOptions()` helper directly
 * (dependency-injected `fetch`), following this repo's established pattern of testing pure,
 * exported async functions rather than rendering React components (no jsdom in this project).
 */

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const ok = init.ok ?? true;
  const status = init.status ?? (ok ? 200 : 500);
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

function samplePayload(rows: ParlayOptionsResponse["rows"], overrides: Partial<ParlayOptionsResponse> = {}): ParlayOptionsResponse {
  return {
    schemaVersion: 1,
    snapshotVersion: "parlay-options:test",
    publishedAt: "2026-07-16T14:10:46.313Z",
    dataThrough: null,
    sourceRefreshedAt: null,
    effectiveFilterScope: null,
    pipelineRunId: "local-20260716141046313",
    status: "published",
    snapshot_source: "published",
    count: rows.length,
    rows,
    ...overrides,
  } as ParlayOptionsResponse;
}

test("fetchParlayOptions requests with cache:'no-store', not force-cache -- the fix for the indefinite-staleness defect", async () => {
  let capturedInit: RequestInit | undefined;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedInit = init;
    return jsonResponse(samplePayload([]));
  }) as typeof fetch;

  await fetchParlayOptions(fetchImpl);
  assert.equal(capturedInit?.cache, "no-store");
  assert.notEqual(capturedInit?.cache, "force-cache");
});

test("fetchParlayOptions is public and credential-free", async () => {
  let capturedInit: RequestInit | undefined;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedInit = init;
    return jsonResponse(samplePayload([]));
  }) as typeof fetch;

  await fetchParlayOptions(fetchImpl);
  assert.equal(capturedInit?.credentials, "omit");
});

test("a newer published response replaces a previously observed empty response -- no artificial reuse across calls", async () => {
  const stale = samplePayload([], { status: "fallback", snapshot_source: "published", pipelineRunId: "local-20260714212935156", publishedAt: "2026-07-14T21:29:35.156Z" });
  const fresh = samplePayload(
    [{ current_prop_id: "prop-1" } as ParlayOptionRow],
    { status: "published", pipelineRunId: "local-20260716141046313", publishedAt: "2026-07-16T14:10:46.313Z" },
  );

  let call = 0;
  const fetchImpl = (async () => {
    call += 1;
    return jsonResponse(call === 1 ? stale : fresh);
  }) as typeof fetch;

  const first = await fetchParlayOptions(fetchImpl);
  const second = await fetchParlayOptions(fetchImpl);

  assert.equal(first.kind, "success");
  assert.equal(second.kind, "success");
  if (first.kind === "success" && second.kind === "success") {
    assert.equal(first.data.rows.length, 0);
    assert.equal(first.data.pipelineRunId, "local-20260714212935156");
    assert.equal(second.data.rows.length, 1);
    assert.equal(second.data.pipelineRunId, "local-20260716141046313", "the second call must observe the newer publication, not a reused stale result");
  }
});

test("successful rows render (outcome carries the fresh rows through unchanged)", async () => {
  const rows = Array.from({ length: 33 }, (_, i) => ({ current_prop_id: `prop-${i}` }) as ParlayOptionRow);
  const fetchImpl = (async () => jsonResponse(samplePayload(rows))) as typeof fetch;

  const outcome = await fetchParlayOptions(fetchImpl);
  assert.equal(outcome.kind, "success");
  if (outcome.kind === "success") {
    assert.equal(outcome.data.rows.length, 33);
    assert.equal(outcome.data.count, 33);
  }
});

test("a legitimate fresh zero-row snapshot is still a successful outcome, distinguishable from a request failure", async () => {
  const okButEmpty = (async () => jsonResponse(samplePayload([]))) as typeof fetch;
  const failing = (async () => jsonResponse(samplePayload([]), { ok: false, status: 500 })) as typeof fetch;

  const emptyOutcome = await fetchParlayOptions(okButEmpty);
  const failedOutcome = await fetchParlayOptions(failing);

  assert.equal(emptyOutcome.kind, "success", "a genuine zero-row published snapshot must not be reported as an error");
  if (emptyOutcome.kind === "success") assert.equal(emptyOutcome.data.rows.length, 0);

  assert.equal(failedOutcome.kind, "error", "a failed request must never be classified the same as a valid empty snapshot");
});

test("a thrown network error is reported as an error outcome, not silently treated as an empty snapshot", async () => {
  const throwing = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  const outcome = await fetchParlayOptions(throwing);
  assert.equal(outcome.kind, "error");
  if (outcome.kind === "error") assert.equal(outcome.message, "fetch failed");
});

test("the default client filters do not hide all 33 freshly-published eligible rows", () => {
  const todayEastern = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const startTimeIso = `${todayEastern}T23:00:00.000Z`;

  const rows: ParlayOptionRow[] = Array.from({ length: 33 }, (_, i) => ({
    current_prop_id: `prop-${i}`,
    latest_scored_prop_id: `scored-${i}`,
    latest_snapshot_id: null,
    market_instance_key: null,
    event_id: "event-1",
    participant_id: `participant-${i}`,
    participant_type: "player",
    display_label: `Player ${i}`,
    sport: "basketball",
    league: i % 2 === 0 ? "wnba" : "mlb",
    event_display_name: "Team A vs Team B",
    participant_display_name: `Player ${i}`,
    participant_image_url: null,
    player_headshot_url: null,
    team_display_name: "Team A",
    team_logo_url: null,
    opponent_display_name: "Team B",
    opponent_logo_url: null,
    market_type: "player_points",
    sportsbook: null,
    sportsbooks: [],
    sportsbook_count: 0,
    grouped_variant_count: 1,
    side: "More",
    line: 10 + i,
    over_price: -110,
    under_price: -110,
    start_time: startTimeIso,
    match_status: "matched",
    match_confidence: 0.9,
    match_quality_flags: [],
    publishability_status: "publishable",
    publishability_reasons: [],
    covered_score: 50 + i,
    score_label: "Playable",
    confidence_label: "Solid Confidence",
    risk_label: "Moderate Risk",
  } as ParlayOptionRow));

  // Mirrors ParlayBuilderShell's manualCatalogRows call with its default (untouched) filter state.
  const filtered = filterParlayOptionsSnapshotRows(rows, {
    date: todayEastern,
    sport: null,
    league: null,
    eventId: null,
    marketType: null,
    sportsbook: null,
    participantSearch: "",
    onlyScored: true,
    onlyMatched: false,
    excludeStaleOdds: false,
    excludeLowConfidenceMatches: false,
    limit: 100,
    includeVariantBooks: false,
  });

  assert.equal(filtered.length, 33, "the default filter state must not hide any of the eligible published rows");
});

function manualRow(score: number, index: number): ParlayOptionRow {
  return {
    current_prop_id: `manual-${index}`,
    latest_scored_prop_id: `scored-${index}`,
    latest_snapshot_id: `snapshot-${index}`,
    market_instance_key: null,
    event_id: `event-${index}`,
    participant_id: `participant-${index}`,
    participant_type: "player",
    display_label: `Player ${index} — More 10.5 player points · Event ${index} · Jul 20, 7:00 PM`,
    sport: "basketball",
    league: "wnba",
    event_display_name: `Event ${index}`,
    participant_display_name: `Player ${index}`,
    participant_image_url: null,
    player_headshot_url: null,
    team_display_name: `Team ${index}`,
    team_logo_url: null,
    opponent_display_name: `Opponent ${index}`,
    opponent_logo_url: null,
    market_type: "player_points",
    sportsbook: null,
    sportsbooks: [],
    sportsbook_count: 0,
    grouped_variant_count: 1,
    side: "More",
    line: 10.5,
    over_price: -110,
    under_price: -110,
    start_time: `2026-07-20T23:${String(index).padStart(2, "0")}:00.000Z`,
    match_status: "matched",
    match_confidence: 0.9,
    match_quality_flags: [],
    publishability_status: "publishable",
    publishability_reasons: [],
    covered_score: score,
    score_label: score >= 70 ? "Playable" : "Lean",
    confidence_label: "Solid Confidence",
    risk_label: "Moderate Risk",
  } as ParlayOptionRow;
}

test("Manual Analyzer exposes explicit sub-70, 70+, 80+, and 90+ score bands", () => {
  assert.deepEqual(manualScoreBandOptions.map((option) => option.value), ["", "sub70", "70+", "80+", "90+"]);
  assert.equal(manualScoreBandMatches(69, "sub70"), true);
  assert.equal(manualScoreBandMatches(70, "sub70"), false);
  assert.equal(manualScoreBandMatches(70, "70+"), true);
  assert.equal(manualScoreBandMatches(79, "80+"), false);
  assert.equal(manualScoreBandMatches(80, "80+"), true);
  assert.equal(manualScoreBandMatches(89, "90+"), false);
  assert.equal(manualScoreBandMatches(90, "90+"), true);
});

test("Manual Analyzer keeps more than ten scored props visible by default", () => {
  const rows = Array.from({ length: 12 }, (_, index) => manualRow(60 + index, index));
  const catalog = buildManualCatalogRows(rows, {
    date: "2026-07-20",
    league: "",
    marketType: "",
    search: "",
    scoreBand: "",
    sortBy: "score",
    limit: 25,
  });

  assert.equal(catalog.length, 12);
  assert.ok(catalog.some((row) => Number(row.covered_score ?? 0) < 70));
  assert.ok(catalog.some((row) => Number(row.covered_score ?? 0) >= 70));
});

test("Manual Analyzer score-band filtering isolates sub-70 and 70+/80+/90+ buckets", () => {
  const rows = [manualRow(65, 1), manualRow(72, 2), manualRow(83, 3), manualRow(91, 4)];

  assert.equal(buildManualCatalogRows(rows, {
    date: "2026-07-20",
    league: "",
    marketType: "",
    search: "",
    scoreBand: "sub70",
    sortBy: "score",
    limit: 25,
  }).length, 1);

  assert.equal(buildManualCatalogRows(rows, {
    date: "2026-07-20",
    league: "",
    marketType: "",
    search: "",
    scoreBand: "70+",
    sortBy: "score",
    limit: 25,
  }).length, 3);

  assert.equal(buildManualCatalogRows(rows, {
    date: "2026-07-20",
    league: "",
    marketType: "",
    search: "",
    scoreBand: "80+",
    sortBy: "score",
    limit: 25,
  }).length, 2);

  assert.equal(buildManualCatalogRows(rows, {
    date: "2026-07-20",
    league: "",
    marketType: "",
    search: "",
    scoreBand: "90+",
    sortBy: "score",
    limit: 25,
  }).length, 1);
});
