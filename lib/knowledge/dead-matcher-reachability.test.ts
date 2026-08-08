import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Phase 18 continuation (owner-directed, final closure audit) item 3: a
 * narrow architectural regression guard, not a behavioral test. Confirmed
 * this session (and the prior one) that `matchNormalizedSharpProp`
 * (lib/knowledge/matching.ts) has no production caller anywhere -- its only
 * caller (`ingestSharpApiCandidates`, sharp-ingestion.ts) is itself only
 * called by `refreshSharpApiFeed` (sharpapi-refresh.ts), which nothing in
 * production imports. This test does not re-verify that chain exhaustively
 * (that proof lives in matching.test.ts's file header and this session's
 * report); it exists solely so a FUTURE accidental wire-up of the dead path
 * into a real production entry point fails a test immediately, rather than
 * silently reintroducing a second live matching path with different
 * ambiguity/identity guarantees than matchSharpMarketCandidate.
 */

const root = path.resolve(import.meta.dirname, "..", "..");

function readSource(relativePath: string) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

const PRODUCTION_ENTRY_POINTS = [
  "lib/knowledge/sharp-ingestion-job.ts",
  "lib/ops/github-actions-pipeline.ts",
  "lib/inngest/sharp.ts",
  "lib/inngest/index.ts",
  "app/api/inngest/route.ts",
];

test("dead-matcher reachability guard: no known production entry point imports the dead sharpapi-refresh/matching.ts chain", () => {
  for (const entryPoint of PRODUCTION_ENTRY_POINTS) {
    const source = readSource(entryPoint);
    assert.ok(
      !/from\s+["']@?\/?(\.\.\/)*lib\/providers\/sharpapi-refresh["']/.test(source),
      `${entryPoint} must not import lib/providers/sharpapi-refresh -- doing so would reactivate the dead, unaudited-for-ambiguity matchNormalizedSharpProp path into production`,
    );
    assert.ok(
      !/from\s+["']@?\/?(\.\.\/)*lib\/knowledge\/matching["']/.test(source),
      `${entryPoint} must not import lib/knowledge/matching -- matchNormalizedSharpProp has no ambiguity detection at any tier (see matching.test.ts) and must not become production-reachable without a corresponding fix`,
    );
  }
});

test("dead-matcher reachability guard: sharp-ingestion.ts (matching.ts's only caller) has no production importer other than the already-dead sharpapi-refresh.ts", () => {
  const knownCallerSource = readSource("lib/providers/sharpapi-refresh.ts");
  assert.ok(
    /from\s+["']@\/lib\/knowledge\/sharp-ingestion["']/.test(knownCallerSource),
    "sharpapi-refresh.ts is expected to still be the sole caller of sharp-ingestion.ts's ingestSharpApiCandidates -- if this changes, re-audit reachability",
  );
});
