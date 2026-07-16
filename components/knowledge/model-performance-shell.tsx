"use client";

import { useEffect, useState } from "react";

import { PerformanceSummary } from "@/components/knowledge/performance-summary";
import { buildModelPerformanceSnapshotResponse, filterModelPerformanceFacts } from "@/lib/knowledge/public-snapshots";
import type { ModelPerformanceBucket, ModelPerformanceResponse } from "@/lib/knowledge/read-types";

const leagues = [
  { label: "All leagues", value: "" },
  { label: "MLB", value: "mlb" },
  { label: "WNBA", value: "wnba" },
  { label: "NBA", value: "nba" },
];

function queryString(filters: Record<string, string | number | boolean | null | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return params.toString();
}

function formatRate(value: number | null) {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function BreakdownPanel({ title, groups }: { title: string; groups: ModelPerformanceBucket[] }) {
  return (
    <section className="performance-panel">
      <div className="performance-panel__head">
        <div>
          <h2>{title}</h2>
          <p>Read-only model-performance grouping from graded scored props.</p>
        </div>
        <span>Hit rate</span>
      </div>
      {groups.length ? (
        <div className="performance-bars">
          {groups.map((group) => (
            <div className="performance-bar" key={group.key}>
              <div className="performance-bar__label">
                <strong>{group.key}</strong>
                <span>{group.wins}W · {group.losses}L · {group.pushes}P</span>
              </div>
              <div className="performance-bar__track"><i style={{ width: `${(group.hit_rate_excluding_pushes_no_grades ?? 0) * 100}%` }} /></div>
              <strong className="performance-bar__rate">{formatRate(group.hit_rate_excluding_pushes_no_grades)}</strong>
            </div>
          ))}
        </div>
      ) : <div className="mini-empty">No graded props matched these filters.</div>}
    </section>
  );
}

export function ModelPerformanceShell() {
  const [data, setData] = useState<ModelPerformanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [league, setLeague] = useState("");
  const [marketType, setMarketType] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");

    fetch("/api/knowledge/model-performance", {
      cache: "force-cache",
      credentials: "omit",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load model performance.");
        return response.json() as Promise<ModelPerformanceResponse>;
      })
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load model performance.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const filteredPerformance = data
    ? buildModelPerformanceSnapshotResponse(filterModelPerformanceFacts(data.rows ?? [], {
      dateFrom: "2026-01-01",
      dateTo: new Date().toISOString().slice(0, 10),
      sport: null,
      league,
      marketType,
      sportsbook: null,
      scoreLabel: null,
      confidenceLabel: null,
      riskLabel: null,
      recommendation: null,
      minimumCoveredScore: null,
      modelVersion: null,
      result: null,
    }))
    : null;

  return (
    <div className="page-wrap performance-page">
      <header className="page-hero performance-hero">
        <div>
          <div className="eyebrow"><span /> Public model read</div>
          <h1>Model Performance</h1>
          <p>Read-only grading summaries for the Covered model layer. No account is needed to review how scored props have held up.</p>
        </div>
      </header>

      <section className="knowledge-filter-bar">
        <select value={league} onChange={(event) => setLeague(event.target.value)}>{leagues.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <input className="knowledge-search" placeholder="Filter market type (example: player_points)" value={marketType} onChange={(event) => setMarketType(event.target.value)} />
      </section>

      {loading ? <div className="empty-state"><strong>Loading model performance…</strong><span>Pulling graded results from the knowledge read layer.</span></div> : null}
      {!loading && error ? <div className="empty-state"><strong>Couldn’t load model performance.</strong><span>{error}</span></div> : null}
      {!loading && !error && data ? (
        <>
          <PerformanceSummary summary={filteredPerformance?.summary ?? data.summary} />
          <div className="performance-grid">
            <BreakdownPanel title="By sport" groups={filteredPerformance?.performance_by_sport ?? data.performance_by_sport} />
            <BreakdownPanel title="By league" groups={filteredPerformance?.performance_by_league ?? data.performance_by_league} />
          </div>
          <div className="performance-grid">
            <BreakdownPanel title="By market type" groups={filteredPerformance?.performance_by_market_type ?? data.performance_by_market_type} />
            <BreakdownPanel title="By score label" groups={filteredPerformance?.performance_by_score_label ?? data.performance_by_score_label} />
          </div>
          <div className="performance-grid">
            <BreakdownPanel title="By confidence label" groups={filteredPerformance?.performance_by_confidence_label ?? data.performance_by_confidence_label} />
            <BreakdownPanel title="By risk label" groups={filteredPerformance?.performance_by_risk_label ?? data.performance_by_risk_label} />
          </div>
        </>
      ) : null}
    </div>
  );
}
