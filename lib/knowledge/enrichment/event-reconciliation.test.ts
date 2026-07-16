import assert from "node:assert/strict";
import test from "node:test";
import { ensureEvent } from "./shared.ts";
import { deleteRows, selectRows } from "@/lib/db/supabase-server";

/**
 * Deterministic integration test for the ESPN -> SportsDataverse cross-provider
 * event reconciliation path. Calls the real production ensureEvent() function
 * (not a reimplementation) to verify that a SportsDataverse ingestion of a
 * game that ESPN already created reuses the existing event row rather than
 * creating a duplicate.
 *
 * SAFETY — this test writes to a real Supabase project and must NEVER run
 * against the production project. It is skipped by default and requires all
 * guards below to be satisfied before it runs:
 *
 *   1. RUN_WNBA_RECONCILIATION_TEST=true       — explicit opt-in
 *   2. SUPABASE_TEST_PROJECT=true              — declares target is a test project
 *   3. COVERED_PRODUCTION_SUPABASE_URL set     — REQUIRED for URL cross-check
 *   4. NEXT_PUBLIC_SUPABASE_URL must differ    — enforced; never logged
 *   5. Rejects when:
 *        NODE_ENV=production
 *        VERCEL_ENV=production
 *        VERCEL=1 (Vercel runtime)
 *
 * COVERED_PRODUCTION_SUPABASE_URL is not optional. The test refuses to run if
 * it is absent, because without it there is no way to confirm the configured
 * project is not production. Set it to the production Supabase URL in your
 * local .env.test (never commit it); the value is used only for comparison and
 * is never written to logs.
 *
 * To run against a safe test/staging Supabase project:
 *
 *   NEXT_PUBLIC_SUPABASE_URL=<test-project-url> \
 *   SUPABASE_SECRET_KEY=<test-service-role-key> \
 *   COVERED_PRODUCTION_SUPABASE_URL=<production-project-url> \
 *   RUN_WNBA_RECONCILIATION_TEST=true \
 *   SUPABASE_TEST_PROJECT=true \
 *   pnpm exec node --experimental-strip-types \
 *     --loader ./scripts/ts-path-loader.mjs \
 *     --test lib/knowledge/enrichment/event-reconciliation.test.ts
 *
 * STATUS: as of the initial commit this test has NOT been run against any
 * project. It documents and exercises the reconciliation path but does not
 * yet constitute proof that reconciliation works end-to-end. The live
 * cross-provider reconciliation path remains pending until either:
 *   - this test passes on a safe non-production project, OR
 *   - SportsDataverse ingests the pending ESPN-created event (c621477c-...)
 *     and a production re-check confirms no duplicate was created.
 */

function assertSafeToRun(): void {
  const errors: string[] = [];

  if (process.env.RUN_WNBA_RECONCILIATION_TEST !== "true") {
    errors.push("RUN_WNBA_RECONCILIATION_TEST is not set to 'true'");
  }
  if (process.env.SUPABASE_TEST_PROJECT !== "true") {
    errors.push("SUPABASE_TEST_PROJECT is not set to 'true' — this test must not run against the production project");
  }
  if (process.env.NODE_ENV === "production") {
    errors.push("NODE_ENV=production — refusing to run write test in production");
  }
  if (process.env.VERCEL_ENV === "production") {
    errors.push("VERCEL_ENV=production — refusing to run write test in production");
  }
  if (process.env.VERCEL === "1") {
    errors.push("VERCEL=1 — refusing to run inside a Vercel request lifecycle");
  }

  // Mandatory URL cross-check. COVERED_PRODUCTION_SUPABASE_URL must be set
  // so we can confirm the configured project is not production. Without it
  // there is no independent anchor to verify against. Never logged.
  const prodUrl = process.env.COVERED_PRODUCTION_SUPABASE_URL ?? "";
  const configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!prodUrl) {
    errors.push("COVERED_PRODUCTION_SUPABASE_URL is not set — required to confirm the configured project is not production");
  } else if (prodUrl === configuredUrl) {
    errors.push("Configured Supabase project matches COVERED_PRODUCTION_SUPABASE_URL — refusing to run against production");
  }

  if (errors.length > 0) {
    throw new Error(
      `[event-reconciliation.test] Unsafe to run:\n${errors.map((e) => `  - ${e}`).join("\n")}\n\nSee test file header for required guards.`,
    );
  }
}

