import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "docs/public-repo-boundary.json");

const IMPORT_PATTERN = /(?:import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+|)|export\s+(?:type\s+)?[\s\S]*?\s+from\s+|import\s*\()(['"])([^'"\n]+)\1/g;
const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"];

export function loadManifest(manifestPath = MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

export function matchesPattern(modulePath, pattern) {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3).replace(/\/$/, "");
    return modulePath === prefix || modulePath.startsWith(`${prefix}/`);
  }
  return modulePath === pattern;
}

export function classifyModule(modulePath, manifest) {
  for (const pattern of manifest.privateOnly ?? []) {
    if (matchesPattern(modulePath, pattern)) return "private-only";
  }
  for (const pattern of manifest.publicSafe ?? []) {
    if (matchesPattern(modulePath, pattern)) return "public-safe";
  }
  for (const pattern of manifest.conditional ?? []) {
    if (matchesPattern(modulePath, pattern)) return "conditional";
  }
  return "unclassified";
}

export function extractImportSpecifiers(source) {
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[2]);
}

const defaultFileExists = (filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile();

function existingModulePath(candidate, fileExists) {
  for (const extension of SOURCE_EXTENSIONS) {
    const fileCandidate = `${candidate}${extension}`;
    if (fileExists(fileCandidate)) return fileCandidate;
  }
  for (const extension of SOURCE_EXTENSIONS.slice(1)) {
    const indexCandidate = path.join(candidate, `index${extension}`);
    if (fileExists(indexCandidate)) return indexCandidate;
  }
  return null;
}

/**
 * fileExists defaults to the real filesystem, but is injectable so tests can prove
 * classification/violation-detection logic without a real file on disk -- necessary
 * because a privateOnly fixture (by definition) never exists in a public export copy,
 * so a test relying on the real filesystem can never be made to pass there.
 */
export function resolveImport(sourcePath, specifier, repoRoot = REPO_ROOT, fileExists = defaultFileExists) {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return null;
  const base = specifier.startsWith("@/")
    ? path.join(repoRoot, specifier.slice(2))
    : path.resolve(path.dirname(path.join(repoRoot, sourcePath)), specifier);
  const resolved = existingModulePath(base, fileExists);
  return resolved ? path.relative(repoRoot, resolved).split(path.sep).join("/") : null;
}

export function inspectSource(sourcePath, source, manifest, repoRoot = REPO_ROOT, fileExists = defaultFileExists) {
  const sourceClass = classifyModule(sourcePath, manifest);
  const imports = extractImportSpecifiers(source)
    .map((specifier) => ({
      specifier,
      resolved: resolveImport(sourcePath, specifier, repoRoot, fileExists),
    }))
    .filter((entry) => entry.resolved);
  const violations = sourceClass === "public-safe"
    ? imports
      .filter((entry) => classifyModule(entry.resolved, manifest) === "private-only")
      .map((entry) => ({ from: sourcePath, to: entry.resolved, specifier: entry.specifier }))
    : [];
  return { source: sourcePath, classification: sourceClass, imports, violations };
}

export function auditBoundary({ repoRoot = REPO_ROOT, manifest = loadManifest(), readFile = (filePath) => fs.readFileSync(filePath, "utf8") } = {}) {
  const publicModules = manifest.publicSafe ?? [];
  const reports = [];
  const missingPublicSafe = [];
  const missingConditional = [];

  for (const modulePath of publicModules) {
    const absolutePath = path.join(repoRoot, modulePath);
    if (!fs.existsSync(absolutePath)) {
      missingPublicSafe.push(modulePath);
      continue;
    }
    reports.push(inspectSource(modulePath, readFile(absolutePath), manifest, repoRoot));
  }

  for (const modulePath of manifest.conditional ?? []) {
    if (!fs.existsSync(path.join(repoRoot, modulePath))) missingConditional.push(modulePath);
  }

  const violations = reports.flatMap((report) => report.violations);
  return {
    manifest: path.relative(repoRoot, MANIFEST_PATH).split(path.sep).join("/"),
    publicSafe: reports.map((report) => report.source),
    conditional: (manifest.conditional ?? []).map((modulePath) => ({
      module: modulePath,
      exists: !missingConditional.includes(modulePath),
    })),
    missingPublicSafe,
    missingConditional,
    violations,
  };
}

export function formatReport(report) {
  const lines = [
    `public-safe modules checked: ${report.publicSafe.length}`,
    `private-boundary violations: ${report.violations.length}`,
    `conditional modules reported: ${report.conditional.length}`,
  ];
  if (report.missingPublicSafe.length) lines.push(`missing public-safe modules: ${report.missingPublicSafe.join(", ")}`);
  if (report.missingConditional.length) lines.push(`missing conditional modules: ${report.missingConditional.join(", ")}`);
  for (const violation of report.violations) lines.push(`VIOLATION ${violation.from} -> ${violation.to}`);
  for (const conditional of report.conditional) lines.push(`CONDITIONAL ${conditional.module} (${conditional.exists ? "present" : "missing"})`);
  return lines.join("\n");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const report = auditBoundary();
  console.log(formatReport(report));
  if (report.missingPublicSafe.length || report.violations.length) process.exitCode = 1;
}
