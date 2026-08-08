/**
 * Session 99 (owner-directed): the ONE shared constant identifying the
 * current strict-completeness eligibility contract -- shared by BOTH layers
 * that need to agree on it:
 *
 * 1. The SNAPSHOT envelope layer (lib/knowledge/public-snapshot-types.ts /
 *    public-snapshots.ts, added Session 98): stamps/rejects whole cached
 *    snapshot payloads.
 * 2. The SCORE-ROW layer (this session): stamps/rejects individual
 *    `score_inputs.feature_payload.scoreEligibilityContractVersion` values,
 *    independent of whatever snapshot envelope a row is later copied into.
 *
 * Session 98's snapshot-envelope guard alone was insufficient: it proved a
 * SNAPSHOT was freshly built under strict-v1, but said nothing about whether
 * each individual SCORE ROW copied into that snapshot had itself ever been
 * evaluated under strict-v1's blocker set. A score row computed months ago
 * under a weaker rule set, never rescored since, can still carry
 * `publishable: true` with empty `publishability_reasons` -- and a freshly
 * built, correctly-stamped `strict-v1` snapshot will faithfully copy that
 * stale, never-revalidated decision in, because nothing checked the ROW
 * itself. Real production example (2026-08-01, Payton Tolle, MLB
 * pitcher_strikeouts): scored under the live pin's 9-blocker rule set,
 * missing pitcher-matchup and ballpark context the candidate's 21-blocker
 * rule set requires, yet still `publishable: true` with empty reasons,
 * surfaced live in a snapshot correctly stamped `eligibilityContractVersion:
 * "strict-v1"` at the ENVELOPE level.
 *
 * Both constants share this ONE value and this ONE module so bumping the
 * blocker set in scoring-service.ts and updating this string keeps every
 * enforcement point (snapshot envelope AND score row) in sync automatically
 * -- there is deliberately no second, independently-versioned constant.
 *
 * Bump this string ONLY when scoring-service.ts's blocker set changes in a
 * way that could make a previously-eligible row now ineligible (or vice
 * versa) -- e.g. adding/removing a `blockers.add(...)` call in
 * `publishabilityAssessment`. A schema-only change does NOT require bumping
 * this.
 */
export const STRICT_ELIGIBILITY_CONTRACT_VERSION = "strict-v1" as const;
