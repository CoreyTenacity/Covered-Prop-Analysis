import assert from "node:assert/strict";
import test from "node:test";
import { primaryNavLinks } from "./nav-links.ts";

test("primary navigation does not link to the SharpAPI provider-audit page", () => {
  const hrefs: string[] = primaryNavLinks.map(([, href]) => href);
  assert.ok(!hrefs.includes("/sharpapi"), "SharpAPI should not appear in primary navigation");
});

test("primary navigation keeps the expected user-facing links", () => {
  assert.deepEqual(primaryNavLinks.map(([, href]) => href), [
    "/today",
    "/slip-analyzer",
    "/my-picks",
    "/performance",
  ]);
});
