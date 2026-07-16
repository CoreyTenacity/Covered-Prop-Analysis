import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadManifest,
  classifyModule,
  matchesPattern,
  extractImportSpecifiers,
  resolveImport,
} from "./check-public-repo-boundary.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, ".public-export-audit");

// Belt-and-suspenders excludes beyond the manifest's privateOnly list. Everything here
// should already be absent from `git ls-files` because of .gitignore; this only protects
// against something sensitive accidentally being tracked in the future.
const DEFAULT_EXTRA_EXCLUDE_PATTERNS = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.dev.*\.vars$/i,
  /\.(log|tmp|dump|sql\.gz|sqlite|db)$/i,
  /\.(zip|tar|tar\.gz|tgz|7z)$/i,
  /(^|\/)screenshot[^/]*\.(png|jpe?g|gif)$/i,
];

// Precise, deterministic carve-out: a tracked file ending in exactly ".example" (case
// insensitive) is, by strong and standard convention, a template with no real values --
// distinct from ".env"/".env.local"/".env.production" etc, none of which end in ".example".
// This does NOT weaken the exclusion of real env-shaped files; it only stops the broad
// .env(\..*)? pattern above from also catching its own safe template variants.
const KNOWN_SAFE_TEMPLATE_SUFFIX = /\.example$/i;

// Minimal scaffolding a public export needs to be recognizable/buildable-looking.
// This is intentionally small: it is a sanity check, not a full manifest of every file.
const REQUIRED_PUBLIC_FILES = [
  "package.json",
  "tsconfig.json",
  "next.config.ts",
  "pnpm-workspace.yaml",
  "app/layout.tsx",
];

// package.json scripts that must remain callable in the exported package.json -- these are
// exactly the commands documented in the public README as the local dev workflow.
const REQUIRED_PUBLIC_SCRIPTS = ["dev", "build", "test", "lint", "cf:build"];

// Direct proof points requested by the task: none of these paths (or anything under a
// `/**` prefix) may appear in the exported file set, regardless of manifest edits.
const MUST_BE_ABSENT = [
  "scoring-engine/**",
  "lib/knowledge/adapters/basketball.ts",
  "lib/knowledge/adapters/mlb.ts",
  "lib/knowledge/sharp-matching.ts",
  "lib/knowledge/matching.ts",
  "lib/ai/explanation-adapter.ts",
  "lib/providers/request-policy.ts",
];

const SECRET_PATTERNS = [
  { name: "supabase-secret-key", regex: /sb_secret_[A-Za-z0-9_-]{10,}/g },
  { name: "supabase-publishable-key", regex: /sb_publishable_[A-Za-z0-9_-]{10,}/g },
  { name: "jwt-like-token", regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: "github-token", regex: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: "cloudflare-api-token-ish", regex: /\bcf_[A-Za-z0-9]{30,}\b/gi },
  {
    name: "generic-assigned-secret",
    regex: /\b[A-Z][A-Z0-9_]*(?:_KEY|_SECRET|_TOKEN|_PASSWORD)\s*[:=]\s*["'][A-Za-z0-9+/_.=-]{20,}["']/g,
  },
];

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot",
  ".pdf", ".zip", ".gz", ".mp4", ".mov",
]);

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

