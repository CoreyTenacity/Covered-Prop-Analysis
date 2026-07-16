import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { getProviderDiagnostics } from "./provider-registry.ts";
import { OfficialInjuryReportAdapter } from "./official-injuries-adapter.ts";

function withWnbaInjuryUrl(url: string, run: () => Promise<void> | void) {
  const original = process.env.WNBA_INJURY_REPORT_URL;
  process.env.WNBA_INJURY_REPORT_URL = url;
  return Promise.resolve(run()).finally(() => {
    if (original === undefined) delete process.env.WNBA_INJURY_REPORT_URL;
    else process.env.WNBA_INJURY_REPORT_URL = original;
    mock.restoreAll();
  });
}

test("provider registry reports official injury reports when the WNBA URL is configured", async () => {
  await withWnbaInjuryUrl("https://example.test/wnba-injuries.json", async () => {
    const diagnostics = getProviderDiagnostics();
    const official = diagnostics.find((entry) => entry.id === "official-injuries");
    assert.ok(official);
    assert.equal(official?.status, "configured");
    assert.deepEqual(official?.sports, ["MLB", "WNBA", "NBA", "NFL"]);
  });
});

test("the official injuries adapter parses configured JSON payloads", async () => {
  const adapter = new OfficialInjuryReportAdapter({
    NBA: "",
    WNBA: "https://example.test/wnba-injuries.json",
    NFL: "",
  });

  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify([
    {
      playerName: "Alyssa Thomas",
      team: "Connecticut Sun",
      status: "Out",
      note: "Left ankle",
      reportDate: "2026-07-14",
    },
  ]), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));

  const report = await adapter.fetchReport("WNBA");
  assert.equal(report.data.sourceType, "json");
  assert.equal(report.data.records.length, 1);
  assert.equal(report.data.records[0]?.playerName, "Alyssa Thomas");
  assert.equal(report.data.records[0]?.status, "Out");
  assert.equal(report.data.records[0]?.sourceUrl, "https://example.test/wnba-injuries.json");
});
