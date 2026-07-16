export type Sport = "MLB" | "WNBA" | "NFL" | "NBA" | "Tennis";
export type Direction = "More" | "Less";
export type Confidence = "High" | "Medium-High" | "Medium" | "Low";

export interface ScoreBreakdown {
  projectionEdge: number;
  currentForm: number;
  matchupHistory: number;
  opponentWeakness: number;
  injuryRole: number;
  marketContext: number;
  environment: number;
  volatilityPenalty: number;
  dataQualityPenalty: number;
}

export interface Opportunity {
  id: string;
  eventId?: string;
  playerId?: string;
  rank: number;
  sport: Sport;
  matchup?: string;
  playerName: string;
  team: string;
  opponent: string;
  statType: string;
  line: number;
  direction: Direction;
  projection: number;
  rawEdge: number;
  adjustedEdge: number;
  edgePercent: number;
  valueRating: number;
  coveredScore: number;
  recommendationLabel: string;
  confidence: Confidence;
  confidenceScore: number;
  sourceProvider?: string;
  providerFreshness?: string;
  providerError?: string;
  contextConfidence?: Confidence;
  reasons: string[];
  risks: string[];
  riskFlags: string[];
  plainEnglishSummary: string;
  modelNotes: string[];
  factorNotes: Record<string, string>;
  gameTime: string;
  headshotUrl?: string;
  recentValues: number[];
  dataQuality: "High" | "Medium" | "Low";
  breakdown?: ScoreBreakdown;
  trendScore?: number;
}

export type PickResult = "pending" | "hit" | "miss" | "push" | "void";

export interface PickRecord {
  id: string;
  opportunityId: string;
  savedAt: string;
  sport: Sport;
  playerName: string;
  team: string;
  opponent: string;
  statType: string;
  line: number;
  direction: Direction;
  coveredScore: number;
  recommendationLabel: Opportunity["recommendationLabel"];
  confidence?: Confidence;
  result: PickResult;
  notes: string;
  gradingNote?: string;
  source: "top-board" | "manual";
  playerId?: string;
  gameId?: string;
  actualValue?: number;
  gradedAt?: string;
  gradingStatus?: "manual" | "pending-auto" | "graded-auto";
}
