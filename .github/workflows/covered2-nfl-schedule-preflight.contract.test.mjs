import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(new URL("./covered2-nfl-schedule-preflight.yml", import.meta.url), "utf8");
const expectedSha = "8ad98c5f7ab7667fa0d2186be8ea76ee2adc0dba";
const start = workflow.indexOf("      - name: Validate owner, immutable release, and paused gates");
const run = workflow.indexOf("        run: |\n", start);
assert.notEqual(start, -1);
assert.notEqual(run, -1);
const bodyStart = run + "        run: |\n".length;
const nextStep = workflow.indexOf("\n      - name:", bodyStart);
assert.notEqual(nextStep, -1);
const guard = workflow.slice(bodyStart, nextStep).split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");

function runGuard(overrides = {}) {
  return spawnSync("bash", ["-euo", "pipefail", "-c", guard], {
    env: {
      ...process.env,
      REF_NAME: "main",
      ACTOR: "CoreyTenacity",
      RELEASE_SHA: expectedSha,
      PRIVATE_PIN: expectedSha,
      SCHEDULER_ENABLED: "false",
      CERTIFICATION_WRITE_ENABLED: "false",
      ...overrides,
    },
    encoding: "utf8",
    timeout: 5_000,
  });
}

test("workflow is manual-only and its one operation is the exact schedule command", () => {
  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s{2}schedule:/m);
  assert.equal((workflow.match(/pnpm run covered2:nfl-schedule-preflight/g) ?? []).length, 1);
  assert.match(workflow, /repository: CoreyTenacity\/Covered/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /jobs:\n[\s\S]*?\n    env:\n[\s\S]*?SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(workflow, /Run the single bounded NFL schedule-only command[\s\S]*?SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(workflow, /Read-only NFL identity prerequisite check/);
  assert.match(workflow, /Read-only 14-day future NFL event census/);
  assert.match(workflow, /refreshableStatuses = new Set\(\["scheduled", "pre", "pregame"\]\)/);
  assert.equal(runGuard().status, 0);
});

test("wrong actor/ref/SHA/pin or any enabled persistent gate is rejected", () => {
  for (const overrides of [
    { ACTOR: "someone-else" },
    { REF_NAME: "codex/branch" },
    { RELEASE_SHA: "2599264e060e416fce4557ad8eb14b36b1d0ebb8" },
    { PRIVATE_PIN: "2599264e060e416fce4557ad8eb14b36b1d0ebb8" },
    { SCHEDULER_ENABLED: "true" },
    { CERTIFICATION_WRITE_ENABLED: "true" },
  ]) assert.notEqual(runGuard(overrides).status, 0, JSON.stringify(overrides));
});

test("only bounded identity/schedule tables are writable and no market or certification step is present", () => {
  assert.match(workflow, /writes: 0/);
  assert.match(workflow, /source_mappings/);
  assert.match(workflow, /teams/);
  assert.match(workflow, /events/);
  for (const forbidden of ["refreshNflMarkets", "current_props", "odds_snapshots", "score_explanations", "certification-one-observation", "covered2-wnba-refresh"]) {
    assert.doesNotMatch(workflow, new RegExp(forbidden));
  }
});
