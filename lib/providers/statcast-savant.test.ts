import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { StatcastSavantAdapter } from "./statcast-savant.ts";

/**
 * Session 106: deterministic tests against the REAL client (fetch mocked at
 * the network boundary only, never the parser/normalizer/summarizer) using
 * repository-contained synthetic CSV fixtures shaped like Baseball Savant's
 * real statcast_search/csv schema. No live provider call is made anywhere in
 * this file.
 */

function csvResponse(headers: string[], rows: Array<Record<string, string>>, status = 200) {
  const lines = [headers.join(","), ...rows.map((row) => headers.map((header) => row[header] ?? "").join(","))];
  return new Response(lines.join("\n"), { status, headers: { "Content-Type": "text/csv" } });
}

function withMockedFetch(handler: (url: URL) => Response, run: () => Promise<void>) {
  const original = globalThis.fetch;
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => handler(new URL(String(input))));
  return run().finally(() => {
    globalThis.fetch = original;
    mock.restoreAll();
  });
}

const PITCH_HEADERS = ["game_date", "player_name", "events", "description", "launch_speed", "launch_angle", "barrel", "estimated_woba_using_speedangle"];

function pitchRow(overrides: Record<string, string>): Record<string, string> {
  return { game_date: "2026-07-01", player_name: "Test Player", events: "", description: "ball", launch_speed: "", launch_angle: "", barrel: "", estimated_woba_using_speedangle: "", ...overrides };
}

test("valid batter response: hard-hit rate, barrel rate, and xwOBA are computed only over batted-ball rows, not every pitch", async () => {
  await withMockedFetch(() => csvResponse(PITCH_HEADERS, [
    pitchRow({ description: "ball" }), // not a batted ball -- must not count in the batted-ball denominator
    pitchRow({ description: "hit_into_play", launch_speed: "98", launch_angle: "15", barrel: "1", estimated_woba_using_speedangle: "0.9" }),
    pitchRow({ description: "hit_into_play", launch_speed: "80", launch_angle: "40", barrel: "0", estimated_woba_using_speedangle: "0.2" }),
  ]), async () => {
    const adapter = new StatcastSavantAdapter();
    const result = await adapter.fetchPlayerContextSummary({ playerName: "Test Player", playerType: "batter", probeOnly: false });
    assert.equal(result.status, "ok");
    // 1 of 2 BATTED BALLS is hard-hit (>=95mph) -- denominator is 2, not 3 (the ball is excluded).
    assert.equal(result.summary?.hardHitRate, 50);
    assert.equal(result.summary?.barrelRate, 50);
    assert.equal(result.summary?.avgExitVelocity, 89);
    assert.equal(result.summary?.xwoba, 0.6, "average() rounds to 1 decimal: (0.9 + 0.2) / 2 = 0.55 -> 0.6");
    assert.equal(result.summary?.sampleSize, 3, "sampleSize reflects every retrieved row, including non-batted-ball pitches");
  });
});

test("valid pitcher response: K-rate and whiff rate are two genuinely distinct metrics with different denominators", async () => {
  await withMockedFetch(() => csvResponse(PITCH_HEADERS, [
    pitchRow({ description: "swinging_strike" }), // a whiff, NOT a strikeout (count doesn't end here)
    pitchRow({ description: "called_strike" }),
    pitchRow({ events: "strikeout", description: "swinging_strike" }), // whiff AND the PA-ending strikeout
    pitchRow({ events: "walk", description: "ball" }),
    pitchRow({ events: "field_out", description: "hit_into_play" }),
  ]), async () => {
    const adapter = new StatcastSavantAdapter();
    const result = await adapter.fetchPlayerContextSummary({ playerName: "Test Pitcher", playerType: "pitcher", probeOnly: false });
    assert.equal(result.status, "ok");
    // 3 plate-appearance-ending rows (strikeout/walk/field_out); 1 of them is a strikeout.
    assert.equal(result.summary?.strikeoutRate, Math.round((1 / 3) * 1000) / 10);
    assert.equal(result.summary?.walkRate, Math.round((1 / 3) * 1000) / 10);
    // 2 of 5 total pitches are swinging strikes -- a completely separate denominator from K-rate.
    assert.equal(result.summary?.swingingStrikeRate, 40);
  });
});

test("a genuinely measured zero rate stays distinguishable from missing data (no batted balls at all)", async () => {
  await withMockedFetch(() => csvResponse(PITCH_HEADERS, [
    pitchRow({ description: "ball" }),
    pitchRow({ description: "called_strike" }),
  ]), async () => {
    const adapter = new StatcastSavantAdapter();
    const result = await adapter.fetchPlayerContextSummary({ playerName: "Test Player", playerType: "batter", probeOnly: false });
    assert.equal(result.status, "ok");
    assert.equal(result.summary?.hardHitRate, null, "zero batted balls means the rate is genuinely unmeasurable -- null, not a fabricated 0");
    assert.equal(result.summary?.avgExitVelocity, null);
  });
});

