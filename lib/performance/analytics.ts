import type { PickRecord } from "@/lib/types";

export type PerformanceRange = 7 | 30 | "all";

export interface PerformanceGroup {
  label: string;
  hits: number;
  misses: number;
  total: number;
  hitRate: number | null;
}

export interface PerformanceSummary extends PerformanceGroup {
  pending: number;
  pushes: number;
  autoGraded: number;
}

export function scoreBucket(score: number): string {
  if (score >= 85) return "85–100";
  if (score >= 75) return "75–84";
  if (score >= 65) return "65–74";
  if (score >= 50) return "50–64";
  return "Under 50";
}

export function inDateRange(pick: PickRecord, range: PerformanceRange, now = new Date()): boolean {
  if (range === "all") return true;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - range);
  return new Date(pick.savedAt) >= cutoff;
}

function rate(hits: number, misses: number): number | null {
  const total = hits + misses;
  return total ? Number(((hits / total) * 100).toFixed(1)) : null;
}

export function summarize(picks: PickRecord[], label = "Overall"): PerformanceSummary {
  const hits = picks.filter((pick) => pick.result === "hit").length;
  const misses = picks.filter((pick) => pick.result === "miss").length;
  return {
    label, hits, misses, total: hits + misses, hitRate: rate(hits, misses),
    pending: picks.filter((pick) => pick.result === "pending").length,
    pushes: picks.filter((pick) => pick.result === "push").length,
    autoGraded: picks.filter((pick) => pick.gradingStatus === "graded-auto").length,
  };
}

export function groupPerformance(picks: PickRecord[], keyFor: (pick: PickRecord) => string, preferredOrder: string[] = []): PerformanceGroup[] {
  const groups = new Map<string, PickRecord[]>();
  for (const pick of picks) {
    const key = keyFor(pick);
    groups.set(key, [...(groups.get(key) ?? []), pick]);
  }
  return [...groups.entries()].map(([label, group]) => summarize(group, label)).sort((a, b) => {
    const aIndex = preferredOrder.indexOf(a.label);
    const bIndex = preferredOrder.indexOf(b.label);
    if (aIndex >= 0 || bIndex >= 0) return (aIndex < 0 ? 999 : aIndex) - (bIndex < 0 ? 999 : bIndex);
    return b.total - a.total || a.label.localeCompare(b.label);
  });
}

export function currentStreak(picks: PickRecord[]): { result: "hit" | "miss" | null; count: number } {
  const graded = [...picks].filter((pick) => pick.result === "hit" || pick.result === "miss").sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  if (!graded.length) return { result: null, count: 0 };
  const result = graded[0].result as "hit" | "miss";
  let count = 0;
  for (const pick of graded) {
    if (pick.result !== result) break;
    count += 1;
  }
  return { result, count };
}

export function rollingPerformance(picks: PickRecord[], days = 14, now = new Date()): Array<{ label: string; hitRate: number | null; hits: number; total: number }> {
  const output = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(now); day.setHours(23, 59, 59, 999); day.setDate(day.getDate() - offset);
    const start = new Date(day); start.setDate(start.getDate() - 6); start.setHours(0, 0, 0, 0);
    const window = picks.filter((pick) => {
      const saved = new Date(pick.savedAt);
      return saved >= start && saved <= day && (pick.result === "hit" || pick.result === "miss");
    });
    const summary = summarize(window);
    output.push({ label: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(day), hitRate: summary.hitRate, hits: summary.hits, total: summary.total });
  }
  return output;
}
