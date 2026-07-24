// The Covered Picks board hard invariant: only valid, publishable props with
// covered_score >= 70, highest score first, deterministically deduplicated.
// Enforced independently at every boundary (snapshot build, pre-publication
// validation, API, frontend) so "nothing below 70 ever appears" is structural,
// not a display default. If fewer than the target qualify, fewer are published -
// the floor is never lowered to fill the board.
//
// Dependency-free (pure).

export const COVERED_PICKS_MIN_SCORE = 70;

// Clamp a requested minimum to the hard floor - the board floor can never be
// lowered below 70 by an API param or UI control, only raised.
export function clampCoveredPicksFloor(requested: number | null | undefined, floor = COVERED_PICKS_MIN_SCORE): number {
  if (requested == null || !Number.isFinite(requested)) return floor;
  return Math.max(requested, floor);
}

// Filter to >= floor, sort highest score first, and deduplicate by a stable key
// (deterministic: on a score tie the first-seen key wins after the sort, and the
// sort itself is stable by key). Rows with a null/non-finite score are excluded
// (an incomplete/blocked prop never appears on the board).
export function enforceCoveredPicksFloor<T>(
  rows: T[],
  getScore: (row: T) => number | null | undefined,
  getKey: (row: T) => string,
  floor = COVERED_PICKS_MIN_SCORE,
): T[] {
  const eligible = rows.filter((r) => {
    const s = getScore(r);
    return typeof s === "number" && Number.isFinite(s) && s >= floor;
  });
  const keyOf = (row: T) => String(getKey(row) ?? "");
  eligible.sort((a, b) => {
    const sa = getScore(a) as number;
    const sb = getScore(b) as number;
    if (sb !== sa) return sb - sa; // highest first
    return keyOf(a).localeCompare(keyOf(b)); // deterministic tiebreak
  });
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of eligible) {
    const key = keyOf(r);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(r);
  }
  return out;
}

export type BoardFloorValidation = { ok: boolean; offending: number; belowFloorScores: number[] };

// Reject a would-be snapshot that contains ANY row below the floor (or a null
// score). Used as the pre-publication gate: on failure the caller retains the
// prior good snapshot instead of publishing.
export function validateCoveredPicksFloor<T>(
  rows: T[],
  getScore: (row: T) => number | null | undefined,
  floor = COVERED_PICKS_MIN_SCORE,
): BoardFloorValidation {
  const below: number[] = [];
  for (const r of rows) {
    const s = getScore(r);
    if (typeof s !== "number" || !Number.isFinite(s) || s < floor) {
      below.push(typeof s === "number" ? s : NaN);
    }
  }
  return { ok: below.length === 0, offending: below.length, belowFloorScores: below };
}

// Frontend score-filter options: only the floor and higher. Never offers a value
// below the board floor, so the UI cannot request a sub-floor board.
export function coveredPicksScoreFilterOptions(floor = COVERED_PICKS_MIN_SCORE): number[] {
  const options = [floor, 80, 90];
  return [...new Set(options.filter((v) => v >= floor))].sort((a, b) => a - b);
}
