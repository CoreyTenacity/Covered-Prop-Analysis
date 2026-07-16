"use client";

import { useEffect, useMemo, useState } from "react";
import type { PickRecord } from "@/lib/types";
import { getPicks, subscribeToPicks } from "@/lib/db/picks";
import { currentStreak, groupPerformance, inDateRange, rollingPerformance, scoreBucket, summarize, type PerformanceGroup, type PerformanceRange } from "@/lib/performance/analytics";

const ranges: { value: PerformanceRange; label: string }[] = [{ value: 7, label: "Last 7 days" }, { value: 30, label: "Last 30 days" }, { value: "all", label: "All time" }];
const scoreOrder = ["85–100", "75–84", "65–74", "50–64", "Under 50"];

function formatRate(value: number | null) { return value === null ? "—" : `${value}%`; }

function BreakdownPanel({ title, subtitle, groups }: { title: string; subtitle: string; groups: PerformanceGroup[] }) {
  return (
    <section className="performance-panel">
      <div className="performance-panel__head"><div><h2>{title}</h2><p>{subtitle}</p></div><span>Hit rate</span></div>
      {groups.length ? <div className="performance-bars">{groups.map((group) => (
        <div className="performance-bar" key={group.label}>
          <div className="performance-bar__label"><strong>{group.label}</strong><span>{group.hits}H · {group.misses}M</span></div>
          <div className="performance-bar__track"><i style={{ width: `${group.hitRate ?? 0}%` }} /></div>
          <strong className="performance-bar__rate">{formatRate(group.hitRate)} <small>({group.hits}/{group.total})</small></strong>
        </div>
      ))}</div> : <div className="mini-empty">No graded picks in this category yet.</div>}
    </section>
  );
}

