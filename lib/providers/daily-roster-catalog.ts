import { getProviderCache, putProviderCache } from "@/lib/db/provider-cache";
import type { Sport } from "@/lib/types";
import type { ProviderEvent } from "./provider-adapter";
import { MlbStatsApiAdapter, type MlbStatsApiPlayer } from "./mlb-stats-api";
import { NbaComStatsAdapter } from "./nba-com-stats";
import { WeHoopWnbaAdapter } from "./wehoop-wnba";
import { resolveWnbaLeagueId } from "./wnba-league-path";

export type DailyRosterPlayer = {
  sport: Sport;
  eventId: string;
  gameTime: string;
  team: string;
  opponent: string;
  playerId: string;
  playerName: string;
  teamId?: string | null;
  teamAbbreviation?: string | null;
  leagueId?: string | null;
};

export type DailyRosterCatalog = {
  date: string;
  refreshedAt: string;
  players: DailyRosterPlayer[];
  providerErrors: Array<{ sport: Sport; message: string }>;
};

const cacheKey = (date: string) => `daily-roster-catalog:${date}`;
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const normalizeLookup = (value: string | null | undefined) => value ? normalize(value) : "";
const easternDate = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

function teamMatches(left: string, right: string) {
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.includes(b) || b.includes(a);
}

function seasonCandidates(now: Date) {
  const year = now.getFullYear();
  const currentSeasonStart = now.getMonth() >= 9 ? year : year - 1;
  return [...new Set([
    `${currentSeasonStart}-${String(currentSeasonStart + 1).slice(-2)}`,
    String(year),
    String(currentSeasonStart + 1),
  ])];
}

function hasSportPlayers(catalog: DailyRosterCatalog, sport: Sport) {
  return catalog.players.some((player) => player.sport === sport);
}

async function loadCachedEvents() {
  const [mlb, wnba, nba] = await Promise.all([
    getProviderCache<ProviderEvent[]>("the-odds-api:events:baseball_mlb"),
    getProviderCache<ProviderEvent[]>("the-odds-api:events:basketball_wnba"),
    getProviderCache<ProviderEvent[]>("the-odds-api:events:basketball_nba"),
  ]);
  return [mlb, wnba, nba].flatMap((entry) => entry?.payload ?? []);
}

export async function refreshDailyRosterCatalog(events: ProviderEvent[], now = new Date()): Promise<DailyRosterCatalog> {
  const date = easternDate(now);
  const players: DailyRosterPlayer[] = [];
  const providerErrors: DailyRosterCatalog["providerErrors"] = [];
  const mlb = new MlbStatsApiAdapter();
  const nba = new NbaComStatsAdapter();
  const wnba = new WeHoopWnbaAdapter();

  const add = (event: ProviderEvent, sport: Sport, team: string, opponent: string, playerId: string | number, playerName: string, extras?: { teamId?: string | null; teamAbbreviation?: string | null; leagueId?: string | null }) => {
    players.push({ sport, eventId: event.id, gameTime: event.commenceTime, team, opponent, playerId: String(playerId), playerName, teamId: extras?.teamId ?? null, teamAbbreviation: extras?.teamAbbreviation ?? null, leagueId: extras?.leagueId ?? null });
  };

  const todaysEvents = events.filter((event) => easternDate(new Date(event.commenceTime)) === date);
  const mlbEvents = todaysEvents.filter((item) => item.sportKey === "baseball_mlb");
  const mlbTeams = [...new Set(mlbEvents.flatMap((event) => [event.homeTeam, event.awayTeam]))];
  const loadMlbRoster = async (team: string): Promise<readonly [string, MlbStatsApiPlayer[]]> => {
    try { return [team, await mlb.fetchActiveRoster(team)] as const; }
    catch (error) {
      providerErrors.push({ sport: "MLB", message: error instanceof Error ? error.message : `Could not load ${team} roster.` });
      return [team, [] as MlbStatsApiPlayer[]] as const;
    }
  };
  // Load one roster first so the shared MLB team directory is cached before
  // the remaining team-roster requests fan out.
  const firstRoster = mlbTeams[0] ? [await loadMlbRoster(mlbTeams[0])] : [];
  const rosterResults = [...firstRoster, ...await Promise.all(mlbTeams.slice(1).map(loadMlbRoster))];
  const rosters = new Map(rosterResults);
  for (const event of mlbEvents) {
    for (const [team, opponent] of [[event.homeTeam, event.awayTeam], [event.awayTeam, event.homeTeam]] as const) {
      (rosters.get(team) ?? []).forEach((player) => add(event, "MLB", team, opponent, player.id, player.fullName, { teamId: player.currentTeam?.id ? String(player.currentTeam.id) : null, teamAbbreviation: player.currentTeam?.abbreviation ?? null }));
    }
  }

  for (const [sportKey, sport, leagueId, adapter] of [["basketball_wnba", "WNBA", "10", wnba], ["basketball_nba", "NBA", "00", nba]] as const) {
    const sportEvents = todaysEvents.filter((event) => event.sportKey === sportKey);
    if (!sportEvents.length) continue;
    try {
      const resolvedLeagueId = sport === "WNBA" ? (await resolveWnbaLeagueId(now)).leagueId : leagueId;
      const leaguePlayers = (
        await Promise.all(
          seasonCandidates(now).map(async (season) => {
            try {
              return await adapter.fetchCurrentPlayers(resolvedLeagueId, season);
            } catch {
              return [];
            }
          }),
        )
      ).flat();
      const uniqueLeaguePlayers = [...new Map(leaguePlayers.map((player) => [player.id, player])).values()];
      for (const event of sportEvents) {
        for (const [team, opponent] of [[event.homeTeam, event.awayTeam], [event.awayTeam, event.homeTeam]] as const) {
          uniqueLeaguePlayers
            .filter((player) => teamMatches(player.teamName ?? "", team) || teamMatches(player.teamAbbreviation ?? "", team))
            .forEach((player) => add(event, sport, team, opponent, player.id, player.displayFirstLast, { teamId: player.teamId ? String(player.teamId) : null, teamAbbreviation: player.teamAbbreviation ?? null, leagueId: resolvedLeagueId }));
        }
      }
    } catch (error) {
      providerErrors.push({ sport, message: error instanceof Error ? error.message : `Could not load ${sport} players.` });
    }
  }

  const unique = [...new Map(players.map((player) => [`${player.sport}|${player.eventId}|${player.playerId}`, player])).values()];
  const result = { date, refreshedAt: new Date().toISOString(), players: unique, providerErrors };
  await putProviderCache({ cacheKey: cacheKey(date), provider: "mlb-stats-api", payload: result, expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString() });
  return result;
}

