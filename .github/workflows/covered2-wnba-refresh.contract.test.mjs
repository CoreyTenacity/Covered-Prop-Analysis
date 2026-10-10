import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(new URL("./covered2-wnba-refresh.yml", import.meta.url), "utf8");
const reviewedSha = "f79174e5b60216f482ea43587ab4fbdb33d79d3d";
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

function extractPilotGuardShell() {
  const guardStep = workflow.indexOf("        id: pilot_attempt_guard");
  assert.notEqual(guardStep, -1, "outer pilot-attempt guard exists");
  const runStart = workflow.indexOf("        run: |\n", guardStep);
  assert.notEqual(runStart, -1, "outer pilot guard has an inline shell");
  const bodyStart = runStart + "        run: |\n".length;
  const nextStep = workflow.indexOf("\n      - name:", bodyStart);
  assert.notEqual(nextStep, -1, "outer pilot guard has a bounded end");
  return workflow.slice(bodyStart, nextStep).split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
}

const pilotGuardShell = extractPilotGuardShell();

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
    BOARD_BUILD_ENABLED: "true",
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

function naturalWakeOverrides(overrides = {}) {
  return {
    TRIGGER: "repository_dispatch",
    REF_NAME: "main",
    SCHEDULER_ENABLED: "true",
    EVENT_TYPE: "covered2-wnba-refresh",
    SCHEMA: "covered2-wnba-refresh/v1",
    SOURCE: "cloudflare-cron",
    SLOT: "2026-10-09T20:30Z",
    DELIVERY_KEY: "covered2:wnba:2026-10-09T20:30Z",
    MANUAL_VALIDATION: "false",
    ...overrides,
  };
}

function runPilotGuard({ history = [], overrides = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "c2-pilot-attempt-guard-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const curlPath = join(bin, "curl");
  const markerPath = join(directory, "curl-called.txt");
  const outputPath = join(directory, "github-output.txt");
  writeFileSync(outputPath, "");
  writeFileSync(curlPath, "#!/bin/sh\nprintf x >> \"$MOCK_CURL_MARKER\"\n[ \"$MOCK_CURL_FAIL\" != true ] || exit 22\nprintf '%s' \"$MOCK_RUNS\"\n");
  chmodSync(curlPath, 0o755);
  const start = new Date(Date.now() - 60_000).toISOString();
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GITHUB_OUTPUT: outputPath,
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_REPOSITORY: "CoreyTenacity/Covered-Prop-Analysis",
    GITHUB_RUN_ID: "999",
    GITHUB_TOKEN: "test-token-not-a-secret",
    TRIGGER: "repository_dispatch",
    MANUAL_VALIDATION: "false",
    SCHEDULER_ENABLED: "true",
    MARKET_SCOPE: "NFL:receiving_yards",
    RECEIVING_YARDS_ENABLED: "true",
    RECEPTIONS_ENABLED: "false",
    RUSHING_YARDS_ENABLED: "false",
    PASSING_YARDS_ENABLED: "false",
    CERTIFICATION_WRITE_ENABLED: "false",
    NBA_LIFECYCLE_ENABLED: "false",
    PILOT_START_AT: start,
    MOCK_RUNS: JSON.stringify({ total_count: history.length, workflow_runs: history }),
    MOCK_CURL_MARKER: markerPath,
    MOCK_CURL_FAIL: "false",
    ...overrides,
  };
  try {
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", pilotGuardShell], {
      cwd: new URL("..", import.meta.url),
      env,
      encoding: "utf8",
      timeout: 5_000,
    });
    return {
      ...result,
      diagnostics: (result.stdout ?? "") + (result.stderr ?? ""),
      outputs: readFileSync(outputPath, "utf8"),
      curlCalled: existsSync(markerPath) && readFileSync(markerPath, "utf8").length > 0,
    };
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

