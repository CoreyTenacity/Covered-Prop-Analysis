import type { ProviderFetchResult } from "./provider-adapter";
import { getProviderCache, putProviderCache, touchTodayBoardContext } from "@/lib/db/provider-cache";

export type MlbStatsApiPlayer = {
  id: number;
  fullName: string;
  firstName?: string;
  lastName?: string;
  primaryPosition?: { code?: string; name?: string };
  currentTeam?: { id?: number; name?: string; abbreviation?: string };
  batSide?: { code?: string; description?: string };
  pitchHand?: { code?: string; description?: string };
};

export type MlbStatsApiPayload = {
  player: MlbStatsApiPlayer;
  season: number;
  group: "hitting" | "pitching" | "fielding";
  sourceUrl: string;
  response: unknown;
};

type SearchResponse = { people?: MlbStatsApiPlayer[] };
type TeamsResponse = { teams?: Array<{ id?: number; name?: string; abbreviation?: string }> };
type RosterResponse = { roster?: Array<{ person?: { id?: number; fullName?: string }; position?: { name?: string }; status?: { code?: string; description?: string }; note?: string }> };

export type MlbInjuryRecord = {
  playerId: number;
  playerName: string;
  teamId: number;
  teamName: string;
  status: string;
  note: string | null;
};

function normalize(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function currentSeasonYear(now = new Date()) {
  return now.getFullYear();
}

function seasonCacheKey(playerId: number, season: number, group: string) {
  return `mlb-stats-api:gamelog:${playerId}:${season}:${group}`;
}

function searchCacheKey(playerName: string) {
  return `mlb-stats-api:search:${normalize(playerName)}`;
}

function groupForStatType(statType: string): Array<"hitting" | "pitching"> {
  const normalized = normalize(statType);
  if (/(strikeouts|pitch|innings|outs|earned runs|walks allowed|hits allowed|pitcher)/.test(normalized)) return ["pitching"];
  if (/(fantasy|hits|singles|runs|rbis|total bases|home runs|doubles|triples|stolen bases|walks|plate appearances|bases|hit by pitch|hit by pitches)/.test(normalized)) return ["hitting"];
  return ["hitting", "pitching"];
}

function extractRows(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload.flatMap((value) => extractRows(value));
  }
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const stats = Array.isArray(record.stats) ? record.stats as Array<Record<string, unknown>> : [];
  const rows: Array<Record<string, unknown>> = [];
  for (const stat of stats) {
    const splits = Array.isArray(stat.splits) ? stat.splits as Array<Record<string, unknown>> : [];
    for (const split of splits) {
      rows.push(split);
    }
  }
  if (rows.length) return rows;
  const splits = Array.isArray(record.splits) ? record.splits as Array<Record<string, unknown>> : [];
  return splits;
}

function chooseSplit(rows: Array<Record<string, unknown>>, gameId?: string) {
  if (!rows.length) return null;
  if (gameId) {
    const match = rows.find((row) => {
      const game = row.game as Record<string, unknown> | undefined;
      return String(game?.gamePk ?? row["gamePk"] ?? row["game_id"] ?? row["gameId"] ?? "") === String(gameId);
    });
    if (match) return match;
  }
  return [...rows].sort((a, b) => {
    const aGame = a.game as Record<string, unknown> | undefined;
    const bGame = b.game as Record<string, unknown> | undefined;
    const aDate = new Date(String(a["date"] ?? a["gameDate"] ?? aGame?.gameDate ?? aGame?.officialDate ?? "")).getTime();
    const bDate = new Date(String(b["date"] ?? b["gameDate"] ?? bGame?.gameDate ?? bGame?.officialDate ?? "")).getTime();
    return bDate - aDate;
  })[0] ?? null;
}

export class MlbStatsApiAdapter {
  readonly id = "mlb-stats-api";

  configured() {
    return true;
  }

