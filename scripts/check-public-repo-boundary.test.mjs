import assert from "node:assert/strict";
import test from "node:test";
import { auditBoundary, classifyModule, inspectSource, loadManifest } from "./check-public-repo-boundary.mjs";

const manifest = loadManifest();

test("current public-safe modules have no direct private-only imports", () => {
  const report = auditBoundary({ manifest });
  assert.deepEqual(report.missingPublicSafe, []);
  assert.deepEqual(report.violations, []);
});

test("no conditional modules remain unresolved", () => {
  const report = auditBoundary({ manifest });
  assert.deepEqual(report.conditional, []);
});

test("classification distinguishes private and public-safe modules", () => {
  assert.equal(classifyModule("scoring-engine/src/index.ts", manifest), "private-only");
  assert.equal(classifyModule("lib/providers/live-board.ts", manifest), "private-only");
  assert.equal(classifyModule("lib/scoring/explanations.ts", manifest), "public-safe");
});

test("a public-safe source importing a private module is detected", () => {
  const testManifest = { ...manifest, publicSafe: [...manifest.publicSafe, "lib/example-public.ts"] };
  // Built from parts rather than one literal string so this fixture doesn't itself look like
  // a real `import ... from "..."` statement to naive text-scanning tools (e.g. scripts/public-export.mjs),
  // which would otherwise misreport this test file as importing the private module it's testing for.
  const fakeSource = "import { score } " + 'from "@/lib/knowledge/scoring-service";\n';
  // Self-contained fixture: a privateOnly file is, by definition, absent from a public export
  // copy, so this test cannot rely on the real filesystem to prove resolution -- it injects a
  // fake fileExists instead of depending on lib/knowledge/scoring-service.ts actually being on
  // disk. This keeps the test passing identically in the private repo and any export copy.
  const fileExists = (candidate) => candidate.replace(/\\/g, "/").endsWith("lib/knowledge/scoring-service.ts");
  const report = inspectSource(
    "lib/example-public.ts",
    fakeSource,
    testManifest,
    process.cwd(),
    fileExists,
  );
  assert.deepEqual(report.violations, [{
    from: "lib/example-public.ts",
    to: "lib/knowledge/scoring-service.ts",
    specifier: "@/lib/knowledge/scoring-service",
  }]);
});
