// Local, private, SYNTHETIC-ONLY Statcast-shaped fixture contract.
//
// Owner-authorized scope (2026-07-31): a technical prototype only, using
// small synthetic or already-repository-contained fixture data. This module
// NEVER calls Baseball Savant, Statcast, pybaseball, or any other provider,
// never downloads live or historical data, and defines no HTTP client, no
// credentials, and no production entry point. It exists to answer one
// question: CAN the four unresolved MLB fields (handedness, K-rate, whiff
// rate, hard-hit rate, xwOBA) be normalized into exactly what the real
// scoring adapter already consumes, using a bounded, deterministic,
// identity-verified shape? See docs/AGENT_HANDOFF.md Session 89 for the
// full technical/source conclusion and the single recommendation.
//
// This file is intentionally NOT imported by any production code path,
// public API route, or snapshot builder. It is a standalone prototype
// module, exercised only by its own test file.

export type StatcastFixtureRole = "batter" | "pitcher";
export type StatcastFixtureHandedness = "L" | "R" | "S"; // stand (batter) or throws (pitcher); "S" = switch-hitter

export type StatcastFixtureCompletenessState =
  | "complete"
  | "unavailable"
  | "insufficient_sample"
  | "stale"
  | "ambiguous_identity"
  | "contradictory";

export type StatcastFixtureRow = {
  /** Always this literal -- never a real provider name. Marks every row as synthetic prototype data, not live source data. */
  provenance: "statcast-fixture-prototype";
  /** Must resolve to an existing Covered players.id via the repository's own identity resolution -- this module never invents an identity. */
  canonicalPlayerId: string;
  /** The event this sample window is being evaluated for -- used only for identity/scope checks, never as a live join key. */
  canonicalEventId: string;
  canonicalTeamId: string;
  role: StatcastFixtureRole;
  handedness: StatcastFixtureHandedness | null;
  sampleWindow: { startDate: string; endDate: string };
  /** Bounded, small list of source game identifiers contributing to this window -- for traceability/dedup checks, not a live API reference. */
  sourceGameIds: string[];
  /** Denominator for every rate below. 0 is a legitimate value (a real, complete count of zero qualifying events in the window) distinct from null (never measured / population unavailable). */
  plateAppearancesOrBattersFaced: number | null;
  strikeouts: number | null;
  swings: number | null;
  whiffs: number | null;
  battedBalls: number | null;
  hardHitBattedBalls: number | null;
  /** Precomputed only -- Baseball Savant's own xwOBA model weighting is not publicly documented (Session 88 finding), so this prototype never attempts to derive xwOBA from raw components; a row either carries a precomputed value or is null. */
  xwoba: number | null;
  fetchedAt: string;
  completenessState: StatcastFixtureCompletenessState;
};

export type StatcastFixtureValidationResult = {
  valid: boolean;
  reasons: string[];
};

/**
 * Rejects incomplete or internally contradictory rows. This is the fixture
 * contract's own integrity check -- independent of, and prior to, whatever
 * the real scoring adapter would separately require.
 */
export function validateStatcastFixtureRow(row: StatcastFixtureRow): StatcastFixtureValidationResult {
  const reasons: string[] = [];

  if (row.provenance !== "statcast-fixture-prototype") {
    reasons.push("provenance must be the synthetic-prototype literal -- this contract never represents real source data.");
  }
  if (!row.canonicalPlayerId) reasons.push("canonicalPlayerId is required.");
  if (!row.canonicalEventId) reasons.push("canonicalEventId is required.");
  if (!row.canonicalTeamId) reasons.push("canonicalTeamId is required.");
  if (new Date(row.sampleWindow.startDate).getTime() > new Date(row.sampleWindow.endDate).getTime()) {
    reasons.push("sampleWindow.startDate must not be after endDate.");
  }
  if (row.role === "pitcher" && row.handedness !== null && row.handedness === "S") {
    reasons.push("a pitcher cannot be a switch (\"S\") thrower -- contradictory handedness for this role.");
  }

  // The required invariant: a row claiming completeness must have a real,
  // non-negative denominator, and every numerator must be within [0, denominator]
  // where that comparison applies. A row cannot claim "complete" while its own
  // counts are internally contradictory (e.g. more whiffs than swings).
  const denominator = row.plateAppearancesOrBattersFaced;
  if (row.completenessState === "complete") {
    if (denominator === null) reasons.push("completenessState=complete requires a non-null plateAppearancesOrBattersFaced.");
    if (denominator !== null && denominator < 0) reasons.push("plateAppearancesOrBattersFaced cannot be negative.");
    if (row.swings !== null && row.whiffs !== null && row.whiffs > row.swings) {
      reasons.push("whiffs cannot exceed swings -- contradictory sample.");
    }
    if (row.battedBalls !== null && row.hardHitBattedBalls !== null && row.hardHitBattedBalls > row.battedBalls) {
      reasons.push("hardHitBattedBalls cannot exceed battedBalls -- contradictory sample.");
    }
    if (denominator !== null && row.strikeouts !== null && row.strikeouts > denominator) {
      reasons.push("strikeouts cannot exceed plateAppearancesOrBattersFaced -- contradictory sample.");
    }
  }

  // "Unavailable" must mean genuinely no population was ever observed -- if
  // completenessState says unavailable but the row is carrying real counts,
  // that is itself a contradiction (either the state or the data is wrong).
  if (row.completenessState === "unavailable" && (denominator !== null || row.xwoba !== null)) {
    reasons.push("completenessState=unavailable must not carry a real denominator or xwOBA value -- contradicts the declared state.");
  }

  return { valid: reasons.length === 0, reasons };
}
