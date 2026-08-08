import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("credential proof listener is receipt-only and its rollback removes exactly that one file", async () => {
  const workflow = await readFile("docs/candidate-f/covered-dispatch-credential-proof.yml", "utf8");
  const patch = await readFile("docs/candidate-f/covered-dispatch-credential-proof.patch", "utf8");
  const rollback = await readFile("docs/candidate-f/covered-dispatch-credential-proof.rollback.patch", "utf8");
  assert.match(workflow, /repository_dispatch:\n    types: \[covered-dispatch-credential-proof\]/);
  assert.doesNotMatch(workflow, /workflow_dispatch:|schedule:|checkout@|SUPABASE|SHARP|private-covered|cron:run|snapshot/i);
  assert.match(workflow, /timeout-minutes: 1/);
  assert.match(workflow, /credential-proof event received/);
  assert.match(workflow, /correlation-id=\$CORRELATION_ID/);
  assert.match(workflow, /timestamp=\$\(date -u/);
  assert.match(patch, /new file mode 100644/);
  assert.match(rollback, /deleted file mode 100644/);
  assert.doesNotMatch(rollback, /\+\+\+ b\/|\+.*covered-production-pipeline/i);
});
