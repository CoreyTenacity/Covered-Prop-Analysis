import type { Opportunity, ScoreBreakdown, Sport } from "@/lib/types";
import { labelForScore, type DataQuality, type ScoreResult } from "@/lib/scoring/covered-score";
import { explainScore } from "@/lib/scoring/explanations";
import { generatedAvatarUrl } from "@/lib/providers/player-avatar";

type Seed = Omit<Opportunity, "id" | "rank" | "breakdown" | "plainEnglishSummary" | "modelNotes" | "factorNotes" | "gameTime" | "headshotUrl" | "recentValues" | "dataQuality" | "rawEdge" | "adjustedEdge" | "valueRating" | "confidenceScore" | "riskFlags"> & { breakdown?: Partial<ScoreBreakdown>; dataQuality?: DataQuality };

const baseBreakdown: ScoreBreakdown = {
  projectionEdge: 0, currentForm: 13, matchupHistory: 10, opponentWeakness: 12,
  injuryRole: 12, marketContext: 9, environment: 5, volatilityPenalty: -4, dataQualityPenalty: -2,
};

const seeds: Seed[] = [
  { sport: "MLB", playerName: "Aaron Judge", team: "NYY", opponent: "BOS", statType: "Hits + Runs + RBI", line: 1.5, direction: "More", projection: 2.08, edgePercent: 18.6, coveredScore: 91, recommendationLabel: "Strong Edge", confidence: "High", reasons: ["Elite hard-contact profile against a fly-ball starter", "Projection and market consensus both clear the line"], risks: ["Combo stats carry moderate game-to-game volatility", "A walk-heavy game could limit the number of hittable pitches he sees"], breakdown: { projectionEdge: 29, matchupHistory: 12, opponentWeakness: 12 } },
  { sport: "MLB", playerName: "Tarik Skubal", team: "DET", opponent: "CLE", statType: "Pitcher Strikeouts", line: 6.5, direction: "More", projection: 7.4, edgePercent: 13.8, coveredScore: 87, recommendationLabel: "Strong Edge", confidence: "Medium-High", reasons: ["Deep projected workload with an elite swinging-strike rate", "Opponent lineup grades below average versus left-handed velocity"], risks: ["Efficient contact could cap the pitch count"], breakdown: { projectionEdge: 27, currentForm: 12, matchupHistory: 11 } },
  { sport: "MLB", playerName: "Bobby Witt Jr.", team: "KC", opponent: "MIN", statType: "Total Bases", line: 1.5, direction: "More", projection: 1.91, edgePercent: 12.1, coveredScore: 82, recommendationLabel: "Good Play", confidence: "Medium-High", reasons: ["Strong platoon split and a favorable park adjustment", "Recent quality of contact supports the projection"], risks: ["Total bases remain sensitive to batted-ball variance"] },

  { sport: "WNBA", playerName: "A'ja Wilson", team: "LVA", opponent: "PHX", statType: "Points", line: 25.5, direction: "More", projection: 29.1, edgePercent: 14.1, coveredScore: 90, recommendationLabel: "Strong Edge", confidence: "High", reasons: ["Stable minutes and league-leading half-court usage", "Phoenix allows efficient interior scoring to frontcourt anchors"], risks: ["A lopsided score could trim fourth-quarter minutes"], breakdown: { projectionEdge: 28, currentForm: 14, injuryRole: 13 } },
  { sport: "WNBA", playerName: "Caitlin Clark", team: "IND", opponent: "CHI", statType: "Assists", line: 8.5, direction: "More", projection: 9.6, edgePercent: 12.9, coveredScore: 86, recommendationLabel: "Strong Edge", confidence: "Medium-High", reasons: ["Ball-dominant role creates repeatable passing volume", "Opponent coverage concedes above-the-break creation"], risks: ["Assist conversion depends on teammate shooting", "Chicago can force turnovers before a passing chance develops"], breakdown: { projectionEdge: 27, currentForm: 13, opponentWeakness: 13 } },
  { sport: "WNBA", playerName: "Napheesa Collier", team: "MIN", opponent: "SEA", statType: "Rebounds", line: 8.5, direction: "More", projection: 9.4, edgePercent: 10.6, coveredScore: 81, recommendationLabel: "Good Play", confidence: "Medium-High", reasons: ["Consistent rebounding share across competitive game scripts", "Seattle produces an above-average number of frontcourt chances"], risks: ["Foul trouble is the clearest path to reduced minutes"] },

  { sport: "NFL", playerName: "Justin Jefferson", team: "MIN", opponent: "GB", statType: "Receiving Yards", line: 82.5, direction: "More", projection: 96.2, edgePercent: 16.6, coveredScore: 89, recommendationLabel: "Strong Edge", confidence: "High", reasons: ["Target-share projection leads the slate", "Coverage matchup favors boundary and intermediate volume"], risks: ["Double teams can redistribute high-value targets", "A run-heavy game script would reduce total pass volume"], breakdown: { projectionEdge: 29, currentForm: 13, matchupHistory: 10 } },
  { sport: "NFL", playerName: "Josh Allen", team: "BUF", opponent: "MIA", statType: "Rushing Yards", line: 38.5, direction: "More", projection: 44.8, edgePercent: 16.4, coveredScore: 85, recommendationLabel: "Strong Edge", confidence: "Medium-High", reasons: ["Designed-run share rises in high-leverage matchups", "Man coverage opens scramble lanes"], risks: ["Buffalo may limit contact if playing from ahead"], breakdown: { projectionEdge: 28, environment: 3, volatilityPenalty: -5 } },
  { sport: "NFL", playerName: "Breece Hall", team: "NYJ", opponent: "NE", statType: "Rushing + Receiving Yards", line: 91.5, direction: "More", projection: 101.3, edgePercent: 10.7, coveredScore: 79, recommendationLabel: "Good Play", confidence: "Medium", reasons: ["Dual-role workload protects against game-script changes", "Projected touch count is safely above his season median"], risks: ["Offensive-line uncertainty lowers efficiency confidence"] },

  { sport: "NBA", playerName: "Nikola Jokić", team: "DEN", opponent: "SAC", statType: "Assists", line: 9.5, direction: "More", projection: 11.1, edgePercent: 16.8, coveredScore: 92, recommendationLabel: "Strong Edge", confidence: "High", reasons: ["Matchup encourages offense through the elbow", "Teammate availability concentrates creation in his hands"], risks: ["Teammates still have to make the shots he creates", "A comfortable Denver lead could shorten his fourth-quarter run"], breakdown: { projectionEdge: 30, currentForm: 14, injuryRole: 14, marketContext: 9 } },
  { sport: "NBA", playerName: "Shai Gilgeous-Alexander", team: "OKC", opponent: "DAL", statType: "Points", line: 30.5, direction: "More", projection: 34.0, edgePercent: 11.5, coveredScore: 86, recommendationLabel: "Strong Edge", confidence: "Medium-High", reasons: ["High floor from drives and free-throw creation", "Market projection remains above the listed line"], risks: ["Dallas can slow the game and force early kick-outs"] },
  { sport: "NBA", playerName: "Victor Wembanyama", team: "SAS", opponent: "HOU", statType: "Blocks", line: 3.5, direction: "Less", projection: 2.9, edgePercent: 17.1, coveredScore: 78, recommendationLabel: "Good Play", confidence: "Medium", reasons: ["Houston attempts fewer shots at the rim than league average", "The under projection retains room below a demanding line"], risks: ["Blocks are extremely volatile and can cluster quickly"], breakdown: { projectionEdge: 26, volatilityPenalty: -8 } },

  { sport: "Tennis", playerName: "Carlos Alcaraz", team: "ESP", opponent: "Alexander Zverev", statType: "Break Points Won", line: 3.5, direction: "More", projection: 4.3, edgePercent: 15.2, coveredScore: 88, recommendationLabel: "Strong Edge", confidence: "Medium-High", reasons: ["Return model creates repeated pressure on second serves", "Surface profile strengthens his point-by-point edge"], risks: ["A short straight-sets match reduces break opportunities"], breakdown: { projectionEdge: 28, matchupHistory: 12, environment: 6 } },
  { sport: "Tennis", playerName: "Iga Świątek", team: "POL", opponent: "Coco Gauff", statType: "Games Won", line: 12.5, direction: "More", projection: 14.1, edgePercent: 12.8, coveredScore: 84, recommendationLabel: "Good Play", confidence: "Medium-High", reasons: ["Surface-adjusted hold and return rates both grade strongly", "Head-to-head patterns support sustained return pressure"], risks: ["A dominant two-set win can still fall near the number"] },
  { sport: "Tennis", playerName: "Jannik Sinner", team: "ITA", opponent: "Daniil Medvedev", statType: "Aces", line: 8.5, direction: "More", projection: 9.4, edgePercent: 10.6, coveredScore: 77, recommendationLabel: "Good Play", confidence: "Medium", reasons: ["Expected match length supports service volume", "Indoor conditions reward first-strike serving"], risks: ["Opponent return depth suppresses clean ace lanes"], breakdown: { volatilityPenalty: -6, dataQualityPenalty: -3 } },
];