test("the recurring pin comes only from the production environment variable and is exact, 40-hex, and non-secret diagnosed", () => {
  const envIndex = workflow.indexOf("    environment: production");
  const guardIndex = workflow.indexOf("id: pilot_attempt_guard");
  const contractIndex = workflow.indexOf("id: contract");
  assert.ok(envIndex >= 0 && envIndex < guardIndex && guardIndex < contractIndex);
  assert.ok(workflow.includes("PIN: ${{ vars.COVERED_PRIVATE_PIPELINE_SHA_V2 }}"));
  assert.doesNotMatch(workflow, /PIN:\s*\$\{\{\s*secrets\.COVERED_PRIVATE_PIPELINE_SHA_V2/);
  assert.equal(reviewedSha.length, 40);
  assert.match(workflow, new RegExp(`REVIEWED_RELEASE_SHA="${reviewedSha}"`));

  const accepted = runContract(naturalWakeOverrides({ PIN: reviewedSha }));
  assert.equal(accepted.status, 0, accepted.diagnostics);
  assert.match(accepted.diagnostics, /source=production_environment_variable present=true length=40 format_valid=true matches_reviewed_release=true/);
  assert.doesNotMatch(accepted.diagnostics, new RegExp(reviewedSha));

  const invalidPins = [
    ["missing", "", /present=false length=0 format_valid=false matches_reviewed_release=false/],
    ["malformed", reviewedSha.slice(0, -1), /present=true length=39 format_valid=false matches_reviewed_release=false/],
    ["whitespace-wrapped", ` ${reviewedSha} `, /format_valid=false matches_reviewed_release=false/],
    ["stale", "e51d02ebe61d8e6eab998cb20d3814e8f14827cd", /format_valid=true matches_reviewed_release=false/],
  ];
  for (const [name, pin, diagnostic] of invalidPins) {
    const result = runContract(naturalWakeOverrides({ PIN: pin }));
    assert.notEqual(result.status, 0, `${name} pin must fail closed`);
    assert.match(result.diagnostics, diagnostic);
    if (pin.length > 0) assert.doesNotMatch(result.diagnostics, new RegExp(pin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("the outer pilot guard counts all natural wake attempts, including the current run, and stops before checkout after three", () => {
  const now = Date.now();
  const history = (count) => Array.from({ length: count }, (_, index) => ({
    id: String(index + 1),
    event: "repository_dispatch",
    created_at: new Date(now - 30_000 + index * 1000).toISOString(),
    run_attempt: 1,
  }));
  for (const [previous, expected] of [[0, 1], [1, 2], [2, 3]]) {
    const result = runPilotGuard({ history: history(previous) });
    assert.equal(result.status, 0, result.diagnostics);
    assert.match(result.outputs, new RegExp(`^pilot_attempt_number=${expected}$`, "m"));
    assert.equal(result.curlCalled, true);
  }
  const fourth = runPilotGuard({ history: history(3) });
  assert.notEqual(fourth.status, 0);
  assert.match(fourth.diagnostics, /exhausted its three natural wake attempts/);

  const includesCurrent = runPilotGuard({ history: [{
    id: "999",
    event: "repository_dispatch",
    created_at: new Date(now - 10_000).toISOString(),
    run_attempt: 1,
  }] });
  assert.equal(includesCurrent.status, 0, includesCurrent.diagnostics);
  assert.match(includesCurrent.outputs, /^pilot_attempt_number=1$/m);
});

test("expired/invalid pilot windows, unsafe scope, and history failures fail closed before private checkout", () => {
  const expired = runPilotGuard({ overrides: { PILOT_START_AT: new Date(Date.now() - 86_401_000).toISOString() } });
  assert.notEqual(expired.status, 0);
  assert.match(expired.diagnostics, /pilot window has expired/);
  assert.equal(expired.curlCalled, false);

  for (const overrides of [
    { PILOT_START_AT: "" },
    { PILOT_START_AT: "not-a-timestamp" },
    { MARKET_SCOPE: "NFL:rushing_yards" },
    { MARKET_SCOPE: "" },
    { RECEPTIONS_ENABLED: "true" },
    { RUSHING_YARDS_ENABLED: "true" },
    { PASSING_YARDS_ENABLED: "true" },
    { CERTIFICATION_WRITE_ENABLED: "true" },
  ]) {
    const result = runPilotGuard({ overrides });
    assert.notEqual(result.status, 0, JSON.stringify(overrides));
    assert.equal(result.curlCalled, false, "unsafe state must fail before history lookup or private checkout");
  }

  const apiFailure = runPilotGuard({ overrides: { MOCK_CURL_FAIL: "true" } });
  assert.notEqual(apiFailure.status, 0);
  assert.match(apiFailure.diagnostics, /Could not read bounded pilot wake history/);
  assert.match(workflow, /id: pilot_attempt_guard[\s\S]*?id: contract[\s\S]*?Check out PRIVATE Covered at the immutable production pin/);
  assert.match(workflow, /group:.*'covered2-wnba-refresh'/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /actions:\s*read/);
  assert.doesNotMatch(workflow, /^\s{2}schedule:/m);
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

test("published board refresh is one owner-gated NFL receiving-yards run with scheduler and persistent writes off", () => {
  const accepted = runContract({
    MANUAL_OPERATION: "exact-market-board-refresh",
    VALIDATION_SPORT_INPUT: "NFL",
    VALIDATION_MARKET_INPUT: "receiving_yards",
    FORCE_DISCOVERY_INPUT: "true",
  });
  assert.equal(accepted.status, 0, accepted.diagnostics);
  assert.match(accepted.outputs, /^mode=manual-board-refresh$/m);
  assert.match(accepted.outputs, /^manual_validation=true$/m);
  assert.match(accepted.outputs, /^publish_board=true$/m);
  assert.match(accepted.outputs, /^force_discovery=true$/m);
  assert.match(workflow, /COVERED2_MANUAL_VALIDATION_PUBLISH_BOARD:\s*\$\{\{\s*steps\.contract\.outputs\.publish_board\s*\}\}/);
  assert.match(workflow, /COVERED2_MANUAL_VALIDATION:\s*\$\{\{\s*steps\.contract\.outputs\.manual_validation\s*\}\}/);
  assert.match(workflow, /COVERED2_SCHEDULED_MARKET_SCOPE:\s*\$\{\{\s*vars\.COVERED2_SCHEDULED_MARKET_SCOPE\s*\}\}/);
  assert.match(workflow, /COVERED2_NFL_RECEIVING_PILOT_START_AT:\s*\$\{\{\s*vars\.COVERED2_NFL_RECEIVING_PILOT_START_AT\s*\}\}/);
  assert.match(workflow, /COVERED2_NFL_RECEIVING_YARDS_REFRESH:.*manual_validation == 'true'.*market == 'receiving_yards'.*'false'.*vars\.COVERED2_NFL_RECEIVING_YARDS_REFRESH/);
  assert.match(workflow, /COVERED2_NFL_RUSHING_YARDS_REFRESH:.*manual_validation == 'true'.*market == 'rushing_yards'.*'false'.*vars\.COVERED2_NFL_RUSHING_YARDS_REFRESH/);
  assert.match(workflow, /COVERED2_NFL_PASSING_YARDS_REFRESH:.*manual_validation == 'true'.*market == 'passing_yards'.*'false'.*vars\.COVERED2_NFL_PASSING_YARDS_REFRESH/);
  assert.match(workflow, /COVERED2_NFL_RECEPTIONS_REFRESH:.*manual_validation == 'true'.*market == 'receptions'.*'false'.*vars\.COVERED2_NFL_RECEPTIONS_REFRESH/);
  assert.match(workflow, /COVERED2_CERTIFICATION_LEDGER_ENABLED:\s*\$\{\{\s*vars\.COVERED2_CERTIFICATION_LEDGER_ENABLED\s*\}\}/);
  assert.doesNotMatch(workflow, /COVERED2_WNBA_SCHEDULER_ENABLED:\s*"true"/);
  for (const invalid of [
    { VALIDATION_SPORT_INPUT: "NFL", VALIDATION_MARKET_INPUT: "rushing_yards" },
    { VALIDATION_SPORT_INPUT: "MLB", VALIDATION_MARKET_INPUT: "pitcher_strikeouts" },
    { FORCE_DISCOVERY_INPUT: "false" },
    { BOARD_BUILD_ENABLED: "false" },
  ]) {
    const result = runContract({ MANUAL_OPERATION: "exact-market-board-refresh", ...invalid });
    assert.notEqual(result.status, 0, JSON.stringify(invalid));
    assert.match(result.diagnostics, /Published one-shot board refresh requires exact NFL receiving_yards/);
  }
  assert.match(workflow, /exact-market-board-refresh/);
  assert.match(workflow, /BOARD_BUILD_ENABLED:\s*\$\{\{\s*vars\.COVERED2_PICKS_BOARD_BUILD\s*\}\}/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.doesNotMatch(workflow, /^\s{2}schedule:/m);
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

test("current-analysis certification accepts only one exact NFL receiving-yards run and never discovers", () => {
  const accepted = runContract({
    MANUAL_OPERATION: "certification-one-current-analysis",
    VALIDATION_SPORT_INPUT: "NFL",
    VALIDATION_MARKET_INPUT: "receiving_yards",
    FORCE_DISCOVERY_INPUT: "false",
    SCORED_PROP_ID_INPUT: "",
  });
  assert.equal(accepted.status, 0, accepted.diagnostics);
  assert.match(accepted.outputs, /^mode=manual-current-analysis-certification$/m);
  assert.match(accepted.outputs, /^sport=NFL$/m);
  assert.match(accepted.outputs, /^market=receiving_yards$/m);
  assert.doesNotMatch(accepted.outputs, /^scored_prop_id=/m);
  assert.match(workflow, /mode != 'manual-current-analysis-certification'/);
  assert.match(workflow, /COVERED2_CERTIFICATION_LEDGER_ENABLED:\s*"false"/);
  assert.ok(workflow.includes('run: node --experimental-strip-types --loader ./scripts/ts-path-loader.mjs ./scripts/run-covered2-current-analysis-certification.mjs --sport "$SPORT" --market "$MARKET"'));
  for (const invalid of [
    { VALIDATION_SPORT_INPUT: "NFL", VALIDATION_MARKET_INPUT: "rushing_yards" },
    { VALIDATION_SPORT_INPUT: "MLB", VALIDATION_MARKET_INPUT: "batter_total_bases" },
    { FORCE_DISCOVERY_INPUT: "true" },
    { SCORED_PROP_ID_INPUT: "00000000-0000-4000-8000-000000000001" },
  ]) {
    const result = runContract({ MANUAL_OPERATION: "certification-one-current-analysis", ...invalid });
    assert.notEqual(result.status, 0, JSON.stringify(invalid));
    assert.match(result.diagnostics, /Current-analysis certification is restricted/);
  }
  assert.match(workflow, /Certify one current NFL receiving-yards analysis/);
  assert.ok(workflow.includes("steps.contract.outputs.mode == 'manual-current-analysis-certification'"));
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
