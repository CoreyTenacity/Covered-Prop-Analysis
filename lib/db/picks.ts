import type { Opportunity, PickRecord, PickResult } from "@/lib/types";
import { describeGradingResult } from "./grading.ts";

const STORAGE_KEY = "covered-picks-v1";
const CHANGE_EVENT = "covered:picks-changed";

function isPickRecord(value: unknown): value is PickRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PickRecord>;
  return typeof candidate.id === "string" && typeof candidate.playerName === "string" && typeof candidate.savedAt === "string";
}

export function getPicks(): PickRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter(isPickRecord).sort((a, b) => b.savedAt.localeCompare(a.savedAt)) : [];
  } catch {
    return [];
  }
}

function writePicks(picks: PickRecord[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(picks));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function gradePickResult(actualValue: number, line: number, direction: PickRecord["direction"]): PickResult {
  if (!Number.isFinite(actualValue) || !Number.isFinite(line)) return "pending";
  const delta = Number((actualValue - line).toFixed(2));
  if (Math.abs(delta) < 0.01) return "push";
  if (direction === "More") return delta > 0 ? "hit" : "miss";
  return delta < 0 ? "hit" : "miss";
}

export function isOpportunitySaved(opportunityId: string): boolean {
  return getPicks().some((pick) => pick.opportunityId === opportunityId);
}

export function toggleOpportunity(opportunity: Opportunity): boolean {
  const picks = getPicks();
  const existing = picks.find((pick) => pick.opportunityId === opportunity.id);
  if (existing) {
    writePicks(picks.filter((pick) => pick.id !== existing.id));
    return false;
  }
  const record: PickRecord = {
    id: `pick-${opportunity.id}-${Date.now()}`,
    opportunityId: opportunity.id,
    savedAt: new Date().toISOString(),
    sport: opportunity.sport,
    playerName: opportunity.playerName,
    team: opportunity.team,
    opponent: opportunity.opponent,
    statType: opportunity.statType,
    line: opportunity.line,
    direction: opportunity.direction,
    coveredScore: opportunity.coveredScore,
    recommendationLabel: opportunity.recommendationLabel,
    confidence: opportunity.confidence,
    result: "pending",
    notes: "",
    gradingNote: undefined,
    source: "top-board",
    gradingStatus: "manual",
  };
  writePicks([record, ...picks]);
  return true;
}

export function updatePick(id: string, changes: { result?: PickResult; notes?: string; actualValue?: number; gradedAt?: string; gradingStatus?: PickRecord["gradingStatus"]; gradingNote?: string }) {
  writePicks(getPicks().map((pick) => pick.id === id ? { ...pick, ...changes } : pick));
}

export function updatePickActualValue(id: string, actualValue: string | number | null) {
  const parsed = typeof actualValue === "number" ? actualValue : actualValue === null || actualValue === "" ? null : Number(actualValue);
  writePicks(getPicks().map((pick) => {
    if (pick.id !== id) return pick;
    if (parsed === null || !Number.isFinite(parsed)) {
      return { ...pick, actualValue: undefined, gradedAt: undefined, gradingStatus: "manual" };
    }
    return {
      ...pick,
      actualValue: parsed,
      result: gradePickResult(parsed, pick.line, pick.direction),
      gradedAt: new Date().toISOString(),
      gradingNote: describeGradingResult(parsed, pick.line, pick.direction, gradePickResult(parsed, pick.line, pick.direction)),
      gradingStatus: "graded-auto",
    };
  }));
}

export function removePick(id: string) {
  writePicks(getPicks().filter((pick) => pick.id !== id));
}

export function subscribeToPicks(callback: () => void) {
  const handler = () => callback();
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}
