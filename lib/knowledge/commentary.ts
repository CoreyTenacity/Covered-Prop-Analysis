// Public-safe Parlay Builder commentary: a bounded, read-time reshaping of
// already-stored score_explanations text (summary/reasoning_block/factors --
// all produced once by the real adapter during scoring, per Session 86's
// finding that this data already exists and is already public-safe prose).
// No new computation happens here and no raw weights/provenance/internal
// enums are read -- only the adapter's own human-readable factor labels and
// descriptions, which is exactly what a completed, publishable prop already
// carries. A prop that reaches this function is by construction publishable
// (getParlayOptions/getCoveredPicksOfTheDay both gate on that before this
// point), so there is never a "missing required data" case to narrate.
//
// Session 89 further simplification (owner-directed): the Session 88
// 8-field shape (summary, recent_form, projection_vs_line, matchup_context,
// role_context, strongest_factors, primary_risks, score_note) measured
// 653 bytes/row (36% snapshot growth). The four named category fields
// (recent_form/projection_vs_line/matchup_context/role_context) overlapped
// conceptually with strongest_factors/primary_risks -- both were reading the
// same underlying factors array, just formatted two different ways.
// Collapsing to the owner's suggested compact shape (one summary, up to
// three positive factors, up to two risks, one status line) keeps every
// category's evidence -- each factor entry still carries its name and a
// short description, e.g. "Recent Form: trending up over the last 5" -- while
// removing the duplicated second representation of the same facts.

export type ParlayCommentary = {
  summary: string;
  /** Up to 3 entries, each "<Factor Name>: <short description>" for a positive-impact factor. */
  positive_factors: string[];
  /** Up to 2 entries, same shape, for negative/caution-impact factors. */
  risks: string[];
  /** Score, label, recommendation, and Covered Picks threshold comparison in one line. */
  status: string;
};

type FactorLike = { name?: unknown; label?: unknown; impact?: unknown; description?: unknown };

// Bounded lengths: this object is embedded in the Manual Analyzer snapshot
// for every publishable prop (potentially hundreds of rows), so per-row text
// size is a real, material egress cost. 80 characters carries one concrete
// clause of evidence; 60 is enough for a "<Name>: <short clause>" factor entry.
const MAX_SUMMARY_LENGTH = 80;
const MAX_FACTOR_ENTRY_LENGTH = 70;
const MAX_POSITIVE_FACTORS = 3;
const MAX_RISKS = 2;

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const cut = value.slice(0, maxLength - 1).replace(/\s+\S*$/, "");
  return `${cut || value.slice(0, maxLength - 1)}…`;
}

function factorEntries(factors: Array<Record<string, unknown>> | null | undefined, impacts: string[], limit: number, maxLength: number): string[] {
  if (!factors) return [];
  const wanted = new Set(impacts);
  const entries: string[] = [];
  for (const factor of factors) {
    const impact = String((factor as FactorLike).impact ?? "");
    if (!wanted.has(impact)) continue;
    const name = String((factor as FactorLike).name ?? "").trim();
    const description = String((factor as FactorLike).description ?? "").trim();
    if (!name && !description) continue;
    const entry = description ? `${name}: ${description}` : name;
    entries.push(truncate(entry, maxLength));
    if (entries.length >= limit) break;
  }
  return entries;
}

export function buildParlayCommentary(input: {
  summary: string | null;
  reasoningBlock: string | null;
  factors: Array<Record<string, unknown>> | null;
  coveredScore: number | null;
  recommendation: string | null;
  scoreLabel: string | null;
}): ParlayCommentary {
  const coveredScore = input.coveredScore;
  // Prefer reasoning_block (usually the more specific "why" text); fall back
  // to summary only when reasoning_block is absent -- never store both when
  // one already subsumes the other's conclusion.
  const leanText = (input.reasoningBlock ?? "").trim() || (input.summary ?? "").trim() || "No summary available for this prop yet.";
  const status = coveredScore === null
    ? "Not yet scored."
    : `${coveredScore}${input.scoreLabel ? ` (${input.scoreLabel})` : ""} -- ${coveredScore >= 70 ? "meets" : "below"} Covered Picks (70+).`;
  return {
    summary: truncate(leanText, MAX_SUMMARY_LENGTH),
    positive_factors: factorEntries(input.factors, ["positive"], MAX_POSITIVE_FACTORS, MAX_FACTOR_ENTRY_LENGTH),
    risks: factorEntries(input.factors, ["negative", "caution"], MAX_RISKS, MAX_FACTOR_ENTRY_LENGTH),
    status,
  };
}