const startHours: Record<Sport, number> = { MLB: 19, WNBA: 20, NFL: 16, NBA: 19, Tennis: 11 };
const environmentText: Record<Sport, string> = {
  MLB: "Park and weather can change batted-ball carry and pitching conditions.",
  WNBA: "Expected pace, rest, and home-court setting shape possession and minute expectations.",
  NFL: "Weather, venue, and likely game script can change play volume and efficiency.",
  NBA: "Expected pace, rest, and venue affect possessions and playing-time expectations.",
  Tennis: "Surface, court speed, and expected match length change opportunity for this stat.",
};

function mockGameTime(sport: Sport, index: number) {
  const date = new Date("2026-07-03T12:00:00-04:00");
  date.setHours(startHours[sport] + (index % 3), index % 2 ? 30 : 10, 0, 0);
  return date.toISOString();
}

function mockRecentValues(projection: number, line: number, index: number) {
  const pattern = [-0.16, 0.09, -0.04, 0.18, 0.03, -0.11, 0.14, 0.06, -0.08, 0.12];
  return pattern.map((change, offset) => Number(Math.max(0, projection + line * change + ((index + offset) % 3 - 1) * line * .025).toFixed(1)));
}

function factorNotes(seed: Seed, dataQuality: DataQuality, recent: number[]): Record<keyof ScoreBreakdown, string> {
  const second = seed.reasons[1] ?? `The ${seed.opponent} matchup does not contradict the estimate`;
  const roleReason = seed.reasons.find((reason) => /role|usage|minutes|workload|availability|touch|target|creation/i.test(reason));
  const marketReason = seed.reasons.find((reason) => /\bmarket\b|\bline\b|projection|consensus/i.test(reason));
  const hasHistory = seed.reasons.some((reason) => /history|head-to-head/i.test(reason));
  const hasEnvironment = seed.reasons.some((reason) => /park|surface|indoor|weather|rest|pace|travel/i.test(reason));
  const lastFive = recent.slice(-5);
  const recentAverage = Number((recent.reduce((sum, value) => sum + value, 0) / recent.length).toFixed(1));
  const lastFiveAverage = Number((lastFive.reduce((sum, value) => sum + value, 0) / lastFive.length).toFixed(1));
  const clears = recent.filter((value) => seed.direction === "More" ? value > seed.line : value < seed.line).length;
  const missing = [!hasHistory && "direct opponent history", !roleReason && "confirmed role-change data", !marketReason && "line-movement snapshots", !hasEnvironment && "game-setting evidence"].filter(Boolean).join(", ");
  const activeInputs = ["recent performance", "opponent profile", roleReason && "role/volume context", marketReason && "market comparison", hasEnvironment && "game setting"].filter(Boolean).join(", ");
  return {
    projectionEdge: `The ${seed.projection} estimate blends these active inputs: ${activeInputs}. It reaches the model's top edge band only after those inputs move the expected ${seed.statType} materially beyond ${seed.line}; the percentage gap does not create the projection by itself.`,
    currentForm: `The mock game log cleared this line ${clears} times in 10. Its full-sample average is ${recentAverage}, while the last-five average is ${lastFiveAverage}; that comparison shows whether the trend is strengthening or fading.`,
    matchupHistory: hasHistory ? `${seed.reasons.find((reason) => /history|head-to-head/i.test(reason))}. This is treated as supporting context, not a substitute for current form.` : `No reliable direct head-to-head sample is attached for ${seed.playerName} against ${seed.opponent}, so this factor is neutral instead of using a tiny or invented sample.`,
    opponentWeakness: `${second}. This is the opponent-specific evidence used to judge whether ${seed.opponent} tends to allow the role or stat opportunity needed for ${seed.statType}.`,
    injuryRole: roleReason ? `${roleReason}. The relevant question is whether that changes expected volume—minutes, touches, targets, plate appearances, or service opportunities—before the game starts.` : `${seed.playerName} is being evaluated at the normal expected role. No confirmed teammate absence, restriction, lineup promotion, or workload change is being used as an extra reason to like the pick.`,
    marketContext: marketReason ? `${marketReason}. The live version will preserve the opening and current comparison so this confirmation can be audited.` : `No verified opening-to-current line history is attached to this mock. Market movement is therefore neutral rather than guessed from the displayed ${seed.line} line.`,
    environment: hasEnvironment ? `${seed.reasons.find((reason) => /park|surface|indoor|weather|rest|pace|travel/i.test(reason))}. ${environmentText[seed.sport]}` : `No verified venue, weather, pace, rest, travel, or surface advantage is attached to this mock matchup, so game setting is not being used to inflate the case.`,
    volatilityPenalty: `${seed.risks[0] ?? `${seed.statType} can vary sharply from game to game`}. That risk matters even when the average is favorable because one game can be decided by limited opportunities or conversion variance.`,
    dataQualityPenalty: `${dataQuality} data coverage is assigned because the mock is still missing ${missing || "no major tracked category"}. Missing inputs remain visible and neutral; they are never replaced with a fabricated trend.`,
  };
}

