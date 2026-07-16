"use client";

import type { ModelPerformanceBucket } from "@/lib/knowledge/read-types";
import type { ModelPerformanceSummary } from "@/lib/knowledge/read-types";

function formatRate(value: number | null) {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function PerformanceSummary({ summary }: { summary: ModelPerformanceSummary }) {
  return (
    <section className="performance-kpis knowledge-performance-kpis">
      <article className="kpi-card kpi-card--primary">
        <span>Total graded</span>
        <strong>{summary.total_graded}</strong>
        <small>Hit rate {formatRate(summary.hit_rate_excluding_pushes_no_grades)}</small>
      </article>
      <article className="kpi-card">
        <span>Record</span>
        <strong>{summary.wins}-{summary.losses}</strong>
        <small>{summary.pushes} pushes · {summary.no_grades} no grades</small>
      </article>
      <article className="kpi-card">
        <span>Average Covered Score</span>
        <strong>{summary.average_covered_score ?? "—"}</strong>
        <small>Across graded model props</small>
      </article>
      <article className="kpi-card">
        <span>Average confidence</span>
        <strong>{summary.average_confidence_score ?? "—"}</strong>
        <small>Stored scoring confidence average</small>
      </article>
    </section>
  );
}
