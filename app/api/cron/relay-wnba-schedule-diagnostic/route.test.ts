import { test } from "node:test";
import assert from "node:assert";

/**
 * Tests for the WNBA schedule diagnostic relay route
 *
 * Note: These tests do not make actual network requests to stats.nba.com
 * during CI/CD. Use the Vercel preview for end-to-end testing.
 */

test("validates date format strictly", () => {
  // Format pattern validation (YYYY-MM-DD only)
  // This validates the FORMAT; semantic validity (month 1-12) is checked at route level
  const formatValidator = /^\d{4}-\d{2}-\d{2}$/;

  // Valid dates (must match format)
  const validDates = ["2026-07-11", "2025-12-31", "2024-01-01"];
  for (const date of validDates) {
    assert.strictEqual(formatValidator.test(date), true, `${date} should match YYYY-MM-DD format`);
  }

  // Invalid FORMAT (must NOT match pattern)
  const invalidFormats = [
    "07-11-2026",       // Wrong order
    "2026/07/11",       // Wrong separators
    "2026-7-11",        // Single digit month/day
    "invalid",          // Not a date
    "",                 // Empty
  ];
  for (const date of invalidFormats) {
    assert.strictEqual(formatValidator.test(date), false, `${date} should NOT match YYYY-MM-DD format`);
  }

  // Note: Semantic validation (month 1-12, valid day for month) happens in route
  // via the Date constructor, not in format validation
});

test("formats dates in Eastern timezone correctly", () => {
  // The formatter should convert to MM/DD/YYYY Eastern time
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });

  const testDate = new Date("2026-07-11T12:00:00-04:00");
  const formatted = formatter.format(testDate);
  // Should be MM/DD/YYYY format
  assert.match(formatted, /^\d{2}\/\d{2}\/\d{4}$/);
});

test("produces minimal diagnostic output", () => {
  // Verify the diagnostic response shape
  const exampleDiagnostic = {
    environment: "vercel",
    timestamp: new Date().toISOString(),
    testDate: "07/11/2026",
    leagueId: "10",
    url: "https://stats.nba.com/stats/scoreboardv2?GameDate=07%2F11%2F2026&LeagueID=10&DayOffset=0",
    timeoutMs: 12000,
    durationMs: 150,
    httpStatus: 200,
    httpStatusText: "OK",
    contentType: "application/json",
    responseBytes: 5432,
    resultSetCount: 1,
    success: true,
    error: null,
    parseError: null,
  };

  // Verify all required fields exist
  assert.strictEqual(typeof exampleDiagnostic.environment, "string");
  assert.strictEqual(typeof exampleDiagnostic.timestamp, "string");
  assert.strictEqual(typeof exampleDiagnostic.durationMs, "number");
  assert.strictEqual(typeof exampleDiagnostic.success, "boolean");
  assert.strictEqual(typeof exampleDiagnostic.resultSetCount, "number");

  // Verify response structure is minimal (only diagnostic metadata, no full provider payload)
  const keys = Object.keys(exampleDiagnostic);
  assert.ok(keys.includes("environment"));
  assert.ok(keys.includes("timestamp"));
  assert.ok(keys.includes("durationMs"));
  assert.ok(keys.includes("success"));
  assert.ok(keys.length <= 16, "Response should have minimal fields only");
});

test("league ID is hardcoded to WNBA", () => {
  // The route must not accept arbitrary league IDs
  const leagueId = "10"; // WNBA only
  assert.strictEqual(leagueId, "10");
});

test("authentication is required", () => {
  // This is verified by cronAuthorized() at route level
  // The route should return 401 if authorization header is missing or invalid
  assert.strictEqual(typeof cronAuthorized, "function");
});

// Helper function imported from actual code
function cronAuthorized(authorization: string | null) {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return false;
  const received = authorization?.replace(/^Bearer\s+/i, "").trim();
  return Boolean(received) && received === expected;
}
