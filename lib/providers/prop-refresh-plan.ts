import type { ProviderEvent } from "./provider-adapter";
import { estimateEventPropsCost } from "./the-odds-api.ts";
import { isSportInSeason } from "./sport-season.ts";

export const approvedPropMarkets: Record<string, string[]> = {
  baseball_mlb: [
    "batter_singles",
    "batter_doubles",
    "batter_triples",
    "batter_hits",
    "batter_total_bases",
    "batter_runs",
    "batter_rbis",
    "batter_home_runs",
    "batter_walks",
    "batter_stolen_bases",
    "batter_hit_by_pitch",
    "batter_strikeouts",
    "pitcher_strikeouts",
    "pitcher_outs_recorded",
    "pitcher_earned_runs",
    "pitcher_hits_allowed",
    "pitcher_walks_allowed",
    "batter_fantasy_score",
    "pitcher_fantasy_score",
    "batter_hits_runs_rbis",
    "batter_runs_rbis",
    "batter_hits_total_bases",
    "batter_hits_runs_total_bases",
    "batter_hits_runs_total_bases_rbis",
    "batter_on_base_percentage",
    "batter_slugging_percentage",
  ],
  basketball_wnba: [
    "player_points",
    "player_rebounds",
    "player_assists",
    "player_points_rebounds",
    "player_points_assists",
    "player_rebounds_assists",
    "player_points_rebounds_assists",
  ],
  basketball_nba: [
    "player_points",
    "player_rebounds",
    "player_assists",
    "player_points_rebounds",
    "player_points_assists",
    "player_rebounds_assists",
    "player_points_rebounds_assists",
  ],
  americanfootball_nfl: ["player_pass_yds", "player_rush_reception_yds"],
};

const sportKeyToSport: Record<string, "MLB" | "WNBA" | "NFL" | "NBA"> = {
  baseball_mlb: "MLB",
  basketball_wnba: "WNBA",
  basketball_nba: "NBA",
  americanfootball_nfl: "NFL",
};

function easternDate(value: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

export type PlannedPropRequest = {
  sportKey: string;
  eventId: string;
  matchup: string;
  commenceTime: string;
  markets: string[];
  regions: string[];
  maximumCost: number;
};

function marketForPass(event: ProviderEvent, pass: number) {
  const available = approvedPropMarkets[event.sportKey] ?? [];
  if (!available.length) return null;
  if (pass >= available.length) return null;
  const hash = [...event.id].reduce((total, character) => total + character.charCodeAt(0), 0);
  return available[(hash + pass) % available.length] ?? null;
}

function slateWeightedBudgets(bySport: Map<string, ProviderEvent[]>, totalBudget: number) {
  const sports = [...bySport.entries()].filter(([, games]) => games.length > 0);
  const totalGames = sports.reduce((sum, [, games]) => sum + games.length, 0);
  if (!totalGames || totalBudget <= 0) return new Map<string, number>();
  const shares = sports.map(([sportKey, games]) => {
    const exact = totalBudget * (games.length / totalGames);
    return { sportKey, budget: Math.floor(exact), remainder: exact - Math.floor(exact), games: games.length };
  });
  let assigned = shares.reduce((sum, share) => sum + share.budget, 0);
  for (const share of [...shares].sort((a, b) => b.remainder - a.remainder || b.games - a.games)) {
    if (assigned >= totalBudget) break;
    share.budget += 1;
    assigned += 1;
  }
  return new Map(shares.map((share) => [share.sportKey, share.budget]));
}

export function buildPropRefreshPlan(events: ProviderEvent[], options: {
  now?: Date;
  horizonHours?: number;
  maximumTotalCost?: number;
  allowedSportKeys?: string[];
  sportBudgets?: Partial<Record<string, number>>;
} = {}) {
  const now = options.now ?? new Date();
  const targetDate = easternDate(now);
  const horizon = now.getTime() + (options.horizonHours ?? 48) * 60 * 60 * 1000;
  const maximumTotalCost = options.maximumTotalCost ?? 15;
  const allowedSportKeys = options.allowedSportKeys ? new Set(options.allowedSportKeys) : null;
  const requests: PlannedPropRequest[] = [];
  let maximumCost = 0;

  const candidates = events
    .filter((event) => approvedPropMarkets[event.sportKey])
    .filter((event) => !allowedSportKeys || allowedSportKeys.has(event.sportKey))
    .filter((event) => {
      const sport = sportKeyToSport[event.sportKey];
      return sport ? isSportInSeason(sport, now) : false;
    })
    .filter((event) => {
      const start = new Date(event.commenceTime).getTime();
      return Number.isFinite(start)
        && start >= now.getTime()
        && start <= horizon
        && easternDate(new Date(start)) === targetDate;
    });

  const bySport = new Map<string, ProviderEvent[]>();
  for (const event of candidates) {
    const list = bySport.get(event.sportKey) ?? [];
    list.push(event);
    bySport.set(event.sportKey, list);
  }

  for (const list of bySport.values()) {
    list.sort((a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime());
  }

  const remainingBySport = slateWeightedBudgets(bySport, maximumTotalCost);
  for (const [sportKey, budget] of Object.entries(options.sportBudgets ?? {})) {
    if (typeof budget === "number" && Number.isFinite(budget)) remainingBySport.set(sportKey, Math.max(0, Math.floor(budget)));
  }
  const allocatedBySport = new Map(remainingBySport);

  const sportOrder = ["baseball_mlb", "basketball_wnba"].filter((sportKey) => bySport.has(sportKey));

  // Breadth first: every affordable game gets one core market before any
  // matchup receives a second market. Later passes rotate the extra market so
  // repeated refreshes do not stay stuck on the same narrow stat category.
  let pass = 0;
  let madeProgress = true;
  while (madeProgress && maximumCost < maximumTotalCost) {
    madeProgress = false;
    for (const sportKey of sportOrder) {
      const list = bySport.get(sportKey);
      if (!list?.length) continue;
      for (const event of list) {
        const market = marketForPass(event, pass);
        if (!market) continue;
        const markets = [market];
        const requestCost = estimateEventPropsCost(markets, ["us"]);
        const sportBudget = remainingBySport.get(sportKey) ?? 0;
        if (requestCost > sportBudget || maximumCost + requestCost > maximumTotalCost) continue;
        requests.push({
          sportKey: event.sportKey,
          eventId: event.id,
          matchup: `${event.awayTeam} at ${event.homeTeam}`,
          commenceTime: event.commenceTime,
          markets,
          regions: ["us"],
          maximumCost: requestCost,
        });
        maximumCost += requestCost;
        remainingBySport.set(sportKey, sportBudget - requestCost);
        madeProgress = true;
      }
    }
    pass += 1;
  }

  return {
    requests,
    maximumCost,
    ceiling: maximumTotalCost,
    propCallsEnabled: false,
    sportBudgets: Object.fromEntries(allocatedBySport),
    remainingSportBudgets: Object.fromEntries(remainingBySport),
  };
}
