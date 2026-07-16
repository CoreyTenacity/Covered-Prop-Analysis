import assert from "node:assert/strict";
import test from "node:test";
import { SharpApiAdapter, summarizeSharpApiPayload } from "./sharpapi.ts";

test("reports whether SharpAPI is configured", () => {
  assert.equal(new SharpApiAdapter("").configured(), false);
  assert.equal(new SharpApiAdapter("test-key").configured(), true);
});

test("summarizes records without exposing the full provider payload", () => {
  assert.deepEqual(summarizeSharpApiPayload({ data: [{ market_type: "player_prop" }, { market_type: "moneyline" }], pagination: { total: 8 } }), {
    records: 2, propRecords: 0, hasMore: false, marketTypes: ["player_prop", "moneyline"],
  });
});
