import { BigBallsDataAdapter } from "./big-balls-data.ts";
import { HighlightlyMlbAdapter } from "./highlightly-mlb.ts";
import { MlbStatsApiAdapter } from "./mlb-stats-api.ts";
import { NbaComStatsAdapter } from "./nba-com-stats.ts";
import { OpenMeteoWeatherAdapter } from "./open-meteo-weather.ts";
import { StatcastSavantAdapter } from "./statcast-savant.ts";
import { SharpApiAdapter } from "./sharpapi.ts";
import { SportsGameOddsAdapter } from "./sports-game-odds.ts";
import { TheOddsApiAdapter } from "./the-odds-api.ts";
import { officialInjuryReportConfigured } from "./official-injuries.ts";
import type { ProviderId, ProviderStatus } from "./provider-contracts.ts";
export type { ProviderStatus } from "./provider-contracts.ts";

export type ProviderDiagnostic = {
  id: ProviderId;
  label: string;
  status: ProviderStatus;
  purpose: string;
  sports: string[];
  browserSafe: "no";
};

export function getProviderDiagnostics(): ProviderDiagnostic[] {
  const odds = new TheOddsApiAdapter();
  const sharp = new SharpApiAdapter();
  const sgo = new SportsGameOddsAdapter();
  const bbs = new BigBallsDataAdapter();
  const highlightly = new HighlightlyMlbAdapter();
  const mlbStats = new MlbStatsApiAdapter();
  const nbaStats = new NbaComStatsAdapter();
  const statcast = new StatcastSavantAdapter();
  const openMeteo = new OpenMeteoWeatherAdapter();

  const diagnostics: ProviderDiagnostic[] = [
    {
      id: "the-odds-api",
      label: "The Odds API",
      status: odds.configured() ? "configured" : "disabled",
      purpose: "Consensus lines and event discovery for board construction.",
      sports: ["MLB", "WNBA", "NFL", "NBA"],
      browserSafe: "no",
    },
    {
      id: "sports-game-odds",
      label: "SportsGameOdds",
      status: sgo.configured() ? "configured" : "disabled",
      purpose: "Secondary player-prop coverage when other feeds are thin.",
      sports: ["MLB", "WNBA"],
      browserSafe: "no",
    },
    {
      id: "official-injuries",
      label: "Official injury reports",
      status: officialInjuryReportConfigured("MLB") || officialInjuryReportConfigured("WNBA") || officialInjuryReportConfigured("NBA") || officialInjuryReportConfigured("NFL") ? "configured" : "disabled",
      purpose: "Official MLB injured-list context plus optional NBA, WNBA, and NFL report sources.",
      sports: ["MLB", "WNBA", "NBA", "NFL"],
      browserSafe: "no",
    },
    {
      id: "mlb-stats-api",
      label: "MLB Stats API",
      status: mlbStats.configured() ? "configured" : "disabled",
      purpose: "Official MLB player logs, season context, and deeper stat enrichment.",
      sports: ["MLB"],
      browserSafe: "no",
    },
    {
      id: "statcast-savant",
      label: "Statcast / Baseball Savant",
      status: statcast.configured() ? "configured" : "disabled",
      purpose: "Pitch-level MLB context such as contact quality, whiffs, and batted-ball signals.",
      sports: ["MLB"],
      browserSafe: "no",
    },
    {
      id: "open-meteo",
      label: "Open-Meteo weather",
      status: openMeteo.configured() ? "configured" : "disabled",
      purpose: "Optional MLB weather context for park, wind, and precipitation.",
      sports: ["MLB", "NFL"],
      browserSafe: "no",
    },
    {
      id: "nba-com-stats",
      label: "nba_api / NBA.com",
      status: nbaStats.configured() ? "configured" : "disabled",
      purpose: "Free NBA.com player logs and official stats, using nba_api-compatible endpoint shapes.",
      sports: ["NBA"],
      browserSafe: "no",
    },
    {
      id: "wehoop-wnba",
      label: "stats.nba.com WNBA wrapper (deprecated, opt-in only)",
      status: "configured",
      purpose: "Legacy WNBA player logs, team context, and recent-form enrichment via stats.nba.com (LeagueID=10).",
      sports: ["WNBA"],
      browserSafe: "no",
    },
    {
      id: "espn-wnba",
      label: "ESPN WNBA (site.api.espn.com)",
      status: "configured",
      purpose: "Current-day schedule, live game status, scores, and box scores for WNBA.",
      sports: ["WNBA"],
      browserSafe: "no",
    },
    {
      id: "sportsdataverse-wnba",
      label: "SportsDataverse wehoop-wnba-data (ESPN-backed parquet releases)",
      status: "configured",
      purpose: "Durable completed-game records: historical player and team box scores for WNBA.",
      sports: ["WNBA"],
      browserSafe: "no",
    },
    {
      id: "sharpapi",
      label: "SharpAPI",
      status: sharp.configured() ? "configured" : "disabled",
      purpose: "Secondary pre-match odds and player-prop coverage.",
      sports: ["MLB", "WNBA", "NFL", "NBA"],
      browserSafe: "no",
    },
    {
      id: "big-balls-data",
      label: "Big Balls Data",
      status: bbs.configured() ? "configured" : "disabled",
      purpose: "MLB match discovery and lineup/context enrichment.",
      sports: ["MLB"],
      browserSafe: "no",
    },
    {
      id: "highlightly",
      label: "Highlightly MLB",
      status: highlightly.configured() ? "configured" : "disabled",
      purpose: "MLB player identity and player-stat enrichment.",
      sports: ["MLB"],
      browserSafe: "no",
    },
  ].map((provider) => ({
    ...provider,
    status: provider.status === "configured" || provider.status === "limited" ? provider.status : "unavailable",
  })) as ProviderDiagnostic[];

  return diagnostics;
}
