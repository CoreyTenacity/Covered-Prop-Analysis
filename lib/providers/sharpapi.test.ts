import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { SharpApiAdapter, summarizeSharpApiPayload, type SharpApiProviderError } from "./sharpapi.ts";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

test("reports whether SharpAPI is configured", () => {
  assert.equal(new SharpApiAdapter("").configured(), false);
  assert.equal(new SharpApiAdapter("test-key").configured(), true);
});

test("summarizes records without exposing the full provider payload", () => {
  assert.deepEqual(summarizeSharpApiPayload({ data: [{ market_type: "player_prop" }, { market_type: "moneyline" }], pagination: { total: 8 } }), {
    records: 2, propRecords: 0, hasMore: false, marketTypes: ["player_prop", "moneyline"],
  });
});

test("a successful strict-shape response makes exactly one physical request -- no compatibility retry", async () => {
  const calls: string[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async (url: string | URL) => {
    calls.push(String(url));
    return jsonResponse(200, { data: [], pagination: {} });
  });
  try {
    const adapter = new SharpApiAdapter("test-key");
    const result = await adapter.fetchOdds({ league: "MLB", sport: "BASEBALL", marketType: "player_strikeouts", sportsbook: "DraftKings" });
    assert.equal(result.physicalRequestCount, 1);
    assert.equal(calls.length, 1);
  } finally {
    fetchMock.mock.restore();
  }
});

test("allowFallbacks:false never attempts a second request, even on a 400", async () => {
  let calls = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return jsonResponse(400, { error: "bad market_type" });
  });
  try {
    const adapter = new SharpApiAdapter("test-key");
    await assert.rejects(
      () => adapter.fetchOdds({ league: "MLB", sport: "BASEBALL", allowFallbacks: false }),
      (error: SharpApiProviderError) => {
        assert.equal(error.errorClass, "bad_request");
        assert.equal(error.physicalRequestCount, 1);
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    fetchMock.mock.restore();
  }
});

test("a 400 triggers exactly one spaced compatibility retry (not four immediate variants) -- both physical requests are counted", async () => {
  const callTimestamps: number[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    callTimestamps.push(Date.now());
    if (callTimestamps.length === 1) return jsonResponse(400, { error: "bad market_type" });
    return jsonResponse(200, { data: [], pagination: {} });
  });
  try {
    const adapter = new SharpApiAdapter("test-key");
    const result = await adapter.fetchOdds({ league: "MLB", sport: "BASEBALL" });
    assert.equal(callTimestamps.length, 2);
    assert.equal(result.physicalRequestCount, 2);
    const gapMs = callTimestamps[1] - callTimestamps[0];
    assert.ok(gapMs >= 1400, `expected the retry to be spaced by ~${SharpApiAdapter.RETRY_SPACING_MS}ms, got ${gapMs}ms`);
  } finally {
    fetchMock.mock.restore();
  }
});

test("two consecutive 400s are reported as errorClass:bad_request with the accurate physical request count", async () => {
  let calls = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return jsonResponse(400, { error: "bad market_type" });
  });
  try {
    const adapter = new SharpApiAdapter("test-key");
    await assert.rejects(
      () => adapter.fetchOdds({ league: "MLB", sport: "BASEBALL" }),
      (error: SharpApiProviderError) => {
        assert.equal(error.errorClass, "bad_request");
        assert.equal(error.physicalRequestCount, 2);
        return true;
      },
    );
    assert.equal(calls, 2);
  } finally {
    fetchMock.mock.restore();
  }
});

test("a 429 is classified as rate_limited and never attempts the compatibility retry", async () => {
  let calls = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return jsonResponse(429, { error: "rate limited" }, { "retry-after": "1" });
  });
  try {
    const adapter = new SharpApiAdapter("test-key");
    await assert.rejects(
      () => adapter.fetchOdds({ league: "MLB", sport: "BASEBALL" }),
      (error: SharpApiProviderError) => {
        assert.equal(error.errorClass, "rate_limited");
        assert.equal(error.physicalRequestCount, 1);
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    fetchMock.mock.restore();
  }
});

test("a 5xx is classified as server_error, distinct from a 400 or a 429", async () => {
  let calls = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return jsonResponse(503, { error: "upstream unavailable" });
  });
  try {
    const adapter = new SharpApiAdapter("test-key");
    await assert.rejects(
      () => adapter.fetchOdds({ league: "MLB", sport: "BASEBALL" }),
      (error: SharpApiProviderError) => {
        assert.equal(error.errorClass, "server_error");
        return true;
      },
    );
    // A 5xx is not the "retry a different casing" case -- it stops immediately,
    // same as a 429, rather than burning a second physical request.
    assert.equal(calls, 1);
  } finally {
    fetchMock.mock.restore();
  }
});

