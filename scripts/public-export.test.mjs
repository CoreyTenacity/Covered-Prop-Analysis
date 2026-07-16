import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  auditPublicExport,
  copyExportTree,
  findImportClosureViolations,
  findMissingRequiredFiles,
  findMissingRequiredScripts,
  findMustBeAbsentViolations,
  planExport,
  planPackageJsonForExport,
  scanForSecrets,
} from "./public-export.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeFixtureTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "public-export-fixture-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  return root;
}

const baseManifest = {
  publicSafe: ["lib/safe.ts"],
  privateOnly: ["scoring-engine/**", "lib/private/secret-sauce.ts"],
  conditional: [],
};

test("planExport excludes manifest privateOnly patterns and keeps everything else", () => {
  const files = {
    "lib/safe.ts": "export const ok = true;\n",
    "lib/private/secret-sauce.ts": "export const formula = 42;\n",
    "scoring-engine/src/index.ts": "export const engine = true;\n",
    "package.json": "{}\n",
  };
  const root = makeFixtureTree(files);
  const tracked = Object.keys(files);
  const { included, excluded } = planExport({ repoRoot: root, manifest: baseManifest, trackedFiles: tracked });
  assert.deepEqual(included.sort(), ["lib/safe.ts", "package.json"]);
  assert.deepEqual(excluded.sort(), ["lib/private/secret-sauce.ts", "scoring-engine/src/index.ts"]);
});

test("planExport applies default excludes for env-like and archive-like tracked paths", () => {
  const files = {
    "lib/safe.ts": "export const ok = true;\n",
    ".env.local": "SECRET=1\n",
    "notes/screenshot-debug.png": "binary",
    "backup.zip": "binary",
  };
  const root = makeFixtureTree(files);
  const tracked = Object.keys(files);
  const { included, excluded } = planExport({ repoRoot: root, manifest: baseManifest, trackedFiles: tracked });
  assert.deepEqual(included, ["lib/safe.ts"]);
  assert.deepEqual(excluded.sort(), [".env.local", "backup.zip", "notes/screenshot-debug.png"]);
});

test("findImportClosureViolations detects a public file importing an excluded private file", () => {
  const files = {
    "lib/safe.ts": 'import { formula } from "./private/secret-sauce";\nexport const ok = formula;\n',
    "lib/private/secret-sauce.ts": "export const formula = 42;\n",
  };
  const root = makeFixtureTree(files);
  const { included, excluded } = planExport({
    repoRoot: root,
    manifest: baseManifest,
    trackedFiles: Object.keys(files),
  });
  const violations = findImportClosureViolations({ repoRoot: root, included, excluded });
  assert.deepEqual(violations, [{
    from: "lib/safe.ts",
    to: "lib/private/secret-sauce.ts",
    specifier: "./private/secret-sauce",
    reason: "imports an excluded (private-only) module",
  }]);
});

test("findImportClosureViolations passes when a public file only imports other included files", () => {
  const files = {
    "lib/safe.ts": 'import { helper } from "./helper";\nexport const ok = helper;\n',
    "lib/helper.ts": "export const helper = 1;\n",
  };
  const root = makeFixtureTree(files);
  const { included, excluded } = planExport({
    repoRoot: root,
    manifest: baseManifest,
    trackedFiles: Object.keys(files),
  });
  const violations = findImportClosureViolations({ repoRoot: root, included, excluded });
  assert.deepEqual(violations, []);
});

test("findMissingRequiredFiles reports absent scaffolding", () => {
  const missing = findMissingRequiredFiles(["package.json"]);
  assert.ok(missing.includes("tsconfig.json"));
  assert.ok(missing.includes("app/layout.tsx"));
  assert.ok(!missing.includes("package.json"));
});

test("findMustBeAbsentViolations flags scoring-engine and tuned-adapter leakage", () => {
  const violations = findMustBeAbsentViolations(["scoring-engine/src/index.ts", "lib/safe.ts"]);
  assert.deepEqual(violations, ["scoring-engine/**"]);
  assert.deepEqual(findMustBeAbsentViolations(["lib/safe.ts"]), []);
});

