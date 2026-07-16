import type { ProviderFetchResult } from "./provider-adapter";
import { getProviderCache, putProviderCache, touchTodayBoardContext } from "@/lib/db/provider-cache";

export type NbaComPlayer = {
  id: number;
  displayFirstLast: string;
  displayLastCommaFirst?: string;
  teamId?: string;
  teamAbbreviation?: string;
  teamName?: string;
  isCurrent?: boolean;
};

export type NbaComStatsPayload = {
  player: NbaComPlayer;
  season: string;
  leagueId: string;
  sourceUrl: string;
  resultSets: unknown[];
};

export type NbaComTeamStatsRow = Record<string, unknown>;

export type NbaComGameFinderPayload = {
  leagueId: string;
  season: string;
  seasonType: string;
  sourceUrl: string;
  resultSets: unknown[];
};

export type NbaComTeamStatsPayload = {
  leagueId: string;
  season: string;
  measureType: string;
  sourceUrl: string;
  resultSets: unknown[];
};

export type NbaComLeagueProbe = {
  status: "supported" | "unsupported" | "timeout" | "provider-error";
  leagueId: string;
  endpoint: string;
  requestUrl: string;
  responseStatus: number | null;
  elapsedMs: number;
  rows: number;
  message?: string;
};

type ResultSet = {
  name?: string;
  headers?: string[];
  rowSet?: unknown[][];
};

