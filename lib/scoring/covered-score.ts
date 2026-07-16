import type { Confidence, Direction, ScoreBreakdown, Sport } from "@/lib/types";

export type RecommendationLabel = "Strong Edge" | "Good Play" | "Lean" | "Risky" | "Avoid";
export type DataQuality = "High" | "Medium" | "Low";

// This is the public wire contract shared by the server caller and the private
// scoring-engine Worker. It intentionally contains inputs and outputs only;
// tuned weights and scoring decisions live in scoring-engine/src.
export interface ScoreInput {
  sport: Sport;
  line: number;
  projection: number;
  direction: Direction;
  components: Omit<ScoreBreakdown, "projectionEdge">;
  dataQuality: DataQuality;
  riskFlags?: string[];
}

export interface ScoreResult {
  score: number;
  rawEdge: number;
  adjustedEdge: number;
  edgePercent: number;
  valueRating: number;
  label: RecommendationLabel;
  confidence: Confidence;
  confidenceScore: number;
  riskFlags: string[];
  breakdown: ScoreBreakdown;
}

/** Generic published math; the tuned scorer is isolated in the Worker. */
export function calculateEdge(line: number, projection: number, direction: Direction): number {
  if (!Number.isFinite(line) || !Number.isFinite(projection) || line <= 0) return 0;
  const edge = direction === "More" ? (projection - line) / line : (line - projection) / line;
  return Number((edge * 100).toFixed(1));
}

/** Published label mapping used to render an already-produced score. */
export function labelForScore(score: number): RecommendationLabel {
  if (score >= 80) return "Strong Edge";
  if (score >= 65) return "Good Play";
  if (score >= 50) return "Risky";
  return "Avoid";
}