test("scanForSecrets finds a Supabase-shaped secret key but not a harmless value", () => {
  // Built from two parts rather than one literal so this fixture's own source text in
  // scripts/public-export.test.mjs doesn't match the very pattern it's testing for --
  // otherwise the tool would flag its own test file when auditing the real repo.
  const fakeSupabaseSecret = "sb_secret_" + "abcdefghijklmnopqrstuvwxyz123456";
  const files = {
    "lib/leaky.ts": `const key = "${fakeSupabaseSecret}";\n`,
    "lib/clean.ts": 'const label = "just a normal string";\n',
  };
  const root = makeFixtureTree(files);
  const findings = scanForSecrets({ repoRoot: root, included: Object.keys(files) });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "lib/leaky.ts");
  assert.equal(findings[0].pattern, "supabase-secret-key");
});

test("auditPublicExport reports ok:true for a clean synthetic tree", () => {
  const files = {
    "package.json": JSON.stringify({ scripts: { dev: "next dev", build: "next build", test: "node --test", lint: "next lint", "cf:build": "opennextjs-cloudflare build" } }) + "\n",
    "tsconfig.json": "{}\n",
    "next.config.ts": "export default {};\n",
    "pnpm-workspace.yaml": "packages: []\n",
    "app/layout.tsx": "export default function Layout() { return null; }\n",
    "lib/safe.ts": 'import { helper } from "./helper";\nexport const ok = helper;\n',
    "lib/helper.ts": "export const helper = 1;\n",
    "lib/private/secret-sauce.ts": "export const formula = 42;\n",
  };
  const root = makeFixtureTree(files);
  const report = auditPublicExport({ repoRoot: root, manifest: baseManifest, trackedFiles: Object.keys(files) });
  assert.equal(report.ok, true);
  assert.equal(report.counts.excludedFiles, 1);
});

test("copyExportTree copies only included files and no others", () => {
  const files = {
    "package.json": "{}\n",
    "lib/private/secret-sauce.ts": "export const formula = 42;\n",
  };
  const root = makeFixtureTree(files);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "public-export-out-"));
  const { fileCount } = copyExportTree({ repoRoot: root, included: ["package.json"], outDir });
  assert.equal(fileCount, 1);
  assert.ok(fs.existsSync(path.join(outDir, "package.json")));
  assert.ok(!fs.existsSync(path.join(outDir, "lib/private/secret-sauce.ts")));
  assert.ok(!fs.existsSync(path.join(outDir, ".git")));
});

test("planPackageJsonForExport drops a script whose command references an excluded file", () => {
  const packageJson = {
    scripts: {
      dev: "next dev",
      "scoring-engine:dev": "wrangler dev --config scoring-engine/wrangler.jsonc",
    },
  };
  const { packageJson: result, removedScripts } = planPackageJsonForExport({
    packageJson,
    excludedFiles: ["scoring-engine/wrangler.jsonc"],
  });
  assert.deepEqual(removedScripts, ["scoring-engine:dev"]);
  assert.deepEqual(Object.keys(result.scripts), ["dev"]);
});

test("planPackageJsonForExport transitively drops a script that only invokes an already-removed script", () => {
  const packageJson = {
    scripts: {
      dev: "next dev",
      "cron:run": "node ./scripts/run-covered-job.mjs",
      "cron:test:mlb-live-focus": "pnpm run cron:run -- knowledge --job refresh_teams --league MLB",
    },
  };
  const { packageJson: result, removedScripts } = planPackageJsonForExport({
    packageJson,
    excludedFiles: ["scripts/run-covered-job.mjs"],
  });
  assert.deepEqual(removedScripts.sort(), ["cron:run", "cron:test:mlb-live-focus"]);
  assert.deepEqual(Object.keys(result.scripts), ["dev"]);
});