export function PerformanceDashboard() {
  const [picks, setPicks] = useState<PickRecord[]>([]);
  const [range, setRange] = useState<PerformanceRange>(30);

  useEffect(() => { const sync = () => setPicks(getPicks()); sync(); return subscribeToPicks(sync); }, []);
  const filtered = useMemo(() => picks.filter((pick) => inDateRange(pick, range)), [picks, range]);
  const graded = useMemo(() => filtered.filter((pick) => pick.result === "hit" || pick.result === "miss"), [filtered]);
  const overall = summarize(filtered);
  const sevenDays = summarize(picks.filter((pick) => inDateRange(pick, 7)), "Last 7 days");
  const thirtyDays = summarize(picks.filter((pick) => inDateRange(pick, 30)), "Last 30 days");
  const streak = currentStreak(picks);
  const bySport = groupPerformance(graded, (pick) => pick.sport);
  const byScore = groupPerformance(graded, (pick) => scoreBucket(pick.coveredScore), scoreOrder);
  const byStat = groupPerformance(graded, (pick) => pick.statType);
  const byConfidence = groupPerformance(graded, (pick) => pick.confidence ?? "Legacy / unknown", ["High", "Medium-High", "Medium", "Low", "Legacy / unknown"]);
  const trend = rollingPerformance(picks);
  const rankedSports = bySport.filter((group) => group.hitRate !== null).sort((a, b) => (b.hitRate ?? 0) - (a.hitRate ?? 0));
  const calibrationBuckets = byScore.filter((group) => group.hitRate !== null);
  const bestBucket = [...calibrationBuckets].sort((a, b) => (b.hitRate ?? 0) - (a.hitRate ?? 0))[0];
  const weakestBucket = [...calibrationBuckets].sort((a, b) => (a.hitRate ?? 0) - (b.hitRate ?? 0))[0];
  const strongestConfidence = [...byConfidence].filter((group) => group.hitRate !== null).sort((a, b) => (b.hitRate ?? 0) - (a.hitRate ?? 0))[0];

  return (
    <div className="page-wrap performance-page">
      <header className="page-hero performance-hero"><div><div className="eyebrow"><span /> Model calibration</div><h1>Performance Dashboard</h1><p>Track which Covered signals are holding up—and where the model needs more evidence.</p></div></header>
      <div className="range-tabs" role="tablist" aria-label="Performance date range">{ranges.map((option) => <button role="tab" aria-selected={range === option.value} className={range === option.value ? "active" : ""} key={option.label} onClick={() => setRange(option.value)}>{option.label}</button>)}</div>

      <section className="performance-kpis">
        <article className="kpi-card kpi-card--primary"><span>Record</span><strong>{overall.hits}-{overall.misses}</strong><small>{overall.total ? `${formatRate(overall.hitRate)} (${overall.hits}/${overall.total}) · ${overall.pushes} pushes excluded` : "Grade picks to establish a baseline"}</small></article>
        <article className="kpi-card"><span>Last 7 days</span><strong>{formatRate(sevenDays.hitRate)}</strong><small>{sevenDays.total} graded · {sevenDays.pending} pending</small></article>
        <article className="kpi-card"><span>Last 30 days</span><strong>{formatRate(thirtyDays.hitRate)}</strong><small>{thirtyDays.total} graded · {thirtyDays.pending} pending</small></article>
        <article className="kpi-card"><span>Current streak</span><strong className={streak.result === "miss" ? "danger-value" : ""}>{streak.count ? `${streak.count}${streak.result === "hit" ? "H" : "M"}` : "—"}</strong><small>{streak.count ? `${streak.result === "hit" ? "Hit" : "Miss"} streak` : "No graded decisions yet"}</small></article>
      </section>

      {!graded.length && <div className="performance-empty performance-empty--compact"><div>↗</div><h2>Performance starts with graded picks</h2><p>The complete dashboard is ready below. Save opportunities and grade results to populate each view; pushes and voids never count against hit rate.</p><a href="/history">Open Pick History →</a></div>}
      {!!graded.length && <section className="performance-insights">
          <div><span>Best-performing sport</span><strong>{rankedSports[0]?.label ?? "—"}</strong><small>{formatRate(rankedSports[0]?.hitRate ?? null)} across {rankedSports[0]?.total ?? 0} picks</small></div>
          <div><span>Needs the most review</span><strong>{rankedSports.length > 1 ? rankedSports[rankedSports.length - 1].label : "More data"}</strong><small>{rankedSports.length > 1 ? `${formatRate(rankedSports[rankedSports.length - 1].hitRate)} across ${rankedSports[rankedSports.length - 1].total} picks` : "Grade another sport to compare"}</small></div>
          <div><span>Best stat type</span><strong>{[...byStat].sort((a,b) => (b.hitRate ?? 0) - (a.hitRate ?? 0))[0]?.label ?? "—"}</strong><small>Directional—not an automatic weight change</small></div>
      </section>}
      {!!calibrationBuckets.length && <section className="performance-insights performance-insights--calibration">
        <div><span>Most reliable score bucket</span><strong>{bestBucket?.label ?? "—"}</strong><small>{formatRate(bestBucket?.hitRate ?? null)} across {bestBucket?.total ?? 0} graded picks</small></div>
        <div><span>Weakest score bucket</span><strong>{weakestBucket?.label ?? "—"}</strong><small>{formatRate(weakestBucket?.hitRate ?? null)} across {weakestBucket?.total ?? 0} graded picks</small></div>
        <div><span>Strongest confidence tier</span><strong>{strongestConfidence?.label ?? "—"}</strong><small>{formatRate(strongestConfidence?.hitRate ?? null)} across {strongestConfidence?.total ?? 0} graded picks</small></div>
      </section>}
      <section className="performance-panel trend-panel"><div className="performance-panel__head"><div><h2>Rolling 7-day hit rate</h2><p>Each bar uses the seven days ending on that date, so short streaks have context</p></div><span>Number below = sample size</span></div><div className="trend-bars">{trend.map((point) => <div key={point.label} title={`${point.label}: ${formatRate(point.hitRate)} (${point.hits}/${point.total})`}><i style={{ height: `${point.hitRate ?? 2}%` }} /><small>{point.total}</small></div>)}</div><div className="trend-axis"><span>14 days ago</span><span>Today</span></div></section>
      <div className="performance-grid"><BreakdownPanel title="By sport" subtitle="Where the board has been most reliable" groups={bySport} /><BreakdownPanel title="Calibration by score bucket" subtitle="Higher buckets should earn higher actual hit rates over enough picks" groups={byScore} /></div>
      <div className="performance-grid"><BreakdownPanel title="By confidence tier" subtitle="Separates high-confidence research from thinner signals" groups={byConfidence} /><BreakdownPanel title="By stat type" subtitle="Find repeatable strengths and volatile categories" groups={byStat} /></div>
      <p className="local-storage-note"><span /> Calculated locally from your graded history. Pushes and voids are tracked but excluded from hit rate. Actual-result grading is available in history, and saved actual values can be auto-graded into hit, miss, or push.</p>
    </div>
  );
}
