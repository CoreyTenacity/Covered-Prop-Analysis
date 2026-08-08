import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public heartbeat fixture has one bounded non-round schedule and preserves safety controls", async () => {
  const source = await readFile("docs/candidate-f/covered-production-pipeline.yml", "utf8");
  assert.match(source, /cron: "7,27,47 16-23,0-4 \* \* \*"/);
  assert.doesNotMatch(source, /cron: "0,20,40 22,23,0,1,2,3,4 \* \* \*"/);
  assert.doesNotMatch(source, /cron: "10,30,50 16,17,18,19,20,21,22,23,0,1,2,3,4 \* \* \*"/);
  assert.match(source, /group: covered-production-sharpapi/);
  assert.match(source, /timeout-minutes: 25/);
  assert.match(source, /COVERED_PRIVATE_PIPELINE_SHA_V2/);
  assert.match(source, /--league "\$\{\{ steps\.params\.outputs\.league \}\}"/);
  assert.match(source, /--wnbaEnabled "\$\{WNBA_INGESTION_ENABLED\}"/);
  assert.match(source, /LEAGUE="auto"; CFG="1"/);
});