test("planPackageJsonForExport keeps public-safe scripts untouched", () => {
  const packageJson = {
    scripts: {
      dev: "next dev",
      build: "next build",
      "cf:build": "opennextjs-cloudflare build",
    },
  };
  const { packageJson: result, removedScripts } = planPackageJsonForExport({
    packageJson,
    excludedFiles: ["scoring-engine/wrangler.jsonc", "scripts/run-covered-job.mjs"],
  });
  assert.deepEqual(removedScripts, []);
  assert.deepEqual(result.scripts, packageJson.scripts);
});

test("findMissingRequiredScripts reports absent required commands", () => {
  assert.deepEqual(findMissingRequiredScripts({ dev: "next dev" }), ["build", "test", "lint", "cf:build"]);
  assert.deepEqual(findMissingRequiredScripts({ dev: "x", build: "x", test: "x", lint: "x", "cf:build": "x" }), []);
});

test("the real repository's exported package.json keeps every required command and never advertises a private-only script", () => {
  // Environment-agnostic on purpose: run in the private repo, this proves the transform
  // actively strips the 4 known private-only scripts out of the source package.json. Run
  // from inside an already-exported copy (whose package.json was already transformed by
  // copyExportTree), there is nothing left to remove -- report.removedScripts is legitimately
  // empty there. Either way, finalScripts (the result after transformation) must contain every
  // required command and none of the known private-only ones, so this assertion holds in both.
  const report = auditPublicExport();
  assert.deepEqual(report.missingRequiredScripts, []);
  const knownPrivateOnlyScriptNames = ["scoring-engine:dev", "scoring-engine:deploy", "cron:run", "cron:test:mlb-live-focus"];
  for (const name of knownPrivateOnlyScriptNames) {
    assert.ok(!(name in report.finalScripts), `${name} should not be callable from the exported package.json`);
  }
});

test("copyExportTree writes a transformed package.json with private-only scripts removed", () => {
  const files = {
    "package.json": JSON.stringify({
      scripts: {
        dev: "next dev",
        "scoring-engine:dev": "wrangler dev --config scoring-engine/wrangler.jsonc",
      },
    }),
    "scoring-engine/wrangler.jsonc": "{}\n",
  };
  const root = makeFixtureTree(files);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "public-export-pkg-"));
  copyExportTree({ repoRoot: root, included: ["package.json"], excluded: ["scoring-engine/wrangler.jsonc"], outDir });
  const written = JSON.parse(fs.readFileSync(path.join(outDir, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(written.scripts), ["dev"]);
});

test("no included GitHub Actions workflow references an excluded file or a removed package.json script", () => {
  const report = auditPublicExport();
  const excludedSet = new Set(report.excluded);
  const removedScriptRefs = report.removedScripts.map((name) => `run ${name}`);
  const includedWorkflows = report.included.filter((file) => file.startsWith(".github/workflows/") && file.endsWith(".yml"));
  assert.ok(includedWorkflows.length > 0);
  for (const workflowFile of includedWorkflows) {
    const source = fs.readFileSync(workflowFile, "utf8");
    for (const excludedFile of excludedSet) {
      assert.ok(!source.includes(excludedFile), `${workflowFile} references excluded file ${excludedFile}`);
    }
    for (const removedScriptRef of removedScriptRefs) {
      assert.ok(!source.includes(removedScriptRef), `${workflowFile} references removed script via "${removedScriptRef}"`);
    }
  }
});

