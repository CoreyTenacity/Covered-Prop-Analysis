/**
 * Provider identifiers and generic status values that are safe to share with
 * public-facing modules. Operational budgets, cadence, and request controls
 * belong in request-policy.ts instead.
 */
export type ProviderId = "highlightly" | "api-sports" | "big-balls-data" | "the-odds-api" | "sports-game-odds" | "sharpapi" | "official-injuries" | "mlb-stats-api" | "nba-com-stats" | "statcast-savant" | "open-meteo";

export type ProviderStatus = "configured" | "limited" | "unavailable" | "disabled";

export const providerDisplayNames: Readonly<Record<ProviderId, string>> = {
  highlightly: "Highlightly MLB",
  "api-sports": "API-Sports",
  "big-balls-data": "Big Balls Data",
  "the-odds-api": "The Odds API",
  "sports-game-odds": "SportsGameOdds",
  sharpapi: "SharpAPI",
  "official-injuries": "Official injury reports",
  "mlb-stats-api": "MLB Stats API",
  "nba-com-stats": "nba_api / NBA.com",
  "statcast-savant": "Statcast / Baseball Savant",
  "open-meteo": "Open-Meteo weather",
};
