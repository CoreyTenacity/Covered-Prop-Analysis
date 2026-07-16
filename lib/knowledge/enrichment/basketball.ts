import { getProviderCache } from "@/lib/db/provider-cache";
import { deleteRows, insertRows, selectRows, updateRows } from "@/lib/db/supabase-server";
import { ensureEvent, ensurePlayer, ensureTeam, ACTIVE_LEAGUES, configuredChunkSize, configuredScheduleLookaheadDays, currentBasketballSeason, currentWnbaSeason, easternDate, findEventByProviderId, normalizeName, takeRotatingSlice } from "@/lib/knowledge/enrichment/shared";
import type { RefreshWindow } from "@/lib/knowledge/enrichment/shared";
import type { ActiveKnowledgeLeagueCode } from "@/lib/knowledge/types";
import { NbaComStatsAdapter } from "@/lib/providers/nba-com-stats";
import { OfficialInjuryReportAdapter } from "@/lib/providers/official-injuries-adapter";
import { WeHoopWnbaAdapter } from "@/lib/providers/wehoop-wnba";
import { resolveWnbaLeagueId } from "@/lib/providers/wnba-league-path";

type LeagueScope = "NBA" | "WNBA";

type SharpPriorityRow = {
  player_id?: string | null;
  player_name?: string | null;
  team_id?: string | null;
  team_name?: string | null;
  start_time?: string | null;
};

type RefreshPlayerRow = {
  id: string;
  canonical_name: string;
  current_team_id: string | null;
  external_ids: Record<string, unknown> | null;
};

const WNBA_STATIC_TEAMS = [
  { name: "Atlanta Dream", city: "Atlanta", nickname: "Dream", abbreviation: "ATL" },
  { name: "Chicago Sky", city: "Chicago", nickname: "Sky", abbreviation: "CHI" },
  { name: "Connecticut Sun", city: "Connecticut", nickname: "Sun", abbreviation: "CON" },
  { name: "Dallas Wings", city: "Dallas", nickname: "Wings", abbreviation: "DAL" },
  { name: "Golden State Valkyries", city: "Golden State", nickname: "Valkyries", abbreviation: "GSV" },
  { name: "Indiana Fever", city: "Indiana", nickname: "Fever", abbreviation: "IND" },
  { name: "Las Vegas Aces", city: "Las Vegas", nickname: "Aces", abbreviation: "LVA" },
  { name: "Los Angeles Sparks", city: "Los Angeles", nickname: "Sparks", abbreviation: "LAS" },
  { name: "Minnesota Lynx", city: "Minnesota", nickname: "Lynx", abbreviation: "MIN" },
  { name: "New York Liberty", city: "New York", nickname: "Liberty", abbreviation: "NYL" },
  { name: "Phoenix Mercury", city: "Phoenix", nickname: "Mercury", abbreviation: "PHX" },
  { name: "Portland Fire", city: "Portland", nickname: "Fire", abbreviation: "POR" },
  { name: "Seattle Storm", city: "Seattle", nickname: "Storm", abbreviation: "SEA" },
  { name: "Toronto Tempo", city: "Toronto", nickname: "Tempo", abbreviation: "TOR" },
  { name: "Washington Mystics", city: "Washington", nickname: "Mystics", abbreviation: "WAS" },
] as const;

type TeamStatsRow = Record<string, unknown>;
type GameFinderRow = Record<string, unknown>;
type ScoreboardGame = {
  gameId: string;
  gameCode?: string;
  gameStatusText?: string;
  gameStatus?: number;
  gameEt?: string;
  gameDateEst?: string;
  homeTeam?: { teamId?: number | string; teamName?: string; teamCity?: string; teamTricode?: string; score?: number | string };
  awayTeam?: { teamId?: number | string; teamName?: string; teamCity?: string; teamTricode?: string; score?: number | string };
  arena?: { arenaName?: string; arenaCity?: string; arenaState?: string };
};

function headers() {
  return {
    Accept: "application/json, text/plain, */*",
    Origin: "https://www.nba.com",
    Referer: "https://www.nba.com/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "x-nba-stats-origin": "stats",
    "x-nba-stats-token": "true",
  };
}

function rowsToObjects(resultSets: unknown[]) {
  const resultSet = Array.isArray(resultSets)
    ? (resultSets as Array<{ headers?: string[]; rowSet?: unknown[][] }>).find((set) => Array.isArray(set.headers) && Array.isArray(set.rowSet))
    : null;
  if (!resultSet?.headers || !Array.isArray(resultSet.rowSet)) return [];
  return resultSet.rowSet.map((row) => Object.fromEntries(resultSet.headers!.map((header, index) => [header, row[index]])));
}

function rowsFromAllResultSets(resultSets: unknown[]) {
  if (!Array.isArray(resultSets)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const resultSet of resultSets as Array<{ headers?: string[]; rowSet?: unknown[][] }>) {
    if (!Array.isArray(resultSet?.headers) || !Array.isArray(resultSet?.rowSet)) continue;
    for (const row of resultSet.rowSet) {
      rows.push(Object.fromEntries(resultSet.headers.map((header, index) => [header, row[index]])));
    }
  }
  return rows;
}

function safeNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function seasonForNow(scope: LeagueScope, now = new Date()) {
  return scope === "WNBA" ? currentWnbaSeason(now) : currentBasketballSeason(now);
}

function seasonsToTry(scope: LeagueScope, now = new Date()) {
  return scope === "WNBA"
    ? [...new Set([
        seasonForNow(scope, now),
        String(now.getFullYear()),
        String(now.getFullYear() - 1),
        currentBasketballSeason(now),
      ])]
    : [seasonForNow(scope, now)];
}

function playerLogSeasonsToTry(scope: LeagueScope, now = new Date()) {
  if (scope !== "WNBA") return seasonsToTry(scope, now);
  return [...new Set([
    seasonForNow(scope, now),
    String(now.getFullYear()),
  ])];
}

async function fetchScoreboardForDate(leagueId: string, date: string) {
  const mmddyyyy = new Date(`${date}T12:00:00-04:00`);
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  }).format(mmddyyyy);
  const url = `https://stats.nba.com/stats/scoreboardv2?GameDate=${encodeURIComponent(formatted)}&LeagueID=${encodeURIComponent(leagueId)}&DayOffset=0`;
  const response = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(12_000), cache: "no-store" });
  const payload = await response.json().catch(() => null) as { resultSets?: Array<{ name?: string; headers?: string[]; rowSet?: unknown[][] }> } | null;
  if (!response.ok) throw new Error(`Basketball scoreboard request failed with status ${response.status}.`);
  const gameSet = payload?.resultSets?.find((set) => /gameheader/i.test(set.name ?? "")) ?? payload?.resultSets?.[0] ?? null;
  return rowsToObjects(gameSet ? [gameSet] : []);
}

function mapScoreboardRow(row: ScoreboardGame | Record<string, unknown>) {
  const record = row as Record<string, unknown>;
  const nested = row as ScoreboardGame;
  const homeTeam = nested.homeTeam ?? {};
  const awayTeam = nested.awayTeam ?? {};
  const arena = nested.arena ?? {};
  const homeId = safeText(record.HOME_TEAM_ID ?? homeTeam.teamId ?? "");
  const awayId = safeText(record.VISITOR_TEAM_ID ?? awayTeam.teamId ?? "");
  const homeTri = safeText(record.HOME_TEAM_ABBREVIATION ?? homeTeam.teamTricode ?? "");
  const awayTri = safeText(record.VISITOR_TEAM_ABBREVIATION ?? awayTeam.teamTricode ?? "");
  const homeName = safeText(record.HOME_TEAM_NAME ?? homeTeam.teamName ?? "");
  const awayName = safeText(record.VISITOR_TEAM_NAME ?? awayTeam.teamName ?? "");
  const gameId = safeText(record.GAME_ID ?? nested.gameId ?? "");
  const gameStatusText = safeText(record.GAME_STATUS_TEXT ?? nested.gameStatusText ?? "Scheduled");
  const startTimeUTC = safeText(record.GAME_DATE_EST ?? nested.gameDateEst ?? "")
    || safeText(record.GAME_STATUS_TEXT ?? "")
    || safeText(record.GAME_ET ?? nested.gameEt ?? "");
  const startTime = safeText(record.GAME_DATE_EST ?? nested.gameDateEst ?? "")
    ? new Date(String(record.GAME_DATE_EST ?? nested.gameDateEst)).toISOString()
    : safeText(record.GAME_ET ?? nested.gameEt ?? "") || new Date().toISOString();
  return {
    gameId,
    homeId,
    awayId,
    homeAbbreviation: homeTri,
    awayAbbreviation: awayTri,
    homeName,
    awayName,
    startTime,
    rawTime: startTimeUTC,
    status: gameStatusText || "Scheduled",
    homeScore: safeNumber(record.PTS_HOME ?? homeTeam.score ?? null),
    awayScore: safeNumber(record.PTS_AWAY ?? awayTeam.score ?? null),
    arenaName: safeText(record.ARENA_NAME ?? arena.arenaName ?? ""),
    arenaCity: safeText(record.ARENA_CITY ?? arena.arenaCity ?? ""),
    arenaState: safeText(record.ARENA_STATE ?? arena.arenaState ?? ""),
  };
}