function gitTrackedFiles(repoRoot = REPO_ROOT) {
  const output = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" });
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

function isPrivatePattern(modulePath, patterns) {
  return patterns.some((pattern) => matchesPattern(modulePath, pattern));
}

function isDefaultExcluded(modulePath) {
  if (KNOWN_SAFE_TEMPLATE_SUFFIX.test(modulePath)) return false;
  return DEFAULT_EXTRA_EXCLUDE_PATTERNS.some((pattern) => pattern.test(modulePath));
}

const TEST_SUFFIX_PATTERN = /\.test\.(ts|tsx|js|jsx|mjs)$/;

function siblingTestPath(modulePath) {
  const extension = path.extname(modulePath);
  if (!extension || TEST_SUFFIX_PATTERN.test(modulePath)) return null;
  return `${modulePath.slice(0, -extension.length)}.test${extension}`;
}

export function planExport({ repoRoot = REPO_ROOT, manifest = loadManifest(), trackedFiles = gitTrackedFiles(repoRoot) } = {}) {
  const privatePatterns = manifest.privateOnly ?? [];
  const excluded = [];
  const included = [];

  for (const file of trackedFiles) {
    if (isPrivatePattern(file, privatePatterns) || isDefaultExcluded(file)) {
      excluded.push(file);
    } else {
      included.push(file);
    }
  }

  // A test file paired with an excluded module (foo.ts -> foo.test.ts) stays private
  // even if it wasn't itself named in the manifest, per the "paired private tests" rule.
  const trackedSet = new Set(trackedFiles);
  const includedSet = new Set(included);
  for (const file of [...excluded]) {
    const pairedTest = siblingTestPath(file);
    if (pairedTest && trackedSet.has(pairedTest) && includedSet.has(pairedTest)) {
      includedSet.delete(pairedTest);
      excluded.push(pairedTest);
    }
  }

  return { included: [...includedSet], excluded };
}

export function findImportClosureViolations({ repoRoot = REPO_ROOT, included, excluded, readFile = (filePath) => fs.readFileSync(filePath, "utf8") }) {
  const includedSet = new Set(included);
  const excludedSet = new Set(excluded);
  const violations = [];

  for (const file of included) {
    const extension = path.extname(file);
    if (!SOURCE_EXTENSIONS.has(extension)) continue;
    const absolutePath = path.join(repoRoot, file);
    if (!fs.existsSync(absolutePath)) continue;
    const source = readFile(absolutePath);
    for (const specifier of extractImportSpecifiers(source)) {
      const resolved = resolveImport(file, specifier, repoRoot);
      if (!resolved) continue;
      // Generated build output (.next/, .open-next/) is never git-tracked and is expected
      // to be absent from a fresh checkout until the consuming project runs its own build.
      if (resolved.startsWith(".next/") || resolved.startsWith(".open-next/")) continue;
      if (excludedSet.has(resolved)) {
        violations.push({ from: file, to: resolved, specifier, reason: "imports an excluded (private-only) module" });
      } else if (!includedSet.has(resolved) && fs.existsSync(path.join(repoRoot, resolved))) {
        violations.push({ from: file, to: resolved, specifier, reason: "imports a tracked module that is neither included nor excluded (unclassified gap)" });
      }
    }
  }

  return violations;
}

export function findMissingRequiredFiles(included) {
  const includedSet = new Set(included);
  return REQUIRED_PUBLIC_FILES.filter((file) => !includedSet.has(file));
}

export function findMustBeAbsentViolations(included) {
  return MUST_BE_ABSENT.filter((pattern) => included.some((file) => matchesPattern(file, pattern)));
}

/**
 * Deterministically drops any package.json script whose command references a file path that
 * is excluded from the export (e.g. `scoring-engine/wrangler.jsonc`, `scripts/run-covered-job.mjs`)
 * -- those scripts would fail purely because their implementation was intentionally left out,
 * not because of anything a public reader did. Also transitively drops any remaining script
 * that only exists to invoke an already-dropped script (`pnpm run <name>`), so nothing
 * advertises a command that can no longer do anything.
 */
export function planPackageJsonForExport({ packageJson, excludedFiles }) {
  const scripts = { ...(packageJson.scripts ?? {}) };
  const removedScripts = [];

  for (const [name, command] of Object.entries(scripts)) {
    if (excludedFiles.some((excludedPath) => command.includes(excludedPath))) {
      delete scripts[name];
      removedScripts.push(name);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, command] of Object.entries(scripts)) {
      const dependsOnRemoved = removedScripts.some((removedName) =>
        command.includes(`run ${removedName} `) || command.includes(`run ${removedName}"`) || command.endsWith(`run ${removedName}`) || command.includes(`run-script ${removedName}`));
      if (dependsOnRemoved) {
        delete scripts[name];
        removedScripts.push(name);
        changed = true;
      }
    }
  }

  return { packageJson: { ...packageJson, scripts }, removedScripts };
}

export function findMissingRequiredScripts(scripts) {
  return REQUIRED_PUBLIC_SCRIPTS.filter((name) => !scripts[name]);
}

export function scanForSecrets({ repoRoot = REPO_ROOT, included, readFile = (filePath) => fs.readFileSync(filePath, "utf8") }) {
  const findings = [];
  for (const file of included) {
    const extension = path.extname(file);
    if (BINARY_EXTENSIONS.has(extension)) continue;
    if (file === "pnpm-lock.yaml") continue;
    const absolutePath = path.join(repoRoot, file);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
    let source;
    try {
      source = readFile(absolutePath);
    } catch {
      continue;
    }
    for (const { name, regex } of SECRET_PATTERNS) {
      const matches = source.match(regex);
      if (matches?.length) findings.push({ file, pattern: name, count: matches.length });
    }
  }
  return findings;
}