test("a real 0% hard-hit rate (batted balls exist, none are hard-hit) is a measured zero, not null", async () => {
  await withMockedFetch(() => csvResponse(PITCH_HEADERS, [
    pitchRow({ description: "hit_into_play", launch_speed: "70", launch_angle: "5", barrel: "0" }),
    pitchRow({ description: "hit_into_play", launch_speed: "60", launch_angle: "50", barrel: "0" }),
  ]), async () => {
    const adapter = new StatcastSavantAdapter();
    const result = await adapter.fetchPlayerContextSummary({ playerName: "Test Player", playerType: "batter", probeOnly: false });
    assert.equal(result.summary?.hardHitRate, 0, "a real, measured 0% must not collapse into null");
    assert.equal(result.summary?.barrelRate, 0);
  });
});

test("empty complete response (header row only, zero data rows): sampleSize 0, every rate null, status ok not an error", async () => {
  await withMockedFetch(() => new Response(PITCH_HEADERS.join(","), { status: 200, headers: { "Content-Type": "text/csv" } }), async () => {
    const adapter = new StatcastSavantAdapter();
    const result = await adapter.fetchPlayerContextSummary({ playerName: "Test Player", playerType: "batter", probeOnly: false });
    assert.equal(result.status, "ok");
    assert.equal(result.summary?.sampleSize, 0);
    assert.equal(result.summary?.hardHitRate, null);
    assert.equal(result.summary?.contextConfidence, "low");
  });
});

test("malformed/missing-column CSV does not crash -- unrecognized fields simply produce null rates", async () => {
  await withMockedFetch(() => new Response("some_other_column,another_column\nfoo,bar\nbaz,qux", { status: 200, headers: { "Content-Type": "text/csv" } }), async () => {
    const adapter = new StatcastSavantAdapter();
    const result = await adapter.fetchPlayerContextSummary({ playerName: "Test Player", playerType: "batter", probeOnly: false });
    assert.equal(result.status, "ok");
    assert.equal(result.summary?.sampleSize, 2);
    assert.equal(result.summary?.hardHitRate, null);
    assert.equal(result.summary?.xwoba, null);
  });
});

test("truncated response (a cut-off final line) is parsed without throwing", async () => {
  const text = `${PITCH_HEADERS.join(",")}\n2026-07-01,Test Player,strikeout,swinging_strike,,,,\n2026-07-01,Test Player,,hit_into_play,98`; // trailing line missing several columns
  await withMockedFetch(() => new Response(text, { status: 200, headers: { "Content-Type": "text/csv" } }), async () => {
    const adapter = new StatcastSavantAdapter();
    const result = await adapter.fetchPlayerContextSummary({ playerName: "Test Player", playerType: "pitcher", probeOnly: false });
    assert.equal(result.status, "ok");
    assert.equal(result.summary?.sampleSize, 2);
  });
});

test("oversized response is capped at the documented default per-call row limit (75 for a non-probe call, well under the 150 ceiling maxRows can request)", async () => {
  const rows = Array.from({ length: 400 }, () => pitchRow({ description: "hit_into_play", launch_speed: "90" }));
  await withMockedFetch(() => csvResponse(PITCH_HEADERS, rows), async () => {
    const adapter = new StatcastSavantAdapter();
    const result = await adapter.fetchPlayerContextSummary({ playerName: "Test Player", playerType: "batter", probeOnly: false });
    assert.equal(result.summary?.sampleSize, 75, "non-probe retrieval defaults to a 75-row cap even when the provider returns far more");
  });
});

test("an explicit maxRows above the default is honored up to its 150-row ceiling for a non-probe call", async () => {
  const rows = Array.from({ length: 400 }, () => pitchRow({ description: "hit_into_play", launch_speed: "90" }));
  await withMockedFetch(() => csvResponse(PITCH_HEADERS, rows), async () => {
    const adapter = new StatcastSavantAdapter();
    const result = await adapter.fetchPlayerContextSummary({ playerName: "Test Player", playerType: "batter", probeOnly: false, maxRows: 500 });
    assert.equal(result.summary?.sampleSize, 150, "maxRows cannot exceed the 150-row ceiling for a full (non-probe) retrieval");
  });
});

test("a probe-mode call defaults to a 25-row cap, not the non-probe default", async () => {
  const rows = Array.from({ length: 400 }, () => pitchRow({ description: "hit_into_play", launch_speed: "90" }));
  await withMockedFetch(() => csvResponse(PITCH_HEADERS, rows), async () => {
    const adapter = new StatcastSavantAdapter();
    const result = await adapter.probePlayerContext({ playerName: "Test Player", playerType: "batter" });
    assert.equal(result.summary?.sampleSize, 25);
  });
});