function completedStatus(status: string) {
  return /final/i.test(status) ? "completed" : /halftime|qtr|live|in progress/i.test(status) ? "live" : "scheduled";
}

function seasonCandidates(now = new Date()) {
  const season = seasonForNow("NBA", now);
  const year = now.getFullYear();
  return [...new Set([season, `${year - 1}-${String(year).slice(-2)}`, `${year}-${String(year + 1).slice(-2)}`])];
}

async function leagueAdapter(scope: LeagueScope) {
  if (scope === "WNBA") {
    const selection = await resolveWnbaLeagueId();
    return {
      leagueId: selection.leagueId,
      provider: "wehoop-wnba" as const,
      adapter: new WeHoopWnbaAdapter(),
    };
  }
  return {
    leagueId: "00",
    provider: "nba-com-stats" as const,
    adapter: new NbaComStatsAdapter(),
  };
}

async function loadLiveSharpPriorities(scope: LeagueScope) {
  const config = ACTIVE_LEAGUES[scope];
  const rows = await selectRows<SharpPriorityRow>("current_props", {
    select: "player_id,player_name,team_id,team_name,start_time",
    filters: [
      { column: "league_id", value: config.leagueId },
      { column: "active", value: true },
    ],
    orderBy: "updated_at.desc",
    limit: 300,
  });
  const now = Date.now();
  const activeRows = rows.filter((row) => {
    if (!row.start_time) return true;
    const startMs = new Date(row.start_time).getTime();
    return !Number.isNaN(startMs) && startMs >= now - 2 * 60 * 60 * 1000;
  });
  const playerNameSamples = new Map<string, string>();
  for (const row of activeRows) {
    const rawName = String(row.player_name ?? "").trim();
    const normalized = normalizeName(rawName);
    if (normalized && rawName && !playerNameSamples.has(normalized)) {
      playerNameSamples.set(normalized, rawName);
    }
  }
  return {
    playerIds: new Set(activeRows.map((row) => row.player_id).filter((value): value is string => Boolean(value))),
    playerNames: new Set(activeRows.map((row) => normalizeName(String(row.player_name ?? ""))).filter(Boolean)),
    playerNameSamples,
    teamIds: new Set(activeRows.map((row) => row.team_id).filter((value): value is string => Boolean(value))),
    teamNames: new Set(activeRows.map((row) => normalizeName(String(row.team_name ?? ""))).filter(Boolean)),
  };
}

async function loadMissingRecentFeaturePlayerIds(scope: LeagueScope, playerIds: string[]) {
  if (!playerIds.length) return new Set<string>();
  const config = ACTIVE_LEAGUES[scope];
  const [recentRows, basketballRows] = await Promise.all([
    selectRows<{ player_id: string | null }>("player_recent_features", {
      select: "player_id",
      filters: [
        { column: "league_id", value: config.leagueId },
        { column: "player_id", operator: "in", value: playerIds },
      ],
      limit: Math.max(playerIds.length * 2, 50),
    }).catch(() => []),
    selectRows<{ player_id: string | null }>("basketball_player_features", {
      select: "player_id",
      filters: [
        { column: "league_id", value: config.leagueId },
        { column: "player_id", operator: "in", value: playerIds },
      ],
      limit: Math.max(playerIds.length * 2, 50),
    }).catch(() => []),
  ]);
  const covered = new Set([
    ...recentRows.map((row) => row.player_id),
    ...basketballRows.map((row) => row.player_id),
  ].filter((value): value is string => Boolean(value)));
  return new Set(playerIds.filter((playerId) => !covered.has(playerId)));
}

async function loadLivePropCoverage(scope: LeagueScope) {
  const config = ACTIVE_LEAGUES[scope];
  const rows = await selectRows<SharpPriorityRow>("current_props", {
    select: "player_id,player_name,team_id,team_name,start_time",
    filters: [
      { column: "league_id", value: config.leagueId },
      { column: "active", value: true },
    ],
    orderBy: "updated_at.desc",
    limit: 500,
  });
  const now = Date.now();
  const activeRows = rows.filter((row) => {
    if (!row.start_time) return true;
    const startMs = new Date(row.start_time).getTime();
    return !Number.isNaN(startMs) && startMs >= now - 2 * 60 * 60 * 1000;
  });
  const distinctPlayerIds = [...new Set(activeRows.map((row) => row.player_id).filter((value): value is string => Boolean(value)))];
  const missingRecentPlayerIds = await loadMissingRecentFeaturePlayerIds(scope, distinctPlayerIds);
  const playerIdentityRows = distinctPlayerIds.length
    ? await selectRows<{ id: string; normalized_name: string; current_team_id: string | null }>("players", {
        select: "id,normalized_name,current_team_id",
        filters: [
          { column: "league_id", value: config.leagueId },
          { column: "id", operator: "in", value: distinctPlayerIds },
        ],
        limit: Math.max(distinctPlayerIds.length * 2, 50),
      }).catch(() => [])
    : [];
  const identityByPlayerId = new Map(playerIdentityRows.map((row) => [row.id, row]));
  const coveredIdentityKeys = new Set(
    Array.from(missingRecentPlayerIds).map((playerId) => {
      const row = identityByPlayerId.get(playerId);
      return row ? `${row.normalized_name}|${row.current_team_id ?? ""}` : null;
    }).filter((value): value is string => Boolean(value)),
  );
  const missingRecentPlayerNamesNormalized = new Set(
    activeRows
      .filter((row) => {
        if (row.player_id && missingRecentPlayerIds.has(row.player_id)) return true;
        const normalizedName = normalizeName(String(row.player_name ?? ""));
        if (!normalizedName) return false;
        const identityKey = `${normalizedName}|${row.team_id ?? ""}`;
        return coveredIdentityKeys.has(identityKey);
      })
      .map((row) => normalizeName(String(row.player_name ?? "")))
      .filter(Boolean),
  );
  const sampleMissingPlayerNames = [...new Set(
    activeRows
      .filter((row) => {
        const normalizedName = normalizeName(String(row.player_name ?? ""));
        return normalizedName && missingRecentPlayerNamesNormalized.has(normalizedName);
      })
      .map((row) => String(row.player_name ?? "").trim())
      .filter(Boolean),
  )].slice(0, 10);
  return {
    activeRows,
    distinctPlayerIds,
    missingRecentPlayerIds,
    missingRecentPlayerNamesNormalized,
    sampleMissingPlayerNames,
  };
}

