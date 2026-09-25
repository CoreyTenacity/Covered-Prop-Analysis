import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("./covered2-wnba-refresh.yml", import.meta.url), "utf8");

test("manual and scheduled deliveries use isolated, non-cancelling concurrency groups", () => {
  assert.match(workflow, /group:\s*\$\{\{\s*github\.event\.client_payload\.manual_validation\s*==\s*true\s*&&\s*'covered2-wnba-refresh-manual-validation'\s*\|\|\s*'covered2-wnba-refresh'\s*\}\}/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
});

test("ordinary dispatch exits behind the false global gate before private checkout", () => {
  const gate = workflow.indexOf('C2 global scheduler gate is false; scheduled and ordinary repository_dispatch wakes exit before private checkout.');
  const checkout = workflow.indexOf('Check out PRIVATE Covered at the immutable production pin');
  assert.ok(gate >= 0 && checkout > gate);
  assert.match(workflow, /if:\s*steps\.contract\.outputs\.skip\s*!=\s*'true'/);
});

test("manual validation is bound to the exact owner payload, paused gates, immutable pin, and supported runner sport", () => {
  assert.match(workflow, /MANUAL_VALIDATION_ID" != "covered-nfl-force-discovery-20260925"/);
  assert.match(workflow, /ACTOR" != "CoreyTenacity"/);
  assert.match(workflow, /SENDER" != "CoreyTenacity"/);
  assert.match(workflow, /EXPECTED_SHA" != "\$REVIEWED_SHA"/);
  assert.match(workflow, /PIN" != "\$REVIEWED_SHA"/);
  assert.match(workflow, /SCHEDULER_ENABLED" != "false"/);
  assert.match(workflow, /CERTIFICATION_LEDGER_ENABLED" != "false"/);
  assert.match(workflow, /case "\$VALIDATION_SPORT" in\s+MLB\|NFL\|WNBA\)/);
  assert.match(workflow, /Manual validation is accepted only while the global scheduler gate is false/);
});

test("manual validation pins execution to one sport and leaves all other sport flags false", () => {
  assert.match(workflow, /COVERED2_MANUAL_VALIDATION_SPORT:\s*\$\{\{\s*steps\.contract\.outputs\.sport\s*\}\}/);
  for (const name of [
    "COVERED2_MLB_SCHEDULE_INGEST",
    "COVERED2_MLB_PLAYER_IDENTITY",
    "COVERED2_MLB_MARKET_GAMELOG",
    "COVERED2_MLB_MARKET_OPPONENT",
    "COVERED2_MLB_PLAYER_LOG_REFRESH",
    "COVERED2_MLB_LINEUP_REFRESH",
    "COVERED2_NFL_RECEPTIONS_REFRESH",
    "COVERED2_NFL_RECEIVING_YARDS_REFRESH",
    "COVERED2_NFL_RUSHING_YARDS_REFRESH",
    "COVERED2_NFL_PASSING_YARDS_REFRESH",
  ]) {
    assert.match(workflow, new RegExp(`${name}:.*manual-validation.*sport.*false`));
  }
});

test("the authorized one-off payload is NFL-only and process-locally bypasses only discovery cadence", () => {
  assert.match(workflow, /MANUAL_VALIDATION_ID" != "covered-nfl-force-discovery-20260925"/);
  assert.match(workflow, /REVIEWED_SHA="206e9c850e0749c10e6cd71ba3eb5b4f442946a4"/);
  assert.match(workflow, /FORCE_DISCOVERY: \$\{\{ github\.event\.client_payload\.manual_validation_force_discovery \}\}/);
  assert.match(workflow, /\[ "\$FORCE_DISCOVERY" != "true" \] \|\| \[ "\$VALIDATION_SPORT" != "NFL" \]/);
  assert.match(workflow, /force_discovery=true/);
  assert.match(workflow, /COVERED2_MANUAL_VALIDATION_FORCE_DISCOVERY:\s*\$\{\{\s*steps\.contract\.outputs\.force_discovery\s*\}\}/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.doesNotMatch(workflow, /COVERED2_[A-Z_]*(?:CAP|HORIZON|WINDOW)[A-Z_]*\s*:/i);
  assert.doesNotMatch(workflow, /COVERED2_WNBA_SCHEDULER_ENABLED:\s*"true"/);
});

test("workflow does not change persistent gate values or enable certification", () => {
  assert.doesNotMatch(workflow, /gh\s+variable\s+set|gh\s+api\s+--method\s+(PATCH|POST|PUT|DELETE)/i);
  assert.match(workflow, /COVERED2_CERTIFICATION_LEDGER_ENABLED:\s*\$\{\{\s*vars\.COVERED2_CERTIFICATION_LEDGER_ENABLED\s*\}\}/);
  assert.doesNotMatch(workflow, /COVERED2_CERTIFICATION_LEDGER_ENABLED:\s*"true"/);
});