test("a network-level abort reports status 'timeout', not a generic provider-error, and no summary is produced", async () => {
  const original = globalThis.fetch;
  mock.method(globalThis, "fetch", async () => {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    throw error;
  });
  try {
    const adapter = new StatcastSavantAdapter();
    const result = await adapter.fetchPlayerContextSummary({ playerName: "Test Player", playerType: "batter", probeOnly: false });
    assert.equal(result.status, "timeout");
    assert.equal(result.summary, undefined);
  } finally {
    globalThis.fetch = original;
    mock.restoreAll();
  }
});

test("duplicate/repeated identical pitch rows are each counted as their own event, never silently deduped (Statcast rows are one-per-pitch, not one-per-player)", async () => {
  const identicalRow = pitchRow({ description: "hit_into_play", launch_speed: "98", barrel: "1" });
  await withMockedFetch(() => csvResponse(PITCH_HEADERS, [identicalRow, identicalRow, identicalRow]), async () => {
    const adapter = new StatcastSavantAdapter();
    const result = await adapter.fetchPlayerContextSummary({ playerName: "Test Player", playerType: "batter", probeOnly: false });
    assert.equal(result.summary?.sampleSize, 3, "three identical rows are three real events, not collapsed into one");
    assert.equal(result.summary?.hardHitRate, 100);
  });
});

test("a doubleheader (two rows sharing the same game_date) is not deduplicated or special-cased -- both pitches count", async () => {
  await withMockedFetch(() => csvResponse(PITCH_HEADERS, [
    pitchRow({ game_date: "2026-07-04", description: "hit_into_play", launch_speed: "96" }),
    pitchRow({ game_date: "2026-07-04", description: "hit_into_play", launch_speed: "80" }),
  ]), async () => {
    const adapter = new StatcastSavantAdapter();
    const result = await adapter.fetchPlayerContextSummary({ playerName: "Test Player", playerType: "batter", probeOnly: false });
    assert.equal(result.summary?.sampleSize, 2, "the client has no per-game grouping logic -- every row from either game of a doubleheader counts");
  });
});

test("the summary's playerId/playerName reflect the REQUESTED identity, not anything parsed from the CSV rows -- the client performs no per-row identity verification", async () => {
  await withMockedFetch(() => csvResponse(PITCH_HEADERS, [pitchRow({ player_name: "A Totally Different Name In The Data" })]), async () => {
    const adapter = new StatcastSavantAdapter();
    const result = await adapter.fetchPlayerContextSummary({ playerName: "Requested Player", playerId: "12345", playerType: "batter", probeOnly: false });
    assert.equal(result.summary?.playerName, "Requested Player");
    assert.equal(result.summary?.playerId, "12345");
  });
});

test("the requested date range is forwarded as query parameters and trusted -- the client does not re-filter rows by game_date itself", async () => {
  let capturedUrl: URL | null = null;
  await withMockedFetch((url) => {
    capturedUrl = url;
    return csvResponse(PITCH_HEADERS, [pitchRow({ game_date: "2020-01-01" })]); // outside any reasonable window; not re-filtered client-side
  }, async () => {
    const adapter = new StatcastSavantAdapter();
    const result = await adapter.fetchPlayerContextSummary({ playerName: "Test Player", playerType: "batter", probeOnly: false, daysBack: 10 });
    assert.equal(result.summary?.sampleSize, 1, "the client trusts the server-side game_date_gt/game_date_lt filter and does not re-validate row dates");
    assert.ok(capturedUrl?.searchParams.has("game_date_gt"));
    assert.ok(capturedUrl?.searchParams.has("game_date_lt"));
  });
});

test("a small (partial-season) sample is classified with low/medium confidence, matching the documented thresholds", async () => {
  const fewRows = Array.from({ length: 5 }, () => pitchRow({ description: "hit_into_play", launch_speed: "90" }));
  await withMockedFetch(() => csvResponse(PITCH_HEADERS, fewRows), async () => {
    const adapter = new StatcastSavantAdapter();
    const result = await adapter.fetchPlayerContextSummary({ playerName: "Test Player", playerType: "batter", probeOnly: false });
    assert.equal(result.summary?.contextConfidence, "low");
  });
});

test("the client never computes or returns batter/pitcher handedness -- confirming Session 105/106's finding that handedness is unrelated to this source", async () => {
  await withMockedFetch(() => csvResponse([...PITCH_HEADERS, "stand", "p_throws"], [pitchRow({ description: "hit_into_play", launch_speed: "90" })]), async () => {
    const adapter = new StatcastSavantAdapter();
    const result = await adapter.fetchPlayerContextSummary({ playerName: "Test Player", playerType: "batter", probeOnly: false });
    assert.equal(Object.prototype.hasOwnProperty.call(result.summary ?? {}, "bats"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result.summary ?? {}, "throws"), false);
  });
});
