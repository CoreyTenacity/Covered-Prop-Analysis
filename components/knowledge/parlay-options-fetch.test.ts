import assert from "node:assert/strict";
import test from "node:test";

import { fetchParlayOptions } from "./parlay-options-fetch.ts";
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
