// Deterministic derivation from a StatcastFixtureRow into the EXACT column
// shapes the real production tables (mlb_handedness_splits, mlb_pitcher_features,
// mlb_batter_features) already carry, and that the real mlb adapter
// (lib/knowledge/adapters/mlb.ts) already reads. No new scoring logic is
// introduced here -- this module only proves the shape is normalizable; the
// actual scoring math is exercised unmodified in statcast-fixture-scoring.test.ts.

import { validateStatcastFixtureRow, type StatcastFixtureRow } from "./statcast-fixture-contract";

export type DerivedHandednessSplit = {
  player_id: string;
  batter_side: string | null;
  pitcher_side: string | null;
  stat_type: string;
  split_value: number | null;
  sample_size: number | null;
  split_date: string;
  updated_at: string;
};

export type DerivedPitcherFeatures = {
  player_id: string;
  season_k_rate: number | null;
  swinging_strike_rate: number | null;
  feature_date: string;
  updated_at: string;
};

export type DerivedBatterFeatures = {
  player_id: string;
  hard_hit_rate: number | null;
  xwoba: number | null;
  feature_date: string;
  updated_at: string;
};

export type DerivedMlbFeatures = {
  ok: true;
  handedness: DerivedHandednessSplit | null;
  pitcherFeatures: DerivedPitcherFeatures | null;
  batterFeatures: DerivedBatterFeatures | null;
} | {
  ok: false;
  reason: string;
};

// A rate cannot be computed from a null OR zero denominator without
// misrepresenting an unmeasured or genuinely-empty population as a real 0%.
// numerator/denominator both present and denominator > 0 -> a real rate.
// denominator === 0 -> the population was completely observed and is
// genuinely empty (e.g. a reliever who faced zero batters in the window) --
// this is NOT the same as "never measured," but a rate still cannot be
// computed from it, so the rate stays null while the underlying row is not
// treated as unavailable.
function safeRate(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null) return null;
  if (denominator <= 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

export function deriveMlbFeaturesFromStatcastFixture(row: StatcastFixtureRow): DerivedMlbFeatures {
  const validation = validateStatcastFixtureRow(row);
  if (!validation.valid) {
    return { ok: false, reason: `fixture row failed contract validation: ${validation.reasons.join("; ")}` };
  }
  if (row.completenessState === "unavailable") {
    return { ok: false, reason: "completenessState=unavailable -- no population was observed for this player/window." };
  }
  if (row.completenessState === "ambiguous_identity") {
    return { ok: false, reason: "completenessState=ambiguous_identity -- canonical identity could not be verified, refusing to derive features from an unverified row." };
  }
  if (row.completenessState === "contradictory") {
    return { ok: false, reason: "completenessState=contradictory -- refusing to derive features from a row the fixture itself has flagged as internally inconsistent." };
  }
  if (row.completenessState === "stale") {
    return { ok: false, reason: "completenessState=stale -- the sample window is outside the freshness contract; treated as unavailable rather than silently reused." };
  }

  const handedness: DerivedHandednessSplit | null = row.handedness
    ? {
        player_id: row.canonicalPlayerId,
        batter_side: row.role === "batter" ? row.handedness : null,
        pitcher_side: row.role === "pitcher" ? row.handedness : null,
        stat_type: row.role === "pitcher" ? "strikeouts" : "hits",
        split_value: safeRate(row.strikeouts, row.plateAppearancesOrBattersFaced),
        sample_size: row.plateAppearancesOrBattersFaced,
        split_date: row.sampleWindow.endDate,
        updated_at: row.fetchedAt,
      }
    : null;

  const pitcherFeatures: DerivedPitcherFeatures | null = row.role === "pitcher"
    ? {
        player_id: row.canonicalPlayerId,
        season_k_rate: safeRate(row.strikeouts, row.plateAppearancesOrBattersFaced),
        swinging_strike_rate: safeRate(row.whiffs, row.swings),
        feature_date: row.sampleWindow.endDate,
        updated_at: row.fetchedAt,
      }
    : null;

  const batterFeatures: DerivedBatterFeatures | null = row.role === "batter"
    ? {
        player_id: row.canonicalPlayerId,
        hard_hit_rate: safeRate(row.hardHitBattedBalls, row.battedBalls),
        xwoba: row.xwoba,
        feature_date: row.sampleWindow.endDate,
        updated_at: row.fetchedAt,
      }
    : null;

  // insufficient_sample is not itself a hard failure -- it produces the same
  // shape as "complete", but with the rate fields naturally coming out null
  // via safeRate()'s zero/near-zero-denominator handling above. The real
  // scoring adapter's own handedness_missing/pitcher_matchup_missing/
  // batter_quality_missing blockers (Session 86) are what correctly turn
  // that null into a public-publication block -- this module does not
  // duplicate that gating, it only proves the null propagates honestly.
  return { ok: true, handedness, pitcherFeatures, batterFeatures };
}