test("the SharpAPI operational page/component is fully removed from source and the public export, while backend provider/ingestion modules remain", () => {
  const sharpApiPagePath = "app/(dashboard)/sharpapi/page.tsx";
  const sharpApiComponentPath = "components/providers/sharpapi-slate.tsx";

  // Removed at the source, not just export-excluded: neither file should exist on disk at all.
  assert.ok(!fs.existsSync(path.join(REPO_ROOT, sharpApiPagePath)), "the SharpAPI page should no longer exist on disk");
  assert.ok(!fs.existsSync(path.join(REPO_ROOT, sharpApiComponentPath)), "the SharpAPI operational component should no longer exist on disk");

  const report = auditPublicExport();
  assert.ok(!report.included.includes(sharpApiPagePath), "the SharpAPI page must not be in the public export");
  assert.ok(!report.excluded.includes(sharpApiPagePath), "a deleted file should not appear in either export list");
  assert.ok(!report.included.includes(sharpApiComponentPath));
  assert.ok(!report.excluded.includes(sharpApiComponentPath));

  // Public-safe backend files must exist and remain included in every context -- the private
  // repo and an already-exported copy both ship these, so this assertion is environment-agnostic.
  const publicSafeBackendFiles = ["lib/providers/sharpapi.ts", "lib/providers/normalize-sharpapi.ts"];
  for (const file of publicSafeBackendFiles) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, file)), `required public-safe backend file missing: ${file}`);
    assert.ok(report.included.includes(file), `${file} should remain in the public export`);
  }

  // Private-only ingestion/matching files are, by design, absent from any already-exported
  // copy -- that is the entire point of the export boundary. Detect which context this test
  // is running in via a stable private-only marker (scoring-engine/ never ships in any
  // export) rather than assuming a full private checkout, so this test passes correctly in
  // both the private repo and a fresh export copy.
  const isPrivateCheckout = fs.existsSync(path.join(REPO_ROOT, "scoring-engine"));
  const privateOnlyBackendFiles = [
    "lib/providers/sharpapi-refresh.ts",
    "lib/knowledge/sharp-ingestion-job.ts",
    "lib/knowledge/sharp-matching.ts",
  ];
  if (isPrivateCheckout) {
    for (const file of privateOnlyBackendFiles) {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, file)), `required private-only backend file missing: ${file}`);
      assert.ok(report.excluded.includes(file), `${file} should be excluded from the public export but present in the private repo`);
    }
  } else {
    for (const file of privateOnlyBackendFiles) {
      assert.ok(!report.included.includes(file), `${file} must never be in the public export`);
    }
  }
});

test("deploy-cloudflare.yml is excluded from the public export, and no account-specific workers.dev hostname appears in any included file", () => {
  const report = auditPublicExport();
  const deployWorkflowPath = ".github/workflows/deploy-cloudflare.yml";

  // Cloudflare Workers Builds is the intended deployment mechanism for the public repo; this
  // GitHub-Actions-driven workflow is a separate, private-repo-only deploy path and must not
  // ship in the public export (see docs/public-repo-boundary.json's note for the full reasoning).
  // The file itself is only expected to exist when running against a full private checkout --
  // an already-exported copy never has it at all, same as the SharpAPI backend-file check above.
  const isPrivateCheckout = fs.existsSync(path.join(REPO_ROOT, "scoring-engine"));
  if (isPrivateCheckout) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, deployWorkflowPath)), "deploy-cloudflare.yml should still exist in the private repository");
    assert.ok(report.excluded.includes(deployWorkflowPath), "deploy-cloudflare.yml should be recorded as excluded");
  }
  assert.ok(!report.included.includes(deployWorkflowPath), "deploy-cloudflare.yml must not be in the public export");

  // Regression guard for the specific leak this test was written for: no included file may
  // contain the account-specific workers.dev hostname that was previously hardcoded here.
  // Built from two parts rather than one literal so this test file's own source text doesn't
  // match the very pattern it's testing for (this file is itself part of the public export).
  const accountSpecificHostnameFragment = "corey" + "093011";
  for (const file of report.included) {
    const absolutePath = path.join(REPO_ROOT, file);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
    const extension = path.extname(file);
    if ([".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2"].includes(extension)) continue;
    const source = fs.readFileSync(absolutePath, "utf8");
    assert.ok(!source.includes(accountSpecificHostnameFragment), `${file} must not reference the account-specific workers.dev hostname`);
  }
});