async function resolvePriorityPlayersForLogs(input: {
  scope: LeagueScope;
  provider: string;
  leagueId: string;
  adapter: NbaComStatsAdapter | WeHoopWnbaAdapter;
  rawNameSamples: Map<string, string>;
  normalizedNames: Set<string>;
  existingPlayers: RefreshPlayerRow[];
}) {
  const { scope, provider, leagueId, adapter, rawNameSamples, normalizedNames, existingPlayers } = input;
  if (!normalizedNames.size) return [] as RefreshPlayerRow[];

  const config = ACTIVE_LEAGUES[scope];
  const existingById = new Map(existingPlayers.map((player) => [player.id, player]));
  const missingNames = [...normalizedNames].filter(Boolean);

  const directPlayers = await selectRows<RefreshPlayerRow & { normalized_name: string }>("players", {
    select: "id,canonical_name,current_team_id,external_ids,normalized_name",
    filters: [
      { column: "league_id", value: config.leagueId },
      { column: "normalized_name", operator: "in", value: missingNames },
    ],
    limit: Math.max(missingNames.length * 4, 40),
  }).catch(() => []);

  const aliasRows = await selectRows<{ entity_id: string }>("entity_aliases", {
    select: "entity_id",
    filters: [
      { column: "entity_type", value: "player" },
      { column: "league_id", value: config.leagueId },
      { column: "normalized_alias", operator: "in", value: missingNames },
    ],
    limit: Math.max(missingNames.length * 4, 40),
  }).catch(() => []);

  const aliasPlayerIds = [...new Set(aliasRows.map((row) => row.entity_id).filter(Boolean))];
  const aliasPlayers = aliasPlayerIds.length
    ? await selectRows<RefreshPlayerRow>("players", {
        select: "id,canonical_name,current_team_id,external_ids",
        filters: [
          { column: "league_id", value: config.leagueId },
          { column: "id", operator: "in", value: aliasPlayerIds },
        ],
        limit: Math.max(aliasPlayerIds.length * 2, 40),
      }).catch(() => [])
    : [];

  const resolved = new Map<string, RefreshPlayerRow>();
  for (const player of [...directPlayers, ...aliasPlayers]) {
    const existing = existingById.get(player.id);
    resolved.set(player.id, existing ?? {
      id: player.id,
      canonical_name: player.canonical_name,
      current_team_id: player.current_team_id,
      external_ids: player.external_ids,
    });
  }

  const coveredNames = new Set(
    [...resolved.values()].map((player) => normalizeName(player.canonical_name)).filter(Boolean),
  );

  const unresolvedNames = missingNames.filter((name) => !coveredNames.has(name)).slice(0, scope === "WNBA" ? 8 : 4);
  for (const normalizedName of unresolvedNames) {
    const rawName = rawNameSamples.get(normalizedName) ?? normalizedName;
    const searched = await adapter.searchPlayer(rawName, leagueId, seasonForNow(scope)).catch(() => null);
    if (!searched?.id || !searched.displayFirstLast) continue;
    const fallbackTeamName = searched.teamName || searched.teamAbbreviation || (searched.teamId ? `Team ${searched.teamId}` : null);
    const teamId = searched.teamId && fallbackTeamName
      ? await ensureTeam({
          league: scope,
          provider,
          externalId: String(searched.teamId),
          name: fallbackTeamName,
          abbreviation: searched.teamAbbreviation || null,
          metadata: { season: seasonForNow(scope) },
        })
      : null;
    const [firstName, ...rest] = searched.displayFirstLast.split(" ");
    const playerId = await ensurePlayer({
      league: scope,
      provider,
      externalId: String(searched.id),
      canonicalName: searched.displayFirstLast,
      displayName: searched.displayFirstLast,
      firstName: firstName || null,
      lastName: rest.join(" ") || null,
      currentTeamId: teamId,
      active: true,
      metadata: {
        league_provider_id: leagueId,
        team_abbreviation: searched.teamAbbreviation ?? null,
      },
    }).catch(() => null);
    if (!playerId) continue;
    resolved.set(playerId, {
      id: playerId,
      canonical_name: searched.displayFirstLast,
      current_team_id: teamId,
      external_ids: {
        [provider]: String(searched.id),
        "nba-com-stats": String(searched.id),
      },
    });
  }

  return [...resolved.values()];
}

async function takeLiveFirstWindow<T>(input: {
  cacheKey: string;
  provider: string;
  items: T[];
  isPriority: (item: T) => boolean;
  sliceSize: number;
  maxPriorityItems?: number;
}): Promise<RefreshWindow<T>> {
  const priorityItems = input.items.filter(input.isPriority);
  const desiredPrioritySize = Math.max(0, Math.min(
    input.sliceSize,
    typeof input.maxPriorityItems === "number" ? Math.max(0, Math.floor(input.maxPriorityItems)) : input.sliceSize,
  ));
  if (priorityItems.length >= input.sliceSize && desiredPrioritySize >= input.sliceSize) {
    const priorityRotation = await takeRotatingSlice({
      cacheKey: `${input.cacheKey}:priority`,
      provider: input.provider,
      items: priorityItems,
      sliceSize: input.sliceSize,
    });
    return {
      items: priorityRotation.items,
      start: priorityRotation.start,
      end: priorityRotation.end,
      nextIndex: priorityRotation.nextIndex,
      total: input.items.length,
      priorityOnly: true,
    };
  }

  const prioritySelection = desiredPrioritySize > 0
    ? priorityItems.length > desiredPrioritySize
      ? await takeRotatingSlice({
          cacheKey: `${input.cacheKey}:priority`,
          provider: input.provider,
          items: priorityItems,
          sliceSize: desiredPrioritySize,
        })
      : { items: priorityItems, start: 0, end: priorityItems.length, nextIndex: 0, total: priorityItems.length }
    : { items: [] as T[], start: 0, end: 0, nextIndex: 0, total: priorityItems.length };

  const nonPriorityItems = input.items.filter((item) => !input.isPriority(item));
  const remainderSize = Math.max(0, input.sliceSize - prioritySelection.items.length);
  const rotation = remainderSize > 0
    ? await takeRotatingSlice({
        cacheKey: input.cacheKey,
        provider: input.provider,
        items: nonPriorityItems,
        sliceSize: remainderSize,
      })
    : { items: [] as T[], start: 0, end: 0, nextIndex: 0, total: nonPriorityItems.length };

  return {
    items: [...prioritySelection.items, ...rotation.items],
    start: prioritySelection.start,
    end: prioritySelection.items.length + rotation.end,
    nextIndex: rotation.nextIndex,
    total: input.items.length,
    priorityOnly: false,
  };
}

