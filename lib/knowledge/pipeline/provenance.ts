// Per-prop readiness state and the scoring-provenance record persisted with each
// valid score. Provenance makes historical grading stable: a published pick
// stays associated with the scoring model + enrichment contract + feature
// timestamps that existed WHEN it was published, so newly changed features never
// silently reinterpret old recommendations.
//
// Dependency-free (pure types + helpers).

import type { MissingCause } from "./stage-result.ts";

// The single readiness state every active prop ends in (owner terminology).
export type ReadinessState =
  | "score_ready" //   all required applicable fields present + fresh -> valid score
  | "score_limited" // only contract-approved fields genuinely provider-absent (proven) -> valid score, flagged limited
  | "score_blocked"; //required context missing/stale for a pipeline reason -> NO normal valid score

// One classified blocker/absence attached to a prop.
export type FieldStatus = {
  field: string;
  present: boolean;
  fresh: boolean;
  cause?: MissingCause; // set when not present-and-fresh
};

export type ProvenanceCompleteness = {
  state: ReadinessState;
  // fields that are genuinely provider-absent (proven) and allowed by contract.
  allowedProviderAbsent: string[];
  // classified blockers that make a prop score_blocked.
  blockers: Array<{ field: string; cause: MissingCause }>;
  // per-field status snapshot for audit.
  fields: FieldStatus[];
};

export type ScoringProvenance = {
  runId: string;
  scoringModelVersion: string; // opaque version id, never the formula
  contractVersion: string;
  featureTimestamp: string | null; // newest feature timestamp used
  sourceFreshness: Record<string, string | null>; // source -> newest timestamp used
  completenessState: ReadinessState;
  allowedProviderAbsentFields: string[];
  blockers: Array<{ field: string; cause: MissingCause }>;
  scoredAt: string;
};

// Derive the readiness state from a prop's per-field statuses + which absences
// are proven-and-permitted. Rules:
// - any hard-required field missing/stale for a PIPELINE cause -> score_blocked
// - only proven provider_absent (contract-permitted) absences remain -> score_limited
// - everything present + fresh -> score_ready
export function deriveReadiness(input: {
  fields: FieldStatus[];
  hardRequiredFields: Set<string>;
  provenAbsentFields: Set<string>; // fields proven provider_absent AND permitted
}): { state: ReadinessState; blockers: Array<{ field: string; cause: MissingCause }>; allowedProviderAbsent: string[] } {
  const blockers: Array<{ field: string; cause: MissingCause }> = [];
  const allowedProviderAbsent: string[] = [];

  for (const f of input.fields) {
    if (f.present && f.fresh) continue;
    // not present-and-fresh
    if (input.provenAbsentFields.has(f.field) && f.cause === "provider_absent") {
      allowedProviderAbsent.push(f.field);
      continue;
    }
    if (input.hardRequiredFields.has(f.field)) {
      blockers.push({ field: f.field, cause: f.cause ?? "enrichment_error" });
    }
    // soft, not-proven-absent fields are penalized in scoring but never block.
  }

  const state: ReadinessState = blockers.length > 0
    ? "score_blocked"
    : allowedProviderAbsent.length > 0
      ? "score_limited"
      : "score_ready";

  return { state, blockers, allowedProviderAbsent };
}