function normalize(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function currentSeasonString(now = new Date()) {
  const year = now.getFullYear();
  const startYear = now.getMonth() >= 9 ? year : year - 1;
  return `${startYear}-${String(startYear + 1).slice(-2)}`;
}

function searchCacheKey(playerName: string, leagueId: string, season: string) {
  return `nba-com-stats:search:${leagueId}:${season}:${normalize(playerName)}`;
}

function gamelogCacheKey(playerId: number, leagueId: string, season: string) {
  return `nba-com-stats:gamelog:${leagueId}:${season}:${playerId}`;
}

function rowsToObjects(resultSet: ResultSet | null | undefined) {
  if (!resultSet?.headers || !Array.isArray(resultSet.rowSet)) return [];
  return resultSet.rowSet.map((row) => Object.fromEntries(resultSet.headers!.map((header, index) => [header, row[index]])));
}

function resultSetRowCount(resultSets: unknown[] | null | undefined) {
  if (!Array.isArray(resultSets)) return 0;
  return resultSets.reduce<number>((total, set) => {
    const rowSet = Array.isArray((set as ResultSet | null | undefined)?.rowSet)
      ? (((set as ResultSet).rowSet?.length) ?? 0)
      : 0;
    return total + rowSet;
  }, 0);
}

function hasUsefulResultRows(resultSets: unknown[] | null | undefined) {
  return resultSetRowCount(resultSets) > 0;
}

function chooseLatestRow(rows: Record<string, unknown>[], gameId?: string) {
  if (!rows.length) return null;
  if (gameId) {
    const match = rows.find((row) => String(row.GAME_ID ?? row.Game_ID ?? row.gameId ?? "") === String(gameId));
    if (match) return match;
  }
  return rows[0] ?? null;
}

function statGroupForType(statType: string) {
  const normalized = normalize(statType);
  if (/(points|rebounds|assists|steals|blocks|turnovers|minutes|fantasy|field goals|3-pointers|free throws|double double|triple double|points rebounds|points assists|rebounds assists)/.test(normalized)) return "traditional";
  return "traditional";
}

function mapPlayerName(player: NbaComPlayer) {
  return normalize(player.displayFirstLast || player.displayLastCommaFirst || "");
}

export class NbaComStatsAdapter {
  readonly id = "nba-com-stats";

  configured() {
    return true;
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json, text/plain, */*",
        Origin: "https://www.nba.com",
        Referer: "https://www.nba.com/",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "x-nba-stats-origin": "stats",
        "x-nba-stats-token": "true",
      },
      signal: AbortSignal.timeout(18_000),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`NBA.com stats request failed with status ${response.status}.`);
    return payload;
  }

  async probeLeaguePath(leagueId: string, season = currentSeasonString()): Promise<NbaComLeagueProbe> {
    const endpoint = "commonallplayers";
    const requestUrl = `https://stats.nba.com/stats/commonallplayers?LeagueID=${encodeURIComponent(leagueId)}&Season=${encodeURIComponent(season)}&IsOnlyCurrentSeason=1`;
    const startedAt = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6_000);
      const response = await fetch(requestUrl, {
        headers: {
          Accept: "application/json, text/plain, */*",
          Origin: "https://www.nba.com",
          Referer: "https://www.nba.com/",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "x-nba-stats-origin": "stats",
          "x-nba-stats-token": "true",
        },
        signal: controller.signal,
        cache: "no-store",
      }).finally(() => clearTimeout(timeout));
      const payload = await response.json().catch(() => null);
      const resultSet = Array.isArray((payload as { resultSets?: unknown[] }).resultSets)
        ? ((payload as { resultSets?: unknown[] }).resultSets as ResultSet[]).find((set) => set?.name === "CommonAllPlayers")
        : null;
      const rows = rowsToObjects(resultSet);
      return {
        status: response.ok ? (rows.length > 0 ? "supported" : "unsupported") : "provider-error",
        leagueId,
        endpoint,
        requestUrl,
        responseStatus: response.status,
        elapsedMs: Date.now() - startedAt,
        rows: rows.length,
        message: response.ok ? undefined : `NBA.com stats request failed with status ${response.status}.`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown NBA league probe error";
      const timeout = /aborted|timeout/i.test(message);
      return {
        status: timeout ? "timeout" : "provider-error",
        leagueId,
        endpoint,
        requestUrl,
        responseStatus: null,
        elapsedMs: Date.now() - startedAt,
        rows: 0,
        message: timeout ? "NBA.com league probe timed out" : message,
      };
    }
  }

  async searchPlayer(playerName: string, leagueId = "00", season = currentSeasonString()): Promise<NbaComPlayer | null> {
    const cacheKey = searchCacheKey(playerName, leagueId, season);
    const cached = await getProviderCache<NbaComPlayer>(cacheKey);
    if (cached && !cached.is_stale && new Date(cached.expires_at).getTime() > Date.now()) return cached.payload;

    const payload = await this.fetchJson(`https://stats.nba.com/stats/commonallplayers?LeagueID=${encodeURIComponent(leagueId)}&Season=${encodeURIComponent(season)}&IsOnlyCurrentSeason=0`);
    const resultSet = Array.isArray((payload as { resultSets?: unknown[] }).resultSets)
      ? ((payload as { resultSets?: unknown[] }).resultSets as ResultSet[]).find((set) => set?.name === "CommonAllPlayers")
      : null;
    const rows = rowsToObjects(resultSet);
    const target = normalize(playerName);
    const player = rows.map((row) => ({
      id: Number(row.PERSON_ID ?? row.person_id ?? row.PLAYER_ID ?? 0),
      displayFirstLast: String(row.DISPLAY_FIRST_LAST ?? row.display_first_last ?? row.PLAYER_NAME ?? ""),
      displayLastCommaFirst: String(row.DISPLAY_LAST_COMMA_FIRST ?? row.display_last_comma_first ?? ""),
      teamId: String(row.TEAM_ID ?? row.team_id ?? ""),
      teamAbbreviation: String(row.TEAM_ABBREVIATION ?? row.team_abbreviation ?? ""),
      isCurrent: Boolean(row.IS_CURRENT ?? row.is_current),
    })).find((candidate) => candidate.id > 0 && (mapPlayerName(candidate).includes(target) || target.includes(mapPlayerName(candidate)))) ?? null;

    if (!player?.id) return null;
    await putProviderCache({ cacheKey, provider: "nba-com-stats", payload: player, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
    await touchTodayBoardContext(`nba-com-stats player search ${leagueId}`);
    return player;
  }

  async fetchCurrentPlayers(leagueId = "00", season = currentSeasonString()): Promise<NbaComPlayer[]> {
    const cacheKey = `nba-com-stats:current-players:${leagueId}:${season}`;
    const cached = await getProviderCache<NbaComPlayer[]>(cacheKey);
    if (cached && !cached.is_stale && new Date(cached.expires_at).getTime() > Date.now()) return cached.payload;
    const payload = await this.fetchJson(`https://stats.nba.com/stats/commonallplayers?LeagueID=${encodeURIComponent(leagueId)}&Season=${encodeURIComponent(season)}&IsOnlyCurrentSeason=1`);
    const resultSet = Array.isArray((payload as { resultSets?: unknown[] }).resultSets)
      ? ((payload as { resultSets?: unknown[] }).resultSets as ResultSet[]).find((set) => set?.name === "CommonAllPlayers")
      : null;
    const players = rowsToObjects(resultSet).map((row) => ({
      id: Number(row.PERSON_ID ?? row.PLAYER_ID ?? 0),
      displayFirstLast: String(row.DISPLAY_FIRST_LAST ?? row.PLAYER_NAME ?? ""),
      displayLastCommaFirst: String(row.DISPLAY_LAST_COMMA_FIRST ?? ""),
      teamId: String(row.TEAM_ID ?? row.team_id ?? ""),
      teamAbbreviation: String(row.TEAM_ABBREVIATION ?? ""),
      teamName: String(row.TEAM_NAME ?? ""),
      isCurrent: Boolean(row.IS_CURRENT ?? true),
    })).filter((player) =>
      player.id > 0
      && player.displayFirstLast
      && (player.teamName || player.teamAbbreviation || player.teamId),
    );
    await putProviderCache({ cacheKey, provider: "nba-com-stats", payload: players, expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString() });
    await touchTodayBoardContext(`nba-com-stats current players ${leagueId}`);
    return players;
  }

  async fetchPlayerGameLog(input: { playerId: number; playerName: string; statType: string; season?: string; leagueId?: string; gameId?: string }): Promise<ProviderFetchResult<NbaComStatsPayload> | null> {
    const leagueId = input.leagueId ?? "00";
    const season = input.season ?? currentSeasonString();
    const cacheKey = gamelogCacheKey(input.playerId, leagueId, season);
    const cached = await getProviderCache<NbaComStatsPayload>(cacheKey);
    const cachedHasRows = hasUsefulResultRows(cached?.payload?.resultSets);
    if (cached && cachedHasRows && !cached.is_stale && new Date(cached.expires_at).getTime() > Date.now()) {
      return { data: cached.payload, cost: 0, remaining: null, fetchedAt: cached.fetched_at };
    }

    const response = await this.fetchJson(`https://stats.nba.com/stats/playergamelog?PlayerID=${encodeURIComponent(String(input.playerId))}&Season=${encodeURIComponent(season)}&SeasonType=Regular+Season&LeagueID=${encodeURIComponent(leagueId)}&PerMode=PerGame`);
    const resultSets = Array.isArray((response as { resultSets?: unknown[] }).resultSets) ? ((response as { resultSets?: unknown[] }).resultSets as unknown[]) : [];
    const payload: NbaComStatsPayload = {
      player: { id: input.playerId, displayFirstLast: input.playerName },
      season,
      leagueId,
      sourceUrl: `https://stats.nba.com/stats/playergamelog?PlayerID=${input.playerId}&Season=${season}&SeasonType=Regular+Season&LeagueID=${leagueId}&PerMode=PerGame`,
      resultSets,
    };
    await putProviderCache({ cacheKey, provider: "nba-com-stats", payload, expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString() });
    await touchTodayBoardContext(`nba-com-stats player gamelog ${leagueId}`);
    return { data: payload, cost: 0, remaining: null, fetchedAt: new Date().toISOString() };
  }

  async fetchLeagueTeamStats(leagueId = "00", season = currentSeasonString(), measureType = "Advanced"): Promise<NbaComTeamStatsPayload> {
    const cacheKey = `nba-com-stats:team-stats:${leagueId}:${season}:${measureType}`;
    const cached = await getProviderCache<NbaComTeamStatsPayload>(cacheKey);
    const cachedHasRows = hasUsefulResultRows(cached?.payload?.resultSets);
    if (cached && cachedHasRows && !cached.is_stale && new Date(cached.expires_at).getTime() > Date.now()) return cached.payload;
    const sourceUrl = `https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&LastNGames=0&LeagueID=${encodeURIComponent(leagueId)}&Location=&MeasureType=${encodeURIComponent(measureType)}&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=${encodeURIComponent(season)}&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TwoWay=0`;
    const payload = await this.fetchJson(sourceUrl);
    const resultSets = Array.isArray((payload as { resultSets?: unknown[] }).resultSets) ? ((payload as { resultSets?: unknown[] }).resultSets as unknown[]) : [];
    const result: NbaComTeamStatsPayload = { leagueId, season, measureType, sourceUrl, resultSets };
    await putProviderCache({ cacheKey, provider: "nba-com-stats", payload: result, expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString() });
    await touchTodayBoardContext(`nba-com-stats team stats ${leagueId}:${measureType}`);
    return result;
  }

  async fetchLeagueGameFinder(leagueId = "00", season = currentSeasonString(), seasonType = "Regular Season"): Promise<NbaComGameFinderPayload> {
    const cacheKey = `nba-com-stats:gamefinder:${leagueId}:${season}:${seasonType}`;
    const cached = await getProviderCache<NbaComGameFinderPayload>(cacheKey);
    const cachedHasRows = hasUsefulResultRows(cached?.payload?.resultSets);
    if (cached && cachedHasRows && !cached.is_stale && new Date(cached.expires_at).getTime() > Date.now()) return cached.payload;
    const sourceUrl = `https://stats.nba.com/stats/leaguegamefinder?LeagueID=${encodeURIComponent(leagueId)}&PlayerOrTeam=T&Season=${encodeURIComponent(season)}&SeasonType=${encodeURIComponent(seasonType)}&Sorter=DATE&Direction=DESC`;
    const payload = await this.fetchJson(sourceUrl);
    const resultSets = Array.isArray((payload as { resultSets?: unknown[] }).resultSets) ? ((payload as { resultSets?: unknown[] }).resultSets as unknown[]) : [];
    const result: NbaComGameFinderPayload = { leagueId, season, seasonType, sourceUrl, resultSets };
    await putProviderCache({ cacheKey, provider: "nba-com-stats", payload: result, expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString() });
    await touchTodayBoardContext(`nba-com-stats game finder ${leagueId}`);
    return result;
  }

  extractBestGame(payload: NbaComStatsPayload, gameId?: string) {
    const resultSet = (payload.resultSets as ResultSet[]).find((set) => set?.name?.toLowerCase().includes("playergamelog")) ?? (payload.resultSets as ResultSet[])[0];
    const rows = rowsToObjects(resultSet);
    return chooseLatestRow(rows, gameId);
  }

  statGroup(statType: string) {
    return statGroupForType(statType);
  }
}
