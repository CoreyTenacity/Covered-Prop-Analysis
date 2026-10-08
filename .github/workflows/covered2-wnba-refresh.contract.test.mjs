import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(new URL("./covered2-wnba-refresh.yml", import.meta.url), "utf8");
const reviewedSha = "0d7551fb7ff0ed9bd410ea2b0cdd57f510bfee72";
const retiredSha = "667c13ac455786210618ecfd9a9af65cfb56cad4";
const readyPairs = [
  ["NFL", "receiving_yards"],
  ["NFL", "rushing_yards"],
  ["MLB", "batter_total_bases"],
  ["MLB", "pitcher_strikeouts"],
  ["WNBA", "rebounds"],
  ["NBA", "points"],
  ["NBA", "rebounds"],
  ["NBA", "assists"],
];
const blockedPairs = [
  ["NFL", "passing_yards"],
  ["WNBA", "assists"],
  ["WNBA", "points"],
];

function extractContractShell() {
  const contractStep = workflow.indexOf("        id: contract");
  assert.notEqual(contractStep, -1, "contract step exists");
  const runStart = workflow.indexOf("        run: |\n", contractStep);
  assert.notEqual(runStart, -1, "contract step has an inline shell");
  const bodyStart = runStart + "        run: |\n".length;
  const nextStep = workflow.indexOf("\n      - name:", bodyStart);
  assert.notEqual(nextStep, -1, "contract shell has a bounded end");
  return workflow.slice(bodyStart, nextStep).split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
}

const contractShell = extractContractShell();

function runContract(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "c2-receiver-contract-"));
  const outputPath = join(directory, "github-output.txt");
  writeFileSync(outputPath, "");
  const env = {
    ...process.env,
    GITHUB_OUTPUT: outputPath,
    TRIGGER: "workflow_dispatch",
    REF_NAME: "main",
    ACTOR: "CoreyTenacity",
    SCHEDULER_ENABLED: "false",
    RELEASE_SHA_INPUT: reviewedSha,
    PIN: reviewedSha,
    ALLOWLIST: "corey093011@gmail.com",
    CADENCE: "0,30 11-23,0-4 * * *",
    DEPLOYMENT_AUTHORIZED: "true",
    CERTIFICATION_LEDGER_ENABLED: "false",
    MANUAL_OPERATION: "exact-market-discovery",
    VALIDATION_SPORT_INPUT: "NFL",
    VALIDATION_MARKET_INPUT: "receiving_yards",
    FORCE_DISCOVERY_INPUT: "false",
    SCORED_PROP_ID_INPUT: "",
    ...overrides,
  };
  try {
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", contractShell], {
      cwd: new URL("..", import.meta.url),
      env,
      encoding: "utf8",
      timeout: 5_000,
    });
    return { ...result, diagnostics: (result.stdout ?? "") + (result.stderr ?? ""), outputs: readFileSync(outputPath, "utf8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("only the exact reviewed SHA, main ref, owner actor, matching production pin, and paused persistent gates are accepted", () => {
  assert.match(workflow, new RegExp("REVIEWED_RELEASE_SHA=\"" + reviewedSha + "\""));
  assert.match(workflow, /\[ "\$PIN" != "\$REVIEWED_RELEASE_SHA" \]/);
  for (const invalid of [
    { RELEASE_SHA_INPUT: "e51d02ebe61d8e6eab998cb20d3814e8f14827cd" },
    { RELEASE_SHA_INPUT: retiredSha },
    { PIN: "e51d02ebe61d8e6eab998cb20d3814e8f14827cd" },
    { SCHEDULER_ENABLED: "true" },
    { CERTIFICATION_LEDGER_ENABLED: "true" },
    { ACTOR: "not-the-owner" },
    { REF_NAME: "codex/old-receiver" },
  ]) {
    const result = runContract(invalid);
    assert.notEqual(result.status, 0, JSON.stringify(invalid));
    assert.match(result.diagnostics, /Rejected exact-market workflow dispatch/);
  }
  assert.equal(runContract().status, 0);
});

test("each and only each READY_FOR_LIVE_EXPERIMENT pair routes as one exact discovery", () => {
  for (const [sport, market] of readyPairs) {
    const result = runContract({ VALIDATION_SPORT_INPUT: sport, VALIDATION_MARKET_INPUT: market });
    assert.equal(result.status, 0, sport + "/" + market + ": " + result.diagnostics);
    assert.match(result.outputs, /^mode=manual-validation$/m);
    assert.match(result.outputs, new RegExp("^sport=" + sport + "$", "m"));
    assert.match(result.outputs, new RegExp("^market=" + market + "$", "m"));
    assert.match(result.outputs, new RegExp("^release_sha=" + reviewedSha + "$", "m"));
    assert.match(result.outputs, /^exact_manual=true$/m);
  }
  for (const [sport, market] of blockedPairs) {
    const result = runContract({ VALIDATION_SPORT_INPUT: sport, VALIDATION_MARKET_INPUT: market });
    assert.notEqual(result.status, 0, sport + "/" + market + " must fail closed");
    assert.match(result.diagnostics, /Unsupported exact sport\/market pair/);
  }
});

