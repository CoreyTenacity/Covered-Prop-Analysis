import { getProviderCache, putProviderCache } from "@/lib/db/provider-cache";
import type { Sport } from "@/lib/types";
import type { ProviderEvent } from "./provider-adapter";

export type ScheduleGame = {
  id: string;
  sport: Sport;
  gameTime: string;
  homeTeam: string;
  awayTeam: string;
  source: string;
  venue?: string | null;
  status?: string | null;
  dayNight?: string | null;
  doubleHeader?: string | null;
  homeTeamAbbreviation?: string | null;
  awayTeamAbbreviation?: string | null;
  probablePitchers?: {
    home?: { name?: string | null; hand?: string | null } | null;
    away?: { name?: string | null; hand?: string | null } | null;
  } | null;
};
export type DailyScheduleCatalog = { refreshedAt: string; today: string; tomorrow: string; games: ScheduleGame[]; errors: string[] };

const easternDate = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const nextDate = (date: Date) => new Date(date.getTime() + 24 * 60 * 60 * 1000);
const cacheKey = (date: string) => `daily-schedule-catalog:${date}`;

function fromEvent(event: ProviderEvent): ScheduleGame | null {
  const sport = ({ baseball_mlb: "MLB", basketball_wnba: "WNBA", basketball_nba: "NBA", americanfootball_nfl: "NFL" } as const)[event.sportKey];
  return sport ? { id: event.id, sport, gameTime: event.commenceTime, homeTeam: event.homeTeam, awayTeam: event.awayTeam, source: "cached event discovery" } : null;
}

function parseMlb(payload: unknown): ScheduleGame[] {
  const dates = payload && typeof payload === "object" && Array.isArray((payload as { dates?: unknown[] }).dates) ? (payload as { dates: Array<{ games?: unknown[] }> }).dates : [];
  return dates.flatMap((date) => Array.isArray(date.games) ? date.games : []).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const game = raw as Record<string, unknown>;
    const teams = game.teams as {
      home?: {
        team?: { name?: string; abbreviation?: string };
        probablePitcher?: { fullName?: string; pitchHand?: { code?: string; description?: string } };
      };
      away?: {
        team?: { name?: string; abbreviation?: string };
        probablePitcher?: { fullName?: string; pitchHand?: { code?: string; description?: string } };
      };
    } | undefined;
    const id = String(game.gamePk ?? "");
    const gameTime = String(game.gameDate ?? "");
    const homeTeam = teams?.home?.team?.name ?? "";
    const awayTeam = teams?.away?.team?.name ?? "";
    const venue = typeof game.venue === "object" && game.venue && typeof (game.venue as { name?: unknown }).name === "string"
      ? String((game.venue as { name?: string }).name)
      : null;
    const status = typeof game.status === "object" && game.status
      ? String((game.status as { detailedState?: unknown; abstractGameState?: unknown }).detailedState ?? (game.status as { abstractGameState?: unknown }).abstractGameState ?? "")
      : null;
    const dayNight = typeof game.dayNight === "string" ? game.dayNight : null;
    const doubleHeader = typeof game.doubleHeader === "string" ? game.doubleHeader : null;
    const homeProbable = teams?.home?.probablePitcher ?? null;
    const awayProbable = teams?.away?.probablePitcher ?? null;
    const probablePitchers = homeProbable || awayProbable ? {
      home: homeProbable ? {
        name: typeof homeProbable.fullName === "string" ? homeProbable.fullName : null,
        hand: homeProbable?.pitchHand?.code ?? homeProbable?.pitchHand?.description ?? null,
      } : null,
      away: awayProbable ? {
        name: typeof awayProbable.fullName === "string" ? awayProbable.fullName : null,
        hand: awayProbable?.pitchHand?.code ?? awayProbable?.pitchHand?.description ?? null,
      } : null,
    } : null;
    return id && gameTime && homeTeam && awayTeam ? [{ id, sport: "MLB" as const, gameTime, homeTeam, awayTeam, source: "MLB Stats API", venue, status, dayNight, doubleHeader, probablePitchers, homeTeamAbbreviation: teams?.home?.team?.abbreviation ?? null, awayTeamAbbreviation: teams?.away?.team?.abbreviation ?? null }] : [];
  });
}

export async function refreshDailyScheduleCatalog(events: ProviderEvent[], now = new Date()): Promise<DailyScheduleCatalog> {
  const today = easternDate(now);
  const tomorrow = easternDate(nextDate(now));
  const errors: string[] = [];
  let mlbGames: ScheduleGame[] = [];
  try {
    const url = new URL("https://statsapi.mlb.com/api/v1/schedule");
    url.searchParams.set("sportId", "1");
    url.searchParams.set("startDate", today);
    url.searchParams.set("endDate", tomorrow);
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000), cache: "no-store" });
    if (!response.ok) throw new Error(`MLB schedule returned ${response.status}`);
    mlbGames = parseMlb(await response.json());
  } catch (error) { errors.push(error instanceof Error ? error.message : "MLB schedule unavailable"); }

  const discovered = events.map(fromEvent).filter((game): game is ScheduleGame => Boolean(game));
  const games = [...new Map([...mlbGames, ...discovered]
    .filter((game) => [today, tomorrow].includes(easternDate(new Date(game.gameTime))))
    .map((game) => [`${game.sport}|${game.id}`, game])).values()]
    .sort((left, right) => new Date(left.gameTime).getTime() - new Date(right.gameTime).getTime());
  const result = { refreshedAt: new Date().toISOString(), today, tomorrow, games, errors };
  await putProviderCache({ cacheKey: cacheKey(today), provider: "mlb-stats-api", payload: result, expiresAt: new Date(Date.now() + 18 * 60 * 60 * 1000).toISOString() });
  return result;
}

export async function getDailyScheduleCatalog(now = new Date()): Promise<DailyScheduleCatalog> {
  const today = easternDate(now);
  const cached = await getProviderCache<DailyScheduleCatalog>(cacheKey(today));
  return cached?.payload ?? { refreshedAt: new Date(0).toISOString(), today, tomorrow: easternDate(nextDate(now)), games: [], errors: [] };
}
