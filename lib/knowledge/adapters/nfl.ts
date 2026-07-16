import { recommendationForCoveredScore, type AdapterPropRow, type AdapterScoreContext, type AdapterScoreOutput, type SportAdapter } from "@/lib/knowledge/adapters/base";

export const nflAdapter: SportAdapter = {
  name: "nflAdapter",
  supportsLeague(leagueId) {
    return leagueId === "nfl";
  },
  buildScore(prop: AdapterPropRow, _context: AdapterScoreContext) {
    const summary = `NFL placeholder adapter is registered, but scoring is intentionally inactive until the NFL knowledge jobs are wired.`;
    return {
      coveredScore: 0,
      projection: prop.line,
      edgeValue: 0,
      edgeScore: 0,
      confidenceScore: 0,
      trendScore: 0,
      matchupScore: 0,
      marketScore: 0,
      dataQualityScore: 0,
      recommendation: recommendationForCoveredScore(0),
      riskFlags: ["adapter_placeholder"],
      scoreLabel: "Avoid",
      confidenceLabel: "Data Limited",
      riskLabel: "High Risk",
      factorNotes: {
        summary,
      },
      factors: [
        {
          name: "Data Quality",
          label: "Weak",
          impact: "caution",
          description: summary,
        },
      ],
      structuredInputs: {
        placeholder: true,
      },
      staleFlags: [],
      summary,
      reasoningBlock: summary,
    } satisfies AdapterScoreOutput;
  },
};
