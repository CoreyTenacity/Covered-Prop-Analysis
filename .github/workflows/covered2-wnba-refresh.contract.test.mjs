import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(new URL("./covered2-wnba-refresh.yml", import.meta.url), "utf8");
const reviewedSha = "4a6ae017fc442237c048c5498e7a442059f8b3aa";
const nbaManualSha = "27dd401ef774bfda9601c66c710f21b8a5d12f96";
const previousNbaManualSha = "5e770d6b79dddd8a948c58aefda431d3bcb79486";
const priorReviewedSha = "a57d76cb6b72039724ed4832d25c4e1e4ef04547";
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

const validNflTuple = {
  "canonicalEventId": "event-2026-chi-ne",
  "nflverseGameId": "2026_08_CHI_NE",
  "providerEventId": "provider-event-chi-ne",
  "officialDate": "2026-10-22",
  "expectedStartTime": "2026-10-23T00:15:00.000Z",
  "homeTeamAbbreviation": "CHI",
  "awayTeamAbbreviation": "NE",
  "canonicalHomeTeamId": "canonical-bears",
  "canonicalAwayTeamId": "canonical-patriots"
};
const validNflHydrationTuple = {
  "nflverseGameId": "2026_08_CHI_NE",
  "officialDate": "2026-10-22",
  "expectedStartTime": "2026-10-23T00:15:00.000Z",
  "homeTeamAbbreviation": "CHI",
  "awayTeamAbbreviation": "NE",
  "canonicalHomeTeamId": "canonical-bears",
  "canonicalAwayTeamId": "canonical-patriots"
};
const validNflResolverTuple = {
  "canonicalEventId": "event-2026-chi-ne",
  "nflverseGameId": "2026_08_CHI_NE",
  "officialDate": "2026-10-22",
  "expectedStartTime": "2026-10-23T00:15:00.000Z",
  "homeTeamAbbreviation": "CHI",
  "awayTeamAbbreviation": "NE",
  "canonicalHomeTeamId": "canonical-bears",
  "canonicalAwayTeamId": "canonical-patriots"
};
const validNflTarget = { NFL_EVENT_TUPLE_INPUT: JSON.stringify(validNflTuple) };
const validNflHydrationTarget = { NFL_EVENT_TUPLE_INPUT: JSON.stringify(validNflHydrationTuple) };

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

function extractSchedulerPreflightShell() {
  const gateStep = workflow.indexOf("        id: scheduler_gate");
  assert.notEqual(gateStep, -1, "repository scheduler preflight exists");
  const runStart = workflow.indexOf("        run: |\n", gateStep);
  assert.notEqual(runStart, -1, "repository scheduler preflight has an inline shell");
  const bodyStart = runStart + "        run: |\n".length;
  const nextJob = workflow.indexOf("\n\n  refresh:", bodyStart);
  assert.notEqual(nextJob, -1, "preflight is a separate job before refresh");
  return workflow.slice(bodyStart, nextJob).split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
}

const schedulerPreflightShell = extractSchedulerPreflightShell();