export function auditPublicExport({ repoRoot = REPO_ROOT, manifest = loadManifest(), trackedFiles = gitTrackedFiles(repoRoot) } = {}) {
  const { included, excluded } = planExport({ repoRoot, manifest, trackedFiles });
  const importViolations = findImportClosureViolations({ repoRoot, included, excluded });
  const missingRequiredFiles = findMissingRequiredFiles(included);
  const mustBeAbsentViolations = findMustBeAbsentViolations(included);
  const secretFindings = scanForSecrets({ repoRoot, included });

  let removedScripts = [];
  let missingRequiredScripts = [];
  let finalScripts = {};
  const packageJsonPath = path.join(repoRoot, "package.json");
  if (included.includes("package.json") && fs.existsSync(packageJsonPath)) {
    const sourcePackageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const transformed = planPackageJsonForExport({ packageJson: sourcePackageJson, excludedFiles: excluded });
    removedScripts = transformed.removedScripts;
    finalScripts = transformed.packageJson.scripts ?? {};
    missingRequiredScripts = findMissingRequiredScripts(finalScripts);
  }

  const ok = importViolations.length === 0
    && missingRequiredFiles.length === 0
    && mustBeAbsentViolations.length === 0
    && secretFindings.length === 0
    && missingRequiredScripts.length === 0;

  return {
    ok,
    counts: { includedFiles: included.length, excludedFiles: excluded.length },
    included,
    excluded,
    importViolations,
    missingRequiredFiles,
    mustBeAbsentViolations,
    secretFindings,
    removedScripts,
    missingRequiredScripts,
    finalScripts,
  };
}

export function formatAuditReport(report) {
  const lines = [
    `Public export audit (dry run — no files copied, no repository created)`,
    `Included files: ${report.counts.includedFiles}`,
    `Excluded files: ${report.counts.excludedFiles}`,
    `Import-closure violations: ${report.importViolations.length}`,
    `Missing required public files: ${report.missingRequiredFiles.length}`,
    `Must-be-absent violations: ${report.mustBeAbsentViolations.length}`,
    `Possible secret findings: ${report.secretFindings.length}`,
    `package.json scripts removed (referenced excluded files): ${report.removedScripts?.length ?? 0}`,
    `Missing required public scripts: ${report.missingRequiredScripts?.length ?? 0}`,
    `Overall: ${report.ok ? "PASS" : "FAIL"}`,
    "",
  ];
  for (const violation of report.importViolations) {
    lines.push(`IMPORT-VIOLATION ${violation.from} -> ${violation.to} (${violation.reason})`);
  }
  for (const file of report.missingRequiredFiles) {
    lines.push(`MISSING-REQUIRED ${file}`);
  }
  for (const pattern of report.mustBeAbsentViolations) {
    lines.push(`MUST-BE-ABSENT-VIOLATION ${pattern}`);
  }
  for (const finding of report.secretFindings) {
    lines.push(`SECRET-PATTERN ${finding.pattern} in ${finding.file} (${finding.count} match(es); value not printed)`);
  }
  for (const name of report.removedScripts ?? []) {
    lines.push(`SCRIPT-REMOVED ${name}`);
  }
  for (const name of report.missingRequiredScripts ?? []) {
    lines.push(`MISSING-REQUIRED-SCRIPT ${name}`);
  }
  return lines.join("\n");
}

export function copyExportTree({ repoRoot = REPO_ROOT, included, excluded = [], outDir }) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const file of included) {
    const source = path.join(repoRoot, file);
    const destination = path.join(outDir, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (file === "package.json") {
      const sourcePackageJson = JSON.parse(fs.readFileSync(source, "utf8"));
      const { packageJson } = planPackageJsonForExport({ packageJson: sourcePackageJson, excludedFiles: excluded });
      fs.writeFileSync(destination, `${JSON.stringify(packageJson, null, 2)}\n`);
      continue;
    }
    fs.copyFileSync(source, destination);
  }
  return { outDir, fileCount: included.length };
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const outDirArg = args.find((arg) => arg.startsWith("--out="));
  const outDir = outDirArg ? path.resolve(outDirArg.slice("--out=".length)) : DEFAULT_OUTPUT_DIR;

  const report = auditPublicExport();
  const text = formatAuditReport(report);
  console.log(text);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, "report.txt"), text);

  if (write) {
    const { fileCount } = copyExportTree({ included: report.included, excluded: report.excluded, outDir: path.join(outDir, "tree") });
    console.log(`\nCopied ${fileCount} files to ${path.join(outDir, "tree")} (local only; no .git, no remote).`);
  } else {
    console.log(`\nDry run only. Pass --write to copy the included files into ${path.join(outDir, "tree")}.`);
  }

  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
