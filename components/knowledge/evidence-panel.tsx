"use client";

import type { ParlayCommentary } from "@/lib/knowledge/commentary";
import type { ParlayOptionEvidence } from "@/lib/knowledge/read-types";

/**
 * The ONE "Why this score?" evidence presentation, shared by the Manual
 * Analyzer (parlay-leg-selector.tsx) and Covered Picks (pick-card.tsx) so
 * the same prop shows identical evidence on both surfaces -- reuses the
 * already-embedded ParlayOptionEvidence/ParlayCommentary objects (see
 * buildScoreEvidence in lib/knowledge/read-service.ts), never a per-card
 * fetch or a second explanation system.
 *
 * Covered Score is deliberately never presented as a percentage/probability
 * here -- it is a relative evidence/quality score, not a calibrated win
 * chance.
 */

function formatDirectional(value: number | null, digits = 1) {
  if (value === null || !Number.isFinite(value)) return null;
  const rounded = value.toFixed(digits);
  return value > 0 ? `+${rounded}` : rounded;
}

function isLessDirection(side: string | null) {
  return (side ?? "").toLowerCase() === "less" || (side ?? "").toLowerCase() === "under";
}

function leanLabel(side: string | null) {
  if (isLessDirection(side)) return "Less";
  const normalized = (side ?? "").toLowerCase();
  if (normalized === "more" || normalized === "over") return "More";
  return side ?? "—";
}

function opportunityTrendLabel(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null;
  if (value > 0.25) return "increasing";
  if (value < -0.25) return "decreasing";
  return "stable";
}

function formatEasternTime(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(parsed);
}

function hitCountSentence(input: {
  label: string;
  hitCount: number | null;
  sampleSize: number | null;
  line: number;
  isLess: boolean;
}) {
  if (input.hitCount === null || !input.sampleSize) return null;
  const verb = input.isLess ? "stayed below" : "cleared";
  return `${input.label}: ${input.hitCount} of ${input.sampleSize} games ${verb} today's ${input.line} line`;
}

export function EvidencePanel({
  evidence,
  commentary,
  line,
  side,
}: {
  evidence: ParlayOptionEvidence | null | undefined;
  commentary: ParlayCommentary | null | undefined;
  line: number;
  side: string | null;
}) {
  if (!evidence && !commentary) {
    return <p className="knowledge-evidence-empty">Detailed evidence is not available for this prop yet.</p>;
  }

  const isLess = isLessDirection(side);
  const last5Sentence = evidence
    ? hitCountSentence({ label: "Last 5", hitCount: evidence.last5HitCount, sampleSize: evidence.last5SampleSize, line, isLess })
    : null;
  const last10Sentence = evidence
    ? hitCountSentence({ label: "Last 10", hitCount: evidence.last10HitCount, sampleSize: evidence.last10SampleSize, line, isLess })
    : null;
  const opportunityTrend = evidence ? opportunityTrendLabel(evidence.minutesTrend ?? evidence.usageTrend) : null;
  const refreshedAt = evidence ? formatEasternTime(evidence.dataRefreshedAt) : null;

  // Egress/duplication check (2026-08-07): matchupNote/injuryNote and the
  // commentary factor list are both built from the SAME stored factor
  // descriptions -- a "Matchup"/"Injury Context" entry in
  // positive_factors/risks would otherwise repeat, word for word, whatever
  // the dedicated Matchup/Injury section above already shows. Drop only
  // entries whose named factor already has its own section here (display-
  // level dedup; the API payload itself is unchanged since other consumers
  // of commentary may not render the dedicated sections).
  const dedupeAgainstSections = (entries: string[]) => entries.filter((entry) => {
    const prefix = entry.split(":")[0]?.trim().toLowerCase();
    if (evidence?.matchupNote && prefix === "matchup") return false;
    if (evidence?.injuryNote && (prefix === "injury context" || prefix === "injury/role" || prefix === "injury")) return false;
    return true;
  });
  const supportFactors = dedupeAgainstSections(commentary?.positive_factors ?? []);
  const riskFactors = dedupeAgainstSections(commentary?.risks ?? []);

  return (
    <div className="knowledge-evidence-panel">
      {evidence && (evidence.projection !== null || evidence.edgeValue !== null) ? (
        <section className="knowledge-evidence-section">
          <h4>Projection vs. line</h4>
          <div className="knowledge-evidence-grid">
            {evidence.projection !== null ? (
              <div className="knowledge-evidence-cell"><span>Projection</span><strong>{evidence.projection.toFixed(1)}</strong></div>
            ) : null}
            <div className="knowledge-evidence-cell"><span>Line</span><strong>{line}</strong></div>
            {evidence.edgeValue !== null ? (
              <div className="knowledge-evidence-cell"><span>Edge</span><strong>{formatDirectional(evidence.edgeValue)}</strong></div>
            ) : null}
            <div className="knowledge-evidence-cell"><span>Lean</span><strong>{leanLabel(side)}</strong></div>
          </div>
        </section>
      ) : null}

      {evidence && (evidence.last5Avg !== null || evidence.last10Avg !== null) ? (
        <section className="knowledge-evidence-section">
          <h4>Recent form</h4>
          {evidence.last5Avg !== null ? (
            <p><strong>Last 5 average:</strong> {evidence.last5Avg.toFixed(1)}{last5Sentence ? ` — ${last5Sentence.replace("Last 5: ", "")}` : ""}</p>
          ) : null}
          {evidence.last10Avg !== null ? (
            <p><strong>Last 10 average:</strong> {evidence.last10Avg.toFixed(1)}{last10Sentence ? ` — ${last10Sentence.replace("Last 10: ", "")}` : ""}</p>
          ) : null}
        </section>
      ) : null}

      {evidence && (evidence.recentMinutesAvg !== null || opportunityTrend) ? (
        <section className="knowledge-evidence-section">
          <h4>Minutes &amp; opportunity</h4>
          {evidence.recentMinutesAvg !== null ? (
            <p><strong>Last 5 average:</strong> {evidence.recentMinutesAvg.toFixed(1)} minutes</p>
          ) : null}
          {opportunityTrend ? (
            <p>Recent opportunity has been <strong>{opportunityTrend}</strong>{opportunityTrend === "stable" ? ", supporting the projection." : "."}</p>
          ) : null}
        </section>
      ) : null}

      {evidence?.matchupNote ? (
        <section className="knowledge-evidence-section">
          <h4>Matchup</h4>
          <p>{evidence.matchupNote}</p>
        </section>
      ) : null}

      {evidence?.injuryNote ? (
        <section className="knowledge-evidence-section">
          <h4>Injury &amp; role context</h4>
          <p>{evidence.injuryNote}</p>
        </section>
      ) : null}

      {supportFactors.length ? (
        <section className="knowledge-evidence-section knowledge-evidence-section--support">
          <h4>What supports it</h4>
          <ul>
            {supportFactors.map((entry) => <li key={entry}>{entry}</li>)}
          </ul>
        </section>
      ) : null}

      {riskFactors.length ? (
        <section className="knowledge-evidence-section knowledge-evidence-section--risk">
          <h4>Main risks</h4>
          <ul>
            {riskFactors.map((entry) => <li key={entry}>{entry}</li>)}
          </ul>
        </section>
      ) : null}

      {refreshedAt ? (
        <p className="knowledge-evidence-freshness">Market data refreshed {refreshedAt} Eastern</p>
      ) : null}
    </div>
  );
}