test("all eight ready markets route to certification only with one exact existing scored_prop UUID and no bypass", () => {
  const scoredPropId = "00000000-0000-4000-8000-000000000001";
  for (const [sport, market] of readyPairs) {
    const result = runContract({
      MANUAL_OPERATION: "certification-one-observation",
      VALIDATION_SPORT_INPUT: sport,
      VALIDATION_MARKET_INPUT: market,
      SCORED_PROP_ID_INPUT: scoredPropId,
    });
    assert.equal(result.status, 0, sport + "/" + market + ": " + result.diagnostics);
    assert.match(result.outputs, /^mode=manual-certification$/m);
    assert.match(result.outputs, new RegExp("^sport=" + sport + "$", "m"));
    assert.match(result.outputs, new RegExp("^market=" + market + "$", "m"));
    assert.match(result.outputs, new RegExp("^scored_prop_id=" + scoredPropId + "$", "m"));
  }
  for (const invalid of ["", "not-a-uuid"]) {
    const result = runContract({
      MANUAL_OPERATION: "certification-one-observation",
      SCORED_PROP_ID_INPUT: invalid,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.diagnostics, /exact existing scored_prop UUID/);
  }
  assert.notEqual(runContract({
    MANUAL_OPERATION: "certification-one-observation",
    FORCE_DISCOVERY_INPUT: "true",
    SCORED_PROP_ID_INPUT: scoredPropId,
  }).status, 0);
});

test("read-only preflight is limited to one NFL market and cannot fall through to discovery", () => {
  const allowed = runContract({ MANUAL_OPERATION: "exact-market-preflight" });
  assert.equal(allowed.status, 0);
  assert.match(allowed.outputs, /^mode=manual-preflight$/m);
  assert.match(workflow, /refreshNflMarkets\(\{ write: false, markets: \[market\] \}\)/);
  assert.match(workflow, /steps\.contract\.outputs\.mode != 'manual-preflight'/);
  for (const invalid of [
    { VALIDATION_SPORT_INPUT: "MLB", VALIDATION_MARKET_INPUT: "batter_total_bases" },
    { FORCE_DISCOVERY_INPUT: "true" },
  ]) {
    assert.notEqual(runContract({ MANUAL_OPERATION: "exact-market-preflight", ...invalid }).status, 0);
  }
});

test("superseded repository_dispatch manual payload is explicitly rejected; ordinary paused wakes still skip checkout", () => {
  assert.doesNotMatch(workflow, new RegExp(retiredSha));
  const retired = runContract({
    TRIGGER: "repository_dispatch",
    SCHEDULER_ENABLED: "false",
    MANUAL_VALIDATION: "true",
    EVENT_TYPE: "covered2-wnba-refresh",
    SCHEMA: "covered2-manual-validation/v1",
    SOURCE: "owner-manual-validation",
    SENDER: "CoreyTenacity",
    EXPECTED_SHA: retiredSha,
  });
  assert.notEqual(retired.status, 0);
  assert.match(retired.diagnostics, /legacy repository_dispatch manual-validation contract is retired/);

  const ordinary = runContract({ TRIGGER: "repository_dispatch", SCHEDULER_ENABLED: "false", MANUAL_VALIDATION: "false" });
  assert.equal(ordinary.status, 0);
  assert.match(ordinary.outputs, /^skip=true$/m);
  const gate = workflow.indexOf("C2 global scheduler gate is false; scheduled and ordinary repository_dispatch wakes exit before private checkout.");
  const checkout = workflow.indexOf("Check out PRIVATE Covered at the immutable production pin");
  assert.ok(gate >= 0 && checkout > gate);
});

test("certification uses the deployed private one-observation CLI and only process-local write permission", () => {
  assert.match(workflow, /COVERED2_CERTIFICATION_LEDGER_ENABLED:\s*"true"/);
  assert.match(workflow, /COVERED2_CERTIFICATION_LEDGER_PERSISTENT_ENABLED:\s*\$\{\{\s*vars\.COVERED2_CERTIFICATION_LEDGER_ENABLED\s*\}\}/);
  assert.match(workflow, /COVERED2_WNBA_SCHEDULER_ENABLED:\s*\$\{\{\s*vars\.COVERED2_WNBA_SCHEDULER_ENABLED\s*\}\}/);
  assert.match(workflow, /run-covered2-certification-validation\.mjs --sport "\$SPORT" --market "\$MARKET" --scoredPropId "\$SCORED_PROP_ID"/);
  assert.doesNotMatch(workflow, /buildCoveredPicksBoard|listCovered2CatalogProps/);
  assert.match(workflow, /COVERED_PRIVATE_PIPELINE_SHA_V2:\s*\$\{\{\s*steps\.contract\.outputs\.release_sha\s*\}\}/);
});

test("blocked readiness markets stay outside the receiver allowlist, including provisional WNBA Points", () => {
  for (const pair of blockedPairs) assert.doesNotMatch(workflow, new RegExp(pair[0] + ":" + pair[1]));
  assert.doesNotMatch(workflow, /COVERED2_WNBA_SCHEDULER_ENABLED:\s*"true"/);
});

test("manual/scheduled concurrency remains isolated, non-cancelling, and no cron is added", () => {
  assert.match(workflow, /group:\s*\$\{\{\s*github\.event\.client_payload\.manual_validation\s*==\s*true\s*&&\s*'covered2-wnba-refresh-manual-validation'\s*\|\|\s*'covered2-wnba-refresh'\s*\}\}/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.doesNotMatch(workflow, /^\s{2}schedule:/m);
});