export async function refreshBasketballTeams(scope: LeagueScope) {
  const { leagueId, provider, adapter } = await leagueAdapter(scope);
  const season = seasonForNow(scope);

  if (scope === "WNBA") {
    let count = 0;
    for (const team of WNBA_STATIC_TEAMS) {
      await ensureTeam({
        league: scope,
        provider,
        externalId: team.abbreviation,
        name: team.name,
        abbreviation: team.abbreviation,
        city: team.city,
        nickname: team.nickname,
        metadata: {
          season,
          seed_source: "static_wnba_team_catalog",
        },
      });
      count += 1;
    }
    return { league: scope, provider, season, rows: count, source: "static-team-catalog" as const };
  }

  const playerFeed = await adapter.fetchCurrentPlayers(leagueId, season).catch(() => []);
  const dedupedTeams = new Map<string, {
    teamName: string;
    abbreviation: string | null;
    city: string | null;
    externalId: string | null;
  }>();

  for (const player of playerFeed) {
    const teamName = (player.teamName || player.teamAbbreviation || "").trim();
    const externalId = safeText(player.teamId);
    if (!teamName || !externalId) continue;
    if (!dedupedTeams.has(externalId)) {
      const abbreviation = safeText(player.teamAbbreviation) || null;
      const cityGuess =
        safeText(player.teamName).replace(new RegExp(`\\s+${safeText(player.teamAbbreviation || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"), "").trim()
        || null;
      dedupedTeams.set(externalId, {
        teamName,
        abbreviation,
        city: cityGuess,
        externalId,
      });
    }
  }

  const rows = dedupedTeams.size
    ? Array.from(dedupedTeams.values()).map((team) => ({
        TEAM_NAME: team.teamName,
        TEAM_ABBREVIATION: team.abbreviation,
        TEAM_CITY: team.city,
        TEAM_ID: team.externalId,
      }))
    : rowsToObjects((await adapter.fetchLeagueTeamStats(leagueId, season, "Advanced")).resultSets);
  let count = 0;
  for (const row of rows) {
    const teamName = safeText(row.TEAM_NAME);
    if (!teamName) continue;
    const abbreviation = safeText(row.TEAM_ABBREVIATION);
    const city = safeText(row.TEAM_CITY);
    const externalId = safeText(row.TEAM_ID);
    await ensureTeam({
      league: scope,
      provider,
      externalId,
      name: teamName,
      abbreviation: abbreviation || null,
      city: city || null,
      nickname: teamName.replace(new RegExp(`^${city}\\s+`, "i"), "") || null,
      metadata: {
        stats_provider: provider,
        season,
      },
    });
    count += 1;
  }
  return { league: scope, provider, season, rows: count };
}

export async function refreshBasketballPlayers(scope: LeagueScope) {
  const { leagueId, provider, adapter } = await leagueAdapter(scope);
  const seasons = scope === "WNBA" ? seasonsToTry(scope) : seasonCandidates();
  const unique = new Map<number, { id: number; displayFirstLast: string; teamId?: string; teamAbbreviation?: string; teamName?: string }>();
  for (const season of seasons) {
    const players = await adapter.fetchCurrentPlayers(leagueId, season).catch(async () => {
      const cached = await getProviderCache<Array<{ id: number; displayFirstLast: string; teamId?: string; teamAbbreviation?: string; teamName?: string }>>(
        `nba-com-stats:current-players:${leagueId}:${season}`,
      );
      if (cached?.payload?.length) return cached.payload;
      throw new Error(`Timed out fetching current ${scope} players and no cached player list was available.`);
    });
    players.forEach((player) => {
      if (!unique.has(player.id)) unique.set(player.id, player);
    });
  }
  const priorities = await loadLiveSharpPriorities(scope);
  const knownNames = new Set(Array.from(unique.values()).map((player) => normalizeName(player.displayFirstLast)));
  const fallbackSearchLimit = scope === "WNBA" ? 8 : 10;
  let fallbackSearches = 0;
  for (const [normalizedName, rawName] of priorities.playerNameSamples.entries()) {
    if (fallbackSearches >= fallbackSearchLimit) break;
    if (!normalizedName || knownNames.has(normalizedName)) continue;
    const searched = await adapter.searchPlayer(rawName, leagueId, seasons[0]).catch(() => null);
    if (!searched?.id || !searched.displayFirstLast) continue;
    unique.set(searched.id, searched);
    knownNames.add(normalizedName);
    fallbackSearches += 1;
  }
  const orderedPlayers = Array.from(unique.values()).sort((left, right) => {
    const leftPriority = priorities.playerNames.has(normalizeName(left.displayFirstLast)) ? 1 : 0;
    const rightPriority = priorities.playerNames.has(normalizeName(right.displayFirstLast)) ? 1 : 0;
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;
    return left.displayFirstLast.localeCompare(right.displayFirstLast);
  });
  const baseSliceSize = configuredChunkSize(scope === "WNBA" ? "KNOWLEDGE_WNBA_PLAYER_REFRESH_PLAYERS_PER_RUN" : "KNOWLEDGE_NBA_PLAYER_REFRESH_PLAYERS_PER_RUN", scope === "WNBA" ? 6 : 24, 4, 80);
  const livePriorityCount = orderedPlayers.filter((player) => priorities.playerNames.has(normalizeName(player.displayFirstLast))).length;
  const playerWindow = await takeLiveFirstWindow({
    cacheKey: `knowledge:cursor:${scope.toLowerCase()}:refresh_players:players`,
    provider,
    items: orderedPlayers,
    isPriority: (player) => priorities.playerNames.has(normalizeName(player.displayFirstLast)),
    sliceSize: Math.min(Math.max(baseSliceSize, Math.min(livePriorityCount, scope === "WNBA" ? 8 : 32)), scope === "WNBA" ? 10 : 48),
  });
  let count = 0;
  for (const player of playerWindow.items) {
    const fallbackTeamName = player.teamName || player.teamAbbreviation || (player.teamId ? `Team ${player.teamId}` : null);
    const teamId = player.teamId && fallbackTeamName ? await ensureTeam({
      league: scope,
      provider,
      externalId: String(player.teamId),
      name: fallbackTeamName,
      abbreviation: player.teamAbbreviation || null,
      metadata: { season: seasonForNow(scope) },
    }) : null;
    const [firstName, ...rest] = player.displayFirstLast.split(" ");
    await ensurePlayer({
      league: scope,
      provider,
      externalId: String(player.id),
      canonicalName: player.displayFirstLast,
      displayName: player.displayFirstLast,
      firstName: firstName || null,
      lastName: rest.join(" ") || null,
      currentTeamId: teamId,
      primaryPosition: null,
      shoots: null,
      active: true,
      metadata: {
        league_provider_id: leagueId,
        team_abbreviation: player.teamAbbreviation ?? null,
      },
    });
    count += 1;
  }
  return { league: scope, provider, players: count, playerCursor: { start: playerWindow.start, nextIndex: playerWindow.nextIndex, total: playerWindow.total } };
}

export async function refreshBasketballSchedules(scope: LeagueScope, now = new Date()) {
  const { leagueId, provider } = await leagueAdapter(scope);
  const lookaheadDays = configuredScheduleLookaheadDays();
  const dates = [...new Set(
    Array.from({ length: lookaheadDays + 1 }, (_, offset) => easternDate(new Date(now.getTime() + offset * 24 * 60 * 60 * 1000))),
  )];
  let count = 0;
  for (const date of dates) {
    const rows = await fetchScoreboardForDate(leagueId, date);
    for (const row of rows) {
      const game = mapScoreboardRow(row);
      if (!game.gameId || !game.homeName || !game.awayName) continue;
      const homeTeamId = await ensureTeam({
        league: scope,
        provider,
        externalId: game.homeId,
        name: game.homeName,
        abbreviation: game.homeAbbreviation || null,
        metadata: { from: "scoreboard" },
      });
      const awayTeamId = await ensureTeam({
        league: scope,
        provider,
        externalId: game.awayId,
        name: game.awayName,
        abbreviation: game.awayAbbreviation || null,
        metadata: { from: "scoreboard" },
      });
      await ensureEvent({
        league: scope,
        provider,
        externalId: game.gameId,
        season: seasonForNow(scope, now),
        scheduledDate: date,
        startTime: game.startTime,
        status: completedStatus(game.status),
        displayName: `${game.awayName} at ${game.homeName}`,
        homeTeamId,
        awayTeamId,
        venue: game.arenaName || null,
        venueCity: game.arenaCity || null,
        venueState: game.arenaState || null,
        metadata: {
          scoreboard_status: game.status,
          home_score: game.homeScore,
          away_score: game.awayScore,
        },
      });
      count += 1;
    }
  }
  return { league: scope, provider, events: count, dates };
}

export async function refreshBasketballSchedulesLiveGate(scope: LeagueScope, now = new Date()) {
  const { leagueId, provider } = await leagueAdapter(scope);
  const { getLiveRefreshDateRange, withRetryAndTimeout } = await import("@/lib/knowledge/enrichment/shared");
  const dateRange = getLiveRefreshDateRange(now);

  let count = 0;
  let processedDates = 0;
  let lastAttempt: any = null;

  for (const date of dateRange.dates) {
    const attempt = await withRetryAndTimeout(
      () => fetchScoreboardForDate(leagueId, date),
      { maxAttempts: 2, timeoutMs: 12000, backoffMs: 2000 },
    );

    if (!attempt.success) {
      const errorDetails = {
        league: scope,
        provider,
        stage: "provider_fetch",
        requestedDate: date,
        requestedDates: dateRange.dates,
        processedDates,
        processedCount: count,
        attempts: attempt.attempts,
        timeouts: attempt.timeouts,
        timeoutMs: 12000,
        errorName: attempt.error.name,
        errorMessage: attempt.error.message,
      };
      const error = new Error(JSON.stringify(errorDetails));
      Object.assign(error, errorDetails);
      throw error;
    }
    lastAttempt = attempt;

    const rows = attempt.value;
    for (const row of rows) {
      const game = mapScoreboardRow(row);
      if (!game.gameId || !game.homeName || !game.awayName) continue;
      const homeTeamId = await ensureTeam({
        league: scope,
        provider,
        externalId: game.homeId,
        name: game.homeName,
        abbreviation: game.homeAbbreviation || null,
        metadata: { from: "scoreboard" },
      });
      const awayTeamId = await ensureTeam({
        league: scope,
        provider,
        externalId: game.awayId,
        name: game.awayName,
        abbreviation: game.awayAbbreviation || null,
        metadata: { from: "scoreboard" },
      });
      await ensureEvent({
        league: scope,
        provider,
        externalId: game.gameId,
        season: seasonForNow(scope, now),
        scheduledDate: date,
        startTime: game.startTime,
        status: completedStatus(game.status),
        displayName: `${game.awayName} at ${game.homeName}`,
        homeTeamId,
        awayTeamId,
        venue: game.arenaName || null,
        venueCity: game.arenaCity || null,
        venueState: game.arenaState || null,
        metadata: {
          scoreboard_status: game.status,
          home_score: game.homeScore,
          away_score: game.awayScore,
        },
      });
      count += 1;
    }
    processedDates += 1;
  }

  const futureEventRows = await selectRows<{ id: string }>("events", {
    select: "id",
    filters: [
      { column: "league_id", value: ACTIVE_LEAGUES[scope].leagueId },
      { column: "start_time", operator: "gte", value: now.toISOString() },
    ],
    limit: 1,
  });

  if (count === 0) {
    const errorDetails = {
      league: scope,
      provider,
      stage: "event_processing",
      requestedDates: dateRange.dates,
      processedDates,
      normalizedEvents: count,
      attempts: lastAttempt?.attempts ?? 1,
      timeouts: lastAttempt?.timeouts ?? 0,
      errorName: "ProcessingError",
      errorMessage: `No events found in ${processedDates} date(s) processed`,
    };
    const error = new Error(JSON.stringify(errorDetails));
    Object.assign(error, errorDetails);
    throw error;
  }

  if (futureEventRows.length === 0) {
    const errorDetails = {
      league: scope,
      provider,
      stage: "future_event_verification",
      requestedDates: dateRange.dates,
      processedDates,
      normalizedEvents: count,
      futureEventsVerified: futureEventRows.length,
      attempts: lastAttempt?.attempts ?? 1,
      timeouts: lastAttempt?.timeouts ?? 0,
      errorName: "VerificationError",
      errorMessage: `No future events visible after refresh (${count} events processed)`,
    };
    const error = new Error(JSON.stringify(errorDetails));
    Object.assign(error, errorDetails);
    throw error;
  }

  return {
    league: scope,
    provider,
    events: count,
    dates: dateRange.dates,
    futureEventsVerified: futureEventRows.length,
  };
}

export async function refreshBasketballCompletedGames(scope: LeagueScope, now = new Date()) {
  const { leagueId, provider } = await leagueAdapter(scope);
  const dates = [easternDate(now), easternDate(new Date(now.getTime() - 24 * 60 * 60 * 1000))];
  let updated = 0;
  for (const date of dates) {
    const rows = await fetchScoreboardForDate(leagueId, date);
    for (const row of rows) {
      const game = mapScoreboardRow(row);
      if (completedStatus(game.status) !== "completed") continue;
      const eventId = await findEventByProviderId(provider, ACTIVE_LEAGUES[scope].leagueId, game.gameId);
      if (!eventId) continue;
      await updateRows("events", [{ column: "id", value: eventId }], {
        status: "completed",
        metadata: {
          final_status: game.status,
          home_score: game.homeScore,
          away_score: game.awayScore,
        },
        updated_at: new Date().toISOString(),
      }, { returning: "minimal" });
      await updateRows("games", [{ column: "id", value: eventId }], {
        status: "completed",
        metadata: {
          final_status: game.status,
          home_score: game.homeScore,
          away_score: game.awayScore,
        },
        updated_at: new Date().toISOString(),
      }, { returning: "minimal" }).catch(() => {});
      updated += 1;
    }
  }
  return { league: scope, provider, completedEvents: updated };
}

type BasketballPlayerLogRefreshResult = {
  league: LeagueScope;
  provider: string;
  status: "ok" | "warning";
  warning: boolean;
  message: string;
  completedAt: string;
  playersChecked: number;
  distinctActivePropPlayers: number;
  priorityPlayersMissingRecent: number;
  resolvedPriorityPlayers: number;
  priorityOnlyWindow: boolean;
  sampleMissingRecentPlayers: string[];
  playerCursor: { start: number; nextIndex: number; total: number };
  requestedPlayers: number;
  providerRequestsAttempted: number;
  returnedRows: number;
  matchedPlayers: number;
  writtenPlayers: number;
  freshAfterRepairPlayers: number;
  unresolvedPlayers: number;
  matchedPlayerIds: string[];
  writtenPlayerIds: string[];
  freshAfterRepairPlayerIds: string[];
  unresolvedPlayerIds: string[];
  logsUpserted: number;
  emptyFetches: number;
};

function playerLogFreshnessMinutes(scope: LeagueScope) {
  return scope === "WNBA" ? 24 * 60 : 18 * 60;
}

function latestPlayerLogTimestamp(row: { updated_at?: string | null; game_date?: string | null }) {
  return row.updated_at ?? row.game_date ?? null;
}

function isFreshPlayerLogTimestamp(timestamp: string | null | undefined, thresholdMinutes: number, now = Date.now()) {
  if (!timestamp) return false;
  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) return false;
  return parsed >= now - thresholdMinutes * 60 * 1000;
}

export function buildBasketballPlayerLogRefreshResult(scope: LeagueScope, details: {
  playersChecked: number;
  distinctActivePropPlayers: number;
  priorityPlayersMissingRecent: number;
  resolvedPriorityPlayers: number;
  priorityOnlyWindow: boolean;
  sampleMissingRecentPlayers: string[];
  playerCursor: { start: number; nextIndex: number; total: number };
  requestedPlayers: number;
  providerRequestsAttempted: number;
  returnedRows: number;
  matchedPlayers: number;
  writtenPlayers: number;
  freshAfterRepairPlayers: number;
  unresolvedPlayers: number;
  matchedPlayerIds: string[];
  writtenPlayerIds: string[];
  freshAfterRepairPlayerIds: string[];
  unresolvedPlayerIds: string[];
  logsUpserted: number;
  emptyFetches: number;
}): BasketballPlayerLogRefreshResult {
  const fullyFresh = details.requestedPlayers > 0
    && details.returnedRows > 0
    && details.matchedPlayers > 0
    && details.writtenPlayers > 0
    && details.unresolvedPlayers === 0
    && details.freshAfterRepairPlayers === details.requestedPlayers;
  const status: BasketballPlayerLogRefreshResult["status"] = fullyFresh ? "ok" : "warning";
  const message = fullyFresh
    ? `Player game logs were refreshed for ${scope} from stored player identities and provider rows.`
    : details.requestedPlayers === 0
      ? `Player game log repair for ${scope} had no targeted players.`
      : details.returnedRows === 0
        ? `Player game log repair for ${scope} returned no provider rows.`
        : details.matchedPlayers === 0
          ? `Player game log repair for ${scope} returned provider rows but matched no targeted players.`
          : details.writtenPlayers === 0
            ? `Player game log repair for ${scope} matched players but wrote no rows.`
            : details.freshAfterRepairPlayers < details.requestedPlayers
              ? `Player game log repair for ${scope} refreshed ${details.freshAfterRepairPlayers}/${details.requestedPlayers} targeted players.`
              : `Player game log repair for ${scope} completed with unresolved identities.`;
  return {
    league: scope,
    provider: scope === "WNBA" ? "wehoop-wnba" : "nba-com-stats",
    ...details,
    status,
    warning: status === "warning",
    message,
    completedAt: new Date().toISOString(),
  };
}

export async function refreshBasketballPlayerLogs(scope: LeagueScope, now = new Date(), options?: {
  playerIds?: string[];
  missingOrStaleOnly?: boolean;
  limit?: number;
}) {
  const { leagueId, provider, adapter } = await leagueAdapter(scope);
  const config = ACTIVE_LEAGUES[scope];
  const baseSliceSize = configuredChunkSize(scope === "WNBA" ? "KNOWLEDGE_WNBA_PLAYER_LOGS_PER_RUN" : "KNOWLEDGE_NBA_PLAYER_LOGS_PER_RUN", scope === "WNBA" ? 6 : 20, 4, 60);
  const playerPoolLimit = scope === "WNBA"
    ? 400
    : Math.max(
        Number(process.env.KNOWLEDGE_PLAYER_LOG_BATCH_SIZE ?? "60"),
        baseSliceSize * 4,
      );
  const players = await selectRows<RefreshPlayerRow>("players", {
    select: "id,canonical_name,current_team_id,external_ids",
    filters: [{ column: "league_id", value: config.leagueId }],
    limit: playerPoolLimit,
  });
  const priorities = await loadLiveSharpPriorities(scope);
  const liveCoverage = await loadLivePropCoverage(scope);
  const missingRecentPriorityPlayerIds = liveCoverage.missingRecentPlayerIds;
  const missingRecentPriorityNames = liveCoverage.missingRecentPlayerNamesNormalized;
  const resolvedPriorityPlayers = await resolvePriorityPlayersForLogs({
    scope,
    provider,
    leagueId,
    adapter,
    rawNameSamples: priorities.playerNameSamples,
    normalizedNames: missingRecentPriorityNames,
    existingPlayers: players,
  });
  const mergedPlayers = Array.from(
    new Map(
      [...resolvedPriorityPlayers, ...players].map((player) => [player.id, player]),
    ).values(),
  );
  const targetedPlayerIds = new Set((options?.playerIds ?? []).filter((value): value is string => Boolean(value)));
  const orderedPlayers = mergedPlayers
    .filter((player) => !targetedPlayerIds.size || targetedPlayerIds.has(player.id))
    .sort((left, right) => {
    const leftMissing = missingRecentPriorityPlayerIds.has(left.id) ? 1 : 0;
    const rightMissing = missingRecentPriorityPlayerIds.has(right.id) ? 1 : 0;
    if (leftMissing !== rightMissing) return rightMissing - leftMissing;
    const leftMissingByName = missingRecentPriorityNames.has(normalizeName(left.canonical_name)) ? 1 : 0;
    const rightMissingByName = missingRecentPriorityNames.has(normalizeName(right.canonical_name)) ? 1 : 0;
    if (leftMissingByName !== rightMissingByName) return rightMissingByName - leftMissingByName;
    const leftPriority = (priorities.playerIds.has(left.id) || priorities.playerNames.has(normalizeName(left.canonical_name))) ? 1 : 0;
    const rightPriority = (priorities.playerIds.has(right.id) || priorities.playerNames.has(normalizeName(right.canonical_name))) ? 1 : 0;
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;
      return left.canonical_name.localeCompare(right.canonical_name);
    });
  const scopedPlayers = options?.missingOrStaleOnly
    ? orderedPlayers.filter((player) => missingRecentPriorityPlayerIds.has(player.id) || missingRecentPriorityNames.has(normalizeName(player.canonical_name)))
    : orderedPlayers;
  const livePriorityCount = scopedPlayers.filter((player) => priorities.playerIds.has(player.id) || priorities.playerNames.has(normalizeName(player.canonical_name))).length;
  const missingRecentPriorityCount = scopedPlayers.filter((player) => missingRecentPriorityPlayerIds.has(player.id) || missingRecentPriorityNames.has(normalizeName(player.canonical_name))).length;

  const wnbaPrioritySliceCap = missingRecentPriorityCount > 0
    ? Math.min(Math.max(missingRecentPriorityCount, 12), 16)
    : 10;
  const playerWindow: RefreshWindow<RefreshPlayerRow> = targetedPlayerIds.size
    ? (() => {
        const targetedItems = scopedPlayers.slice(0, typeof options?.limit === "number" && Number.isFinite(options.limit)
          ? Math.max(1, Math.floor(options.limit))
          : Math.min(scopedPlayers.length || 1, Math.max(baseSliceSize, missingRecentPriorityCount || livePriorityCount || 1)));
        return {
          items: targetedItems,
          start: 0,
          end: targetedItems.length,
          nextIndex: 0,
          total: scopedPlayers.length,
          priorityOnly: false,
        };
      })()
    : await takeLiveFirstWindow({
        cacheKey: `knowledge:cursor:${scope.toLowerCase()}:refresh_player_game_logs:players`,
        provider,
        items: scopedPlayers,
        isPriority: (player) =>
          missingRecentPriorityPlayerIds.has(player.id)
          || missingRecentPriorityNames.has(normalizeName(player.canonical_name))
          || priorities.playerIds.has(player.id)
          || priorities.playerNames.has(normalizeName(player.canonical_name)),
        sliceSize: Math.min(
          Math.max(
            baseSliceSize,
            Math.min(Math.max(missingRecentPriorityCount, livePriorityCount), scope === "WNBA" ? wnbaPrioritySliceCap : 28),
          ),
          scope === "WNBA" ? wnbaPrioritySliceCap : 60,
        ),
        maxPriorityItems:
          scope === "WNBA"
            ? missingRecentPriorityCount > 0
              ? wnbaPrioritySliceCap
              : Math.max(2, Math.floor(baseSliceSize / 2))
            : undefined,
      });
  const playerItems = playerWindow.items;

  let inserted = 0;
  let providerRequestsAttempted = 0;
  let returnedRows = 0;
  const matchedPlayerIds = new Set<string>();
  const writtenPlayerIds = new Set<string>();
  let emptyFetches = 0;
  const eventLookupCache = new Map<string, string | null>();
  const opponentTeamCache = new Map<string, string | null>();
  const refreshedAt = now.toISOString();
  for (const player of playerItems) {
    let externalId = Number(
      (player.external_ids ?? {})[provider]
      ?? (scope === "WNBA" ? (player.external_ids ?? {})["nba-com-stats"] : null)
      ?? 0,
    );
    if (!externalId && scope === "WNBA") {
      const repaired = await adapter.searchPlayer(player.canonical_name, leagueId, seasonForNow(scope, now)).catch(() => null);
      if (repaired?.id) {
        externalId = repaired.id;
        await updateRows("players", [{ column: "id", value: player.id }], {
          external_ids: {
            ...(player.external_ids ?? {}),
            [provider]: String(repaired.id),
            "nba-com-stats": String(repaired.id),
          },
        }).catch(() => {});
      }
    }
    if (!externalId) continue;
    const candidateSeasons = playerLogSeasonsToTry(scope, now);
    let rows: Array<Record<string, unknown>> = [];
    let resolvedSeason = seasonForNow(scope, now);
    for (const season of candidateSeasons) {
      // eslint-disable-next-line no-await-in-loop
      providerRequestsAttempted += 1;
      const payload = await adapter.fetchPlayerGameLog({
        playerId: externalId,
        playerName: player.canonical_name,
        statType: "points",
        leagueId,
        season,
      }).catch(() => null);
      const resultSets = Array.isArray(payload?.data.resultSets) ? payload.data.resultSets : [];
      rows = rowsFromAllResultSets(resultSets);
      if (rows.length) {
        resolvedSeason = season;
        break;
      }
    }
    if (!rows.length && scope === "WNBA") {
      const repaired = await adapter.searchPlayer(player.canonical_name, leagueId, seasonForNow(scope, now)).catch(() => null);
      if (repaired?.id) {
        externalId = repaired.id;
        await updateRows("players", [{ column: "id", value: player.id }], {
          external_ids: {
            ...(player.external_ids ?? {}),
            [provider]: String(repaired.id),
            "nba-com-stats": String(repaired.id),
          },
        }).catch(() => {});
        for (const season of candidateSeasons) {
          // eslint-disable-next-line no-await-in-loop
          const payload = await adapter.fetchPlayerGameLog({
            playerId: externalId,
            playerName: player.canonical_name,
            statType: "points",
            leagueId,
            season,
          }).catch(() => null);
          const resultSets = Array.isArray(payload?.data.resultSets) ? payload.data.resultSets : [];
          rows = rowsFromAllResultSets(resultSets);
          if (rows.length) {
            resolvedSeason = season;
            break;
          }
        }
      }
    }
    if (!rows.length) {
      emptyFetches += 1;
      continue;
    }
    matchedPlayerIds.add(player.id);
    returnedRows += rows.length;
    const records = [];
    for (const row of rows) {
      const gameId = safeText(row.GAME_ID);
      let eventId: string | null = null;
      if (gameId) {
        if (eventLookupCache.has(gameId)) {
          eventId = eventLookupCache.get(gameId) ?? null;
        } else {
          eventId = await findEventByProviderId(provider, config.leagueId, gameId);
          eventLookupCache.set(gameId, eventId);
        }
      }
      const matchup = safeText(row.MATCHUP);
      const isAway = /@/.test(matchup);
      const opponentAbbreviation = matchup.split(/vs\.|@/i).pop()?.trim() || "";
      const normalizedOpponent = opponentAbbreviation ? normalizeName(opponentAbbreviation) : "";
      let opponentTeamId: string | null = null;
      if (normalizedOpponent) {
        if (opponentTeamCache.has(normalizedOpponent)) {
          opponentTeamId = opponentTeamCache.get(normalizedOpponent) ?? null;
        } else {
          const opponentTeam = await selectRows<{ entity_id: string }>("entity_aliases", {
            select: "entity_id",
            filters: [
              { column: "entity_type", value: "team" },
              { column: "league_id", value: config.leagueId },
              { column: "normalized_alias", value: normalizedOpponent },
            ],
            limit: 1,
          }).catch(() => []);
          opponentTeamId = opponentTeam[0]?.entity_id ?? null;
          opponentTeamCache.set(normalizedOpponent, opponentTeamId);
        }
      }
      records.push({
        sport_id: config.sportId,
        league_id: config.leagueId,
        player_id: player.id,
        team_id: player.current_team_id,
        opponent_team_id: opponentTeamId,
        event_id: eventId,
        game_id: eventId,
        game_date: safeText(row.GAME_DATE) ? new Date(String(row.GAME_DATE)).toISOString().slice(0, 10) : easternDate(now),
        season: resolvedSeason,
        provider,
        minutes: safeNumber(row.MIN),
        points: safeNumber(row.PTS),
        rebounds: safeNumber(row.REB),
        assists: safeNumber(row.AST),
        steals: safeNumber(row.STL),
        blocks: safeNumber(row.BLK),
        turnovers: safeNumber(row.TOV),
        fantasy_score: safeNumber(row.FANTASY_PTS),
        stat_line: {
          matchup,
          wl: row.WL,
          is_away: isAway,
          opponent_abbreviation: opponentAbbreviation,
        },
        raw_payload: row,
        source_updated_at: refreshedAt,
        updated_at: refreshedAt,
      });
    }
    if (records.length) {
      const dedupedRecords = Array.from(
        new Map(
          records.map((record) => [
            `${provider}|${player.id}|${String(record.game_date)}|${String(record.event_id ?? "")}`,
            record,
          ]),
        ).values(),
      );
      await deleteRows("player_game_logs", [
        { column: "provider", value: provider },
        { column: "player_id", value: player.id },
      ]).catch(() => {});
      await insertRows("player_game_logs", dedupedRecords, { returning: "minimal" });
      inserted += dedupedRecords.length;
      writtenPlayerIds.add(player.id);
    }
  }
  const postWriteRows = playerItems.length
    ? await selectRows<{ player_id: string | null; updated_at: string | null; game_date: string | null }>("player_game_logs", {
        select: "player_id,updated_at,game_date",
        filters: [
          { column: "league_id", value: config.leagueId },
          { column: "player_id", operator: "in", value: playerItems.map((player) => player.id) },
        ],
        orderBy: "updated_at.desc",
        limit: Math.max(playerItems.length * 8, 100),
      }).catch(() => [])
    : [];
  const latestByPlayer = new Map<string, { updated_at: string | null; game_date: string | null }>();
  for (const row of postWriteRows) {
    if (!row.player_id) continue;
    const current = latestByPlayer.get(row.player_id);
    if (!current || new Date(latestPlayerLogTimestamp(row) ?? 0).getTime() >= new Date(latestPlayerLogTimestamp(current) ?? 0).getTime()) {
      latestByPlayer.set(row.player_id, row);
    }
  }
  const freshAfterRepairPlayerIds = new Set<string>();
  const freshnessThresholdMinutes = playerLogFreshnessMinutes(scope);
  for (const player of playerItems) {
    const latest = latestByPlayer.get(player.id) ?? null;
    if (latest && isFreshPlayerLogTimestamp(latestPlayerLogTimestamp(latest), freshnessThresholdMinutes, now.getTime())) {
      freshAfterRepairPlayerIds.add(player.id);
    }
  }
  const unresolvedPlayerIds = playerItems
    .map((player) => player.id)
    .filter((playerId) => !matchedPlayerIds.has(playerId));

  const report = buildBasketballPlayerLogRefreshResult(scope, {
    playersChecked: playerItems.length,
    distinctActivePropPlayers: liveCoverage.distinctPlayerIds.length,
    priorityPlayersMissingRecent: missingRecentPriorityCount,
    resolvedPriorityPlayers: resolvedPriorityPlayers.length,
    priorityOnlyWindow: playerWindow.priorityOnly,
    sampleMissingRecentPlayers: liveCoverage.sampleMissingPlayerNames,
    playerCursor: { start: playerWindow.start, nextIndex: playerWindow.nextIndex, total: playerWindow.total },
    requestedPlayers: playerItems.length,
    providerRequestsAttempted,
    returnedRows,
    matchedPlayers: matchedPlayerIds.size,
    writtenPlayers: writtenPlayerIds.size,
    freshAfterRepairPlayers: freshAfterRepairPlayerIds.size,
    unresolvedPlayers: unresolvedPlayerIds.length,
    matchedPlayerIds: [...matchedPlayerIds],
    writtenPlayerIds: [...writtenPlayerIds],
    freshAfterRepairPlayerIds: [...freshAfterRepairPlayerIds],
    unresolvedPlayerIds,
    logsUpserted: inserted,
    emptyFetches,
  });
  return report;
}

export async function refreshBasketballTeamLogs(scope: LeagueScope, now = new Date()) {
  const { leagueId, provider, adapter } = await leagueAdapter(scope);
  const config = ACTIVE_LEAGUES[scope];
  let rows: Array<Record<string, unknown>> = [];
  let resolvedSeason = seasonForNow(scope, now);
  for (const season of seasonsToTry(scope, now)) {
    // eslint-disable-next-line no-await-in-loop
    const payload = await adapter.fetchLeagueGameFinder(leagueId, season).catch(() => null);
    const resultSets = Array.isArray(payload?.resultSets) ? payload.resultSets : [];
    rows = rowsFromAllResultSets(resultSets);
    if (rows.length) {
      resolvedSeason = season;
      break;
    }
  }
  const grouped = new Map<string, TeamStatsRow[]>();
  for (const row of rows) {
    const teamId = safeText(row.TEAM_ID);
    if (!teamId) continue;
    const list = grouped.get(teamId) ?? [];
    list.push(row);
    grouped.set(teamId, list);
  }
  let inserted = 0;
  for (const [externalTeamId, teamRows] of grouped.entries()) {
    const teamId = await ensureTeam({
      league: scope,
      provider,
      externalId: externalTeamId,
      name: safeText(teamRows[0]?.TEAM_NAME) || `Team ${externalTeamId}`,
      abbreviation: safeText(teamRows[0]?.TEAM_ABBREVIATION) || null,
    });
    const records = [];
    for (const row of teamRows) {
      const gameId = safeText(row.GAME_ID);
      const eventId = gameId ? await findEventByProviderId(provider, config.leagueId, gameId) : null;
      records.push({
        sport_id: config.sportId,
        league_id: config.leagueId,
        team_id: teamId,
        opponent_team_id: null,
        event_id: eventId,
        game_id: eventId,
        game_date: safeText(row.GAME_DATE) ? new Date(String(row.GAME_DATE)).toISOString().slice(0, 10) : easternDate(now),
        season: resolvedSeason,
        provider,
        pace: safeNumber(row.PACE),
        offensive_rating: safeNumber(row.OFF_RATING),
        defensive_rating: safeNumber(row.DEF_RATING),
        possessions: safeNumber(row.POSS),
        implied_total: null,
        team_total: safeNumber(row.PTS),
        stat_line: row,
        raw_payload: row,
        source_updated_at: new Date().toISOString(),
      });
    }
    await deleteRows("team_game_logs", [
      { column: "provider", value: provider },
      { column: "team_id", value: teamId },
    ]).catch(() => {});
    await insertRows("team_game_logs", records, { returning: "minimal" });
    inserted += records.length;
  }
  return { league: scope, provider, teamLogsUpserted: inserted };
}

export async function refreshBasketballInjuries(scope: LeagueScope) {
  const adapter = new OfficialInjuryReportAdapter();
  if (!adapter.configured(scope)) {
    return { league: scope, provider: "official-injuries", skipped: true, reason: "injury source not configured" };
  }
  const payload = await adapter.fetchReport(scope);
  const config = ACTIVE_LEAGUES[scope];
  await deleteRows("injuries", [
    { column: "league_id", value: config.leagueId },
    { column: "report_source", value: "official-injuries" },
    { column: "injury_date", value: easternDate(new Date()) },
  ]).catch(() => {});
  let inserted = 0;
  for (const record of payload.data.records) {
    const alias = await selectRows<{ entity_id: string }>("entity_aliases", {
      select: "entity_id",
      filters: [
        { column: "entity_type", value: "player" },
        { column: "league_id", value: config.leagueId },
        { column: "normalized_alias", value: normalizeName(record.playerName) },
      ],
      limit: 1,
    });
    const playerId = alias[0]?.entity_id ?? null;
    const teamId = record.team ? (await selectRows<{ entity_id: string }>("entity_aliases", {
      select: "entity_id",
      filters: [
        { column: "entity_type", value: "team" },
        { column: "league_id", value: config.leagueId },
        { column: "normalized_alias", value: normalizeName(record.team) },
      ],
      limit: 1,
    }))[0]?.entity_id ?? null : null;
    await insertRows("injuries", [{
      sport_id: config.sportId,
      league_id: config.leagueId,
      player_id: playerId,
      team_id: teamId,
      injury_date: record.reportDate ? String(record.reportDate).slice(0, 10) : easternDate(new Date()),
      status: record.status,
      report_source: "official-injuries",
      body_part: null,
      note: record.note ?? null,
      return_timeline: null,
      raw_payload: record,
    }], { returning: "minimal" });
    inserted += 1;
  }
  return { league: scope, provider: "official-injuries", inserted };
}

export async function refreshBasketballLineups(scope: LeagueScope) {
  return {
    league: scope,
    provider: "official-scoreboard",
    implemented: false,
    reason: "Basketball lineup/starter source is not yet reliable in the current free-source set.",
  };
}

export async function refreshBasketballRestContext(scope: LeagueScope) {
  const config = ACTIVE_LEAGUES[scope];
  const upcomingEvents = await selectRows<{ id: string; event_id?: string | null; scheduled_date: string; start_time: string; home_team_id: string | null; away_team_id: string | null }>("events", {
    select: "id,scheduled_date,start_time,home_team_id,away_team_id",
    filters: [{ column: "league_id", value: config.leagueId }],
    orderBy: "start_time.asc",
    limit: 120,
  });
  let inserted = 0;
  for (const event of upcomingEvents) {
    for (const teamId of [event.home_team_id, event.away_team_id].filter(Boolean) as string[]) {
      const recent = await selectRows<{ game_date: string }>("team_game_logs", {
        select: "game_date",
        filters: [
          { column: "league_id", value: config.leagueId },
          { column: "team_id", value: teamId },
        ],
        orderBy: "game_date.desc",
        limit: 2,
      });
      const eventDate = new Date(`${event.scheduled_date}T12:00:00-04:00`);
      const lastDate = recent[0]?.game_date ? new Date(`${recent[0].game_date}T12:00:00-04:00`) : null;
      const daysRest = lastDate ? Math.round((eventDate.getTime() - lastDate.getTime()) / (24 * 60 * 60 * 1000)) : null;
      const backToBack = daysRest !== null ? daysRest <= 1 : false;
      await deleteRows("rest_context", [
        { column: "event_id", value: event.id },
        { column: "team_id", value: teamId },
        { raw: "player_id=is.null" },
      ]).catch(() => {});
      await insertRows("rest_context", [{
        sport_id: config.sportId,
        league_id: config.leagueId,
        event_id: event.id,
        game_id: event.id,
        team_id: teamId,
        player_id: null,
        context_date: event.scheduled_date,
        days_rest: daysRest,
        back_to_back: backToBack,
        travel_note: null,
        context_payload: {
          latest_logged_team_date: recent[0]?.game_date ?? null,
          previous_logged_team_date: recent[1]?.game_date ?? null,
        },
      }], { returning: "minimal" });
      inserted += 1;
    }
  }
  return { league: scope, rows: inserted };
}

export async function refreshBasketballMatchupFeatures(scope: LeagueScope, now = new Date(), options?: {
  eventIds?: string[];
  teamIds?: string[];
  missingOrStaleOnly?: boolean;
  limit?: number;
}) {
  const { leagueId, provider, adapter } = await leagueAdapter(scope);
  const config = ACTIVE_LEAGUES[scope];
  const targetedEventIds = new Set((options?.eventIds ?? []).filter((value): value is string => Boolean(value)));
  const targetedTeamIds = new Set((options?.teamIds ?? []).filter((value): value is string => Boolean(value)));
  const upcoming = await selectRows<{ id: string; home_team_id: string | null; away_team_id: string | null; scheduled_date: string }>("events", {
    select: "id,home_team_id,away_team_id,scheduled_date",
    filters: [
      { column: "league_id", value: config.leagueId },
      ...(targetedEventIds.size ? [{ column: "id", operator: "in" as const, value: [...targetedEventIds] }] : []),
    ],
    orderBy: "start_time.asc",
    limit: targetedEventIds.size ? Math.max(targetedEventIds.size * 2, 30) : 30,
  });
  const matchedUpcoming = upcoming.filter((event) => {
    if (!targetedEventIds.size && !targetedTeamIds.size) return true;
    return targetedEventIds.has(event.id)
      || targetedTeamIds.has(event.home_team_id ?? "")
      || targetedTeamIds.has(event.away_team_id ?? "");
  });
  if (options && !matchedUpcoming.length) {
    return {
      league: scope,
      teamContexts: 0,
      matchupRows: 0,
      providerRequests: 0,
    };
  }
  let advancedRows: Array<Record<string, unknown>> = [];
  let baseRows: Array<Record<string, unknown>> = [];
  let providerRequests = 0;
  for (const season of seasonsToTry(scope, now)) {
    // eslint-disable-next-line no-await-in-loop
    const advancedPayload = await adapter.fetchLeagueTeamStats(leagueId, season, "Advanced").catch(() => null);
    providerRequests += 1;
    advancedRows = rowsToObjects(Array.isArray(advancedPayload?.resultSets) ? advancedPayload.resultSets : []);
    if (scope === "WNBA") {
      baseRows = advancedRows;
    } else {
      // eslint-disable-next-line no-await-in-loop
      const basePayload = await adapter.fetchLeagueTeamStats(leagueId, season, "Base").catch(() => null);
      providerRequests += 1;
      baseRows = rowsToObjects(Array.isArray(basePayload?.resultSets) ? basePayload.resultSets : []);
    }
    if (advancedRows.length || baseRows.length) break;
  }
  if (!advancedRows.length && !baseRows.length) {
    const recentTeamLogs = await selectRows<{
      team_id: string;
      game_date: string;
      pace: number | null;
      offensive_rating: number | null;
      defensive_rating: number | null;
      team_total: number | null;
    }>("team_game_logs", {
      select: "team_id,game_date,pace,offensive_rating,defensive_rating,team_total",
      filters: [{ column: "league_id", value: config.leagueId }],
      orderBy: "game_date.desc",
      limit: 300,
    }).catch(() => []);
    const groupedLogs = new Map<string, typeof recentTeamLogs>();
    for (const row of recentTeamLogs) {
      const bucket = groupedLogs.get(row.team_id) ?? [];
      bucket.push(row);
      groupedLogs.set(row.team_id, bucket);
    }
    for (const [teamId, rowsForTeam] of groupedLogs.entries()) {
      const latest = rowsForTeam[0];
      await deleteRows("basketball_team_context", [
        { column: "team_id", value: teamId },
        { column: "context_date", value: easternDate(now) },
      ]).catch(() => {});
      await insertRows("basketball_team_context", [{
        league_id: config.leagueId,
        team_id: teamId,
        game_id: null,
        event_id: null,
        context_date: easternDate(now),
        pace: safeNumber(latest?.pace),
        offensive_rating: safeNumber(latest?.offensive_rating),
        defensive_rating: safeNumber(latest?.defensive_rating),
        standing: null,
        record_summary: null,
        context_payload: {
          source: "team_game_logs",
          sample_size: rowsForTeam.length,
        },
      }], { returning: "minimal" });
    }
  }
  const byTeamId = new Map<string, Record<string, unknown>>();
  for (const row of advancedRows) byTeamId.set(safeText(row.TEAM_ID), row);
  let contexts = 0;
  const contextDate = easternDate(now);
  const teamContextMap = new Map<string, { pace: number | null; defensive_rating: number | null; record_summary: string | null }>();
  for (const row of baseRows) {
    const externalTeamId = safeText(row.TEAM_ID);
    const teamId = await ensureTeam({
      league: scope,
      provider,
      externalId: externalTeamId,
      name: safeText(row.TEAM_NAME) || `Team ${externalTeamId}`,
      abbreviation: safeText(row.TEAM_ABBREVIATION) || null,
    });
    const advanced = byTeamId.get(externalTeamId) ?? {};
    await deleteRows("basketball_team_context", [
      { column: "team_id", value: teamId },
      { column: "context_date", value: easternDate(now) },
    ]).catch(() => {});
    await insertRows("basketball_team_context", [{
      league_id: config.leagueId,
      team_id: teamId,
      game_id: null,
      event_id: null,
      context_date: contextDate,
      pace: safeNumber(advanced.PACE),
      offensive_rating: safeNumber(advanced.OFF_RATING),
      defensive_rating: safeNumber(advanced.DEF_RATING),
      standing: null,
      record_summary: `${safeText(row.W)}-${safeText(row.L)}`,
      context_payload: {
        base: row,
        advanced,
      },
    }], { returning: "minimal" });
    teamContextMap.set(teamId, {
      pace: safeNumber(advanced.PACE),
      defensive_rating: safeNumber(advanced.DEF_RATING),
      record_summary: `${safeText(row.W)}-${safeText(row.L)}`,
    });
    contexts += 1;
  }

  if (!teamContextMap.size) {
    const existingContexts = await selectRows<{
      team_id: string;
      pace: number | null;
      defensive_rating: number | null;
      record_summary: string | null;
    }>("basketball_team_context", {
      select: "team_id,pace,defensive_rating,record_summary",
      filters: [{ column: "context_date", value: contextDate }],
      limit: 80,
    }).catch(() => []);
    for (const row of existingContexts) {
      teamContextMap.set(row.team_id, {
        pace: safeNumber(row.pace),
        defensive_rating: safeNumber(row.defensive_rating),
        record_summary: row.record_summary ?? null,
      });
    }
  }

  const eventWindow = targetedEventIds.size || targetedTeamIds.size
    ? {
        items: matchedUpcoming.slice(0, typeof options?.limit === "number" && Number.isFinite(options.limit)
          ? Math.max(1, Math.floor(options.limit))
          : Math.min(matchedUpcoming.length || 1, 6)),
      }
    : {
        items: matchedUpcoming,
      };
  let matchupRows = 0;
  for (const event of eventWindow.items) {
    if (!event.home_team_id || !event.away_team_id) continue;
    const homeContext = teamContextMap.get(event.home_team_id) ?? null;
    const awayContext = teamContextMap.get(event.away_team_id) ?? null;
    for (const [teamId, opponentTeamId, opponent] of [
      [event.home_team_id, event.away_team_id, awayContext],
      [event.away_team_id, event.home_team_id, homeContext],
    ] as const) {
      await deleteRows("basketball_opponent_context", [
        { column: "event_id", value: event.id },
        { column: "team_id", value: teamId },
        { column: "opponent_team_id", value: opponentTeamId },
      ]).catch(() => {});
      await insertRows("basketball_opponent_context", [{
        league_id: config.leagueId,
        team_id: teamId,
        opponent_team_id: opponentTeamId,
        game_id: event.id,
        event_id: event.id,
        context_date: event.scheduled_date,
        opponent_pace: safeNumber(opponent?.pace),
        opponent_defensive_rating: safeNumber(opponent?.defensive_rating),
        opponent_record_summary: opponent?.record_summary ?? null,
        context_payload: {
          source: "nba-com-stats",
        },
      }], { returning: "minimal" });
      await deleteRows("matchup_features", [
        { column: "event_id", value: event.id },
        { column: "team_id", value: teamId },
        { column: "opponent_team_id", value: opponentTeamId },
        { column: "feature_date", value: event.scheduled_date },
        { column: "matchup_type", value: "basketball-general" },
      ]).catch(() => {});
      await insertRows("matchup_features", [{
        sport_id: config.sportId,
        league_id: config.leagueId,
        team_id: teamId,
        opponent_team_id: opponentTeamId,
        event_id: event.id,
        game_id: event.id,
        feature_date: event.scheduled_date,
        matchup_type: "basketball-general",
        feature_payload: {
          opponent_pace: safeNumber(opponent?.pace),
          opponent_defensive_rating: safeNumber(opponent?.defensive_rating),
          opponent_record_summary: opponent?.record_summary ?? null,
        },
        data_quality_score: 0.72,
      }], { returning: "minimal" });
      matchupRows += 1;
    }
  }
  return { league: scope, teamContexts: contexts, matchupRows, providerRequests };
}
