// Boundary validation: validate provider formats, required columns, id types,
// date formats, and database write shapes BEFORE they enter the pipeline or hit
// the database. This is where "the data came back in a shape the code didn't
// handle" (ZSTD threw; mlb_weather.game_id: null hit a NOT NULL constraint) is
// caught and classified instead of throwing deep or writing garbage.
//
// Also home of the provider-absent proof standard: `provider_absent` is only
// valid with recorded evidence; everything else is a pipeline failure.
//
// Dependency-free (pure validators).

import type { MissingCause } from "./stage-result.ts";
import type { FieldContract } from "./field-contracts.ts";

export type ValidationIssue = { path: string; message: string; cause: MissingCause };
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

export function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}
export function invalid<T>(issues: ValidationIssue[]): ValidationResult<T> {
  return { ok: false, issues };
}

// Required-column check for a parsed provider row (e.g. a parquet/JSON record).
// Missing required columns => ingestion_missing (an omitted/renamed upstream
// column), NOT provider absence.
export function requireColumns<T extends Record<string, unknown>>(
  row: T,
  columns: string[],
  path = "row",
): ValidationResult<T> {
  const issues: ValidationIssue[] = [];
  for (const col of columns) {
    if (!(col in row) || row[col] === undefined) {
      issues.push({ path: `${path}.${col}`, message: `required column "${col}" is missing`, cause: "ingestion_missing" });
    }
  }
  return issues.length ? invalid(issues) : ok(row);
}

// A parsed id must be a finite number or a non-empty string. hyparquet returns
// INT32 columns as `number` and INT64 as `bigint`; both are acceptable ids as
// long as they stringify to a non-empty token. A null/empty id after a
// successful parse is a join/identity problem, not provider absence.
export function validateId(value: unknown, path: string): ValidationResult<string> {
  if (typeof value === "number" && Number.isFinite(value)) return ok(String(value));
  if (typeof value === "bigint") return ok(String(value));
  if (typeof value === "string" && value.trim().length > 0) return ok(value.trim());
  return invalid([{ path, message: `invalid id: ${String(value)}`, cause: "join_failed" }]);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
export function validateDate(value: unknown, path: string): ValidationResult<string> {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return ok(value.toISOString());
  if (typeof value === "string" && (ISO_DATE.test(value) || Number.isFinite(Date.parse(value)))) return ok(value);
  return invalid([{ path, message: `invalid date: ${String(value)}`, cause: "validation_rejected" }]);
}

// Validate a row about to be written against the table's NOT NULL columns, so a
// null-in-not-null write (the mlb_weather.game_id: null / 23502 defect) is
// caught and classified BEFORE the DB rejects it deep in a substage.
export function validateWriteShape<T extends Record<string, unknown>>(
  row: T,
  notNullColumns: string[],
  table: string,
): ValidationResult<T> {
  const issues: ValidationIssue[] = [];
  for (const col of notNullColumns) {
    if (row[col] === null || row[col] === undefined) {
      issues.push({ path: `${table}.${col}`, message: `NOT NULL column "${col}" is null/undefined in write`, cause: "validation_rejected" });
    }
  }
  return issues.length ? invalid(issues) : ok(row);
}

// ---- Provider-absent proof standard ----
//
// Records one attempt against one source for one field, for one exact target.
export type SourceAttempt = {
  source: string;
  requestOk: boolean; // did the request complete without a transport/parse error?
  queriedCorrectTarget: boolean; // player + event + team + date window correct?
  returnedApplicableValue: boolean; // did the source return a usable value?
  errorKind?: "request_failed" | "parse_failed" | "stale" | "bad_join" | "missing_mapping" | "unsupported_format";
};

export type AbsenceClassification =
  | { classified: "provider_absent"; evidence: { field: string; attempts: SourceAttempt[] } }
  | { classified: Exclude<MissingCause, "provider_absent">; reason: string };

// Classify why a field has no value. Returns `provider_absent` ONLY when the
// full proof standard is met: identity resolved, every configured/approved
// source attempted, each request completed successfully against the correct
// target, none returned an applicable value, and the field's contract permits
// absence. Any request/parse/stale/join/mapping/format problem is the
// corresponding pipeline failure instead.
export function classifyAbsence(input: {
  field: string;
  contract: Pick<FieldContract, "sourcePriority" | "fallbackSources" | "absencePermitted" | "pipelineFailureCause">;
  identityResolved: boolean;
  attempts: SourceAttempt[];
}): AbsenceClassification {
  const { field, contract, identityResolved, attempts } = input;

  if (!identityResolved) {
    return { classified: "identity_failed", reason: "identity must be resolved before a field can be proven provider-absent" };
  }

  // Any attempt that failed for a pipeline reason wins classification - absence
  // cannot be proven while a pipeline fault is present.
  for (const a of attempts) {
    if (!a.requestOk) return { classified: mapErrorKind(a.errorKind, "enrichment_error"), reason: `${a.source}: request did not complete` };
    if (!a.queriedCorrectTarget) return { classified: "join_failed", reason: `${a.source}: wrong target (player/event/team/date)` };
    if (a.errorKind === "stale") return { classified: "stale", reason: `${a.source}: returned stale data` };
    if (a.errorKind) return { classified: mapErrorKind(a.errorKind, "enrichment_error"), reason: `${a.source}: ${a.errorKind}` };
  }

  const configuredSources = new Set([...contract.sourcePriority, ...contract.fallbackSources]);
  const attemptedSources = new Set(attempts.map((a) => a.source));
  const allAttempted = [...configuredSources].every((s) => attemptedSources.has(s));
  if (!allAttempted) {
    return { classified: "enrichment_error", reason: `not every configured source was attempted for "${field}"` };
  }

  const anyApplicable = attempts.some((a) => a.returnedApplicableValue);
  if (anyApplicable) {
    return { classified: "join_failed", reason: `a source returned a value for "${field}" but it was not joined` };
  }

  if (!contract.absencePermitted) {
    return { classified: contract.pipelineFailureCause, reason: `"${field}" contract does not permit provider absence` };
  }

  return { classified: "provider_absent", evidence: { field, attempts } };
}

function mapErrorKind(kind: SourceAttempt["errorKind"], fallback: Exclude<MissingCause, "provider_absent">): Exclude<MissingCause, "provider_absent"> {
  switch (kind) {
    case "request_failed": return "enrichment_error";
    case "parse_failed": return "validation_rejected";
    case "stale": return "stale";
    case "bad_join": return "join_failed";
    case "missing_mapping": return "join_failed";
    case "unsupported_format": return "validation_rejected";
    default: return fallback;
  }
}