export function findDailyRosterPlayer(
  roster: DailyRosterCatalog | null,
  input: {
    sport: Sport;
    playerName: string;
    team?: string | null;
    teamAbbreviation?: string | null;
    playerId?: string | number | null;
    eventId?: string | null;
  },
) {
  if (!roster?.players.length) return null;
  const targetName = normalizeLookup(input.playerName);
  const targetTeam = normalizeLookup(input.team);
  const targetAbbrev = normalizeLookup(input.teamAbbreviation);
  const targetPlayerId = input.playerId !== null && input.playerId !== undefined ? String(input.playerId) : "";
  const targetEventId = input.eventId ?? "";
  return roster.players.find((player) => {
    if (player.sport !== input.sport) return false;
    if (targetPlayerId && player.playerId === targetPlayerId) return true;
    if (targetEventId && player.eventId === targetEventId && normalizeLookup(player.playerName) === targetName) return true;
    const playerName = normalizeLookup(player.playerName);
    const playerTeam = normalizeLookup(player.team);
    const playerAbbrev = normalizeLookup(player.teamAbbreviation);
    const nameHit = playerName === targetName || playerName.includes(targetName) || targetName.includes(playerName);
    const teamHit = Boolean(targetTeam && (playerTeam === targetTeam || playerTeam.includes(targetTeam) || targetTeam.includes(playerTeam)));
    const abbrevHit = Boolean(targetAbbrev && (playerAbbrev === targetAbbrev || playerAbbrev.includes(targetAbbrev) || targetAbbrev.includes(playerAbbrev)));
    return nameHit && (!targetTeam || teamHit || abbrevHit || !targetAbbrev);
  }) ?? null;
}

export async function getDailyRosterCatalog(now = new Date()): Promise<DailyRosterCatalog> {
  const date = easternDate(now);
  const cached = await getProviderCache<DailyRosterCatalog>(cacheKey(date));
  return cached?.payload ?? { date, refreshedAt: new Date(0).toISOString(), players: [], providerErrors: [] };
}

export async function ensureDailyRosterCatalog(now = new Date()): Promise<DailyRosterCatalog> {
  const current = await getDailyRosterCatalog(now);
  const events = await loadCachedEvents();
  const activeSports = [...new Set(events.map((event) => {
    if (event.sportKey === "baseball_mlb") return "MLB" as const;
    if (event.sportKey === "basketball_wnba") return "WNBA" as const;
    if (event.sportKey === "basketball_nba") return "NBA" as const;
    return null;
  }).filter(Boolean))] as Sport[];

  const missingActiveSports = activeSports.filter((sport) => !hasSportPlayers(current, sport));
  if (current.players.length && !missingActiveSports.length) return current;

  // A new deployment can arrive before the once-daily cron, or a partial cache
  // can miss one sport. Rebuild from the existing event cache so MLB/WNBA/NBA
  // roster identity stays synchronized for the live board and slip tools.
  if (events.length) return refreshDailyRosterCatalog(events, now);
  return current;
}
