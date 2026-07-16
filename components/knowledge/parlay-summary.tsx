"use client";

import type { ParlaySummary as ParlaySummaryType } from "@/lib/knowledge/parlay-analysis";

function qualityTone(label: ParlaySummaryType["quality_label"]) {
  if (label === "Strong Slip") return "kpi-card--primary";
  if (label === "Playable Slip") return "";
  if (label === "Risky Slip") return "";
  if (label === "Data Limited") return "";
  return "";
}

export function ParlaySummary({ summary }: { summary: ParlaySummaryType }) {
  return (
    <section className="performance-kpis knowledge-performance-kpis">
      <article className={`kpi-card ${qualityTone(summary.quality_label)}`}>
        <span>Overall slip quality</span>
        <strong>{summary.quality_label}</strong>
        <small>{summary.selected_leg_count} selected legs · {summary.warning_count} warnings</small>
      </article>
      <article className="kpi-card">
        <span>Average Covered Score</span>
        <strong>{summary.average_covered_score ?? "—"}</strong>
        <small>Across currently scored selected legs</small>
      </article>
      <article className="kpi-card">
        <span>Average match confidence</span>
        <strong>{summary.average_match_confidence ?? "—"}</strong>
        <small>Identity/matching confidence from current props</small>
      </article>
      <article className="kpi-card">
        <span>High-confidence legs</span>
        <strong>{summary.high_confidence_legs}</strong>
        <small>{summary.low_confidence_or_data_limited_legs} low-confidence or data-limited legs</small>
      </article>
    </section>
  );
}