const ENABLED =
  process.env.RUN_WNBA_RECONCILIATION_TEST === "true" &&
  process.env.SUPABASE_TEST_PROJECT === "true" &&
  Boolean(process.env.COVERED_PRODUCTION_SUPABASE_URL) &&
  process.env.COVERED_PRODUCTION_SUPABASE_URL !== process.env.NEXT_PUBLIC_SUPABASE_URL;

test(
  "ESPN-created event is reused (not duplicated) when SportsDataverse ingests the same game later",
  {
    skip: !ENABLED
      ? "set RUN_WNBA_RECONCILIATION_TEST=true, SUPABASE_TEST_PROJECT=true, and COVERED_PRODUCTION_SUPABASE_URL to a safe non-production project — see test file header"
      : false,
  },
  async () => {
    // Hard-check before any DB access — belt-and-suspenders on top of skip.
    assertSafeToRun();

    // Real WNBA team ids (Las Vegas Aces / Phoenix Mercury) so ensureEvent's
    // league/team config lookups succeed; far-future date isolates this row
    // from any real production event.
    const homeTeamId = "7460c04c-215a-49d1-b2e8-3a81ca2e435d";
    const awayTeamId = "4d965d20-61b1-4e05-9d95-3e940057f61a";
    const scheduledDate = "2099-01-01";
    const startTime = "2099-01-01T22:00:00+00:00";
    const displayName = "TEST Phoenix Mercury at Las Vegas Aces (reconciliation test)";

    let eventId: string | null = null;
    try {
      // 1. ESPN inserts the event first.
      eventId = await ensureEvent({
        league: "WNBA",
        provider: "espn-wnba",
        externalId: "test-espn-999999",
        scheduledDate,
        startTime,
        status: "completed",
        displayName,
        homeTeamId,
        awayTeamId,
        metadata: { source: "espn-wnba", home_score: 90, away_score: 80 },
      });
      assert.ok(eventId, "ESPN insert should return an event id");

      // 2. SportsDataverse ingests the same game later, keyed by its own
      //    external id but matching on (league, date, home_team, away_team).
      const secondId = await ensureEvent({
        league: "WNBA",
        provider: "sportsdataverse-wnba",
        externalId: "test-sdv-999999",
        scheduledDate,
        startTime,
        status: "completed",
        displayName,
        homeTeamId,
        awayTeamId,
        metadata: { source: "sportsdataverse-wnba", home_score: 90, away_score: 80 },
      });

      // 3. Both calls must resolve to the same canonical event row.
      assert.equal(secondId, eventId, "SportsDataverse must reuse the ESPN-created event row");

      const [row] = await selectRows<{ id: string; provider_event_ids: Record<string, string> }>("events", {
        select: "id,provider_event_ids",
        filters: [{ column: "id", value: eventId }],
        limit: 1,
      });
      assert.ok(row, "event row should exist after both provider writes");
      assert.equal(row.provider_event_ids["espn-wnba"], "test-espn-999999");
      assert.equal(row.provider_event_ids["sportsdataverse-wnba"], "test-sdv-999999");

      const duplicates = await selectRows<{ id: string }>("events", {
        select: "id",
        filters: [
          { column: "league_id", value: "wnba" },
          { column: "scheduled_date", value: scheduledDate },
          { column: "home_team_id", value: homeTeamId },
          { column: "away_team_id", value: awayTeamId },
        ],
      });
      assert.equal(duplicates.length, 1, "exactly one event should exist for this matchup/date");
    } finally {
      // Always attempt cleanup, even on assertion failure.
      if (eventId) {
        await deleteRows("source_mappings", [
          { column: "entity_type", value: "event" },
          { column: "entity_id", value: eventId },
        ]);
        await deleteRows("event_participants", [{ column: "event_id", value: eventId }]);
        await deleteRows("games", [{ column: "id", value: eventId }]);
        await deleteRows("events", [{ column: "id", value: eventId }]);
      }
    }
  },
);