  private async fetchJson(path: string): Promise<unknown> {
    const response = await fetch(`https://statsapi.mlb.com${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`MLB Stats API request failed with status ${response.status}.`);
    return payload;
  }

  private async resolveTeam(teamName: string) {
    const teamsCacheKey = "mlb-stats-api:teams:active";
    const cachedTeams = await getProviderCache<TeamsResponse>(teamsCacheKey);
    const teams = cachedTeams && !cachedTeams.is_stale && new Date(cachedTeams.expires_at).getTime() > Date.now()
      ? cachedTeams.payload
      : await this.fetchJson("/api/v1/teams?sportId=1") as TeamsResponse;
    if (!cachedTeams || cachedTeams.is_stale || new Date(cachedTeams.expires_at).getTime() <= Date.now()) {
      await putProviderCache({ cacheKey: teamsCacheKey, provider: "mlb-stats-api", payload: teams, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
      await touchTodayBoardContext("mlb-stats-api teams");
    }
    const target = normalize(teamName);
    return (teams.teams ?? []).find((candidate) => normalize(candidate.name ?? "") === target || normalize(candidate.name ?? "").includes(target) || target.includes(normalize(candidate.name ?? ""))) ?? null;
  }

  async searchPlayer(playerName: string): Promise<MlbStatsApiPlayer | null> {
    const cached = await getProviderCache<MlbStatsApiPlayer>(searchCacheKey(playerName));
    if (cached && !cached.is_stale && new Date(cached.expires_at).getTime() > Date.now()) return cached.payload;
    const payload = await this.fetchJson(`/api/v1/people/search?names=${encodeURIComponent(playerName)}`);
    const people = (payload as SearchResponse | null)?.people ?? [];
    const target = normalize(playerName);
    const player = people.find((candidate) => normalize(candidate.fullName ?? "").includes(target) || target.includes(normalize(candidate.fullName ?? ""))) ?? people[0] ?? null;
    if (!player?.id) return null;
    await putProviderCache({ cacheKey: searchCacheKey(playerName), provider: "mlb-stats-api", payload: player, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
    await touchTodayBoardContext("mlb-stats-api player search");
    return player;
  }

  async fetchActiveRoster(teamName: string): Promise<MlbStatsApiPlayer[]> {
    const team = await this.resolveTeam(teamName);
    if (!team?.id) return [];
    const cacheKey = `mlb-stats-api:active-roster:${team.id}`;
    const cached = await getProviderCache<MlbStatsApiPlayer[]>(cacheKey);
    if (cached && !cached.is_stale && new Date(cached.expires_at).getTime() > Date.now()) return cached.payload;
    const payload = await this.fetchJson(`/api/v1/teams/${team.id}/roster?rosterType=active`) as RosterResponse;
    const players = (payload.roster ?? []).flatMap((row) => row.person?.id && row.person.fullName ? [{ id: row.person.id, fullName: row.person.fullName, primaryPosition: { name: row.position?.name }, currentTeam: { id: team.id, name: team.name, abbreviation: team.abbreviation } }] : []);
    await putProviderCache({ cacheKey, provider: "mlb-stats-api", payload: players, expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString() });
    await touchTodayBoardContext("mlb-stats-api active roster");
    return players;
  }

  async fetchTeamInjuries(teamName: string, season = currentSeasonYear()): Promise<MlbInjuryRecord[]> {
    const team = await this.resolveTeam(teamName);
    if (!team?.id) return [];
    const cacheKey = `mlb-stats-api:injuries:${team.id}:${season}`;
    const cached = await getProviderCache<MlbInjuryRecord[]>(cacheKey);
    if (cached && !cached.is_stale && new Date(cached.expires_at).getTime() > Date.now()) return cached.payload;
    const payload = await this.fetchJson(`/api/v1/teams/${team.id}/roster?rosterType=40Man&season=${season}`) as RosterResponse;
    const records = (payload.roster ?? []).flatMap((row) => {
      const code = row.status?.code ?? "";
      const status = row.status?.description ?? "";
      if (!row.person?.id || !row.person.fullName || (!/^D\d+/i.test(code) && !/injured/i.test(status))) return [];
      return [{ playerId: row.person.id, playerName: row.person.fullName, teamId: team.id!, teamName: team.name ?? teamName, status: status || code, note: row.note?.trim() || null }];
    });
    await putProviderCache({ cacheKey, provider: "mlb-stats-api", payload: records, expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() });
    await touchTodayBoardContext("mlb-stats-api injuries");
    return records;
  }

  async fetchPlayerGameLog(input: { playerId: number; playerName: string; season?: number; gameId?: string; statType: string }): Promise<ProviderFetchResult<MlbStatsApiPayload> | null> {
    const season = input.season ?? currentSeasonYear();
    const groups = groupForStatType(input.statType);
    const responses = await Promise.all(groups.map(async (group) => {
      const cacheKey = seasonCacheKey(input.playerId, season, group);
      const cached = await getProviderCache<MlbStatsApiPayload>(cacheKey);
      if (cached && !cached.is_stale && new Date(cached.expires_at).getTime() > Date.now()) return cached.payload;
      const response = await this.fetchJson(`/api/v1/people/${encodeURIComponent(String(input.playerId))}/stats?stats=gameLog&group=${encodeURIComponent(group)}&season=${encodeURIComponent(String(season))}&gameType=R`);
      const payload = {
        player: { id: input.playerId, fullName: input.playerName },
        season,
        group,
        sourceUrl: `https://statsapi.mlb.com/api/v1/people/${input.playerId}/stats?stats=gameLog&group=${group}&season=${season}&gameType=R`,
        response,
      };
      await putProviderCache({ cacheKey, provider: "mlb-stats-api", payload, expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString() });
      await touchTodayBoardContext(`mlb-stats-api gamelog ${input.playerId}:${group}`);
      return payload;
    }));
    const available = responses.filter(Boolean) as MlbStatsApiPayload[];
    if (!available.length) return null;
    return {
      data: available.length === 1 ? available[0] : { player: { id: input.playerId, fullName: input.playerName }, season, group: groups[0], sourceUrl: "https://statsapi.mlb.com", response: available },
      cost: 0,
      remaining: null,
      fetchedAt: new Date().toISOString(),
    };
  }

  extractBestSplit(payload: MlbStatsApiPayload, gameId?: string) {
    const rows = extractRows(payload.response);
    return chooseSplit(rows, gameId) ?? payload.response;
  }

  extractGameLogRows(payload: MlbStatsApiPayload) {
    return extractRows(payload.response).sort((left, right) => {
      const leftDate = new Date(String(left.date ?? left.gameDate ?? left.GAME_DATE ?? left.GAME_DATE_EST ?? "")).getTime();
      const rightDate = new Date(String(right.date ?? right.gameDate ?? right.GAME_DATE ?? right.GAME_DATE_EST ?? "")).getTime();
      return rightDate - leftDate;
    });
  }
}
