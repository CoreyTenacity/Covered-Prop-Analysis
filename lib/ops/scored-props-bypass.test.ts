import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Session 100 (owner-directed public-surface closure pass): the owner flagged
 * `app/api/knowledge/scored-props/route.ts` as a concrete blocker -- an
 * unauthenticated, zero-caller debug route that read `scored_props` directly
 * via `selectRows`, with no score-eligibility-contract check of any kind
 * (see docs/AGENT_HANDOFF.md Session 99/100 for the full classification:
 * obsolete diagnostic route, no auth, no UI/internal callers, present in the
 * deployed Cloudflare build's route table). Removed outright per the owner's
 * explicit "prefer removal/denial over preserving an unnecessary score
 * endpoint" instruction, rather than gated -- there is no product feature to
 * preserve.
 *
 * These are durable regression guards: the route must never come back, and
 * no OTHER `app/api` route may reintroduce a raw, unfiltered `scored_props`
 * read the way this one did. Every route that legitimately needs score data
 * must go through `lib/knowledge/read-service.ts`'s functions (which apply
 * `filterRowsWithCurrentScoreContract`) rather than calling `selectRows`
 * against `scored_props` itself.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

test("app/api/knowledge/scored-props/route.ts no longer exists", () => {
  const removedPath = path.join(REPO_ROOT, "app/api/knowledge/scored-props/route.ts");
  assert.equal(fs.existsSync(removedPath), false, "the unauthenticated, contract-unenforced debug route must stay removed");
});

test("no app/api route directly selects from scored_props (every score-exposing route must go through read-service.ts's contract-enforced functions)", () => {
  const apiRoot = path.join(REPO_ROOT, "app/api");
  const offenders: string[] = [];

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name !== "route.ts") continue;
      const contents = fs.readFileSync(full, "utf8");
      if (contents.includes('"scored_props"') || contents.includes("'scored_props'")) {
        offenders.push(path.relative(REPO_ROOT, full));
      }
    }
  }

  walk(apiRoot);
  assert.deepEqual(offenders, [], `these routes read scored_props directly, bypassing the shared contract filter: ${offenders.join(", ")}`);
});
