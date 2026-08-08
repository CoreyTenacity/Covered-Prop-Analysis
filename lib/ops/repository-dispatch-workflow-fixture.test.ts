import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("repository_dispatch workflow candidate removes GitHub cron and accepts only the fixed heartbeat contract", async () => {
  const patch = await readFile("docs/candidate-f/covered-production-pipeline-repository-dispatch.patch", "utf8");
  const workflow = await readFile("docs/candidate-f/covered-production-pipeline-repository-dispatch.yml", "utf8");
  assert.match(patch, /repository_dispatch:\n\+    types: \[covered-production-heartbeat\]/);
  assert.doesNotMatch(patch, /^\+.*schedule:/m);
  assert.match(patch, /DISPATCH_SCHEMA.*client_payload\.schema/);
  assert.match(patch, /DISPATCH_SLOT.*client_payload\.slot/);
  assert.match(patch, /Rejected repository_dispatch contract/);
  assert.match(patch, /Rejected repository_dispatch slot/);
  assert.match(patch, /LEAGUE="auto"; CFG="1"; SCHEDULER_HEARTBEAT="true"/);
  assert.match(patch, /--schedulerHeartbeat/);
  assert.match(patch, /--slot/);
  assert.match(patch, /COVERED_GITHUB_SCHEDULER_ENABLED/);
  assert.match(patch, /WNBA_INGESTION_ENABLED/);
  assert.doesNotMatch(patch, /timeout-minutes|cancel-in-progress|group:|COVERED_PRIVATE_PIPELINE_SHA_V2/, "the public patch must not alter timeout, concurrency, or V2 checkout safety");
  assert.match(workflow, /workflow_dispatch:/, "manual operations remain available");
  assert.match(workflow, /repository_dispatch:\n    types: \[covered-production-heartbeat\]/);
  assert.doesNotMatch(workflow, /\n  schedule:/, "Cloudflare becomes the only recurring scheduler");
  assert.match(workflow, /timeout-minutes: 25/);
  assert.match(workflow, /group: covered-production-sharpapi/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /COVERED_PRIVATE_PIPELINE_SHA_V2/);
  assert.match(workflow, /--wnbaEnabled "\$\{WNBA_INGESTION_ENABLED\}"/);
});
