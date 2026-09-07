import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/covered2-wnba-refresh.yml"), "utf8");

test("production wake injects the production low-egress variable into its private runtime", () => {
  assert.match(
    workflow,
    /^\s+KNOWLEDGE_LOW_EGRESS_MODE:\s+\$\{\{ vars\.KNOWLEDGE_LOW_EGRESS_MODE \}\}\s*$/m,
    "the public production wake must pass the production variable to the checked-out private runtime"
  );
});