test("a network/timeout failure is classified as timeout, distinct from every HTTP-status class, and does not retry", async () => {
  let calls = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    calls += 1;
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  });
  try {
    const adapter = new SharpApiAdapter("test-key");
    await assert.rejects(
      () => adapter.fetchOdds({ league: "MLB", sport: "BASEBALL" }),
      (error: SharpApiProviderError) => {
        assert.equal(error.errorClass, "timeout");
        assert.equal(error.physicalRequestCount, 1);
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    fetchMock.mock.restore();
  }
});

// --- Pre-request physical budget enforcement (checked BEFORE each fetch, not counted after) ---

test("remaining allowance of 1 + a canonical 400 -> no compatibility retry is attempted", async () => {
  let calls = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return jsonResponse(400, { error: "bad market_type" });
  });
  try {
    const adapter = new SharpApiAdapter("test-key");
    await assert.rejects(
      () => adapter.fetchOdds({ league: "MLB", sport: "BASEBALL", maxPhysicalRequests: 1 }),
      (error: SharpApiProviderError) => {
        assert.equal(error.errorClass, "bad_request");
        assert.equal(error.physicalRequestCount, 1);
        return true;
      },
    );
    assert.equal(calls, 1, "the budget must prevent a second physical request even though the adapter would otherwise retry a 400");
  } finally {
    fetchMock.mock.restore();
  }
});

test("remaining allowance of 2 + a canonical 400 -> at most one spaced retry, never exceeding the allowance", async () => {
  let calls = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    calls += 1;
    if (calls === 1) return jsonResponse(400, { error: "bad market_type" });
    return jsonResponse(200, { data: [], pagination: {} });
  });
  try {
    const adapter = new SharpApiAdapter("test-key");
    const result = await adapter.fetchOdds({ league: "MLB", sport: "BASEBALL", maxPhysicalRequests: 2 });
    assert.equal(result.physicalRequestCount, 2);
    assert.equal(calls, 2);
  } finally {
    fetchMock.mock.restore();
  }
});

test("a successful canonical request makes exactly one physical call regardless of the configured allowance", async () => {
  let calls = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return jsonResponse(200, { data: [], pagination: {} });
  });
  try {
    const adapter = new SharpApiAdapter("test-key");
    const result = await adapter.fetchOdds({ league: "MLB", sport: "BASEBALL", maxPhysicalRequests: 5 });
    assert.equal(result.physicalRequestCount, 1);
    assert.equal(calls, 1);
  } finally {
    fetchMock.mock.restore();
  }
});

test("a 429 never attempts the compatibility retry even when the allowance would permit one", async () => {
  let calls = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return jsonResponse(429, { error: "rate limited" });
  });
  try {
    const adapter = new SharpApiAdapter("test-key");
    await assert.rejects(
      () => adapter.fetchOdds({ league: "MLB", sport: "BASEBALL", maxPhysicalRequests: 5 }),
      (error: SharpApiProviderError) => {
        assert.equal(error.errorClass, "rate_limited");
        assert.equal(error.physicalRequestCount, 1);
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    fetchMock.mock.restore();
  }
});

test("a timeout respects the remaining allowance (never retries regardless of budget)", async () => {
  let calls = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    calls += 1;
    const error = new Error("timed out");
    error.name = "TimeoutError";
    throw error;
  });
  try {
    const adapter = new SharpApiAdapter("test-key");
    await assert.rejects(() => adapter.fetchOdds({ league: "MLB", sport: "BASEBALL", maxPhysicalRequests: 5 }));
    assert.equal(calls, 1);
  } finally {
    fetchMock.mock.restore();
  }
});

test("a 5xx respects the remaining allowance (never retries regardless of budget)", async () => {
  let calls = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return jsonResponse(503, { error: "upstream unavailable" });
  });
  try {
    const adapter = new SharpApiAdapter("test-key");
    await assert.rejects(() => adapter.fetchOdds({ league: "MLB", sport: "BASEBALL", maxPhysicalRequests: 5 }));
    assert.equal(calls, 1);
  } finally {
    fetchMock.mock.restore();
  }
});