const sportRanks = new Map<Sport, number>();
export const mockOpportunities: Opportunity[] = seeds.map((seed, index) => {
  const rank = (sportRanks.get(seed.sport) ?? 0) + 1;
  sportRanks.set(seed.sport, rank);
  const dataQuality = seed.dataQuality ?? (seed.confidence === "High" ? "High" : "Medium");
  const suppliedBreakdown = { ...baseBreakdown, ...seed.breakdown };
  const recentValues = mockRecentValues(seed.projection, seed.line, index);
  const hasHistory = seed.reasons.some((reason) => /history|head-to-head/i.test(reason));
  const hasRole = seed.reasons.some((reason) => /role|usage|minutes|workload|availability|touch|target|creation/i.test(reason));
  const hasMarket = seed.reasons.some((reason) => /\bmarket\b|\bline\b|projection|consensus/i.test(reason));
  const hasEnvironment = seed.reasons.some((reason) => /park|surface|indoor|weather|rest|pace|travel/i.test(reason));
  const result: ScoreResult = {
    rawEdge: seed.direction === "More" ? seed.projection - seed.line : seed.line - seed.projection,
    adjustedEdge: seed.direction === "More" ? seed.projection - seed.line : seed.line - seed.projection,
    edgePercent: seed.edgePercent,
    valueRating: 0,
    score: seed.coveredScore,
    label: labelForScore(seed.coveredScore),
    confidence: seed.confidence,
    confidenceScore: seed.confidence === "High" ? 88 : seed.confidence === "Medium-High" ? 73 : seed.confidence === "Medium" ? 60 : 45,
    breakdown: {
      ...suppliedBreakdown,
      projectionEdge: suppliedBreakdown.projectionEdge,
      matchupHistory: hasHistory ? suppliedBreakdown.matchupHistory : 0,
      injuryRole: hasRole ? suppliedBreakdown.injuryRole : 0,
      marketContext: hasMarket ? suppliedBreakdown.marketContext : 0,
      environment: hasEnvironment ? suppliedBreakdown.environment : 0,
    },
    riskFlags: [] as string[],
  };
  const explanation = explainScore({ ...seed, dataQuality, result });
  return {
    ...seed,
    id: `${seed.sport.toLowerCase()}-${index + 1}`,
    rank,
    rawEdge: result.rawEdge,
    adjustedEdge: result.adjustedEdge,
    edgePercent: result.edgePercent,
    valueRating: result.valueRating,
    coveredScore: result.score,
    recommendationLabel: result.label,
    confidence: result.confidence,
    confidenceScore: result.confidenceScore,
    breakdown: result.breakdown,
    dataQuality,
    riskFlags: result.riskFlags,
    plainEnglishSummary: explanation.summary,
    modelNotes: explanation.modelNotes,
    factorNotes: factorNotes(seed, dataQuality, recentValues),
    gameTime: mockGameTime(seed.sport, index),
    headshotUrl: generatedAvatarUrl(seed.playerName, seed.sport),
    recentValues,
    sourceProvider: "Demo",
  };
});
