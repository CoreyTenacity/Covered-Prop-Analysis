/**
 * Phase 18 (continuation) owner policy #1: hard current-market freshness.
 *
 * A prop must have a *provably current* provider observation, not merely be
 * active and attached to a future event. The ONLY authoritative observation
 * timestamp is `odds_snapshots.pulled_at`, reached via
 * current_props.latest_snapshot_id.
 *
 * CORRECTION (production run 31129018935, live evidence): current_props.
 * updated_at is NOT a safe proxy for pulled_at, despite both being set on the
 * same isMeaningfulChange upsert in sharp-odds-ingestion. updated_at is a
 * generic row-mutation timestamp that OTHER writers also bump for reasons
 * that have nothing to do with a genuine new price observation --
 * repairSharpCurrentPropIdentities (identity-only repair: player_id/
 * participant_id/team_id/match_status/match_confidence) is the proven
 * example: it stamps a fresh updated_at while leaving latest_snapshot_id
 * untouched, which let an hours-stale Kelsey Mitchell prop pass this exact
 * gate. latest_snapshot_id, by contrast, is set ONLY inside
 * ingestSharpApiMarketCandidates on a genuine isMeaningfulChange price/line
 * observation -- no other current_props writer touches it. All freshness
 * reads in read-service.ts now resolve pulled_at via latest_snapshot_id
 * (loadOddsSnapshotPulledAt) instead of reading updated_at directly.
 *
 * Threshold derivation (evidence, not invented): the live market-observation
 * pipeline (`covered-live-pipeline`) runs every 30 minutes (a cron of
 * "slash-30" minutes in .github/workflows/covered-live-pipeline.yml). The existing
 * per-league odds-staleness thresholds already encoded in the scoring
 * adapters -- WNBA/NBA 180 min, MLB 240 min -- represent 6 and 8 missed
 * 30-minute cycles respectively. This module reuses exactly those numbers,
 * promoting them from the adapters' SOFT `stale_odds` risk flag to a HARD
 * eligibility gate, so a prop cannot remain eligible through multiple missed
 * expected refresh cycles.
 *
 * DOCUMENTED SCHEMA LIMITATION (owner decision, not implemented -- no
 * migration): neither pulled_at nor updated_at advances on a *no-op*
 * re-observation (isMeaningfulChange gates both). So a genuinely-stable line
 * that is still being observed every cycle but has not CHANGED will, past the
 * threshold, be conservatively classified `stale` and blocked. That is the
 * intended conservative behavior ("when currency cannot be proven, block"),
 * but a true "observed-but-unchanged" distinction would require a new
 * always-bumped last_observed_at column (a migration), flagged for the owner.
 */

export const MARKET_FRESHNESS_MAX_AGE_MINUTES: Record<string, number> = {
  mlb: 240,
  nba: 180,
  wnba: 180,
};

// Conservative default for any league not explicitly listed: the stricter
// (smaller) of the known windows, so an unknown league never gets a MORE
// lenient gate than a known one.
const DEFAULT_MAX_AGE_MINUTES = 180;

export function marketFreshnessMaxAgeMinutes(leagueId: string): number {
  return MARKET_FRESHNESS_MAX_AGE_MINUTES[leagueId.toLowerCase()] ?? DEFAULT_MAX_AGE_MINUTES;
}

export type MarketFreshness = "fresh" | "stale" | "never_observed";

/**
 * Classifies a market's freshness from an explicit observation timestamp.
 * Deterministic and fully time-injected (`now`) so fixtures never depend on
 * wall-clock state. `observedAtIso` should be the provider-observation
 * timestamp (odds_snapshots.pulled_at) or its updated_at proxy.
 */
export function classifyMarketFreshness(input: {
  observedAtIso: string | null | undefined;
  leagueId: string;
  now?: number;
}): MarketFreshness {
  if (!input.observedAtIso) return "never_observed";
  const observedMs = new Date(input.observedAtIso).getTime();
  if (!Number.isFinite(observedMs)) return "never_observed";
  const now = input.now ?? Date.now();
  const ageMinutes = (now - observedMs) / (60 * 1000);
  return ageMinutes <= marketFreshnessMaxAgeMinutes(input.leagueId) ? "fresh" : "stale";
}

/** Convenience predicate: a market is publish/display-eligible only when
 * classified `fresh`. `never_observed` and `stale` both block. */
export function isMarketFreshEnoughToPublish(input: {
  observedAtIso: string | null | undefined;
  leagueId: string;
  now?: number;
}): boolean {
  return classifyMarketFreshness(input) === "fresh";
}

/**
 * Classifies freshness directly from a precomputed age-in-minutes value (the
 * form the scoring context already carries as
 * `context.freshness.oddsAgeMinutes`, which is
 * `minutesBetween(snapshot.pulled_at ?? prop.updated_at)`). A null age means
 * no observation timestamp was available at all -> never_observed. A negative
 * age (a future-dated observation, seen in some fixtures) is treated as
 * fresh, not stale.
 */
export function classifyMarketFreshnessFromAgeMinutes(ageMinutes: number | null | undefined, leagueId: string): MarketFreshness {
  if (ageMinutes === null || ageMinutes === undefined || !Number.isFinite(ageMinutes)) return "never_observed";
  return ageMinutes <= marketFreshnessMaxAgeMinutes(leagueId) ? "fresh" : "stale";
}
