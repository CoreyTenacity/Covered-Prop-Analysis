import type { Direction, Opportunity } from "@/lib/types";
import type { DataQuality, ScoreResult } from "./covered-score";

interface ExplanationInput {
  playerName: string;
  statType: string;
  line: number;
  projection: number;
  direction: Direction;
  reasons: string[];
  risks: string[];
  dataQuality: DataQuality;
  result: ScoreResult;
}

export function explainScore(input: ExplanationInput) {
  const summary = [
    `${input.playerName}'s ${input.statType} is on the board because ${input.reasons[0].replace(/\.$/, "")}.`,
    input.reasons[1] ? `${input.reasons[1].replace(/\.$/, "")}.` : "There is no second independent signal, so the read stays conservative.",
    `The score is the model's way of weighing those signals, not a promise that the prop will land.`,
  ].join(" ");
  const modelNotes = [
    `Covered Score: the evidence clears the board bar, but the score is still a research signal rather than a win probability.`,
    input.reasons[1]
      ? `Support check: ${input.reasons[1].replace(/\.$/, "")}.`
      : `Support check: there is no second verified confirmation attached to this read, so it should stay conservative.`,
    `Risk Flags: ${input.risks.join("; ")}.`,
    `Decision frame: treat this as a ranked board candidate, not a lock.`,
  ];
  return { summary, modelNotes };
}

function nonEmpty(values: Array<string | undefined | null>) {
  return values.map((value) => value?.trim() ?? "").filter(Boolean);
}

export function explainOpportunity(opportunity: Pick<Opportunity, "playerName" | "statType" | "direction" | "line" | "reasons" | "risks" | "factorNotes" | "breakdown" | "dataQuality" | "sport" | "coveredScore" | "recommendationLabel" | "confidence"> & Partial<Pick<Opportunity, "riskFlags" | "confidenceScore" | "valueRating" | "adjustedEdge">>) {
  const summary = [
    opportunity.reasons[0]
      ? `The board likes ${opportunity.playerName} because ${opportunity.reasons[0].replace(/\.$/, "")}.`
      : `The board likes ${opportunity.playerName} because the tracked evidence lines up.`,
    opportunity.reasons[1]
      ? `The second reason is ${opportunity.reasons[1].replace(/\.$/, "")}.`
      : `There is no second verified check attached, so the read should stay conservative.`,
    `The current Covered Score simply ranks how strongly the verified evidence agrees; it does not turn the prop into a guarantee.`,
    opportunity.risks.length ? `Biggest risk(s): ${opportunity.risks.join("; ")}.` : `There is no extra hidden risk layer beyond the tracked data.`,
  ].join(" ");

  const adjustedEdge = opportunity.adjustedEdge ?? 0;
  const valueRating = opportunity.valueRating ?? 0;
  const confidenceScore = opportunity.confidenceScore ?? 0;
  const riskFlags = opportunity.riskFlags ?? [];
  const adjustedEdgeText = `${adjustedEdge > 0 ? "+" : adjustedEdge < 0 ? "−" : ""}${Math.abs(adjustedEdge).toFixed(2)}`;
  const valueRatingText = `${valueRating > 0 ? "+" : valueRating < 0 ? "−" : ""}${Math.abs(valueRating)}/5`;
  const notes = [
    `Covered Score: ${opportunity.coveredScore}/100 keeps this in ${opportunity.recommendationLabel.toLowerCase()} territory with ${opportunity.confidence.toLowerCase()} confidence.`,
    `Value Rating: ${valueRatingText} after confidence adjustments, with an adjusted edge of ${adjustedEdgeText}.`,
    `Confidence Score: ${confidenceScore}/100 with ${opportunity.dataQuality.toLowerCase()} data quality behind the read.`,
    `Risk Flags: ${riskFlags.length ? riskFlags.join("; ") : opportunity.risks.join("; ") || "none recorded beyond normal variance."}`,
    `Decision frame: ${opportunity.coveredScore >= 80 ? "featured board candidate" : opportunity.coveredScore >= 65 ? "eligible but not featured" : "informational only unless the slate is thin"}.`,
  ];

  return {
    summary,
    notes: nonEmpty(notes).slice(0, 5),
  };
}
