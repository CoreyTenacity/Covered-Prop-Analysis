import type { ParlayOptionRow } from "@/lib/knowledge/read-types";

// Analysis logic (leg/parlay warning heuristics, quality-label thresholds) moved
// to scoring-engine/src/parlay-analysis.ts, called via app/api/parlay-analysis/route.ts.
// See docs/AGENT_HANDOFF.md for why: this file used to contain the real logic and
// was imported directly into a "use client" component, shipping the analysis
// heuristics in the public JS bundle. Only the type contracts remain here -- types
// are erased at build time, so this file now contributes zero runtime code to any
// bundle. Do not re-add function implementations here.

export type ParlayLegWarningSeverity = "info" | "warning" | "critical";

export type ParlayLegWarning = {
  code: string;
  message: string;
  severity: ParlayLegWarningSeverity;
};

export type AnalyzedParlayLeg = {
  option: ParlayOptionRow;
  warnings: ParlayLegWarning[];
};

export type ParlaySummary = {
  selected_leg_count: number;
  average_covered_score: number | null;
  average_match_confidence: number | null;
  high_confidence_legs: number;
  low_confidence_or_data_limited_legs: number;
  warning_count: number;
  strongest_leg: ParlayOptionRow | null;
  weakest_leg: ParlayOptionRow | null;
  quality_label: "Strong Slip" | "Playable Slip" | "Risky Slip" | "Data Limited" | "Avoid";
};

export type AnalyzedParlay = {
  legs: AnalyzedParlayLeg[];
  parlayWarnings: ParlayLegWarning[];
  summary: ParlaySummary;
  canAddMore: boolean;
};
