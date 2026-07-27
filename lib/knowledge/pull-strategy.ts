import type { ActiveKnowledgeLeagueCode, KnowledgeSportCode, PullStrategyConfig } from "@/lib/knowledge/types";

const defaultSportsbooks = ["DraftKings", "FanDuel"] as const;

type DefaultSharpMarket = {
  marketType: string;
  providerMarketType: string;
  enabled: boolean;
  tier: "core" | "secondary";
};

const basketballFocusedMarkets: DefaultSharpMarket[] = [
  { marketType: "player_points", providerMarketType: "player_points", enabled: true, tier: "core" },
  { marketType: "player_rebounds", providerMarketType: "player_rebounds", enabled: true, tier: "core" },
  { marketType: "player_assists", providerMarketType: "player_assists", enabled: true, tier: "core" },
  { marketType: "player_pra", providerMarketType: "player_points_rebounds_assists", enabled: true, tier: "core" },
  { marketType: "player_threes", providerMarketType: "player_threes", enabled: true, tier: "core" },
  { marketType: "player_points_rebounds", providerMarketType: "player_points_rebounds", enabled: false, tier: "secondary" },
  { marketType: "player_points_assists", providerMarketType: "player_points_assists", enabled: false, tier: "secondary" },
  { marketType: "player_rebounds_assists", providerMarketType: "player_rebounds_assists", enabled: false, tier: "secondary" },
];

// A bounded, authorized live diagnostic (2 physical SharpAPI requests, WNBA/
// DraftKings, one per market) confirmed both player_pra and player_threes
// return a well-formed, successful (200) but genuinely EMPTY response
// (`data: []`) for WNBA -- not a 400/normalization/identity defect, a
// provider-catalog gap specific to WNBA's market coverage. Disabled here so
// the fallback default matches the corresponding live odds_pull_configs
// change (prepared, not yet applied -- see docs/AGENT_HANDOFF.md) instead of
// continuing to spend 2 of WNBA's 8 per-cycle Sharp requests on markets that
// return nothing. NBA was not diagnosed and keeps its own array below
// unchanged -- this finding is WNBA-specific, not a basketball-wide one.
const wnbaFocusedMarkets: DefaultSharpMarket[] = basketballFocusedMarkets.map((market) =>
  market.marketType === "player_pra" || market.marketType === "player_threes"
    ? { ...market, enabled: false, tier: "secondary" as const }
    : market,
);

const mlbFocusedMarkets: DefaultSharpMarket[] = [
  { marketType: "batter_hits", providerMarketType: "player_hits", enabled: true, tier: "core" },
  { marketType: "batter_total_bases", providerMarketType: "player_total_bases", enabled: true, tier: "core" },
  { marketType: "pitcher_strikeouts", providerMarketType: "player_strikeouts", enabled: true, tier: "core" },
  { marketType: "batter_runs", providerMarketType: "player_runs", enabled: true, tier: "core" },
  { marketType: "batter_rbis", providerMarketType: "player_rbis", enabled: true, tier: "core" },
  { marketType: "batter_home_runs", providerMarketType: "player_home_runs", enabled: false, tier: "secondary" },
  { marketType: "batter_walks", providerMarketType: "player_walks", enabled: false, tier: "secondary" },
  { marketType: "batter_stolen_bases", providerMarketType: "player_stolen_bases", enabled: false, tier: "secondary" },
  { marketType: "batter_hits_runs_rbis", providerMarketType: "player_hits_runs_rbis", enabled: false, tier: "secondary" },
  { marketType: "pitcher_outs_recorded", providerMarketType: "player_outs_recorded", enabled: false, tier: "secondary" },
];

function enabled(name: string, fallback = true) {
  const value = process.env[name];
  if (!value) return fallback;
  return value.toLowerCase() === "true";
}

function cadence(name: string, fallback: number) {
  const value = Number(process.env[name] ?? "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sportForLeague(league: ActiveKnowledgeLeagueCode): KnowledgeSportCode {
  return league === "MLB" ? "BASEBALL" : "BASKETBALL";
}

function prioritiesForLeague(league: ActiveKnowledgeLeagueCode) {
  if (league === "MLB") return mlbFocusedMarkets;
  if (league === "WNBA") return wnbaFocusedMarkets;
  return basketballFocusedMarkets;
}

export function sharpApiPullStrategy(): PullStrategyConfig[] {
  const leagues: ActiveKnowledgeLeagueCode[] = ["MLB", "WNBA", "NBA"];
  return leagues.flatMap((league, leagueIndex) =>
    prioritiesForLeague(league).flatMap((marketType, marketIndex) =>
      defaultSportsbooks.map((sportsbook, sportsbookIndex) => ({
        provider: "sharpapi",
        sport: sportForLeague(league),
        league,
        marketType: marketType.marketType,
        sportsbook,
        priority: leagueIndex * 100 + marketIndex * 10 + sportsbookIndex + 1,
        pullCadenceMinutes: cadence(`SHARPAPI_${league}_CADENCE_MINUTES`, league === "MLB" ? 1 : 2),
        enabled: enabled(`SHARPAPI_${league}_ENABLED`, league !== "NBA") && marketType.enabled,
        metadata: {
          providerMarketType: marketType.providerMarketType,
          tier: marketType.tier,
        },
      })),
    ),
  );
}

export function listPullStrategies(provider?: PullStrategyConfig["provider"]) {
  const rows = sharpApiPullStrategy();
  return provider ? rows.filter((row) => row.provider === provider) : rows;
}

export function pullStrategiesForLeague(league: ActiveKnowledgeLeagueCode) {
  return listPullStrategies("sharpapi").filter((row) => row.league === league && row.enabled);
}