function runSchedulerPreflight({
  trigger = "repository_dispatch",
  repositoryValue,
  apiResponse,
  apiExitCode = 0,
  actor = "CoreyTenacity",
  refName = "main",
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "c2-scheduler-preflight-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const curlPath = join(bin, "curl");
  const curlMarker = join(directory, "curl-called.txt");
  writeFileSync(curlPath, "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$MOCK_CURL_MARKER\"\nprintf '%s' \"$MOCK_CURL_RESPONSE\"\nexit \"$MOCK_CURL_EXIT\"\n");
  chmodSync(curlPath, 0o755);
  const outputPath = join(directory, "github-output.txt");
  writeFileSync(outputPath, "");
  const response = apiResponse ?? JSON.stringify({ name: "COVERED2_WNBA_SCHEDULER_ENABLED", value: repositoryValue ?? "" });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GITHUB_OUTPUT: outputPath,
    TRIGGER: trigger,
    ACTOR: actor,
    REF_NAME: refName,
    GITHUB_TOKEN: "test-only-token",
    GITHUB_API_URL: "https://api.github.test",
    GITHUB_REPOSITORY: "CoreyTenacity/Covered-Prop-Analysis",
    MOCK_CURL_MARKER: curlMarker,
    MOCK_CURL_RESPONSE: response,
    MOCK_CURL_EXIT: String(apiExitCode),
  };
  try {
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", schedulerPreflightShell], {
      cwd: new URL("..", import.meta.url),
      env,
      encoding: "utf8",
      timeout: 5_000,
    });
    return {
      ...result,
      diagnostics: (result.stdout ?? "") + (result.stderr ?? ""),
      outputs: readFileSync(outputPath, "utf8"),
      curlCalled: existsSync(curlMarker),
      curlArgs: existsSync(curlMarker) ? readFileSync(curlMarker, "utf8") : "",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runContract(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "c2-receiver-contract-"));
  const outputPath = join(directory, "github-output.txt");
  writeFileSync(outputPath, "");
  const operation = overrides.MANUAL_OPERATION ?? "exact-market-discovery";
  const sport = overrides.VALIDATION_SPORT_INPUT ?? "NFL";
  const defaultReleaseSha = sport === "NBA" && operation === "exact-market-discovery" ? nbaManualSha : reviewedSha;
  const env = {
    ...process.env,
    GITHUB_OUTPUT: outputPath,
    TRIGGER: "workflow_dispatch",
    REF_NAME: "main",
    ACTOR: "CoreyTenacity",
    SCHEDULER_ENABLED: "false",
    RELEASE_SHA_INPUT: overrides.RELEASE_SHA_INPUT ?? defaultReleaseSha,
        ALLOWLIST: "corey093011@gmail.com",
    CADENCE: "0,30 11-23,0-4 * * *",
    DEPLOYMENT_AUTHORIZED: "true",
    CERTIFICATION_LEDGER_ENABLED: "false",
    BOARD_BUILD_ENABLED: "true",
    MANUAL_OPERATION: "exact-market-discovery",
    VALIDATION_SPORT_INPUT: "NFL",
    VALIDATION_MARKET_INPUT: "receiving_yards",
    FORCE_DISCOVERY_INPUT: "false",
    NFL_EVENT_TUPLE_INPUT: "",
    SCORED_PROP_ID_INPUT: "",
    MLB_EVENT_DATE_INPUT: "",
    MLB_EVENT_START_TIME_INPUT: "",
    MLB_HOME_TEAM_ID_INPUT: "",
    MLB_AWAY_TEAM_ID_INPUT: "",
    MLB_GAME_TYPE_INPUT: "",
    MLB_SERIES_DESCRIPTION_INPUT: "",
    MLB_GAME_PK_INPUT: "",
    WNBA_EVENT_ID_INPUT: "",
    WNBA_EVENT_DATE_INPUT: "",
    WNBA_EVENT_START_TIME_INPUT: "",
    WNBA_HOME_TEAM_ID_INPUT: "",
    WNBA_AWAY_TEAM_ID_INPUT: "",
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
    MANUAL_VALIDATION: "",
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
    PILOT_ENABLED: "true",
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

test("only the public-reviewed immutable SHA is executable; manual callers cannot inject another ref", () => {
  assert.match(workflow, new RegExp("REVIEWED_RELEASE_SHA=\"" + reviewedSha + "\""));
  assert.doesNotMatch(workflow, /vars\.COVERED_PRIVATE_PIPELINE_SHA_V2/);
  assert.doesNotMatch(contractShell, /\$PIN/);
  for (const invalid of [
    { RELEASE_SHA_INPUT: "e51d02ebe61d8e6eab998cb20d3814e8f14827cd" },
    { RELEASE_SHA_INPUT: "599e526560861ebecdb3ae6a691b0ac3bc56d101" },
    { RELEASE_SHA_INPUT: "codex/public-repo-repair" },
    { RELEASE_SHA_INPUT: retiredSha },
    { SCHEDULER_ENABLED: "true" },
    { CERTIFICATION_LEDGER_ENABLED: "true" },
    { ACTOR: "not-the-owner" },
    { REF_NAME: "codex/old-receiver" },
  ]) {
    const result = runContract(invalid);
    assert.notEqual(result.status, 0, JSON.stringify(invalid));
    assert.match(result.diagnostics, /Rejected exact-market workflow dispatch/);
  }
  const accepted = runContract({ PIN: "", ...validNflTarget });
  assert.equal(accepted.status, 0, accepted.diagnostics);
  assert.match(accepted.outputs, new RegExp("^release_sha=" + reviewedSha + "$", "m"));
  assert.equal(reviewedSha.length, 40);
  assert.equal(runContract({ RELEASE_SHA_INPUT: retiredSha }).status, 1);
});

test("NBA Points/Rebounds/Assists use only the NBA manual release while the NFL resolver keeps its separately reviewed SHA", () => {
  assert.match(workflow, new RegExp('NBA_MANUAL_RELEASE_SHA="' + nbaManualSha + '"'));
  assert.match(workflow, /EXPECTED_MANUAL_RELEASE_SHA="\$REVIEWED_RELEASE_SHA"[\s\S]*?MANUAL_OPERATION.*?exact-market-discovery[\s\S]*?VALIDATION_SPORT_INPUT.*?NBA[\s\S]*?EXPECTED_MANUAL_RELEASE_SHA="\$NBA_MANUAL_RELEASE_SHA"/);
  for (const market of ["points", "rebounds", "assists"]) {
    const accepted = runContract({ MANUAL_OPERATION: "exact-market-discovery", VALIDATION_SPORT_INPUT: "NBA", VALIDATION_MARKET_INPUT: market, FORCE_DISCOVERY_INPUT: "false" });
    assert.equal(accepted.status, 0, `NBA ${market}: ${accepted.diagnostics}`);
    assert.match(accepted.outputs, new RegExp("^release_sha=" + nbaManualSha + "$", "m"));
    assert.match(accepted.outputs, /^mode=manual-validation$/m);
    assert.match(accepted.outputs, new RegExp("^market=" + market + "$", "m"));
    assert.equal(runContract({ MANUAL_OPERATION: "exact-market-discovery", VALIDATION_SPORT_INPUT: "NBA", VALIDATION_MARKET_INPUT: market, FORCE_DISCOVERY_INPUT: "false", RELEASE_SHA_INPUT: reviewedSha }).status, 1);
    assert.equal(runContract({ MANUAL_OPERATION: "exact-market-discovery", VALIDATION_SPORT_INPUT: "NBA", VALIDATION_MARKET_INPUT: market, FORCE_DISCOVERY_INPUT: "false", RELEASE_SHA_INPUT: previousNbaManualSha }).status, 1);
  }
  for (const invalid of [
    { market: "three_pointers", sha: nbaManualSha },
    { market: "3pm", sha: nbaManualSha },
    { market: "points", force: "true", sha: nbaManualSha },
  ]) {
    const rejected = runContract({
      MANUAL_OPERATION: "exact-market-discovery",
      VALIDATION_SPORT_INPUT: "NBA",
      VALIDATION_MARKET_INPUT: invalid.market,
      FORCE_DISCOVERY_INPUT: invalid.force ?? "false",
      RELEASE_SHA_INPUT: invalid.sha,
    });
    assert.notEqual(rejected.status, 0, JSON.stringify(invalid));
  }
  const resolver = runContract({ MANUAL_OPERATION: "manual-nfl-provider-event-resolution", VALIDATION_SPORT_INPUT: "NFL", VALIDATION_MARKET_INPUT: "", FORCE_DISCOVERY_INPUT: "false", NFL_EVENT_TUPLE_INPUT: JSON.stringify(validNflResolverTuple), RELEASE_SHA_INPUT: reviewedSha });
  assert.equal(resolver.status, 0, resolver.diagnostics);
  assert.match(resolver.outputs, new RegExp("^release_sha=" + reviewedSha + "$", "m"));
  assert.equal(runContract({ MANUAL_OPERATION: "manual-nfl-provider-event-resolution", VALIDATION_SPORT_INPUT: "NFL", VALIDATION_MARKET_INPUT: "", FORCE_DISCOVERY_INPUT: "false", NFL_EVENT_TUPLE_INPUT: JSON.stringify(validNflResolverTuple), RELEASE_SHA_INPUT: nbaManualSha }).status, 1);
  assert.match(workflow, /resolver: \[[\s\S]*?canonicalEventId[\s\S]*?nflverseGameId[\s\S]*?expectedStartTime[\s\S]*?canonicalAwayTeamId/);
});
test("scheduled execution derives the private checkout and runner SHA only from the reviewed public release", () => {
  assert.doesNotMatch(workflow, /vars\.COVERED_PRIVATE_PIPELINE_SHA_V2/);
  assert.doesNotMatch(workflow, /PIN:\s*\$\{\{/);
  assert.match(workflow, /ref:\s*\$\{\{\s*steps\.contract\.outputs\.release_sha\s*\}\}/);
  assert.match(workflow, /COVERED_PRIVATE_PIPELINE_SHA_V2:\s*\$\{\{\s*steps\.contract\.outputs\.release_sha\s*\}\}/);
  assert.match(contractShell, /echo "release_sha=\$REVIEWED_RELEASE_SHA" >> "\$GITHUB_OUTPUT"/);
  const acceptedWithoutPin = runContract(naturalWakeOverrides({ PIN: "" }));
  assert.equal(acceptedWithoutPin.status, 0, acceptedWithoutPin.diagnostics);
  assert.match(acceptedWithoutPin.outputs, new RegExp("^release_sha=" + reviewedSha + "$", "m"));
  const staleUnusedPin = runContract(naturalWakeOverrides({ PIN: "f".repeat(40) }));
  assert.equal(staleUnusedPin.status, 0, staleUnusedPin.diagnostics);
  assert.match(staleUnusedPin.outputs, new RegExp("^release_sha=" + reviewedSha + "$", "m"));
  assert.doesNotMatch(workflow, /(?:vars|secrets)\.COVERED_GITHUB_SCHEDULER_ENABLED|COVERED_GITHUB_SCHEDULER_ENABLED:\s*\$\{\{/);
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

test("normal exact-market recurrence requires explicit pilot=false and bypasses only the completed pilot counter", () => {
  const normal = runPilotGuard({ overrides: { PILOT_ENABLED: "false", PILOT_START_AT: "2026-10-10T03:55:21.264Z" } });
  assert.equal(normal.status, 0, normal.diagnostics);
  assert.match(normal.outputs, /^pilot_attempt_guard=normal_exact_market_recurrence$/m);
  assert.equal(normal.curlCalled, false, "normal recurrence must not query or consume bounded-pilot slots");

  for (const value of ["", "TRUE", "yes", "0"]) {
    const invalid = runPilotGuard({ overrides: { PILOT_ENABLED: value } });
    assert.notEqual(invalid.status, 0, `pilot mode ${JSON.stringify(value)} must fail closed`);
    assert.match(invalid.diagnostics, /pilot mode must be exactly true or false/);
    assert.equal(invalid.curlCalled, false);
  }
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
  assert.match(workflow, /id: pilot_attempt_guard[\s\S]*?id: contract[\s\S]*?Check out PRIVATE Covered at the public-reviewed immutable release SHA/);
  assert.match(workflow, /group:.*'covered2-wnba-refresh'/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /actions:\s*read/);
  assert.doesNotMatch(workflow, /^\s{2}schedule:/m);
});

test("each and only each READY_FOR_LIVE_EXPERIMENT pair routes as one exact discovery", () => {
  for (const [sport, market] of readyPairs) {
    const result = runContract({ VALIDATION_SPORT_INPUT: sport, VALIDATION_MARKET_INPUT: market, ...(sport === "MLB" && market === "batter_total_bases" ? { MLB_GAME_PK_INPUT: "849817" } : {}), ...(sport === "NFL" ? validNflTarget : {}) });
    assert.equal(result.status, 0, sport + "/" + market + ": " + result.diagnostics);
    assert.match(result.outputs, /^mode=manual-validation$/m);
    assert.match(result.outputs, new RegExp("^sport=" + sport + "$", "m"));
    assert.match(result.outputs, new RegExp("^market=" + market + "$", "m"));
    const expectedSha = sport === "NBA" ? nbaManualSha : reviewedSha;
    assert.match(result.outputs, new RegExp("^release_sha=" + expectedSha + "$", "m"));
    assert.match(result.outputs, /^exact_manual=true$/m);
  }
  for (const [sport, market] of blockedPairs) {
    const result = runContract({ VALIDATION_SPORT_INPUT: sport, VALIDATION_MARKET_INPUT: market });
    assert.notEqual(result.status, 0, sport + "/" + market + " must fail closed");
    assert.match(result.diagnostics, /Unsupported exact sport\/market pair/);
  }
});

test("MLB Batter Total Bases manual discovery requires and forwards one bounded exact event gamePk", () => {
  const accepted = runContract({
    VALIDATION_SPORT_INPUT: "MLB",
    VALIDATION_MARKET_INPUT: "batter_total_bases",
    MLB_GAME_PK_INPUT: "849817",
  });
  assert.equal(accepted.status, 0, accepted.diagnostics);
  assert.match(accepted.outputs, /^mode=manual-validation$/m);
  assert.match(accepted.outputs, /^manual_validation=true$/m);
  assert.match(accepted.outputs, /^mlb_game_pk=849817$/m);
  assert.match(workflow, /mlb_game_pk:\s*\n\s*description:.*one-event Batter Total Bases (?:discovery or history hydration|proof)/);
  assert.match(workflow, /COVERED2_MANUAL_MLB_GAME_PK:\s*\$\{\{\s*steps\.contract\.outputs\.mlb_game_pk\s*\}\}/);
  for (const invalid of ["", "84x817", "0849817", "1234567890123"]) {
    const rejected = runContract({
      VALIDATION_SPORT_INPUT: "MLB",
      VALIDATION_MARKET_INPUT: "batter_total_bases",
      MLB_GAME_PK_INPUT: invalid,
    });
    assert.notEqual(rejected.status, 0, `gamePk ${JSON.stringify(invalid)} must fail closed`);
  }
  const wrongMarket = runContract({
    VALIDATION_SPORT_INPUT: "MLB",
    VALIDATION_MARKET_INPUT: "pitcher_strikeouts",
    MLB_GAME_PK_INPUT: "849817",
  });
  assert.notEqual(wrongMarket.status, 0);
  assert.match(wrongMarket.diagnostics, /valid only for the exact MLB Batter Total Bases manual proof/);
});

test("forced WNBA Rebounds discovery requires one exact event tuple and forwards it only to the manual proof", () => {
  const valid = {
    MANUAL_OPERATION: "exact-market-discovery",
    VALIDATION_SPORT_INPUT: "WNBA",
    VALIDATION_MARKET_INPUT: "rebounds",
    FORCE_DISCOVERY_INPUT: "true",
    WNBA_EVENT_ID_INPUT: "401918307",
    WNBA_EVENT_DATE_INPUT: "2026-10-21",
    WNBA_EVENT_START_TIME_INPUT: "2026-10-22T00:00:00.000Z",
    WNBA_HOME_TEAM_ID_INPUT: "20",
    WNBA_AWAY_TEAM_ID_INPUT: "129689",
  };
  const accepted = runContract(valid);
  assert.equal(accepted.status, 0, accepted.diagnostics);
  assert.match(accepted.outputs, /^mode=manual-validation$/m);
  assert.match(accepted.outputs, /^manual_validation=true$/m);
  assert.match(accepted.outputs, /^force_discovery=true$/m);
  for (const [output, value] of [
    ["wnba_event_id", "401918307"],
    ["wnba_event_date", "2026-10-21"],
    ["wnba_event_start_time", "2026-10-22T00:00:00.000Z"],
    ["wnba_home_team_id", "20"],
    ["wnba_away_team_id", "129689"],
  ]) assert.match(accepted.outputs, new RegExp(`^${output}=${value.replaceAll(".", "\\.")}$`, "m"));

  const tupleInputs = [
    "WNBA_EVENT_ID_INPUT",
    "WNBA_EVENT_DATE_INPUT",
    "WNBA_EVENT_START_TIME_INPUT",
    "WNBA_HOME_TEAM_ID_INPUT",
    "WNBA_AWAY_TEAM_ID_INPUT",
  ];
  for (const missing of tupleInputs) {
    const rejected = runContract({ ...valid, [missing]: "" });
    assert.notEqual(rejected.status, 0, `${missing} is required`);
    assert.doesNotMatch(rejected.outputs, /^release_sha=/m);
  }
  for (const invalid of [
    { WNBA_EVENT_ID_INPUT: "0" },
    { WNBA_EVENT_ID_INPUT: "4018x" },
    { WNBA_EVENT_DATE_INPUT: "2026-02-30" },
    { WNBA_EVENT_DATE_INPUT: "tomorrow" },
    { WNBA_EVENT_START_TIME_INPUT: "2026-10-22T00:00:00Z" },
    { WNBA_EVENT_START_TIME_INPUT: "2026-10-22T25:00:00.000Z" },
    { WNBA_HOME_TEAM_ID_INPUT: "0" },
    { WNBA_HOME_TEAM_ID_INPUT: "team-20" },
    { WNBA_AWAY_TEAM_ID_INPUT: "0" },
    { WNBA_AWAY_TEAM_ID_INPUT: "129x" },
    { WNBA_AWAY_TEAM_ID_INPUT: "20" },
    { SCORED_PROP_ID_INPUT: "00000000-0000-4000-8000-000000000001" },
    { MLB_GAME_PK_INPUT: "849817" },
    { MLB_EVENT_DATE_INPUT: "2026-10-21" },
    { MLB_EVENT_START_TIME_INPUT: "2026-10-22T00:00:00.000Z" },
    { MLB_HOME_TEAM_ID_INPUT: "114" },
    { MLB_AWAY_TEAM_ID_INPUT: "139" },
    { MLB_GAME_TYPE_INPUT: "L" },
    { MLB_SERIES_DESCRIPTION_INPUT: "AL Championship Series" },
    { SCHEDULER_ENABLED: "true" },
    { CERTIFICATION_LEDGER_ENABLED: "true" },
  ]) {
    const rejected = runContract({ ...valid, ...invalid });
    assert.notEqual(rejected.status, 0, JSON.stringify(invalid));
    assert.doesNotMatch(rejected.outputs, /^release_sha=/m, "invalid tuple must fail before private checkout");
  }

  for (const invalidScope of [
    { VALIDATION_SPORT_INPUT: "WNBA", VALIDATION_MARKET_INPUT: "points" },
    { VALIDATION_SPORT_INPUT: "WNBA", VALIDATION_MARKET_INPUT: "assists" },
    { VALIDATION_SPORT_INPUT: "NBA", VALIDATION_MARKET_INPUT: "rebounds" },
    { VALIDATION_SPORT_INPUT: "MLB", VALIDATION_MARKET_INPUT: "batter_total_bases" },
  ]) {
    const rejected = runContract({ ...valid, ...invalidScope });
    assert.notEqual(rejected.status, 0, JSON.stringify(invalidScope));
  }

  const ordinaryWnba = runContract({
    MANUAL_OPERATION: "exact-market-discovery",
    VALIDATION_SPORT_INPUT: "WNBA",
    VALIDATION_MARKET_INPUT: "rebounds",
    FORCE_DISCOVERY_INPUT: "false",
  });
  assert.equal(ordinaryWnba.status, 0, ordinaryWnba.diagnostics);
  assert.match(ordinaryWnba.outputs, /^force_discovery=false$/m);
  assert.doesNotMatch(ordinaryWnba.outputs, /^wnba_event_id=/m);

  const nflForced = runContract({
    VALIDATION_SPORT_INPUT: "NFL",
    VALIDATION_MARKET_INPUT: "receiving_yards",
    FORCE_DISCOVERY_INPUT: "true",
    ...validNflTarget,
  });
  assert.equal(nflForced.status, 0, nflForced.diagnostics);
  assert.match(nflForced.outputs, /^force_discovery=true$/m);

  const mlbForced = runContract({
    VALIDATION_SPORT_INPUT: "MLB",
    VALIDATION_MARKET_INPUT: "batter_total_bases",
    FORCE_DISCOVERY_INPUT: "true",
    MLB_GAME_PK_INPUT: "849817",
  });
  assert.notEqual(mlbForced.status, 0, "existing MLB force-discovery prohibition remains unchanged");

  assert.match(workflow, new RegExp(`REVIEWED_RELEASE_SHA="${reviewedSha}"`));
  assert.doesNotMatch(workflow, new RegExp(priorReviewedSha));
  const discoveryStart = workflow.indexOf("      - name: Run exactly one bounded C2 exact-market discovery");
  const discoveryEnd = workflow.indexOf("\n      - name:", discoveryStart + 1);
  assert.ok(discoveryStart >= 0 && discoveryEnd > discoveryStart);
  const discoveryStep = workflow.slice(discoveryStart, discoveryEnd);
  for (const [name, output] of [
    ["COVERED2_MANUAL_WNBA_EVENT_ID", "wnba_event_id"],
    ["COVERED2_MANUAL_WNBA_EVENT_DATE", "wnba_event_date"],
    ["COVERED2_MANUAL_WNBA_EVENT_START_TIME", "wnba_event_start_time"],
    ["COVERED2_MANUAL_WNBA_HOME_TEAM_ID", "wnba_home_team_id"],
    ["COVERED2_MANUAL_WNBA_AWAY_TEAM_ID", "wnba_away_team_id"],
  ]) {
    assert.match(discoveryStep, new RegExp(`${name}:.*mode == 'manual-validation'.*sport == 'WNBA'.*market == 'rebounds'.*force_discovery == 'true'.*steps\\.contract\\.outputs\\.${output}`));
  }
  assert.match(discoveryStep, /steps\.contract\.outputs\.mode == 'manual-validation'/);
  assert.match(discoveryStep, /steps\.contract\.outputs\.market == 'rebounds'/);
  assert.match(discoveryStep, /steps\.contract\.outputs\.force_discovery == 'true'/);
  assert.doesNotMatch(discoveryStep, /run-covered2-wnba-event-hydration\.mjs|sharpapi/i);

  const scheduled = runContract(naturalWakeOverrides({
    MANUAL_OPERATION: "exact-market-discovery",
    VALIDATION_SPORT_INPUT: "WNBA",
    VALIDATION_MARKET_INPUT: "rebounds",
    FORCE_DISCOVERY_INPUT: "true",
    ...Object.fromEntries(Object.entries(valid).filter(([key]) => key.endsWith("_INPUT"))),
  }));
  assert.equal(scheduled.status, 0, scheduled.diagnostics);
  assert.match(scheduled.outputs, /^mode=scheduled$/m);
  assert.match(scheduled.outputs, /^force_discovery=false$/m);
  assert.doesNotMatch(scheduled.outputs, /wnba_event_id=|manual-validation/);
});

test("published board refresh requires and forwards an exact NFL receiving event", () => {
  const accepted = runContract({
    MANUAL_OPERATION: "exact-market-board-refresh",
    VALIDATION_SPORT_INPUT: "NFL",
    VALIDATION_MARKET_INPUT: "receiving_yards",
    FORCE_DISCOVERY_INPUT: "true",
    ...validNflTarget,
  });
  assert.equal(accepted.status, 0, accepted.diagnostics);
  assert.match(accepted.outputs, /^mode=manual-board-refresh$/m);
  assert.match(accepted.outputs, /^manual_validation=true$/m);
  assert.match(accepted.outputs, /^publish_board=true$/m);
  assert.match(accepted.outputs, /^force_discovery=true$/m);
  assert.match(accepted.outputs, /^nfl_canonical_event_id=event-2026-chi-ne$/m);
  assert.match(workflow, /COVERED2_MANUAL_VALIDATION_PUBLISH_BOARD:\s*\$\{\{\s*steps\.contract\.outputs\.publish_board\s*\}\}/);
  assert.match(workflow, /COVERED2_MANUAL_VALIDATION:\s*\$\{\{\s*steps\.contract\.outputs\.manual_validation\s*\}\}/);
  assert.match(workflow, /COVERED2_SCHEDULED_MARKET_SCOPE:\s*\$\{\{\s*vars\.COVERED2_SCHEDULED_MARKET_SCOPE\s*\}\}/);
  assert.match(workflow, /COVERED2_NFL_RECEIVING_PILOT_START_AT:\s*\$\{\{\s*vars\.COVERED2_NFL_RECEIVING_PILOT_START_AT\s*\}\}/);
  assert.match(workflow, /COVERED2_NFL_RECEIVING_PILOT_ENABLED:\s*\$\{\{\s*vars\.COVERED2_NFL_RECEIVING_PILOT_ENABLED\s*\}\}/);
  assert.match(workflow, /COVERED2_NFL_RECEIVING_YARDS_REFRESH:.*manual_validation == 'true'.*market == 'receiving_yards'.*'false'.*vars\.COVERED2_NFL_RECEIVING_YARDS_REFRESH/);
  assert.match(workflow, /COVERED2_NFL_RUSHING_YARDS_REFRESH:.*manual_validation == 'true'.*market == 'rushing_yards'.*'false'.*vars\.COVERED2_NFL_RUSHING_YARDS_REFRESH/);
  assert.match(workflow, /COVERED2_NFL_PASSING_YARDS_REFRESH:.*manual_validation == 'true'.*market == 'passing_yards'.*'false'.*vars\.COVERED2_NFL_PASSING_YARDS_REFRESH/);
  assert.match(workflow, /COVERED2_NFL_RECEPTIONS_REFRESH:.*manual_validation == 'true'.*market == 'receptions'.*'false'.*vars\.COVERED2_NFL_RECEPTIONS_REFRESH/);
  assert.match(workflow, /COVERED2_CERTIFICATION_LEDGER_ENABLED:\s*\$\{\{\s*vars\.COVERED2_CERTIFICATION_LEDGER_ENABLED\s*\}\}/);
  assert.doesNotMatch(workflow, /COVERED2_WNBA_SCHEDULER_ENABLED:\s*"true"/);
  const missingTarget=runContract({MANUAL_OPERATION:"exact-market-board-refresh",VALIDATION_SPORT_INPUT:"NFL",VALIDATION_MARKET_INPUT:"receiving_yards",FORCE_DISCOVERY_INPUT:"true"}); assert.notEqual(missingTarget.status,0); assert.doesNotMatch(missingTarget.outputs,/^release_sha=/m);
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
test("workflow_dispatch stays at 19 inputs, below GitHub's 25-input limit", () => {
  const dispatch = workflow.match(/^  workflow_dispatch:\n([\s\S]*?)(?=^\n(?:permissions|concurrency|jobs):)/m)?.[1] ?? "";
  const names = [...dispatch.matchAll(/^      ([a-z][a-z0-9_]*):$/gm)].map((match) => match[1]);
  assert.equal(names.length, 19);
  assert.ok(names.length <= 25);
  assert.ok(names.includes("nfl_event_tuple"));
  assert.match(workflow, /- manual-nfl-provider-event-resolution/);
  for (const removed of [
    "nfl_canonical_event_id", "nfl_nflverse_game_id", "nfl_provider_event_id",
    "nfl_event_date", "nfl_event_start_time", "nfl_home_team", "nfl_away_team",
    "nfl_home_team_id", "nfl_away_team_id",
  ]) assert.equal(names.includes(removed), false, `${removed} is no longer a top-level dispatch input`);
});

test("manual NFL provider-event resolver accepts only the exact eight-field event tuple and routes to its dedicated command", () => {
  const result = runContract({
    MANUAL_OPERATION: "manual-nfl-provider-event-resolution",
    VALIDATION_SPORT_INPUT: "NFL",
    VALIDATION_MARKET_INPUT: "",
    FORCE_DISCOVERY_INPUT: "false",
    NFL_EVENT_TUPLE_INPUT: JSON.stringify(validNflResolverTuple),
  });
  assert.equal(result.status, 0, result.diagnostics);
  for (const [name, value] of [
    ["mode", "manual-nfl-provider-event-resolution"],
    ["sport", "NFL"], ["market", ""], ["force_discovery", "false"],
    ["manual_validation", "true"], ["publish_board", "false"], ["skip", "false"],
    ["release_sha", reviewedSha], ["exact_manual", "true"],
    ["nfl_canonical_event_id", validNflResolverTuple.canonicalEventId],
    ["nfl_nflverse_game_id", validNflResolverTuple.nflverseGameId],
    ["nfl_event_date", validNflResolverTuple.officialDate],
    ["nfl_event_start_time", validNflResolverTuple.expectedStartTime],
    ["nfl_home_team", validNflResolverTuple.homeTeamAbbreviation],
    ["nfl_away_team", validNflResolverTuple.awayTeamAbbreviation],
    ["nfl_home_team_id", validNflResolverTuple.canonicalHomeTeamId],
    ["nfl_away_team_id", validNflResolverTuple.canonicalAwayTeamId],
  ]) assert.match(result.outputs, new RegExp(`^${name}=${value.replaceAll(".", "\\.")}$`, "m"));
  assert.doesNotMatch(result.outputs, /^nfl_provider_event_id=/m);

  assert.match(workflow, /REVIEWED_RELEASE_SHA="4a6ae017fc442237c048c5498e7a442059f8b3aa"/);
  assert.doesNotMatch(workflow, /REVIEWED_RELEASE_SHA="d157c13d74e1d4c8347aef4ee8fb1aa209b7e698"/);
  assert.doesNotMatch(workflow, /REVIEWED_RELEASE_SHA="a57d76cb6b72039724ed4832d25c4e1e4ef04547"/);
  assert.match(workflow, /run: pnpm run covered2:nfl-provider-event-resolution/);
  assert.doesNotMatch(workflow, /nfl_provider_event_id:\s*\$\{\{\s*steps\.contract\.outputs/);

  const start = workflow.indexOf("      - name: Resolve exactly one admitted NFL provider event ID");
  const end = workflow.indexOf("\n      - name:", start + 1);
  assert.ok(start >= 0 && end > start);
  const step = workflow.slice(start, end);
  assert.match(step, /if: steps\.contract\.outputs\.mode == 'manual-nfl-provider-event-resolution'/);
  assert.match(step, /COVERED_PRIVATE_PIPELINE_SHA_V2:\s*\$\{\{\s*steps\.contract\.outputs\.release_sha\s*\}\}/);
  assert.match(step, /COVERED2_MANUAL_VALIDATION_OPERATION:\s*manual-nfl-provider-event-resolution/);
  assert.match(step, /COVERED2_WNBA_SCHEDULER_ENABLED:\s*\$\{\{\s*vars\.COVERED2_WNBA_SCHEDULER_ENABLED\s*\}\}/);
  assert.match(step, /COVERED2_CERTIFICATION_LEDGER_ENABLED:\s*\$\{\{\s*vars\.COVERED2_CERTIFICATION_LEDGER_ENABLED\s*\}\}/);
  assert.match(step, /SHARPAPI_KEY:\s*\$\{\{\s*secrets\.SHARPAPI_KEY\s*\}\}/);
  for (const [name, output] of [
    ["COVERED2_MANUAL_NFL_CANONICAL_EVENT_ID", "nfl_canonical_event_id"],
    ["COVERED2_MANUAL_NFLVERSE_GAME_ID", "nfl_nflverse_game_id"],
    ["COVERED2_MANUAL_NFL_EVENT_DATE", "nfl_event_date"],
    ["COVERED2_MANUAL_NFL_EVENT_START_TIME", "nfl_event_start_time"],
    ["COVERED2_MANUAL_NFL_HOME_TEAM", "nfl_home_team"],
    ["COVERED2_MANUAL_NFL_AWAY_TEAM", "nfl_away_team"],
    ["COVERED2_MANUAL_NFL_HOME_TEAM_ID", "nfl_home_team_id"],
    ["COVERED2_MANUAL_NFL_AWAY_TEAM_ID", "nfl_away_team_id"],
  ]) assert.match(step, new RegExp(`${name}:\\s*\\$\\{\\{\\s*steps\\.contract\\.outputs\\.${output}\\s*\\}\\}`));
  assert.doesNotMatch(step, /COVERED2_MANUAL_NFL_PROVIDER_EVENT_ID|COVERED2_MANUAL_VALIDATION_MARKET|COVERED2_MANUAL_VALIDATION_PUBLISH_BOARD|COVERED2_MANUAL_BOARD_PUBLICATION|COVERED2_MANUAL_LINE|COVERED2_MANUAL_ODDS/);
  for (const output of [
    "nfl_canonical_event_id", "nfl_nflverse_game_id", "nfl_event_date", "nfl_event_start_time",
    "nfl_home_team", "nfl_away_team", "nfl_home_team_id", "nfl_away_team_id",
  ]) assert.match(step, new RegExp(`steps\\.contract\\.outputs\\.${output}`));
  assert.match(step, /run: pnpm run covered2:nfl-provider-event-resolution/);

  const genericStart = workflow.indexOf("- name: Run exactly one bounded C2 exact-market discovery");
  const genericEnd = workflow.indexOf("\n      - name:", genericStart + 1);
  const generic = workflow.slice(genericStart, genericEnd);
  assert.match(generic, /mode != 'manual-nfl-provider-event-resolution'/);
  assert.doesNotMatch(generic, /covered2:nfl-provider-event-resolution/);
});

test("manual NFL provider-event resolver rejects malformed, duplicate, extra, or incomplete tuple fields", () => {
  const tuples = [
    "{", // malformed JSON
    '{"canonicalEventId":"one","canonicalEventId":"two"}', // duplicate key
    JSON.stringify({ ...validNflResolverTuple, providerEventId: "must-not-be-supplied" }),
    JSON.stringify({ ...validNflResolverTuple, unknown: "extra" }),
    JSON.stringify(Object.fromEntries(Object.entries(validNflResolverTuple).filter(([key]) => key !== "canonicalEventId"))),
    JSON.stringify(Object.fromEntries(Object.entries(validNflResolverTuple).filter(([key]) => key !== "nflverseGameId"))),
    JSON.stringify({ ...validNflResolverTuple, canonicalEventId: "bad/id" }),
    JSON.stringify({ ...validNflResolverTuple, nflverseGameId: "" }),
    JSON.stringify({ ...validNflResolverTuple, officialDate: "2026-02-30" }),
    JSON.stringify({ ...validNflResolverTuple, expectedStartTime: "2026-10-23T00:15:00Z" }),
    JSON.stringify({ ...validNflResolverTuple, homeTeamAbbreviation: "Chicago" }),
    JSON.stringify({ ...validNflResolverTuple, homeTeamAbbreviation: "NE" }),
    JSON.stringify({ ...validNflResolverTuple, canonicalAwayTeamId: "canonical-bears" }),
  ];
  for (const tuple of tuples) {
    const rejected = runContract({
      MANUAL_OPERATION: "manual-nfl-provider-event-resolution",
      VALIDATION_SPORT_INPUT: "NFL", VALIDATION_MARKET_INPUT: "", FORCE_DISCOVERY_INPUT: "false",
      NFL_EVENT_TUPLE_INPUT: tuple,
    });
    assert.notEqual(rejected.status, 0, tuple);
    assert.doesNotMatch(rejected.outputs, /^release_sha=/m);
  }
});

test("manual NFL provider-event resolver requires the safe operation scope and rejects cross-sport/write inputs", () => {
  const base = {
    MANUAL_OPERATION: "manual-nfl-provider-event-resolution",
    VALIDATION_SPORT_INPUT: "NFL", VALIDATION_MARKET_INPUT: "", FORCE_DISCOVERY_INPUT: "false",
    NFL_EVENT_TUPLE_INPUT: JSON.stringify(validNflResolverTuple),
  };
  for (const invalid of [
    { VALIDATION_SPORT_INPUT: "MLB" },
    { VALIDATION_MARKET_INPUT: "receiving_yards" },
    { VALIDATION_MARKET_INPUT: "points" },
    { FORCE_DISCOVERY_INPUT: "true" },
    { SCHEDULER_ENABLED: "true" },
    { CERTIFICATION_LEDGER_ENABLED: "true" },
    { SCORED_PROP_ID_INPUT: "00000000-0000-4000-8000-000000000001" },
    { MLB_GAME_PK_INPUT: "849815" },
    { MLB_EVENT_DATE_INPUT: "2026-10-22" },
    { WNBA_EVENT_ID_INPUT: "401918307" },
    { WNBA_EVENT_DATE_INPUT: "2026-10-22" },
  ]) {
    const rejected = runContract({ ...base, ...invalid });
    assert.notEqual(rejected.status, 0, JSON.stringify(invalid));
    assert.doesNotMatch(rejected.outputs, /^release_sha=/m);
  }
  for (const sha of ["d157c13d74e1d4c8347aef4ee8fb1aa209b7e698", "a57d76cb6b72039724ed4832d25c4e1e4ef04547", "19f52b9a88abdf5c0623a97ca9108bcd964883be"]) {
    assert.notEqual(runContract({ ...base, RELEASE_SHA_INPUT: sha }).status, 0, `old SHA ${sha} must fail`);
  }
  assert.doesNotMatch(workflow, /^\s{2}schedule:/m);
  const natural = runContract(naturalWakeOverrides({ ...base }));
  assert.equal(natural.status, 0, natural.diagnostics);
  assert.match(natural.outputs, /^mode=scheduled$/m);
  assert.doesNotMatch(natural.outputs, /manual-nfl-provider-event-resolution|^nfl_/m);
});

test("NFL JSON tuple accepts the exact hydration and nine-field discovery shapes and preserves internal outputs", () => {
  const definition = workflow.match(/^      nfl_event_tuple:\n([\s\S]*?)(?=^      [a-z_]+:\n|^\n)/m)?.[1] ?? "";
  assert.match(definition, /^        required: false$/m);
  assert.match(definition, /^        type: string$/m);
  assert.match(workflow, /NFL_EVENT_TUPLE_INPUT:\s*\$\{\{ inputs\.nfl_event_tuple \}\}/);

  const hydration = runContract({
    MANUAL_OPERATION: "manual-nfl-event-hydration",
    VALIDATION_SPORT_INPUT: "NFL",
    VALIDATION_MARKET_INPUT: "",
    FORCE_DISCOVERY_INPUT: "false",
    ...validNflHydrationTarget,
  });
  assert.equal(hydration.status, 0, hydration.diagnostics);
  assert.match(hydration.outputs, /^mode=manual-nfl-event-hydration$/m);
  assert.match(hydration.outputs, /^nfl_nflverse_game_id=2026_08_CHI_NE$/m);
  assert.match(hydration.outputs, /^nfl_event_date=2026-10-22$/m);
  assert.match(hydration.outputs, /^nfl_event_start_time=2026-10-23T00:15:00\.000Z$/m);
  assert.match(hydration.outputs, /^nfl_home_team=CHI$/m);
  assert.match(hydration.outputs, /^nfl_away_team=NE$/m);
  assert.match(hydration.outputs, /^nfl_home_team_id=canonical-bears$/m);
  assert.match(hydration.outputs, /^nfl_away_team_id=canonical-patriots$/m);
  assert.doesNotMatch(hydration.outputs, /^nfl_(?:canonical_event_id|provider_event_id)=/m);
  assert.match(workflow, /run: pnpm run covered2:nfl-event-hydration/);
  assert.match(workflow, /mode != 'manual-nfl-event-hydration'/);

  for (const market of ["receiving_yards", "rushing_yards"]) {
    const discovery = runContract({
      MANUAL_OPERATION: "exact-market-discovery",
      VALIDATION_SPORT_INPUT: "NFL",
      VALIDATION_MARKET_INPUT: market,
      ...validNflTarget,
    });
    assert.equal(discovery.status, 0, market + ": " + discovery.diagnostics);
    for (const [output, key] of [
      ["nfl_canonical_event_id", "canonicalEventId"], ["nfl_nflverse_game_id", "nflverseGameId"],
      ["nfl_provider_event_id", "providerEventId"], ["nfl_event_date", "officialDate"],
      ["nfl_event_start_time", "expectedStartTime"], ["nfl_home_team", "homeTeamAbbreviation"],
      ["nfl_away_team", "awayTeamAbbreviation"], ["nfl_home_team_id", "canonicalHomeTeamId"],
      ["nfl_away_team_id", "canonicalAwayTeamId"],
    ]) assert.match(discovery.outputs, new RegExp(`^${output}=${validNflTuple[key].replaceAll(".", "\\.")}$`, "m"));
  }
  const board = runContract({
    MANUAL_OPERATION: "exact-market-board-refresh",
    VALIDATION_SPORT_INPUT: "NFL",
    VALIDATION_MARKET_INPUT: "receiving_yards",
    FORCE_DISCOVERY_INPUT: "true",
    ...validNflTarget,
  });
  assert.equal(board.status, 0, board.diagnostics);
  assert.match(board.outputs, /^mode=manual-board-refresh$/m);
});

test("NFL tuple parser rejects malformed JSON, duplicate/unknown keys, wrong shapes, types, and invalid identities before checkout", () => {
  const invalidDiscovery = [
    "{",
    "[]", "null", '"string"', "42", "true",
    JSON.stringify({ ...validNflTuple, unknown: "not-allowed" }),
    '{"canonicalEventId":"first","canonicalEventId":"second"}',
    JSON.stringify({ ...validNflTuple, canonicalEventId: 42 }),
    JSON.stringify({ ...validNflTuple, providerEventId: "" }),
    JSON.stringify(Object.fromEntries(Object.entries(validNflTuple).filter(([key]) => key !== "canonicalEventId"))),
    JSON.stringify(Object.fromEntries(Object.entries(validNflTuple).filter(([key]) => key !== "providerEventId"))),
    JSON.stringify({ ...validNflTuple, canonicalEventId: "bad/id" }),
    JSON.stringify({ ...validNflTuple, officialDate: "2026-02-30" }),
    JSON.stringify({ ...validNflTuple, expectedStartTime: "2026-10-23T00:15:00Z" }),
    JSON.stringify({ ...validNflTuple, expectedStartTime: "2026-10-23T25:15:00.000Z" }),
    JSON.stringify({ ...validNflTuple, homeTeamAbbreviation: "Chicago" }),
    JSON.stringify({ ...validNflTuple, homeTeamAbbreviation: "CHI\n::warning::bad" }),
    JSON.stringify({ ...validNflTuple, awayTeamAbbreviation: "CHI" }),
    JSON.stringify({ ...validNflTuple, canonicalAwayTeamId: "canonical-bears" }),
    JSON.stringify({ ...validNflTuple, nflverseGameId: " " }),
    JSON.stringify({ ...validNflTuple, officialDate: 20261022 }),
  ];
  for (const tuple of invalidDiscovery) {
    const rejected = runContract({
      MANUAL_OPERATION: "exact-market-discovery",
      VALIDATION_SPORT_INPUT: "NFL",
      VALIDATION_MARKET_INPUT: "receiving_yards",
      NFL_EVENT_TUPLE_INPUT: tuple,
    });
    assert.notEqual(rejected.status, 0, `tuple ${tuple} must fail closed`);
    assert.doesNotMatch(rejected.outputs, /^release_sha=/m);
  }

  for (const tuple of [
    JSON.stringify({ ...validNflHydrationTuple, canonicalEventId: validNflTuple.canonicalEventId }),
    JSON.stringify({ ...validNflHydrationTuple, providerEventId: validNflTuple.providerEventId }),
    JSON.stringify({ ...validNflHydrationTuple, another: "key" }),
    JSON.stringify(Object.fromEntries(Object.entries(validNflHydrationTuple).filter(([key]) => key !== "homeTeamAbbreviation"))),
    JSON.stringify({ ...validNflHydrationTuple, homeTeamAbbreviation: 7 }),
  ]) {
    const rejected = runContract({
      MANUAL_OPERATION: "manual-nfl-event-hydration",
      VALIDATION_SPORT_INPUT: "NFL",
      VALIDATION_MARKET_INPUT: "",
      FORCE_DISCOVERY_INPUT: "false",
      NFL_EVENT_TUPLE_INPUT: tuple,
    });
    assert.notEqual(rejected.status, 0, tuple);
    assert.doesNotMatch(rejected.outputs, /^release_sha=/m);
  }
});

test("NFL exact-event operations preserve preflight, scheduled, Passing, and incompatible-market boundaries", () => {
  const preflight = runContract({ MANUAL_OPERATION: "exact-market-preflight" });
  assert.equal(preflight.status, 0, preflight.diagnostics);
  assert.match(preflight.outputs, /^mode=manual-preflight$/m);
  const tuplePreflight = runContract({
    MANUAL_OPERATION: "exact-market-preflight",
    ...validNflTarget,
  });
  assert.notEqual(tuplePreflight.status, 0);
  assert.match(tuplePreflight.diagnostics, /preflight rejects exact-event tuple/);
  const whitespaceTuplePreflight = runContract({
    MANUAL_OPERATION: "exact-market-preflight",
    NFL_EVENT_TUPLE_INPUT: " \n ",
  });
  assert.notEqual(whitespaceTuplePreflight.status, 0, "any non-empty tuple input is incompatible with read-only preflight");
  assert.match(whitespaceTuplePreflight.diagnostics, /preflight rejects exact-event tuple/);
  assert.match(workflow, /refreshNflMarkets\(\{ write: false, markets: \[market\], includeReadOnlyDiagnostics: true \}\)/);
  assert.match(workflow, /steps\.contract\.outputs\.mode != 'manual-preflight'/);

  const missing = runContract({
    MANUAL_OPERATION: "exact-market-discovery",
    VALIDATION_SPORT_INPUT: "NFL",
    VALIDATION_MARKET_INPUT: "receiving_yards",
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.diagnostics, /NFL exact-event tuple is required for this manual operation/);

  const passing = runContract({
    MANUAL_OPERATION: "exact-market-discovery",
    VALIDATION_SPORT_INPUT: "NFL",
    VALIDATION_MARKET_INPUT: "passing_yards",
    ...validNflTarget,
  });
  assert.notEqual(passing.status, 0);
  assert.match(passing.diagnostics, /Unsupported exact sport\/market pair/);

  const scheduled = runContract(naturalWakeOverrides({
    ...validNflTarget,
    MANUAL_OPERATION: "exact-market-discovery",
    VALIDATION_SPORT_INPUT: "NFL",
    VALIDATION_MARKET_INPUT: "receiving_yards",
  }));
  assert.equal(scheduled.status, 0, scheduled.diagnostics);
  assert.match(scheduled.outputs, /^mode=scheduled$/m);
  assert.doesNotMatch(scheduled.outputs, /^nfl_/m);
  assert.doesNotMatch(workflow, /^\s{2}schedule:/m);
});

test("one-shot MLB postseason event hydration is exact, owner-only, and cannot enter the market pipeline", () => {
  const accepted = runContract({
    MANUAL_OPERATION: "mlb-event-hydration",
    VALIDATION_SPORT_INPUT: "MLB",
    VALIDATION_MARKET_INPUT: "batter_total_bases",
    FORCE_DISCOVERY_INPUT: "false",
    MLB_GAME_PK_INPUT: "849817",
    MLB_EVENT_DATE_INPUT: "2026-10-14",
    MLB_EVENT_START_TIME_INPUT: "2026-10-15T00:00:00.000Z",
    MLB_HOME_TEAM_ID_INPUT: "119",
    MLB_AWAY_TEAM_ID_INPUT: "158",
    MLB_GAME_TYPE_INPUT: "L",
    MLB_SERIES_DESCRIPTION_INPUT: "National League Championship Series",
  });
  assert.equal(accepted.status, 0, accepted.diagnostics);
  assert.match(accepted.outputs, /^mode=manual-mlb-event-hydration$/m);
  assert.match(accepted.outputs, /^manual_validation=false$/m);
  assert.match(accepted.outputs, /^mlb_game_pk=849817$/m);
  assert.match(accepted.outputs, /^mlb_event_date=2026-10-14$/m);
  assert.match(accepted.outputs, /^mlb_game_type=L$/m);
  assert.match(workflow, /- mlb-event-hydration/);
  assert.match(workflow, /COVERED2_MANUAL_MLB_EVENT_HYDRATION:\s*"true"/);
  assert.match(workflow, /COVERED2_WNBA_SCHEDULER_ENABLED:\s*\$\{\{\s*vars\.COVERED2_WNBA_SCHEDULER_ENABLED\s*\}\}/);
  assert.match(workflow, /COVERED2_CERTIFICATION_LEDGER_ENABLED:\s*\$\{\{\s*vars\.COVERED2_CERTIFICATION_LEDGER_ENABLED\s*\}\}/);
  assert.match(workflow, /run-covered2-mlb-event-hydration\.mjs/);
  const hydrationStart = workflow.indexOf("- name: Hydrate exactly one current MLB postseason event only");
  const hydrationEnd = workflow.indexOf("\n      - name:", hydrationStart + 1);
  assert.ok(hydrationStart >= 0 && hydrationEnd > hydrationStart);
  const hydrationStep = workflow.slice(hydrationStart, hydrationEnd);
  assert.match(hydrationStep, /MLB_GAME_PK:\s*\$\{\{\s*steps\.contract\.outputs\.mlb_game_pk\s*\}\}/);
  assert.match(hydrationStep, /--game-pk "\$MLB_GAME_PK"/);
  assert.doesNotMatch(hydrationStep, /SHARPAPI_KEY:\s*\$\{\{/);
  assert.match(workflow, /mode != 'manual-mlb-event-hydration'/);
  assert.doesNotMatch(workflow, /schedule:\s*\n/);
  assert.match(workflow, /environment:\s*production/);

  for (const invalid of [
    { VALIDATION_SPORT_INPUT: "NFL" },
    { VALIDATION_MARKET_INPUT: "pitcher_strikeouts" },
    { FORCE_DISCOVERY_INPUT: "true" },
    { MLB_GAME_PK_INPUT: "" },
    { MLB_GAME_PK_INPUT: "0" },
    { MLB_GAME_PK_INPUT: "84x817" },
    { SCHEDULER_ENABLED: "true" },
    { MLB_EVENT_DATE_INPUT: "2026-10-14\n::warning::bad" },
    { MLB_EVENT_START_TIME_INPUT: "tomorrow" },
    { MLB_HOME_TEAM_ID_INPUT: "119\n" },
    { MLB_AWAY_TEAM_ID_INPUT: "119" },
    { MLB_GAME_TYPE_INPUT: "R" },
    { MLB_SERIES_DESCRIPTION_INPUT: "" },
    { CERTIFICATION_LEDGER_ENABLED: "true" },
  ]) {
    const result = runContract({
      MANUAL_OPERATION: "mlb-event-hydration",
      VALIDATION_SPORT_INPUT: "MLB",
      VALIDATION_MARKET_INPUT: "batter_total_bases",
      FORCE_DISCOVERY_INPUT: "false",
      MLB_GAME_PK_INPUT: "849817",
      MLB_EVENT_DATE_INPUT: "2026-10-14",
      MLB_EVENT_START_TIME_INPUT: "2026-10-15T00:00:00.000Z",
      MLB_HOME_TEAM_ID_INPUT: "119",
      MLB_AWAY_TEAM_ID_INPUT: "158",
      MLB_GAME_TYPE_INPUT: "L",
      MLB_SERIES_DESCRIPTION_INPUT: "National League Championship Series",
      ...invalid,
    });
    assert.notEqual(result.status, 0, JSON.stringify(invalid));
    assert.doesNotMatch(result.outputs, /^release_sha=/m, "invalid event contract must fail before private checkout");
  }
});

test("one-shot WNBA postseason event hydration is exact, guarded, and isolated from market discovery", () => {
  const valid = {
    MANUAL_OPERATION: "wnba-event-hydration",
    VALIDATION_SPORT_INPUT: "WNBA",
    VALIDATION_MARKET_INPUT: "rebounds",
    FORCE_DISCOVERY_INPUT: "false",
    WNBA_EVENT_ID_INPUT: "401812345",
    WNBA_EVENT_DATE_INPUT: "2026-10-17",
    WNBA_EVENT_START_TIME_INPUT: "2026-10-17T19:30:00.000Z",
    WNBA_HOME_TEAM_ID_INPUT: "9",
    WNBA_AWAY_TEAM_ID_INPUT: "3",
  };
  const accepted = runContract(valid);
  assert.equal(accepted.status, 0, accepted.diagnostics);
  assert.match(accepted.outputs, /^mode=manual-wnba-event-hydration$/m);
  assert.match(accepted.outputs, /^manual_validation=false$/m);
  assert.match(accepted.outputs, /^force_discovery=false$/m);
  assert.match(accepted.outputs, /^wnba_event_id=401812345$/m);
  assert.match(accepted.outputs, /^wnba_event_date=2026-10-17$/m);
  assert.match(accepted.outputs, /^wnba_event_start_time=2026-10-17T19:30:00\.000Z$/m);
  assert.match(accepted.outputs, /^wnba_home_team_id=9$/m);
  assert.match(accepted.outputs, /^wnba_away_team_id=3$/m);

  const acceptedWithoutId = runContract({ ...valid, WNBA_EVENT_ID_INPUT: "" });
  assert.equal(acceptedWithoutId.status, 0, acceptedWithoutId.diagnostics);
  assert.match(acceptedWithoutId.outputs, /^mode=manual-wnba-event-hydration$/m);
  assert.match(acceptedWithoutId.outputs, /^wnba_event_id=$/m);

  for (const invalid of [
    { VALIDATION_SPORT_INPUT: "MLB" },
    { VALIDATION_MARKET_INPUT: "points" },
    { FORCE_DISCOVERY_INPUT: "true" },
    { WNBA_EVENT_ID_INPUT: "0" },
    { WNBA_EVENT_ID_INPUT: "4018x" },
    { WNBA_EVENT_DATE_INPUT: "2026-10-17\n::warning::bad" },
    { WNBA_EVENT_DATE_INPUT: "" },
    { WNBA_EVENT_DATE_INPUT: "tomorrow" },
    { WNBA_EVENT_START_TIME_INPUT: "" },
    { WNBA_EVENT_START_TIME_INPUT: "2026-10-17T19:30:00Z" },
    { WNBA_EVENT_START_TIME_INPUT: "2026-10-17T19:30:00.000\nZ" },
    { WNBA_HOME_TEAM_ID_INPUT: "" },
    { WNBA_HOME_TEAM_ID_INPUT: "3" },
    { WNBA_AWAY_TEAM_ID_INPUT: "" },
    { WNBA_AWAY_TEAM_ID_INPUT: "team-three" },
    { SCORED_PROP_ID_INPUT: "00000000-0000-4000-8000-000000000001" },
    { MLB_GAME_PK_INPUT: "849817" },
    { MLB_EVENT_DATE_INPUT: "2026-10-17" },
    { CERTIFICATION_LEDGER_ENABLED: "true" },
    { SCHEDULER_ENABLED: "true" },
  ]) {
    const rejected = runContract({ ...valid, ...invalid });
    assert.notEqual(rejected.status, 0, JSON.stringify(invalid));
    assert.doesNotMatch(rejected.outputs, /^release_sha=/m, "invalid input must fail before private checkout");
  }

  assert.match(workflow, /- wnba-event-hydration/);
  for (const [name, input] of [
    ["WNBA_EVENT_ID_INPUT", "wnba_event_id"],
    ["WNBA_EVENT_DATE_INPUT", "wnba_event_date"],
    ["WNBA_EVENT_START_TIME_INPUT", "wnba_event_start_time"],
    ["WNBA_HOME_TEAM_ID_INPUT", "wnba_home_team_id"],
    ["WNBA_AWAY_TEAM_ID_INPUT", "wnba_away_team_id"],
  ]) assert.match(workflow, new RegExp(`${name}:\\s*\\$\\{\\{\\s*inputs\\.${input}\\s*\\}\\}`));
  assert.match(workflow, new RegExp(`REVIEWED_RELEASE_SHA="${reviewedSha}"`));
  assert.match(workflow, /mode != 'manual-wnba-event-hydration'/);
  assert.doesNotMatch(workflow, /^\s{2}schedule:/m);

  const genericStart = workflow.indexOf("- name: Run exactly one bounded C2 exact-market discovery");
  const genericEnd = workflow.indexOf("\n      - name:", genericStart + 1);
  assert.ok(genericStart >= 0 && genericEnd > genericStart);
  const generic = workflow.slice(genericStart, genericEnd);
  assert.match(generic, /mode != 'manual-wnba-event-hydration'/);
  assert.doesNotMatch(generic, /run-covered2-wnba-event-hydration/);
  for (const name of [
    "COVERED2_MANUAL_WNBA_EVENT_ID",
    "COVERED2_MANUAL_WNBA_EVENT_DATE",
    "COVERED2_MANUAL_WNBA_EVENT_START_TIME",
    "COVERED2_MANUAL_WNBA_HOME_TEAM_ID",
    "COVERED2_MANUAL_WNBA_AWAY_TEAM_ID",
  ]) assert.match(generic, new RegExp(`${name}:.*mode == 'manual-validation'.*sport == 'WNBA'.*market == 'rebounds'.*force_discovery == 'true'`));

  const operationStart = workflow.indexOf("      - name: Admit exactly one upcoming WNBA postseason event only");
  const operationEnd = workflow.indexOf("\n      - name:", operationStart + 1);
  assert.ok(operationStart >= 0 && operationEnd > operationStart);
  const operation = workflow.slice(operationStart, operationEnd);
  assert.match(operation, /if: steps\.contract\.outputs\.mode == 'manual-wnba-event-hydration'/);
  assert.match(operation, /run-covered2-wnba-event-hydration\.mjs/);
  assert.match(operation, /COVERED2_MANUAL_WNBA_EVENT_HYDRATION:\s*"true"/);
  assert.match(operation, /COVERED2_WNBA_SCHEDULER_ENABLED:\s*\$\{\{\s*vars\.COVERED2_WNBA_SCHEDULER_ENABLED\s*\}\}/);
  assert.match(operation, /COVERED2_CERTIFICATION_LEDGER_ENABLED:\s*\$\{\{\s*vars\.COVERED2_CERTIFICATION_LEDGER_ENABLED\s*\}\}/);
  assert.ok(operation.includes('if [ -n "$WNBA_EVENT_ID" ]; then'));
  assert.ok(operation.includes('WNBA_EVENT_ARGS=(--event-id "$WNBA_EVENT_ID" "${WNBA_EVENT_ARGS[@]}")'));
  assert.ok(operation.includes('run-covered2-wnba-event-hydration.mjs "${WNBA_EVENT_ARGS[@]}"'));
  assert.doesNotMatch(operation, /run-covered2-wnba-event-hydration\.mjs \s*--event-id/);
  assert.match(operation, /--official-date "\$WNBA_EVENT_DATE"/);
  assert.match(operation, /--start-time "\$WNBA_EVENT_START_TIME"/);
  assert.match(operation, /--home-team-id "\$WNBA_HOME_TEAM_ID"/);
  assert.match(operation, /--away-team-id "\$WNBA_AWAY_TEAM_ID"/);
  assert.match(operation, /SHARPAPI_KEY:\s*""/);
  assert.match(operation, /BBS_API_KEY:\s*""/);
  assert.doesNotMatch(operation, /run-covered2-wnba-refresh\.mjs|run-covered2-mlb-refresh|--write|--market/i);

  const scheduled = runContract(naturalWakeOverrides({
    SCHEDULER_ENABLED: "false",
    MANUAL_OPERATION: "wnba-event-hydration",
    ...Object.fromEntries(Object.entries(valid).filter(([key]) => key.endsWith("_INPUT"))),
  }));
  assert.equal(scheduled.status, 0, scheduled.diagnostics);
  assert.match(scheduled.outputs, /^skip=true$/m);
  assert.doesNotMatch(scheduled.outputs, /manual-wnba-event-hydration|wnba_event_id=/);

  const naturalMlbHydration = runContract(naturalWakeOverrides({
    MANUAL_OPERATION: "mlb-event-hydration",
    VALIDATION_SPORT_INPUT: "MLB",
    VALIDATION_MARKET_INPUT: "batter_total_bases",
    MLB_GAME_PK_INPUT: "849817",
  }));
  assert.equal(naturalMlbHydration.status, 0, naturalMlbHydration.diagnostics);
  assert.match(naturalMlbHydration.outputs, /^mode=scheduled$/m);
  assert.doesNotMatch(naturalMlbHydration.outputs, /manual-mlb-event-hydration|mlb_game_pk=/);

  const naturalWnbaHydration = runContract(naturalWakeOverrides({
    MANUAL_OPERATION: "wnba-event-hydration",
    VALIDATION_SPORT_INPUT: "WNBA",
    VALIDATION_MARKET_INPUT: "rebounds",
    WNBA_EVENT_DATE_INPUT: "2026-10-17",
    WNBA_EVENT_START_TIME_INPUT: "2026-10-17T19:30:00.000Z",
    WNBA_HOME_TEAM_ID_INPUT: "9",
    WNBA_AWAY_TEAM_ID_INPUT: "3",
  }));
  assert.equal(naturalWnbaHydration.status, 0, naturalWnbaHydration.diagnostics);
  assert.match(naturalWnbaHydration.outputs, /^mode=scheduled$/m);
  assert.doesNotMatch(naturalWnbaHydration.outputs, /manual-wnba-event-hydration|wnba_event_id=/);

  const naturallyScheduled = runContract(naturalWakeOverrides({
    MANUAL_OPERATION: "",
    ...Object.fromEntries(Object.entries(valid).filter(([key]) => key.endsWith("_INPUT"))),
  }));
  assert.equal(naturallyScheduled.status, 0, naturallyScheduled.diagnostics);
  assert.match(naturallyScheduled.outputs, /^mode=scheduled$/m);
  assert.doesNotMatch(naturallyScheduled.outputs, /manual-wnba-event-hydration|wnba_event_id=/);
});

test("MLB player-history hydration is exact-event, exact-market, write-bounded, and isolated from Sharp discovery", () => {
  const accepted = runContract({
    MANUAL_OPERATION: "mlb-player-history-hydration",
    VALIDATION_SPORT_INPUT: "MLB",
    VALIDATION_MARKET_INPUT: "batter_total_bases",
    FORCE_DISCOVERY_INPUT: "false",
    MLB_GAME_PK_INPUT: "849817",
  });
  assert.equal(accepted.status, 0, accepted.diagnostics);
  assert.match(accepted.outputs, /^mode=manual-mlb-player-history-hydration$/m);
  assert.match(accepted.outputs, /^manual_validation=false$/m);
  assert.match(accepted.outputs, /^mlb_game_pk=849817$/m);

  for (const invalid of [
    { VALIDATION_SPORT_INPUT: "NFL" },
    { VALIDATION_MARKET_INPUT: "pitcher_strikeouts" },
    { MLB_GAME_PK_INPUT: "84x817" },
    { FORCE_DISCOVERY_INPUT: "true" },
    { MLB_EVENT_DATE_INPUT: "2026-10-15" },
    { SCORED_PROP_ID_INPUT: "00000000-0000-4000-8000-000000000001" },
    { CERTIFICATION_LEDGER_ENABLED: "true" },
    { SCHEDULER_ENABLED: "true" },
  ]) {
    const rejected = runContract({
      MANUAL_OPERATION: "mlb-player-history-hydration",
      VALIDATION_SPORT_INPUT: "MLB",
      VALIDATION_MARKET_INPUT: "batter_total_bases",
      FORCE_DISCOVERY_INPUT: "false",
    MLB_GAME_PK_INPUT: "849817",
      ...invalid,
    });
    assert.notEqual(rejected.status, 0, JSON.stringify(invalid));
    assert.doesNotMatch(rejected.outputs, /^release_sha=/m);
  }

  assert.match(workflow, /- mlb-player-history-hydration/);
  const start = workflow.indexOf("- name: Hydrate exact-target MLB Total Bases player history only");
  const end = workflow.indexOf("- name: Hydrate exactly one current MLB postseason event only", start);
  assert.ok(start >= 0 && end > start);
  const step = workflow.slice(start, end);
  assert.match(step, /if: steps\.contract\.outputs\.mode == 'manual-mlb-player-history-hydration'/);
  assert.match(step, /COVERED2_MANUAL_MLB_PLAYER_HISTORY_HYDRATION:\s*"true"/);
  assert.match(step, /COVERED2_WNBA_SCHEDULER_ENABLED:\s*\$\{\{\s*vars\.COVERED2_WNBA_SCHEDULER_ENABLED\s*\}\}/);
  assert.match(step, /COVERED2_CERTIFICATION_LEDGER_ENABLED:\s*\$\{\{\s*vars\.COVERED2_CERTIFICATION_LEDGER_ENABLED\s*\}\}/);
  assert.match(step, /SUPABASE_SERVICE_ROLE_KEY:\s*\$\{\{\s*secrets\.SUPABASE_SERVICE_ROLE_KEY\s*\}\}/);
  assert.match(step, /SHARPAPI_KEY:\s*""/);
  assert.match(step, /BBS_API_KEY:\s*""/);
  assert.match(step, /run-covered2-mlb-player-history-hydration\.mjs --game-pk/);
  assert.doesNotMatch(step, /run-covered2-wnba-refresh\.mjs|run-covered2-mlb-refresh|--write/);
  const generic = workflow.slice(workflow.indexOf("- name: Run exactly one bounded C2 exact-market discovery"));
  assert.match(generic.split("\n")[1] ?? "", /manual-mlb-player-history-hydration/);
});

test("MLB identity diagnostic is owner-only, exact-date, read-only, and isolated from market discovery", () => {
  const accepted = runContract({
    MANUAL_OPERATION: "mlb-game-identity-diagnostic",
    VALIDATION_SPORT_INPUT: "MLB",
    VALIDATION_MARKET_INPUT: "batter_total_bases",
    FORCE_DISCOVERY_INPUT: "false",
    MLB_EVENT_DATE_INPUT: "2026-10-15",
  });
  assert.equal(accepted.status, 0, accepted.diagnostics);
  assert.match(accepted.outputs, /^mode=manual-mlb-game-identity-diagnostic$/m);
  assert.match(accepted.outputs, /^mlb_event_date=2026-10-15$/m);
  assert.match(accepted.outputs, /^manual_validation=false$/m);
  assert.match(accepted.outputs, /^force_discovery=false$/m);

  for (const invalid of [
    { VALIDATION_SPORT_INPUT: "NFL" },
    { VALIDATION_MARKET_INPUT: "pitcher_strikeouts" },
    { FORCE_DISCOVERY_INPUT: "true" },
    { MLB_EVENT_DATE_INPUT: "2026-10-14" },
    { CERTIFICATION_LEDGER_ENABLED: "true" },
    { SCHEDULER_ENABLED: "true" },
  ]) {
    const rejected = runContract({
      MANUAL_OPERATION: "mlb-game-identity-diagnostic",
      VALIDATION_SPORT_INPUT: "MLB",
      VALIDATION_MARKET_INPUT: "batter_total_bases",
      FORCE_DISCOVERY_INPUT: "false",
      MLB_EVENT_DATE_INPUT: "2026-10-15",
      ...invalid,
    });
    assert.notEqual(rejected.status, 0, JSON.stringify(invalid));
    assert.doesNotMatch(rejected.outputs, /^release_sha=/m);
  }

  assert.match(workflow, /- mlb-game-identity-diagnostic/);
  assert.match(workflow, /mode != 'manual-mlb-game-identity-diagnostic'/);
  const start = workflow.indexOf("- name: Read exact official MLB game identity without writes");
  const end = workflow.indexOf("- name: Hydrate exactly one current MLB postseason event only", start);
  assert.ok(start >= 0 && end > start);
  const step = workflow.slice(start, end);
  assert.match(step, /if: steps\.contract\.outputs\.mode == 'manual-mlb-game-identity-diagnostic'/);
  assert.match(step, /run-covered2-mlb-event-hydration\.mjs/);
  assert.match(step, /ensureTeam: async \(\) => \{ throw new Error\("diagnostic_stop_before_write"\); \}/);
  assert.match(step, /ensureEvent: async \(\) => \{ throw new Error\("diagnostic_stop_before_write"\); \}/);
  assert.match(step, /scheduleRequestCount !== 0/);
  assert.match(step, /searchParams\.get\("startDate"\) !== officialDate/);
  assert.match(step, /searchParams\.get\("endDate"\) !== officialDate/);
  assert.match(step, /searchParams\.get\("sportId"\) !== "1"/);
  assert.match(step, /searchParams\.get\("hydrate"\) !== "team"/);
  assert.match(step, /COVERED2_ALLOWED_EMAILS: ""/);
  assert.match(step, /NEXT_PUBLIC_SUPABASE_URL: ""/);
  assert.match(step, /SUPABASE_SERVICE_ROLE_KEY: ""/);
  assert.match(step, /SHARPAPI_KEY: ""/);
  assert.match(step, /BBS_API_KEY: ""/);
  assert.doesNotMatch(step, /run-covered2-wnba-refresh\.mjs|--write/);
  assert.match(step, /targetRows\.length !== 1/);
  assert.match(step, /officialGames: rows\.map\(project\)/);
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
  const checkout = workflow.indexOf("Check out PRIVATE Covered at the public-reviewed immutable release SHA");
  assert.ok(gate >= 0 && checkout > gate);
});

test("scheduled wakes pass explicit false to the public-reviewed private runner and reject malformed manual flags before checkout", () => {
  for (const value of ["", "false"]) {
    const accepted = runContract(naturalWakeOverrides({ MANUAL_VALIDATION: value }));
    assert.equal(accepted.status, 0, accepted.diagnostics);
    assert.match(accepted.outputs, /^mode=scheduled$/m);
    assert.match(accepted.outputs, /^manual_validation=false$/m);
  }

  for (const value of ["true", "yes", "0"]) {
    const rejected = runContract(naturalWakeOverrides({ MANUAL_VALIDATION: value }));
    assert.notEqual(rejected.status, 0, `manual_validation=${value} must not enter scheduled execution`);
    assert.equal(rejected.outputs.includes("release_sha="), false, "rejected input must not authorize checkout");
  }

  assert.ok(workflow.includes('echo "manual_validation=false" >> "$GITHUB_OUTPUT"'));
  assert.match(workflow, /COVERED2_MANUAL_VALIDATION:\s*\$\{\{\s*steps\.contract\.outputs\.manual_validation\s*\}\}/);
  const contract = workflow.indexOf("id: contract");
  const checkout = workflow.indexOf("Check out PRIVATE Covered at the public-reviewed immutable release SHA");
  assert.ok(contract >= 0 && checkout > contract, "invalid flags fail before private checkout/provider code can run");
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

test("repository-level scheduler preflight blocks a natural wake before the Production job", () => {
  const preflight = workflow.slice(workflow.indexOf("  scheduler_preflight:"), workflow.indexOf("\n  refresh:"));
  assert.match(preflight, /actions\/variables\/COVERED2_WNBA_SCHEDULER_ENABLED/);
  assert.match(preflight, /GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
  assert.doesNotMatch(preflight, /^\s*environment:/m);
  assert.doesNotMatch(preflight, /uses:\s*actions\/checkout|SUPABASE|SHARPAPI|BBS_API|secrets\./i);
  assert.doesNotMatch(preflight, /provider call|certif(?:y|ication)|database write|private-covered/i);
  assert.doesNotMatch(preflight, /COVERED_GITHUB_SCHEDULER_ENABLED/);
  assert.match(workflow, /refresh:\s*\n\s+needs:\s*scheduler_preflight\s*\n\s+if:\s*needs\.scheduler_preflight\.outputs\.allow_refresh\s*==\s*'true'/);
  assert.ok(workflow.indexOf("  scheduler_preflight:") < workflow.indexOf("  refresh:"));
  assert.match(workflow, /environment:\s*production/);
  assert.match(workflow, /COVERED2_WNBA_SCHEDULER_ENABLED:\s*\$\{\{\s*vars\.COVERED2_WNBA_SCHEDULER_ENABLED\s*\}\}/);

  const falseRepoGate = runSchedulerPreflight({ repositoryValue: "false" });
  assert.equal(falseRepoGate.status, 0, falseRepoGate.diagnostics);
  assert.equal(falseRepoGate.curlCalled, true);
  assert.match(falseRepoGate.curlArgs, /\/repos\/CoreyTenacity\/Covered-Prop-Analysis\/actions\/variables\/COVERED2_WNBA_SCHEDULER_ENABLED/);
  assert.match(falseRepoGate.outputs, /^allow_refresh=false$/m);
  assert.match(falseRepoGate.diagnostics, /blocked before Production environment/);
});

test("only exact repository true authorizes natural recurrence and Production gate remains independently required", () => {
  const missing = runSchedulerPreflight({ apiExitCode: 22, apiResponse: "" });
  assert.equal(missing.status, 0, missing.diagnostics);
  assert.match(missing.outputs, /^allow_refresh=false$/m);

  for (const repositoryValue of ["", "false", "TRUE", "yes", "1"]) {
    const blocked = runSchedulerPreflight({ repositoryValue });
    assert.equal(blocked.status, 0, blocked.diagnostics);
    assert.match(blocked.outputs, /^allow_refresh=false$/m);
  }

  const malformed = runSchedulerPreflight({ apiResponse: "not-json" });
  assert.equal(malformed.status, 0, malformed.diagnostics);
  assert.match(malformed.outputs, /^allow_refresh=false$/m);

  const wrongVariable = runSchedulerPreflight({ apiResponse: JSON.stringify({ name: "OTHER", value: "true" }) });
  assert.equal(wrongVariable.status, 0, wrongVariable.diagnostics);
  assert.match(wrongVariable.outputs, /^allow_refresh=false$/m);

  const allowedRepository = runSchedulerPreflight({ repositoryValue: "true" });
  assert.equal(allowedRepository.status, 0, allowedRepository.diagnostics);
  assert.match(allowedRepository.outputs, /^allow_refresh=true$/m);

  const productionPaused = runContract(naturalWakeOverrides({ SCHEDULER_ENABLED: "false" }));
  assert.equal(productionPaused.status, 0, productionPaused.diagnostics);
  assert.match(productionPaused.outputs, /^skip=true$/m);
  assert.doesNotMatch(productionPaused.outputs, /^release_sha=/m);

  const bothGatesOpen = runContract(naturalWakeOverrides({ SCHEDULER_ENABLED: "true" }));
  assert.equal(bothGatesOpen.status, 0, bothGatesOpen.diagnostics);
  assert.match(bothGatesOpen.outputs, /^skip=false$/m);
  assert.match(bothGatesOpen.outputs, /^mode=scheduled$/m);
});

test("manual owner dispatch bypasses only the recurring repository gate and remains under the existing exact-operation contract", () => {
  const preflight = runSchedulerPreflight({ trigger: "workflow_dispatch", repositoryValue: "false" });
  assert.equal(preflight.status, 0, preflight.diagnostics);
  assert.equal(preflight.curlCalled, false, "manual operations do not read or depend on the recurring gate");
  assert.match(preflight.outputs, /^allow_refresh=true$/m);

  for (const identity of [{ actor: "someone-else" }, { refName: "feature" }]) {
    const rejected = runSchedulerPreflight({ trigger: "workflow_dispatch", ...identity });
    assert.equal(rejected.status, 0, rejected.diagnostics);
    assert.equal(rejected.curlCalled, false);
    assert.match(rejected.outputs, /^allow_refresh=false$/m);
  }

  const acceptedManual = runContract({ TRIGGER: "workflow_dispatch", SCHEDULER_ENABLED: "false", ...validNflTarget });
  assert.equal(acceptedManual.status, 0, acceptedManual.diagnostics);
  assert.match(acceptedManual.outputs, /^exact_manual=true$/m);

  const invalidManual = runContract({
    TRIGGER: "workflow_dispatch",
    SCHEDULER_ENABLED: "false",
    VALIDATION_MARKET_INPUT: "unsupported_market",
  });
  assert.notEqual(invalidManual.status, 0);
  assert.match(invalidManual.diagnostics, /Unsupported exact sport\/market pair/);
});


test("scheduled dispatch emits the complete explicit-false private validation contract", () => {
  for (const manualValidation of ["", "false"]) {
    const accepted = runContract(naturalWakeOverrides({ MANUAL_VALIDATION: manualValidation }));
    assert.equal(accepted.status, 0, accepted.diagnostics);
    assert.match(accepted.outputs, /^mode=scheduled$/m);
    assert.match(accepted.outputs, /^manual_validation=false$/m);
    assert.match(accepted.outputs, /^force_discovery=false$/m);
    assert.match(accepted.outputs, /^publish_board=false$/m);
    assert.match(accepted.outputs, /^sport=$/m);
    assert.match(accepted.outputs, /^market=$/m);
  }

  for (const malformed of ["true", "yes", "0"]) {
    const rejected = runContract(naturalWakeOverrides({ MANUAL_VALIDATION: malformed }));
    assert.notEqual(rejected.status, 0, `manual_validation=${malformed} must fail before checkout`);
    assert.doesNotMatch(rejected.outputs, /^release_sha=/m);
  }

  assert.ok(workflow.includes('echo "manual_validation=false" >> "$GITHUB_OUTPUT"'));
  assert.ok(workflow.includes('echo "force_discovery=false" >> "$GITHUB_OUTPUT"'));
  assert.ok(workflow.includes('echo "publish_board=false" >> "$GITHUB_OUTPUT"'));
  for (const [name, output] of [
    ["COVERED2_MANUAL_VALIDATION", "manual_validation"],
    ["COVERED2_MANUAL_VALIDATION_FORCE_DISCOVERY", "force_discovery"],
    ["COVERED2_MANUAL_VALIDATION_SPORT", "sport"],
    ["COVERED2_MANUAL_VALIDATION_MARKET", "market"],
    ["COVERED2_MANUAL_VALIDATION_PUBLISH_BOARD", "publish_board"],
  ]) {
    assert.match(workflow, new RegExp(`${name}:\\s*\\$\\{\\{\\s*steps\\.contract\\.outputs\\.${output}\\s*\\}\\}`));
  }
  const contractStep = workflow.indexOf("id: contract");
  const checkout = workflow.indexOf("Check out PRIVATE Covered at the public-reviewed immutable release SHA");
  const marketStep = workflow.indexOf("Run exactly one bounded C2 exact-market discovery");
  assert.ok(contractStep >= 0 && checkout > contractStep && marketStep > checkout);
});

test("manual exact-market discovery passes the reviewed release SHA into the private runtime contract", () => {
  const start = workflow.indexOf("      - name: Run exactly one bounded C2 exact-market discovery");
  assert.notEqual(start, -1);
  const end = workflow.indexOf("\n      - name:", start + 1);
  assert.notEqual(end, -1);
  const discoveryStep = workflow.slice(start, end);
  assert.match(discoveryStep, /EXPECTED_SHA:\s*\$\{\{\s*steps\.contract\.outputs\.release_sha\s*\}\}/);
  assert.match(discoveryStep, /COVERED_PRIVATE_PIPELINE_SHA_V2:\s*\$\{\{\s*steps\.contract\.outputs\.release_sha\s*\}\}/);
});

