import { deleteRows, insertRows, selectRows, upsertRows, updateRows } from "@/lib/db/supabase-server";
import { ACTIVE_LEAGUES, addDays, configuredChunkSize, configuredPlayerLogBatchSize, configuredScheduleLookaheadDays, currentMlbSeason, easternDate, ensureEvent, ensurePlayer, ensureTeam, findEventByProviderId, normalizeName, takeRotatingSlice } from "@/lib/knowledge/enrichment/shared";
import type { RefreshWindow } from "@/lib/knowledge/enrichment/shared";
import { HighlightlyMlbAdapter } from "@/lib/providers/highlightly-mlb";
import { MlbStatsApiAdapter } from "@/lib/providers/mlb-stats-api";
import { OpenMeteoWeatherAdapter } from "@/lib/providers/open-meteo-weather";
import { StatcastSavantAdapter } from "@/lib/providers/statcast-savant";

type MlbScheduleGame = {
  gamePk: number;
  gameDate: string;
  status?: { detailedState?: string; abstractGameState?: string };
  venue?: { name?: string; location?: { city?: string; stateAbbrev?: string } };
  dayNight?: string;
  doubleHeader?: string;
  teams?: {
    home?: {
      team?: { id?: number; name?: string; abbreviation?: string };
      probablePitcher?: { id?: number; fullName?: string; pitchHand?: { code?: string; description?: string } };
      score?: number;
    };
    away?: {
      team?: { id?: number; name?: string; abbreviation?: string };
      probablePitcher?: { id?: number; fullName?: string; pitchHand?: { code?: string; description?: string } };
      score?: number;
    };
  };
  linescore?: Record<string, unknown>;
};

type SchedulePayload = { dates?: Array<{ date?: string; games?: MlbScheduleGame[] }> };
type TeamDirectoryPayload = { teams?: Array<{ id?: number; name?: string; abbreviation?: string; venue?: { name?: string; location?: { city?: string; stateAbbrev?: string } } }> };
type MlbBoxscorePayload = {
  teams?: {
    home?: { players?: Record<string, unknown>; team?: { id?: number; name?: string } };
    away?: { players?: Record<string, unknown>; team?: { id?: number; name?: string } };
  };
};

type SharpPriorityRow = {
  player_id?: string | null;
  player_name?: string | null;
  team_id?: string | null;
  team_name?: string | null;
  event_id?: string | null;
  start_time?: string | null;
};

type MlbPlayerRow = {
  id: string;
  canonical_name: string;
  current_team_id: string | null;
  primary_position: string | null;
  external_ids: Record<string, unknown> | null;
};

const config = ACTIVE_LEAGUES.MLB;

function liveWindowBounds(now = new Date()) {
  const nowMs = now.getTime();
  const lookbackMs = 2 * 60 * 60 * 1000;
  const lookaheadHours = Math.min(Math.max(Number(process.env.KNOWLEDGE_MLB_LIVE_LOOKAHEAD_HOURS ?? 36), 6), 72);
  const lookaheadMs = lookaheadHours * 60 * 60 * 1000;
  return {
    earliestMs: nowMs - lookbackMs,
    latestMs: nowMs + lookaheadMs,
  };
}

function isWithinLiveWindow(startTime: string | null | undefined, bounds: { earliestMs: number; latestMs: number }) {
  if (!startTime) return true;
  const startMs = new Date(startTime).getTime();
  if (!Number.isFinite(startMs)) return true;
  return startMs >= bounds.earliestMs && startMs <= bounds.latestMs;
}

function safeText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function safeNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchMlbJson(path: string) {
  const response = await fetch(`https://statsapi.mlb.com${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`MLB Stats API request failed with status ${response.status}.`);
  return payload;
}

function extractScheduleGames(payload: unknown) {
  const dates = (payload as SchedulePayload | null)?.dates ?? [];
  return dates.flatMap((date) => date.games ?? []);
}

function gameStatus(game: MlbScheduleGame) {
  const detail = game.status?.detailedState ?? game.status?.abstractGameState ?? "Scheduled";
  if (/final|completed/i.test(detail)) return "completed";
  if (/live|progress|delay|review/i.test(detail)) return "live";
  return "scheduled";
}

function rowValue(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function statLineValue(stat: Record<string, unknown>, ...keys: string[]) {
  const direct = rowValue(stat, ...keys);
  if (direct !== null) return direct;
  const nested = stat.stat && typeof stat.stat === "object" ? rowValue(stat.stat as Record<string, unknown>, ...keys) : null;
  return nested;
}

async function loadLiveSharpPriorities() {
  const rows = await selectRows<SharpPriorityRow>("current_props", {
    select: "player_id,player_name,team_id,team_name,start_time",
    filters: [
      { column: "provider", value: "sharpapi" },
      { column: "league_id", value: config.leagueId },
      { column: "active", value: true },
    ],
    orderBy: "updated_at.desc",
    limit: 400,
  });
  const bounds = liveWindowBounds();
  const activeRows = rows.filter((row) => isWithinLiveWindow(row.start_time, bounds));
  return {
    playerIds: new Set(activeRows.map((row) => row.player_id).filter((value): value is string => Boolean(value))),
    playerNames: new Set(activeRows.map((row) => normalizeName(String(row.player_name ?? ""))).filter(Boolean)),
    teamIds: new Set(activeRows.map((row) => row.team_id).filter((value): value is string => Boolean(value))),
    teamNames: new Set(activeRows.map((row) => normalizeName(String(row.team_name ?? ""))).filter(Boolean)),
  };
}

type UnresolvedEventTeamRow = { event_id: string | null; start_time: string | null };
type UnresolvedEventRow = { id: string; start_time: string | null; home_team_id: string | null; away_team_id: string | null };

/**
 * Roster-refresh prioritization has a circular blind spot: it boosts teams found in
 * current_props.team_id/team_name, but that's exactly what's null on the rows this refresh
 * exists to fix (SharpAPI's MLB batter_hits feed has no player-team field -- see
 * docs/AGENT_HANDOFF.md's session 5 Phase 2 finding). This reads the OTHER identity signal
 * that's already resolved and reliable for these same rows: current_props.event_id ->
 * events.home_team_id/away_team_id. No name matching, no fuzzy inference -- exact ID joins
 * only. Returns team IDs ordered by nearest future event first, deduplicated, so callers can
 * fold them into their existing priority set without changing bounded team-limit math.
 */
export async function loadUnresolvedFutureMlbEventTeamPriorities(now = new Date()) {
  const nowIso = now.toISOString();
  const unresolvedProps = await selectRows<UnresolvedEventTeamRow>("current_props", {
    select: "event_id,start_time",
    filters: [
      { column: "provider", value: "sharpapi" },
      { column: "league_id", value: config.leagueId },
      { column: "active", value: true },
      { column: "team_id", operator: "is", value: null },
      { column: "start_time", operator: "gte", value: nowIso },
    ],
    orderBy: "start_time.asc",
    limit: 200,
  });

  const distinctEventIds = [...new Set(unresolvedProps.map((row) => row.event_id).filter((value): value is string => Boolean(value)))].slice(0, 25);
  if (!distinctEventIds.length) return { teamIds: new Set<string>() };

  const events = await selectRows<UnresolvedEventRow>("events", {
    select: "id,start_time,home_team_id,away_team_id",
    filters: [
      { column: "league_id", value: config.leagueId },
      { column: "id", operator: "in", value: distinctEventIds },
    ],
  });

  const sortedEvents = [...events].sort((left, right) => {
    const leftMs = left.start_time ? new Date(left.start_time).getTime() : Number.POSITIVE_INFINITY;
    const rightMs = right.start_time ? new Date(right.start_time).getTime() : Number.POSITIVE_INFINITY;
    return leftMs - rightMs;
  });

  const orderedTeamIds: string[] = [];
  const seen = new Set<string>();
  for (const event of sortedEvents) {
    for (const teamId of [event.home_team_id, event.away_team_id]) {
      if (!teamId || seen.has(teamId)) continue;
      seen.add(teamId);
      orderedTeamIds.push(teamId);
    }
  }

  return { teamIds: new Set(orderedTeamIds), orderedTeamIds };
}

async function loadMissingRecentFeaturePlayerIds(playerIds: string[]) {
  if (!playerIds.length) return new Set<string>();
  const [recentRows, batterRows, pitcherRows] = await Promise.all([
    selectRows<{ player_id: string | null }>("player_recent_features", {
      select: "player_id",
      filters: [
        { column: "league_id", value: config.leagueId },
        { column: "player_id", operator: "in", value: playerIds },
      ],
      limit: Math.max(playerIds.length * 2, 50),
    }).catch(() => []),
    selectRows<{ player_id: string | null }>("mlb_batter_features", {
      select: "player_id",
      filters: [{ column: "player_id", operator: "in", value: playerIds }],
      limit: Math.max(playerIds.length * 2, 50),
    }).catch(() => []),
    selectRows<{ player_id: string | null }>("mlb_pitcher_features", {
      select: "player_id",
      filters: [{ column: "player_id", operator: "in", value: playerIds }],
      limit: Math.max(playerIds.length * 2, 50),
    }).catch(() => []),
  ]);
  const covered = new Set([
    ...recentRows.map((row) => row.player_id),
    ...batterRows.map((row) => row.player_id),
    ...pitcherRows.map((row) => row.player_id),
  ].filter((value): value is string => Boolean(value)));
  return new Set(playerIds.filter((playerId) => !covered.has(playerId)));
}

async function loadLivePropCoverage() {
  const rows = await selectRows<SharpPriorityRow>("current_props", {
    select: "player_id,player_name,team_id,team_name,event_id,start_time",
    filters: [
      { column: "provider", value: "sharpapi" },
      { column: "league_id", value: config.leagueId },
      { column: "active", value: true },
    ],
    orderBy: "updated_at.desc",
    limit: 500,
  });
  const bounds = liveWindowBounds();
  const activeRows = rows.filter((row) => isWithinLiveWindow(row.start_time, bounds));
  const distinctEventIds = [...new Set(activeRows.map((row) => row.event_id).filter((value): value is string => Boolean(value)))];
  const distinctPlayerIds = [...new Set(activeRows.map((row) => row.player_id).filter((value): value is string => Boolean(value)))];
  const distinctTeamIds = [...new Set(activeRows.map((row) => row.team_id).filter((value): value is string => Boolean(value)))];
  const distinctTeamNames = [...new Set(activeRows.map((row) => normalizeName(String(row.team_name ?? ""))).filter(Boolean))];
  const missingRecentPlayerIds = await loadMissingRecentFeaturePlayerIds(distinctPlayerIds);
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
    distinctEventIds,
    distinctPlayerIds,
    distinctTeamIds,
    distinctTeamNames,
    missingRecentPlayerIds,
    missingRecentPlayerNamesNormalized,
    sampleMissingPlayerNames,
  };
}

async function resolvePriorityPlayersForLogs(input: {
  rawNameSamples: Map<string, string>;
  normalizedNames: Set<string>;
  existingPlayers: MlbPlayerRow[];
}) {
  const { rawNameSamples, normalizedNames, existingPlayers } = input;
  if (!normalizedNames.size) return [] as MlbPlayerRow[];

  const existingById = new Map(existingPlayers.map((player) => [player.id, player]));
  const missingNames = [...normalizedNames].filter(Boolean);

  const directPlayers = await selectRows<MlbPlayerRow & { normalized_name: string }>("players", {
    select: "id,canonical_name,current_team_id,primary_position,external_ids,normalized_name",
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
    ? await selectRows<MlbPlayerRow>("players", {
        select: "id,canonical_name,current_team_id,primary_position,external_ids",
        filters: [
          { column: "league_id", value: config.leagueId },
          { column: "id", operator: "in", value: aliasPlayerIds },
        ],
        limit: Math.max(aliasPlayerIds.length * 2, 40),
      }).catch(() => [])
    : [];

  const resolved = new Map<string, MlbPlayerRow>();
  for (const player of [...directPlayers, ...aliasPlayers]) {
    const existing = existingById.get(player.id);
    resolved.set(player.id, existing ?? {
      id: player.id,
      canonical_name: player.canonical_name,
      current_team_id: player.current_team_id,
      primary_position: player.primary_position,
      external_ids: player.external_ids,
    });
  }

  const coveredNames = new Set([...resolved.values()].map((player) => normalizeName(player.canonical_name)).filter(Boolean));
  const unresolvedNames = missingNames.filter((name) => !coveredNames.has(name)).slice(0, 8);
  for (const normalizedName of unresolvedNames) {
    const rawName = rawNameSamples.get(normalizedName) ?? normalizedName;
    const searched = await new MlbStatsApiAdapter().searchPlayer(rawName).catch(() => null);
    if (!searched?.id || !searched.fullName) continue;
    const teamName = searched.currentTeam?.name ?? searched.currentTeam?.abbreviation ?? null;
    const teamId = searched.currentTeam?.id && teamName
      ? await ensureTeam({
          league: "MLB",
          provider: "mlb-stats-api",
          externalId: String(searched.currentTeam.id),
          name: teamName,
          abbreviation: searched.currentTeam.abbreviation ?? null,
        })
      : null;
    const [firstName, ...rest] = searched.fullName.split(" ");
    const playerId = await ensurePlayer({
      league: "MLB",
      provider: "mlb-stats-api",
      externalId: String(searched.id),
      canonicalName: searched.fullName,
      displayName: searched.fullName,
      firstName: firstName || null,
      lastName: rest.join(" ") || null,
      currentTeamId: teamId,
      primaryPosition: searched.primaryPosition?.name ?? searched.primaryPosition?.code ?? null,
      bats: searched.batSide?.code ?? searched.batSide?.description ?? null,
      throws: searched.pitchHand?.code ?? searched.pitchHand?.description ?? null,
      active: true,
      metadata: { team_abbreviation: searched.currentTeam?.abbreviation ?? null },
    }).catch(() => null);
    if (!playerId) continue;
    resolved.set(playerId, {
      id: playerId,
      canonical_name: searched.fullName,
      current_team_id: teamId,
      primary_position: searched.primaryPosition?.name ?? searched.primaryPosition?.code ?? null,
      external_ids: {
        "mlb-stats-api": String(searched.id),
      },
    });
  }

  return [...resolved.values()];
}

export async function takeLiveFirstWindow<T>(input: {
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
    ? await takeRotatingSlice({
        cacheKey: `${input.cacheKey}:priority-selection`,
        provider: input.provider,
        items: priorityItems,
        sliceSize: desiredPrioritySize,
      })
    : { items: [] as T[], start: 0, end: 0, nextIndex: 0 };
  const remainingSlots = Math.max(0, input.sliceSize - prioritySelection.items.length);
  const priorityKeys = new Set(prioritySelection.items.map((item) => JSON.stringify(item)));
  const nonPriorityItems = input.items.filter((item) => !input.isPriority(item) && !priorityKeys.has(JSON.stringify(item)));
  const regularRotation = remainingSlots > 0
    ? await takeRotatingSlice({
        cacheKey: `${input.cacheKey}:regular`,
        provider: input.provider,
        items: nonPriorityItems,
        sliceSize: remainingSlots,
      })
    : { items: [] as T[], start: 0, end: 0, nextIndex: 0 };
  return {
    items: [...prioritySelection.items, ...regularRotation.items],
    start: prioritySelection.start,
    end: regularRotation.end,
    nextIndex: regularRotation.nextIndex,
    total: input.items.length,
    priorityOnly: false,
  };
}

export async function refreshMlbTeams() {
  const payload = await fetchMlbJson("/api/v1/teams?sportId=1") as TeamDirectoryPayload;
  const teamsWindow = await takeRotatingSlice({
    cacheKey: "knowledge:cursor:mlb:refresh_teams:teams",
    provider: "mlb-stats-api",
    items: payload.teams ?? [],
    sliceSize: configuredChunkSize("KNOWLEDGE_MLB_TEAMS_PER_RUN", 10, 5, 15),
  });
  let count = 0;
  for (const team of teamsWindow.items) {
    if (!team.id || !team.name) continue;
    await ensureTeam({
      league: "MLB",
      provider: "mlb-stats-api",
      externalId: String(team.id),
      name: team.name,
      abbreviation: team.abbreviation ?? null,
      city: team.venue?.location?.city ?? null,
      nickname: team.name.replace(/^.*?\s/, "") || null,
      metadata: {
        venue_name: team.venue?.name ?? null,
        venue_city: team.venue?.location?.city ?? null,
        venue_state: team.venue?.location?.stateAbbrev ?? null,
      },
    });
    count += 1;
  }
  return { league: "MLB", provider: "mlb-stats-api", teams: count, teamCursor: { start: teamsWindow.start, nextIndex: teamsWindow.nextIndex, total: teamsWindow.total } };
}

/**
 * Pure sort: resolved-priority teams (existing signal) and unresolved-future-event teams (new
 * signal) both win the priority tier; within that tier, teams tied to the nearest unresolved
 * future event go first, then alphabetical. No I/O -- exported so the ordering, dedup, and
 * team-limit math can be unit tested without a live Supabase/MLB Stats API call.
 */
export function orderMlbTeamsForRosterRefresh(
  teams: Array<{ id: string; name: string }>,
  priorities: { teamIds: Set<string>; teamNames: Set<string> },
  unresolvedEventPriorities: { teamIds: Set<string>; orderedTeamIds?: string[] },
) {
  const unresolvedEventRank = new Map((unresolvedEventPriorities.orderedTeamIds ?? []).map((teamId, index) => [teamId, index]));
  const isPriorityTeam = (team: { id: string; name: string }) =>
    priorities.teamIds.has(team.id) || priorities.teamNames.has(normalizeName(team.name)) || unresolvedEventPriorities.teamIds.has(team.id);
  const orderedTeams = [...teams].sort((left, right) => {
    const leftPriority = isPriorityTeam(left) ? 1 : 0;
    const rightPriority = isPriorityTeam(right) ? 1 : 0;
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;
    // Within the priority tier, teams tied to the nearest unresolved future event win first;
    // teams with no unresolved-event linkage (only a resolved-priority signal) sort after those.
    const leftRank = unresolvedEventRank.get(left.id) ?? Number.POSITIVE_INFINITY;
    const rightRank = unresolvedEventRank.get(right.id) ?? Number.POSITIVE_INFINITY;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.name.localeCompare(right.name);
  });
  const livePriorityCount = orderedTeams.filter((team) => isPriorityTeam(team)).length;
  const priorityTeamIds = new Set(orderedTeams.filter((team) => isPriorityTeam(team)).map((team) => team.id));
  return { orderedTeams, livePriorityCount, priorityTeamIds };
}

export async function refreshMlbPlayers() {
  const adapter = new MlbStatsApiAdapter();
  const teams = await selectRows<{ id: string; name: string; external_ids: Record<string, unknown> | null }>("teams", {
    select: "id,name,external_ids",
    filters: [{ column: "league_id", value: config.leagueId }],
  });
  const priorities = await loadLiveSharpPriorities();
  const unresolvedEventPriorities = await loadUnresolvedFutureMlbEventTeamPriorities();
  const { orderedTeams, livePriorityCount, priorityTeamIds } = orderMlbTeamsForRosterRefresh(teams, priorities, unresolvedEventPriorities);
  const baseSliceSize = configuredChunkSize("KNOWLEDGE_MLB_PLAYER_REFRESH_TEAMS_PER_RUN", 1, 1, 10);
  const sliceSize = Math.min(Math.max(baseSliceSize, Math.min(livePriorityCount, 2)), 3);
  // Priority-prefix selection, not a single positional rotation: a persisted array-index cursor
  // is not semantically stable when the prioritized ordering changes between runs (a newly
  // urgent team can occupy a position an old cursor value was never meant to point at). This
  // reuses the same takeLiveFirstWindow() pattern already used by 10+ other MLB/WNBA enrichment
  // refreshes in this file/basketball.ts: urgent (priority) teams are selected from their own
  // small rotation first, and only remaining slots fall through to the non-priority rotation.
  const teamWindow = await takeLiveFirstWindow({
    cacheKey: "knowledge:cursor:mlb:refresh_players:teams",
    provider: "mlb-stats-api",
    items: orderedTeams,
    isPriority: (team) => priorityTeamIds.has(team.id),
    sliceSize,
    maxPriorityItems: 3,
  });
  let playersUpserted = 0;
  const processedPlayerNames = new Set<string>();
  for (const team of teamWindow.items) {
    const roster = await adapter.fetchActiveRoster(team.name).catch(() => []);
    for (const player of roster) {
      await ensurePlayer({
        league: "MLB",
        provider: "mlb-stats-api",
        externalId: String(player.id),
        canonicalName: player.fullName,
        displayName: player.fullName,
        currentTeamId: team.id,
        primaryPosition: player.primaryPosition?.name ?? player.primaryPosition?.code ?? null,
        bats: player.batSide?.code ?? player.batSide?.description ?? null,
        throws: player.pitchHand?.code ?? player.pitchHand?.description ?? null,
        active: true,
        metadata: {
          team_abbreviation: player.currentTeam?.abbreviation ?? null,
        },
      });
      processedPlayerNames.add(normalizeName(player.fullName));
      playersUpserted += 1;
    }
  }

  const highlightly = new HighlightlyMlbAdapter();
  let highlightlyPlayers = 0;
  if (highlightly.configured()) {
    const payload = await highlightly.fetchPlayers().catch(() => null);
    if (payload?.data?.data?.length) {
      for (const player of payload.data.data) {
        if (!player.id || !player.fullName) continue;
        if (!processedPlayerNames.has(normalizeName(player.fullName))) continue;
        const aliasMatch = await selectRows<{ entity_id: string }>("entity_aliases", {
          select: "entity_id",
          filters: [
            { column: "entity_type", value: "player" },
            { column: "league_id", value: config.leagueId },
            { column: "normalized_alias", value: normalizeName(player.fullName) },
          ],
          limit: 1,
        });
        if (!aliasMatch[0]?.entity_id) continue;
        await updateRows("players", [{ column: "id", value: aliasMatch[0].entity_id }], {
          headshot_url: player.logo ?? null,
          updated_at: new Date().toISOString(),
        }, { returning: "minimal" });
        await updateRows("participants", [{ column: "player_id", value: aliasMatch[0].entity_id }], {
          image_url: player.logo ?? null,
          updated_at: new Date().toISOString(),
        }, { returning: "minimal" }).catch(() => {});
        highlightlyPlayers += 1;
      }
    }
  }

  return {
    league: "MLB",
    provider: "mlb-stats-api",
    teamsProcessed: teamWindow.items.length,
    teamCursor: { start: teamWindow.start, nextIndex: teamWindow.nextIndex, total: teamWindow.total, priorityOnly: teamWindow.priorityOnly },
    playersUpserted,
    highlightlyPlayers,
    processedTeamIds: teamWindow.items.map((team) => team.id),
    unresolvedEventPriorityTeamIds: unresolvedEventPriorities.orderedTeamIds ?? [],
  };
}

export async function refreshMlbSchedules(now = new Date()) {
  const dates = [...new Set(Array.from({ length: configuredScheduleLookaheadDays() + 1 }, (_, offset) => easternDate(addDays(now, offset))))];
  const dateWindow = await takeRotatingSlice({
    cacheKey: "knowledge:cursor:mlb:refresh_schedules:dates",
    provider: "mlb-stats-api",
    items: dates,
    sliceSize: configuredChunkSize("KNOWLEDGE_MLB_SCHEDULE_DATES_PER_RUN", 1, 1, 2),
  });
  const startDate = dateWindow.items[0] ?? easternDate(now);
  const endDate = dateWindow.items[dateWindow.items.length - 1] ?? startDate;
  const payload = await fetchMlbJson(`/api/v1/schedule?sportId=1&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&hydrate=probablePitcher,linescore,team`) as SchedulePayload;
  const games = extractScheduleGames(payload);
  let events = 0;
  for (const game of games) {
    const home = game.teams?.home?.team;
    const away = game.teams?.away?.team;
    if (!home?.id || !away?.id || !home.name || !away.name || !game.gameDate) continue;
    const homeTeamId = await ensureTeam({
      league: "MLB",
      provider: "mlb-stats-api",
      externalId: String(home.id),
      name: home.name,
      abbreviation: home.abbreviation ?? null,
    });
    const awayTeamId = await ensureTeam({
      league: "MLB",
      provider: "mlb-stats-api",
      externalId: String(away.id),
      name: away.name,
      abbreviation: away.abbreviation ?? null,
    });
    await ensureEvent({
      league: "MLB",
      provider: "mlb-stats-api",
      externalId: String(game.gamePk),
      season: currentMlbSeason(now),
      scheduledDate: game.gameDate.slice(0, 10),
      startTime: game.gameDate,
      status: gameStatus(game),
      displayName: `${away.name} at ${home.name}`,
      homeTeamId,
      awayTeamId,
      venue: game.venue?.name ?? null,
      venueCity: game.venue?.location?.city ?? null,
      venueState: game.venue?.location?.stateAbbrev ?? null,
      metadata: {
        day_night: game.dayNight ?? null,
        double_header: game.doubleHeader ?? null,
        probable_pitchers: {
          home: {
            id: game.teams?.home?.probablePitcher?.id ?? null,
            name: game.teams?.home?.probablePitcher?.fullName ?? null,
            hand: game.teams?.home?.probablePitcher?.pitchHand?.code ?? game.teams?.home?.probablePitcher?.pitchHand?.description ?? null,
          },
          away: {
            id: game.teams?.away?.probablePitcher?.id ?? null,
            name: game.teams?.away?.probablePitcher?.fullName ?? null,
            hand: game.teams?.away?.probablePitcher?.pitchHand?.code ?? game.teams?.away?.probablePitcher?.pitchHand?.description ?? null,
          },
        },
        linescore: game.linescore ?? null,
        home_score: game.teams?.home?.score ?? null,
        away_score: game.teams?.away?.score ?? null,
      },
    });
    events += 1;
  }
  return { league: "MLB", provider: "mlb-stats-api", events, startDate, endDate, dateCursor: { start: dateWindow.start, nextIndex: dateWindow.nextIndex, total: dateWindow.total } };
}

export async function refreshMlbSchedulesLiveGate(now = new Date()) {
  const { getLiveRefreshDateRange, withRetryAndTimeout } = await import("@/lib/knowledge/enrichment/shared");
  const dateRange = getLiveRefreshDateRange(now);
  const startDate = dateRange.current;
  const endDate = dateRange.next || dateRange.current;

  const attempt = await withRetryAndTimeout(
    () => fetchMlbJson(`/api/v1/schedule?sportId=1&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&hydrate=probablePitcher,linescore,team`) as Promise<SchedulePayload>,
    { maxAttempts: 2, timeoutMs: 12000, backoffMs: 2000 },
  );

  if (!attempt.success) {
    const errorDetails = {
      league: "MLB",
      provider: "mlb-stats-api",
      stage: "provider_fetch",
      requestedDates: dateRange.dates,
      startDate,
      endDate,
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

  const payload = attempt.value;
  const games = extractScheduleGames(payload);
  let events = 0;
  for (const game of games) {
    const home = game.teams?.home?.team;
    const away = game.teams?.away?.team;
    if (!home?.id || !away?.id || !home.name || !away.name || !game.gameDate) continue;
    const homeTeamId = await ensureTeam({
      league: "MLB",
      provider: "mlb-stats-api",
      externalId: String(home.id),
      name: home.name,
      abbreviation: home.abbreviation ?? null,
    });
    const awayTeamId = await ensureTeam({
      league: "MLB",
      provider: "mlb-stats-api",
      externalId: String(away.id),
      name: away.name,
      abbreviation: away.abbreviation ?? null,
    });
    await ensureEvent({
      league: "MLB",
      provider: "mlb-stats-api",
      externalId: String(game.gamePk),
      season: currentMlbSeason(now),
      scheduledDate: game.gameDate.slice(0, 10),
      startTime: game.gameDate,
      status: gameStatus(game),
      displayName: `${away.name} at ${home.name}`,
      homeTeamId,
      awayTeamId,
      venue: game.venue?.name ?? null,
      venueCity: game.venue?.location?.city ?? null,
      venueState: game.venue?.location?.stateAbbrev ?? null,
      metadata: {
        day_night: game.dayNight ?? null,
        double_header: game.doubleHeader ?? null,
        probable_pitchers: {
          home: {
            id: game.teams?.home?.probablePitcher?.id ?? null,
            name: game.teams?.home?.probablePitcher?.fullName ?? null,
            hand: game.teams?.home?.probablePitcher?.pitchHand?.code ?? game.teams?.home?.probablePitcher?.pitchHand?.description ?? null,
          },
          away: {
            id: game.teams?.away?.probablePitcher?.id ?? null,
            name: game.teams?.away?.probablePitcher?.fullName ?? null,
            hand: game.teams?.away?.probablePitcher?.pitchHand?.code ?? game.teams?.away?.probablePitcher?.pitchHand?.description ?? null,
          },
        },
        linescore: game.linescore ?? null,
        home_score: game.teams?.home?.score ?? null,
        away_score: game.teams?.away?.score ?? null,
      },
    });
    events += 1;
  }

  const futureEventRows = await selectRows<{ id: string }>("events", {
    select: "id",
    filters: [
      { column: "league_id", value: config.leagueId },
      { column: "start_time", operator: "gte", value: now.toISOString() },
    ],
    limit: 1,
  });

  if (games.length > 0 && events === 0) {
    const errorDetails = {
      league: "MLB",
      provider: "mlb-stats-api",
      stage: "event_persistence",
      requestedDates: dateRange.dates,
      startDate,
      endDate,
      providerGamesReturned: games.length,
      normalizedEvents: events,
      attempts: attempt.attempts,
      timeouts: attempt.timeouts,
      errorName: "PersistenceError",
      errorMessage: `Provider returned ${games.length} game(s) but zero events were persisted`,
    };
    const error = new Error(JSON.stringify(errorDetails));
    Object.assign(error, errorDetails);
    throw error;
  }

  if (futureEventRows.length === 0) {
    const errorDetails = {
      league: "MLB",
      provider: "mlb-stats-api",
      stage: "future_event_verification",
      requestedDates: dateRange.dates,
      startDate,
      endDate,
      providerGamesReturned: games.length,
      normalizedEvents: events,
      futureEventsVerified: futureEventRows.length,
      attempts: attempt.attempts,
      timeouts: attempt.timeouts,
      errorName: "VerificationError",
      errorMessage: `No future events visible after refresh (${events} events processed)`,
    };
    const error = new Error(JSON.stringify(errorDetails));
    Object.assign(error, errorDetails);
    throw error;
  }

  return {
    league: "MLB",
    provider: "mlb-stats-api",
    events,
    startDate,
    endDate,
    attempts: attempt.attempts,
    timeouts: attempt.timeouts,
    futureEventsVerified: futureEventRows.length,
  };
}

export async function refreshMlbCompletedGames(now = new Date()) {
  const startDate = easternDate(addDays(now, -2));
  const endDate = easternDate(now);
  const payload = await fetchMlbJson(`/api/v1/schedule?sportId=1&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&hydrate=linescore`) as SchedulePayload;
  let completed = 0;
  for (const game of extractScheduleGames(payload)) {
    if (gameStatus(game) !== "completed") continue;
    const eventId = await findEventByProviderId("mlb-stats-api", config.leagueId, String(game.gamePk));
    if (!eventId) continue;
    const patch = {
      status: "completed",
      metadata: {
        linescore: game.linescore ?? null,
        home_score: game.teams?.home?.score ?? null,
        away_score: game.teams?.away?.score ?? null,
      },
      updated_at: new Date().toISOString(),
    };
    await updateRows("events", [{ column: "id", value: eventId }], patch, { returning: "minimal" });
    await updateRows("games", [{ column: "id", value: eventId }], patch, { returning: "minimal" }).catch(() => {});
    completed += 1;
  }
  return { league: "MLB", completed };
}

export async function refreshMlbPlayerLogs(now = new Date(), options?: {
  playerIds?: string[];
  missingOrStaleOnly?: boolean;
  limit?: number;
}) {
  const adapter = new MlbStatsApiAdapter();
  const players = await selectRows<MlbPlayerRow>("players", {
    select: "id,canonical_name,current_team_id,primary_position,external_ids",
    filters: [{ column: "league_id", value: config.leagueId }],
    limit: Math.max(configuredPlayerLogBatchSize(), configuredChunkSize("KNOWLEDGE_MLB_PLAYER_LOGS_PER_RUN", 18, 5, 60) * 4),
  });
  const priorities = await loadLiveSharpPriorities();
  const liveCoverage = await loadLivePropCoverage();
  const missingRecentPriorityPlayerIds = liveCoverage.missingRecentPlayerIds;
  const missingRecentPriorityNames = liveCoverage.missingRecentPlayerNamesNormalized;
  const resolvedPriorityPlayers = await resolvePriorityPlayersForLogs({
    rawNameSamples: new Map(liveCoverage.sampleMissingPlayerNames.map((name) => [normalizeName(name), name])),
    normalizedNames: missingRecentPriorityNames,
    existingPlayers: players,
  });
  const mergedPlayers = Array.from(new Map([...resolvedPriorityPlayers, ...players].map((player) => [player.id, player])).values());
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
    const leftPriority = priorities.playerIds.has(left.id) || priorities.playerNames.has(normalizeName(left.canonical_name)) ? 1 : 0;
    const rightPriority = priorities.playerIds.has(right.id) || priorities.playerNames.has(normalizeName(right.canonical_name)) ? 1 : 0;
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;
      return left.canonical_name.localeCompare(right.canonical_name);
    });
  const scopedPlayers = options?.missingOrStaleOnly
    ? orderedPlayers.filter((player) => missingRecentPriorityPlayerIds.has(player.id) || missingRecentPriorityNames.has(normalizeName(player.canonical_name)))
    : orderedPlayers;
  const baseSliceSize = configuredChunkSize("KNOWLEDGE_MLB_PLAYER_LOGS_PER_RUN", 6, 4, 24);
  const livePriorityCount = scopedPlayers.filter((player) => priorities.playerIds.has(player.id) || priorities.playerNames.has(normalizeName(player.canonical_name))).length;
  const missingRecentPriorityCount = scopedPlayers.filter((player) => missingRecentPriorityPlayerIds.has(player.id) || missingRecentPriorityNames.has(normalizeName(player.canonical_name))).length;
  const playerWindow: RefreshWindow<(typeof scopedPlayers)[number]> = targetedPlayerIds.size
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
        cacheKey: "knowledge:cursor:mlb:refresh_player_game_logs:players",
        provider: "mlb-stats-api",
        items: scopedPlayers,
        isPriority: (player) =>
          missingRecentPriorityPlayerIds.has(player.id)
          || missingRecentPriorityNames.has(normalizeName(player.canonical_name))
          || priorities.playerIds.has(player.id)
          || priorities.playerNames.has(normalizeName(player.canonical_name)),
        sliceSize: Math.min(Math.max(baseSliceSize, Math.min(Math.max(missingRecentPriorityCount, livePriorityCount), 8)), 12),
        maxPriorityItems:
          missingRecentPriorityCount > 0
            ? Math.min(Math.max(missingRecentPriorityCount, 6), 8)
            : Math.max(2, Math.floor(baseSliceSize / 2)),
      });
  const playerItems = playerWindow.items;
  let logsUpserted = 0;
  let emptyFetches = 0;
  for (const player of playerItems) {
    let externalId = Number((player.external_ids ?? {})["mlb-stats-api"] ?? 0);
    if (!externalId) {
      const repaired = await adapter.searchPlayer(player.canonical_name).catch(() => null);
      if (repaired?.id) {
        externalId = repaired.id;
        await updateRows("players", [{ column: "id", value: player.id }], {
          external_ids: {
            ...(player.external_ids ?? {}),
            "mlb-stats-api": String(repaired.id),
          },
        }).catch(() => {});
      }
    }
    if (!externalId) {
      emptyFetches += 1;
      continue;
    }
    // Find the most recent stored game_date for this player so we only
    // delete/re-insert the 3-day overlap window instead of the full season.
    const latestStored = await selectRows<{ game_date: string }>("player_game_logs", {
      select: "game_date",
      filters: [
        { column: "provider", value: "mlb-stats-api" },
        { column: "player_id", value: player.id },
      ],
      orderBy: "game_date.desc",
      limit: 1,
    }).catch(() => [] as { game_date: string }[]);
    const maxGameDate = latestStored[0]?.game_date ?? null;
    // 3-day overlap so corrections to the most-recent games are captured.
    const cutoffDate: string | null = maxGameDate
      ? easternDate(addDays(new Date(maxGameDate + "T12:00:00Z"), -3))
      : null;
    const statType = /pitcher/i.test(player.primary_position ?? "") ? "strikeouts" : "hits";
    const result = await adapter.fetchPlayerGameLog({
      playerId: externalId,
      playerName: player.canonical_name,
      season: Number(currentMlbSeason(now)),
      statType,
    }).catch(() => null);
    const payloads = !result ? [] : Array.isArray(result.data.response) ? result.data.response : [result.data];
    const allRows = payloads.flatMap((payload) => adapter.extractGameLogRows(payload as never));
    const rows = [];
    for (const row of allRows) {
      const gameInfo = row.game && typeof row.game === "object" ? row.game as Record<string, unknown> : {};
      const eventExternalId = String(gameInfo.gamePk ?? row.gamePk ?? row.game_id ?? row.gameId ?? "").trim();
      const eventId = eventExternalId ? await findEventByProviderId("mlb-stats-api", config.leagueId, eventExternalId) : null;
      const rawDate = String(row.date ?? row.gameDate ?? gameInfo.gameDate ?? gameInfo.officialDate ?? "").trim();
      rows.push({
        sport_id: config.sportId,
        league_id: config.leagueId,
        player_id: player.id,
        team_id: player.current_team_id,
        opponent_team_id: null,
        event_id: eventId,
        game_id: eventId,
        game_date: rawDate ? rawDate.slice(0, 10) : easternDate(now),
        season: currentMlbSeason(now),
        provider: "mlb-stats-api",
        hits: safeNumber(statLineValue(row, "hits")),
        singles: safeNumber(statLineValue(row, "singles")),
        doubles: safeNumber(statLineValue(row, "doubles")),
        triples: safeNumber(statLineValue(row, "triples")),
        total_bases: safeNumber(statLineValue(row, "totalBases", "total_bases")),
        runs: safeNumber(statLineValue(row, "runs")),
        rbis: safeNumber(statLineValue(row, "rbi", "rbis")),
        home_runs: safeNumber(statLineValue(row, "homeRuns", "home_runs")),
        walks: safeNumber(statLineValue(row, "baseOnBalls", "walks")),
        strikeouts: safeNumber(statLineValue(row, "strikeOuts", "strikeouts")),
        stolen_bases: safeNumber(statLineValue(row, "stolenBases", "stolen_bases")),
        outs_recorded: safeNumber(statLineValue(row, "outsRecorded", "outs_recorded")),
        innings_pitched: safeNumber(statLineValue(row, "inningsPitched", "innings_pitched")),
        earned_runs: safeNumber(statLineValue(row, "earnedRuns", "earned_runs")),
        hits_allowed: safeNumber(statLineValue(row, "hitsAllowed", "hits_allowed")),
        walks_allowed: safeNumber(statLineValue(row, "baseOnBalls", "walksAllowed", "walks_allowed")),
        stat_line: row,
        raw_payload: row,
        source_updated_at: new Date().toISOString(),
      });
    }
    if (rows.length) {
      const dedupedRows = Array.from(
        new Map(
          rows.map((row) => [
            `mlb-stats-api|${player.id}|${String(row.game_date)}|${String(row.event_id ?? "")}`,
            row,
          ]),
        ).values(),
      );
      // Scope to overlap window: only touch rows >= cutoffDate.
      // When there are no prior rows (cutoffDate=null), insert everything.
      const windowRows = cutoffDate
        ? dedupedRows.filter((row) => String(row.game_date) >= cutoffDate)
        : dedupedRows;
      if (windowRows.length) {
        await deleteRows("player_game_logs", [
          { column: "provider", value: "mlb-stats-api" },
          { column: "player_id", value: player.id },
          ...(cutoffDate ? [{ column: "game_date", operator: "gte" as const, value: cutoffDate }] : []),
        ]);
        await insertRows("player_game_logs", windowRows, { returning: "minimal" });
        logsUpserted += windowRows.length;
      }
    } else {
      emptyFetches += 1;
    }
  }
  return {
    league: "MLB",
    provider: "mlb-stats-api",
    playersChecked: playerItems.length,
    distinctActivePropPlayers: liveCoverage.distinctPlayerIds.length,
    priorityPlayersMissingRecent: missingRecentPriorityCount,
    resolvedPriorityPlayers: resolvedPriorityPlayers.length,
    priorityOnlyWindow: playerWindow.priorityOnly,
    sampleMissingRecentPlayers: liveCoverage.sampleMissingPlayerNames,
    playerCursor: { start: playerWindow.start, nextIndex: playerWindow.nextIndex, total: playerWindow.total },
    logsUpserted,
    emptyFetches,
  };
}

async function fetchMlbBoxscore(gamePk: string) {
  return fetchMlbJson(`/api/v1/game/${encodeURIComponent(gamePk)}/boxscore`) as Promise<MlbBoxscorePayload>;
}

export async function refreshMlbTeamLogs(now = new Date()) {
  const startDate = easternDate(addDays(now, -7));
  const endDate = easternDate(now);
  const payload = await fetchMlbJson(`/api/v1/schedule?sportId=1&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&hydrate=linescore,team`) as SchedulePayload;
  const priorities = await loadLiveSharpPriorities();
  const games = extractScheduleGames(payload);
  const orderedGames = [...games].sort((left, right) => {
    const leftPriority = [
      normalizeName(String(left.teams?.home?.team?.name ?? "")),
      normalizeName(String(left.teams?.away?.team?.name ?? "")),
    ].some((name) => priorities.teamNames.has(name)) ? 1 : 0;
    const rightPriority = [
      normalizeName(String(right.teams?.home?.team?.name ?? "")),
      normalizeName(String(right.teams?.away?.team?.name ?? "")),
    ].some((name) => priorities.teamNames.has(name)) ? 1 : 0;
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;
    return String(left.gameDate ?? "").localeCompare(String(right.gameDate ?? ""));
  });
  const gameWindow = await takeLiveFirstWindow({
    cacheKey: "knowledge:cursor:mlb:refresh_team_logs:games",
    provider: "mlb-stats-api",
    items: orderedGames,
    isPriority: (game) => [
      normalizeName(String(game.teams?.home?.team?.name ?? "")),
      normalizeName(String(game.teams?.away?.team?.name ?? "")),
    ].some((name) => priorities.teamNames.has(name)),
    sliceSize: configuredChunkSize("KNOWLEDGE_MLB_TEAM_LOGS_PER_RUN", 8, 4, 16),
    maxPriorityItems: 8,
  });
  let rowsInserted = 0;
  for (const game of gameWindow.items) {
    if (!game.teams?.home?.team?.id || !game.teams?.away?.team?.id || !game.gameDate) continue;
    const eventId = await findEventByProviderId("mlb-stats-api", config.leagueId, String(game.gamePk));
    const homeTeamId = await ensureTeam({
      league: "MLB",
      provider: "mlb-stats-api",
      externalId: String(game.teams.home.team.id),
      name: game.teams.home.team.name ?? "Home",
      abbreviation: game.teams.home.team.abbreviation ?? null,
    });
    const awayTeamId = await ensureTeam({
      league: "MLB",
      provider: "mlb-stats-api",
      externalId: String(game.teams.away.team.id),
      name: game.teams.away.team.name ?? "Away",
      abbreviation: game.teams.away.team.abbreviation ?? null,
    });
    const gameDate = game.gameDate.slice(0, 10);
    await deleteRows("team_game_logs", [
      { column: "provider", value: "mlb-stats-api" },
      { column: "game_date", value: gameDate },
      { column: "team_id", operator: "in", value: [homeTeamId, awayTeamId] },
    ]).catch(() => {});
    const rows = [
      {
        sport_id: config.sportId,
        league_id: config.leagueId,
        team_id: homeTeamId,
        opponent_team_id: awayTeamId,
        event_id: eventId,
        game_id: eventId,
        game_date: gameDate,
        season: currentMlbSeason(now),
        provider: "mlb-stats-api",
        pace: null,
        offensive_rating: null,
        defensive_rating: null,
        possessions: null,
        implied_total: null,
        team_total: safeNumber(game.teams.home.score),
        stat_line: {
          linescore: game.linescore ?? null,
          role: "home",
        },
        raw_payload: game,
        source_updated_at: new Date().toISOString(),
      },
      {
        sport_id: config.sportId,
        league_id: config.leagueId,
        team_id: awayTeamId,
        opponent_team_id: homeTeamId,
        event_id: eventId,
        game_id: eventId,
        game_date: gameDate,
        season: currentMlbSeason(now),
        provider: "mlb-stats-api",
        pace: null,
        offensive_rating: null,
        defensive_rating: null,
        possessions: null,
        implied_total: null,
        team_total: safeNumber(game.teams.away.score),
        stat_line: {
          linescore: game.linescore ?? null,
          role: "away",
        },
        raw_payload: game,
        source_updated_at: new Date().toISOString(),
      },
    ];
    await insertRows("team_game_logs", rows, { returning: "minimal" });
    rowsInserted += rows.length;
  }
  return { league: "MLB", rowsInserted, gameCursor: { start: gameWindow.start, nextIndex: gameWindow.nextIndex, total: gameWindow.total }, priorityOnlyWindow: gameWindow.priorityOnly };
}

export async function refreshMlbInjuries(now = new Date()) {
  const adapter = new MlbStatsApiAdapter();
  const teams = await selectRows<{ id: string; name: string }>("teams", {
    select: "id,name",
    filters: [{ column: "league_id", value: config.leagueId }],
  });
  const priorities = await loadLiveSharpPriorities();
  const orderedTeams = [...teams].sort((left, right) => {
    const leftPriority = priorities.teamIds.has(left.id) || priorities.teamNames.has(normalizeName(left.name)) ? 1 : 0;
    const rightPriority = priorities.teamIds.has(right.id) || priorities.teamNames.has(normalizeName(right.name)) ? 1 : 0;
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;
    return left.name.localeCompare(right.name);
  });
  const rotation = await takeRotatingSlice({
    cacheKey: "knowledge:mlb:injuries:teams",
    provider: "mlb-stats-api",
    items: orderedTeams,
    sliceSize: configuredChunkSize("KNOWLEDGE_MLB_INJURY_TEAMS_PER_RUN", 4, 2, 8),
  });
  const scopedTeams = rotation.items;
  const injuryDate = easternDate(now);
  const teamIds = scopedTeams.map((team) => team.id).filter(Boolean);
  if (teamIds.length) {
    await deleteRows("injuries", [
      { column: "league_id", value: config.leagueId },
      { column: "report_source", value: "mlb-stats-api" },
      { column: "injury_date", value: injuryDate },
      { column: "team_id", operator: "in", value: teamIds },
    ]).catch(() => {});
  }
  let inserted = 0;
  const pendingRows: Array<Record<string, unknown>> = [];
  for (const team of scopedTeams) {
    const records = await adapter.fetchTeamInjuries(team.name, Number(currentMlbSeason(now))).catch(() => []);
    const externalIds = records.map((record) => String(record.playerId)).filter(Boolean);
    const playerMappings = externalIds.length
      ? await selectRows<{ entity_id: string; external_id: string | null }>("source_mappings", {
          select: "entity_id,external_id",
          filters: [
            { column: "provider", value: "mlb-stats-api" },
            { column: "entity_type", value: "player" },
            { column: "league_id", value: config.leagueId },
            { column: "external_id", operator: "in", value: externalIds },
          ],
        })
      : [];
    const playerMap = new Map(playerMappings.map((mapping) => [String(mapping.external_id ?? ""), mapping.entity_id]));
    for (const record of records) {
      pendingRows.push({
        sport_id: config.sportId,
        league_id: config.leagueId,
        player_id: playerMap.get(String(record.playerId)) ?? null,
        team_id: team.id,
        injury_date: injuryDate,
        status: record.status,
        report_source: "mlb-stats-api",
        body_part: null,
        note: record.note,
        return_timeline: null,
        raw_payload: record,
      });
      inserted += 1;
    }
  }
  if (pendingRows.length) {
    await insertRows("injuries", pendingRows, { returning: "minimal" });
  }
  return {
    league: "MLB",
    provider: "mlb-stats-api",
    inserted,
    teamsProcessed: scopedTeams.length,
    teamsAvailable: teams.length,
    rotation,
  };
}

export async function refreshMlbLineups(now = new Date()) {
  const priorities = await loadLiveSharpPriorities();
  const liveCoverage = await loadLivePropCoverage();
  const events = await selectRows<{ id: string; provider_event_ids: Record<string, unknown> | null; scheduled_date: string; start_time: string; home_team_id: string | null; away_team_id: string | null }>("events", {
    select: "id,provider_event_ids,scheduled_date,start_time,home_team_id,away_team_id",
    filters: [{ column: "league_id", value: config.leagueId }],
    orderBy: "start_time.asc",
  });
  const bounds = liveWindowBounds(now);
  const eligibleEvents = events.filter((event) => {
    if (!event.start_time) return false;
    return isWithinLiveWindow(event.start_time, bounds);
  });
  const orderedEvents = [...eligibleEvents].sort((left, right) => {
    const leftPriority = priorities.teamIds.has(left.home_team_id ?? "") || priorities.teamIds.has(left.away_team_id ?? "") || liveCoverage.distinctEventIds.includes(left.id) ? 1 : 0;
    const rightPriority = priorities.teamIds.has(right.home_team_id ?? "") || priorities.teamIds.has(right.away_team_id ?? "") || liveCoverage.distinctEventIds.includes(right.id) ? 1 : 0;
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;
    return left.start_time.localeCompare(right.start_time);
  });
  const rotation = await takeLiveFirstWindow({
    cacheKey: "knowledge:mlb:lineups:events",
    provider: "mlb-lineups",
    items: orderedEvents,
    isPriority: (event) => priorities.teamIds.has(event.home_team_id ?? "") || priorities.teamIds.has(event.away_team_id ?? "") || liveCoverage.distinctEventIds.includes(event.id),
    sliceSize: configuredChunkSize("KNOWLEDGE_MLB_LINEUP_EVENTS_PER_RUN", 3, 1, 5),
    maxPriorityItems: 4,
  });
  const scopedEvents = rotation.items;
  const scopedEventIds = scopedEvents.map((event) => event.id);

  // Skip events where both teams already have confirmed lineups — no re-fetch needed.
  const existingLineups = scopedEventIds.length
    ? await selectRows<{ event_id: string; team_id: string | null; confirmed: boolean }>("lineups", {
        select: "event_id,team_id,confirmed",
        filters: [{ column: "event_id", operator: "in", value: scopedEventIds }],
      }).catch(() => [] as { event_id: string; team_id: string | null; confirmed: boolean }[])
    : [];
  const confirmedTeamsByEvent = new Map<string, Set<string>>();
  for (const row of existingLineups) {
    if (!row.confirmed || !row.event_id || !row.team_id) continue;
    const teams = confirmedTeamsByEvent.get(row.event_id) ?? new Set<string>();
    teams.add(row.team_id);
    confirmedTeamsByEvent.set(row.event_id, teams);
  }
  const fullyConfirmedEventIds = new Set(
    scopedEvents
      .filter((event) => {
        const confirmed = confirmedTeamsByEvent.get(event.id);
        return (
          confirmed &&
          event.home_team_id && confirmed.has(event.home_team_id) &&
          event.away_team_id && confirmed.has(event.away_team_id)
        );
      })
      .map((event) => event.id),
  );
  const eventsToFetch = scopedEvents.filter((event) => !fullyConfirmedEventIds.has(event.id));
  const eventIdsToFetch = eventsToFetch.map((event) => event.id);

  if (eventIdsToFetch.length) {
    await deleteRows("lineups", [{ column: "event_id", operator: "in", value: eventIdsToFetch }]).catch(() => {});
    await deleteRows("mlb_lineups", [{ column: "event_id", operator: "in", value: eventIdsToFetch }]).catch(() => {});
  }

  type LineupSeedRecord = {
    event_id: string;
    scheduled_date: string;
    team_id: string | null;
    player_external_id: string;
    player_name: string;
    batting_order: number | null;
    position: string | null;
    confirmed: boolean;
    raw_payload: unknown;
  };

  const seedRecords: LineupSeedRecord[] = [];
  const playerExternalIds = new Set<string>();
  let inserted = 0;
  for (const event of eventsToFetch) {
    const providerEventId = String((event.provider_event_ids ?? {})["mlb-stats-api"] ?? "");
    if (!providerEventId) continue;
    let records: Array<LineupSeedRecord> = [];
    try {
      const boxscore = await fetchMlbBoxscore(providerEventId);
      for (const [side, teamId] of [["home", event.home_team_id], ["away", event.away_team_id]] as const) {
        const players = side === "home" ? boxscore.teams?.home?.players : boxscore.teams?.away?.players;
        if (!players || !teamId) continue;
        Object.values(players).forEach((raw) => {
          if (!raw || typeof raw !== "object") return;
          const player = raw as Record<string, unknown>;
          const person = player.person && typeof player.person === "object" ? player.person as Record<string, unknown> : {};
          const stats = player.stats && typeof player.stats === "object" ? player.stats as Record<string, unknown> : {};
          const battingOrder = safeNumber(player.battingOrder ?? person.battingOrder ?? null);
          const playerExternalId = safeText(person.id ?? player.id ?? "");
          const playerName = safeText(person.fullName ?? player.fullName ?? "");
          records.push({
            event_id: event.id,
            scheduled_date: event.scheduled_date,
            team_id: teamId,
            player_external_id: playerExternalId,
            player_name: playerName,
            batting_order: battingOrder,
            position: safeText(person.primaryPosition && typeof person.primaryPosition === "object" ? (person.primaryPosition as Record<string, unknown>).abbreviation : player.position),
            confirmed: Boolean(player.gameStatusCode ?? player.status),
            raw_payload: { player, stats },
          });
        });
      }
    } catch {
      records = [];
    }
    for (const record of records) {
      seedRecords.push(record);
      if (record.player_external_id) playerExternalIds.add(record.player_external_id);
    }
  }
  const playerMappings = playerExternalIds.size
    ? await selectRows<{ entity_id: string; external_id: string | null }>("source_mappings", {
        select: "entity_id,external_id",
        filters: [
          { column: "provider", value: "mlb-stats-api" },
          { column: "entity_type", value: "player" },
          { column: "league_id", value: config.leagueId },
          { column: "external_id", operator: "in", value: Array.from(playerExternalIds) },
        ],
      })
    : [];
  const playerMap = new Map(playerMappings.map((mapping) => [String(mapping.external_id ?? ""), mapping.entity_id]));
  const fallbackPlayers = await selectRows<{
    id: string;
    normalized_name: string;
    current_team_id: string | null;
    primary_position: string | null;
  }>("players", {
    select: "id,normalized_name,current_team_id,primary_position",
    filters: [{ column: "league_id", value: config.leagueId }],
    limit: 4000,
  }).catch(() => []);
  const fallbackPlayerByIdentity = new Map<string, string>();
  const fallbackPlayerByName = new Map<string, string>();
  for (const player of fallbackPlayers) {
    const normalizedName = normalizeName(player.normalized_name);
    if (!normalizedName) continue;
    const identityKey = `${normalizedName}|${player.current_team_id ?? ""}`;
    if (!fallbackPlayerByIdentity.has(identityKey)) {
      fallbackPlayerByIdentity.set(identityKey, player.id);
    }
    if (!fallbackPlayerByName.has(normalizedName)) {
      fallbackPlayerByName.set(normalizedName, player.id);
    }
  }
  const lineupRows: Array<Record<string, unknown>> = [];
  const mlbLineupRows: Array<Record<string, unknown>> = [];
  for (const record of seedRecords) {
    const normalizedName = normalizeName(record.player_name);
    let playerId = record.player_external_id ? (playerMap.get(String(record.player_external_id)) ?? null) : null;
    if (!playerId && normalizedName) {
      playerId =
        fallbackPlayerByIdentity.get(`${normalizedName}|${record.team_id ?? ""}`)
        ?? fallbackPlayerByName.get(normalizedName)
        ?? null;
    }
    if (!playerId && normalizedName) {
      playerId = await ensurePlayer({
        league: "MLB",
        provider: "mlb-stats-api",
        externalId: record.player_external_id || null,
        canonicalName: record.player_name,
        displayName: record.player_name,
        currentTeamId: record.team_id ?? null,
        primaryPosition: record.position ?? null,
        active: true,
        metadata: {
          source: "mlb-lineup-refresh",
          inferred_from: "boxscore_or_lineup",
        },
      }).catch(() => null);
      if (playerId && record.player_external_id) {
        playerMap.set(String(record.player_external_id), playerId);
      }
      if (playerId) {
        fallbackPlayerByIdentity.set(`${normalizedName}|${record.team_id ?? ""}`, playerId);
        fallbackPlayerByName.set(normalizedName, playerId);
      }
    }
    lineupRows.push({
      sport_id: config.sportId,
      league_id: config.leagueId,
      event_id: record.event_id,
      game_id: record.event_id,
      team_id: record.team_id,
      player_id: playerId,
      lineup_date: record.scheduled_date,
      batting_order: record.batting_order,
      slot_index: record.batting_order,
      starting_status: record.confirmed ? "starting" : "projected",
      confirmed: record.confirmed,
      position: record.position,
      note: null,
      raw_payload: record.raw_payload,
    });
    mlbLineupRows.push({
      event_id: record.event_id,
      game_id: record.event_id,
      team_id: record.team_id,
      player_id: playerId,
      batting_order: record.batting_order,
      field_position: record.position,
      confirmed: record.confirmed,
      raw_payload: record.raw_payload,
    });
    inserted += 1;
  }
  if (lineupRows.length) {
    await insertRows("lineups", lineupRows, { returning: "minimal" });
  }
  if (mlbLineupRows.length) {
    await insertRows("mlb_lineups", mlbLineupRows, { returning: "minimal" });
  }
  return {
    league: "MLB",
    inserted,
    eventsProcessed: eventsToFetch.length,
    eventsSkippedConfirmed: fullyConfirmedEventIds.size,
    eventsAvailable: eligibleEvents.length,
    rotation,
  };
}

export async function refreshMlbStartingPitchers(now = new Date()) {
  const priorities = await loadLiveSharpPriorities();
  const liveCoverage = await loadLivePropCoverage();
  const events = await selectRows<{ id: string; metadata: Record<string, unknown> | null; home_team_id: string | null; away_team_id: string | null }>("events", {
    select: "id,metadata,home_team_id,away_team_id",
    filters: [{ column: "league_id", value: config.leagueId }],
  });
  const orderedEvents = [...events].sort((left, right) => {
    const leftPriority = priorities.teamIds.has(left.home_team_id ?? "") || priorities.teamIds.has(left.away_team_id ?? "") || liveCoverage.distinctEventIds.includes(left.id) ? 1 : 0;
    const rightPriority = priorities.teamIds.has(right.home_team_id ?? "") || priorities.teamIds.has(right.away_team_id ?? "") || liveCoverage.distinctEventIds.includes(right.id) ? 1 : 0;
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;
    return left.id.localeCompare(right.id);
  });
  const rotation = await takeLiveFirstWindow({
    cacheKey: "knowledge:mlb:starting-pitchers:events",
    provider: "mlb-stats-api",
    items: orderedEvents,
    isPriority: (event) => priorities.teamIds.has(event.home_team_id ?? "") || priorities.teamIds.has(event.away_team_id ?? "") || liveCoverage.distinctEventIds.includes(event.id),
    sliceSize: configuredChunkSize("KNOWLEDGE_MLB_STARTING_PITCHERS_PER_RUN", 8, 4, 12),
    maxPriorityItems: 8,
  });
  let inserted = 0;
  for (const event of rotation.items) {
    const probable = event.metadata?.probable_pitchers as {
      home?: { id?: number | null; name?: string | null; hand?: string | null } | null;
      away?: { id?: number | null; name?: string | null; hand?: string | null } | null;
    } | undefined;
    for (const [side, teamId, details] of [["home", event.home_team_id, probable?.home], ["away", event.away_team_id, probable?.away]] as const) {
      if (!teamId || !details?.name) continue;
      const playerId = details.id
        ? (await selectRows<{ entity_id: string }>("source_mappings", {
            select: "entity_id",
            filters: [
              { column: "provider", value: "mlb-stats-api" },
              { column: "entity_type", value: "player" },
              { column: "league_id", value: config.leagueId },
              { column: "external_id", value: String(details.id) },
            ],
            limit: 1,
          }))[0]?.entity_id ?? null
        : null;
      await upsertRows("mlb_starting_pitchers", [{
        event_id: event.id,
        game_id: event.id,
        team_id: teamId,
        player_id: playerId,
        hand: details.hand ?? null,
        confirmed: Boolean(playerId),
        source: "mlb-stats-api",
        raw_payload: {
          side,
          ...details,
        },
      }], ["game_id", "team_id"], { returning: "minimal" });
      inserted += 1;
    }
  }
  return { league: "MLB", inserted, eventCursor: { start: rotation.start, nextIndex: rotation.nextIndex, total: rotation.total }, priorityOnlyWindow: rotation.priorityOnly };
}

export async function refreshMlbWeather() {
  const adapter = new OpenMeteoWeatherAdapter();
  const now = new Date();
  const nowMs = now.getTime();
  const lookaheadHours = Math.min(Math.max(Number(process.env.MLB_WEATHER_LOOKAHEAD_HOURS ?? 36), 6), 72);
  const maxEventsPerRun = Math.min(Math.max(Number(process.env.MLB_WEATHER_EVENTS_PER_RUN ?? 4), 1), 6);
  const freshnessMinutes = Math.min(Math.max(Number(process.env.MLB_WEATHER_REFRESH_TTL_MINUTES ?? 180), 30), 720);
  const priorities = await loadLiveSharpPriorities();
  const liveCoverage = await loadLivePropCoverage();

  const events = await selectRows<{ id: string; start_time: string; scheduled_date: string; home_team_id: string | null; away_team_id: string | null }>("events", {
    select: "id,start_time,scheduled_date,home_team_id,away_team_id",
    filters: [{ column: "league_id", value: config.leagueId }],
    orderBy: "start_time.asc",
  });
  const teams = await selectRows<{ id: string; name: string }>("teams", {
    select: "id,name",
    filters: [{ column: "league_id", value: config.leagueId }],
  });
  const teamMap = new Map(teams.map((team) => [team.id, team.name]));

  const eligibleEvents = events
    .filter((event) => {
      if (!event.start_time) return false;
      const startMs = new Date(event.start_time).getTime();
      if (!Number.isFinite(startMs)) return false;
      if (startMs < nowMs - 2 * 60 * 60 * 1000) return false;
      if (startMs > nowMs + lookaheadHours * 60 * 60 * 1000) return false;
      return true;
    });
  const orderedEligibleEvents = [...eligibleEvents].sort((left, right) => {
    const leftPriority = priorities.teamIds.has(left.home_team_id ?? "") || priorities.teamIds.has(left.away_team_id ?? "") || liveCoverage.distinctEventIds.includes(left.id) ? 1 : 0;
    const rightPriority = priorities.teamIds.has(right.home_team_id ?? "") || priorities.teamIds.has(right.away_team_id ?? "") || liveCoverage.distinctEventIds.includes(right.id) ? 1 : 0;
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;
    return left.start_time.localeCompare(right.start_time);
  });
  const eventWindow = await takeLiveFirstWindow({
    cacheKey: "knowledge:mlb:weather:events",
    provider: "open-meteo",
    items: orderedEligibleEvents,
    isPriority: (event) => priorities.teamIds.has(event.home_team_id ?? "") || priorities.teamIds.has(event.away_team_id ?? "") || liveCoverage.distinctEventIds.includes(event.id),
    sliceSize: Math.max(maxEventsPerRun * 3, 12),
    maxPriorityItems: maxEventsPerRun * 2,
  });
  const scopedEligibleEvents = eventWindow.items;

  const weatherRows = scopedEligibleEvents.length
    ? await selectRows<{ event_id: string | null; updated_at: string | null; weather_date: string | null }>("mlb_weather", {
        select: "event_id,updated_at,weather_date",
        filters: [
          {
            column: "event_id",
            operator: "in",
            value: scopedEligibleEvents.map((event) => event.id),
          },
        ],
      })
    : [];
  const latestWeatherByEvent = new Map<string, { updated_at: string | null; weather_date: string | null }>();
  for (const row of weatherRows) {
    if (!row.event_id) continue;
    const existing = latestWeatherByEvent.get(row.event_id);
    if (!existing) {
      latestWeatherByEvent.set(row.event_id, { updated_at: row.updated_at, weather_date: row.weather_date });
      continue;
    }
    const existingTime = existing.updated_at ? new Date(existing.updated_at).getTime() : 0;
    const nextTime = row.updated_at ? new Date(row.updated_at).getTime() : 0;
    if (nextTime >= existingTime) {
      latestWeatherByEvent.set(row.event_id, { updated_at: row.updated_at, weather_date: row.weather_date });
    }
  }

  const refreshQueue = scopedEligibleEvents.filter((event) => {
    const existing = latestWeatherByEvent.get(event.id);
    if (!existing?.updated_at) return true;
    const updatedMs = new Date(existing.updated_at).getTime();
    if (!Number.isFinite(updatedMs)) return true;
    if (existing.weather_date && existing.weather_date !== event.scheduled_date) return true;
    return updatedMs <= nowMs - freshnessMinutes * 60 * 1000;
  }).slice(0, maxEventsPerRun);

  let inserted = 0;
  for (const event of refreshQueue) {
    const homeTeam = event.home_team_id ? teamMap.get(event.home_team_id) ?? null : null;
    const awayTeam = event.away_team_id ? teamMap.get(event.away_team_id) ?? null : null;
    if (!homeTeam || !awayTeam || !adapter.hasCoordinates(homeTeam)) continue;
    const payload = await adapter.fetchMlbWeather({
      team: homeTeam,
      opponent: awayTeam,
      eventId: event.id,
      gameTime: event.start_time,
    }).catch(() => null);
    if (!payload) continue;
    await upsertRows("mlb_weather", [{
      event_id: event.id,
      game_id: null,
      weather_date: event.scheduled_date,
      temperature_f: payload.data.temperatureF,
      wind_mph: payload.data.windMph,
      wind_direction: null,
      precipitation_probability: payload.data.precipitationProbability,
      weather_note: payload.data.note,
      raw_payload: payload.data,
    }], ["event_id", "weather_date"], { returning: "minimal" });
    inserted += 1;
  }
  return {
    league: "MLB",
    inserted,
    queued: refreshQueue.length,
    inspected: scopedEligibleEvents.length,
    lookaheadHours,
    maxEventsPerRun,
    freshnessMinutes,
    priorityOnlyWindow: eventWindow.priorityOnly,
  };
}

// Park factors are multi-year averages (primarily 2021-2024) from publicly
// published MLB park factor tables. Values above 1.00 favor hitters; below
// 1.00 favor pitchers. Roof types: "open" = no roof, "dome" = fixed dome,
// "retractable" = retractable roof. These are static reference values —
// update when stadiums undergo significant physical changes (e.g. wall moves,
// new roof, turf changes) rather than year-over-year statistical variance.
const BALLPARK_META: Record<string, { roofType: string | null; parkFactor: number | null }> = {
  // AL East
  "Fenway Park": { roofType: "open", parkFactor: 1.02 },
  "Yankee Stadium": { roofType: "open", parkFactor: 1.03 },
  "Rogers Centre": { roofType: "retractable", parkFactor: 1.01 },
  "Oriole Park at Camden Yards": { roofType: "open", parkFactor: 1.02 },
  "Tropicana Field": { roofType: "dome", parkFactor: 0.94 },
  // AL Central
  "Rate Field": { roofType: "open", parkFactor: 1.01 },
  "Progressive Field": { roofType: "open", parkFactor: 0.97 },
  "Comerica Park": { roofType: "open", parkFactor: 0.95 },
  "Kauffman Stadium": { roofType: "open", parkFactor: 0.96 },
  "Target Field": { roofType: "open", parkFactor: 0.99 },
  // AL West
  "Minute Maid Park": { roofType: "retractable", parkFactor: 1.02 },
  "Angel Stadium": { roofType: "open", parkFactor: 0.97 },
  "Globe Life Field": { roofType: "retractable", parkFactor: 1.01 },
  "Oakland Coliseum": { roofType: "open", parkFactor: 0.96 },
  "Sutter Health Park": { roofType: "open", parkFactor: 0.95 },
  "T-Mobile Park": { roofType: "retractable", parkFactor: 0.91 },
  // NL East
  "Truist Park": { roofType: "open", parkFactor: 1.03 },
  "Marlins Park": { roofType: "retractable", parkFactor: 0.92 },
  "loanDepot park": { roofType: "retractable", parkFactor: 0.92 },
  "Citi Field": { roofType: "open", parkFactor: 0.95 },
  "Citizens Bank Park": { roofType: "open", parkFactor: 1.05 },
  "Nationals Park": { roofType: "open", parkFactor: 0.98 },
  // NL Central
  "Wrigley Field": { roofType: "open", parkFactor: 1.01 },
  "Great American Ball Park": { roofType: "open", parkFactor: 1.06 },
  "American Family Field": { roofType: "retractable", parkFactor: 1.03 },
  "Busch Stadium": { roofType: "open", parkFactor: 0.96 },
  "PNC Park": { roofType: "open", parkFactor: 0.96 },
  // NL West
  "Coors Field": { roofType: "open", parkFactor: 1.14 },
  "Dodger Stadium": { roofType: "open", parkFactor: 0.97 },
  "Oracle Park": { roofType: "open", parkFactor: 0.91 },
  "Petco Park": { roofType: "open", parkFactor: 0.92 },
  "Chase Field": { roofType: "retractable", parkFactor: 1.01 },
};

export async function refreshMlbBallparks() {
  const priorities = await loadLiveSharpPriorities();
  const liveCoverage = await loadLivePropCoverage();
  const events = await selectRows<{ id: string; venue: string | null; venue_city: string | null; venue_state: string | null; home_team_id: string | null; away_team_id: string | null }>("events", {
    select: "id,venue,venue_city,venue_state,home_team_id,away_team_id",
    filters: [{ column: "league_id", value: config.leagueId }],
  });
  const orderedEvents = [...events].sort((left, right) => {
    const leftPriority = priorities.teamIds.has(left.home_team_id ?? "") || priorities.teamIds.has(left.away_team_id ?? "") || liveCoverage.distinctEventIds.includes(left.id) ? 1 : 0;
    const rightPriority = priorities.teamIds.has(right.home_team_id ?? "") || priorities.teamIds.has(right.away_team_id ?? "") || liveCoverage.distinctEventIds.includes(right.id) ? 1 : 0;
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;
    return String(left.venue ?? "").localeCompare(String(right.venue ?? ""));
  });
  const eventWindow = await takeLiveFirstWindow({
    cacheKey: "knowledge:mlb:ballparks:events",
    provider: "events-schedule",
    items: orderedEvents,
    isPriority: (event) => priorities.teamIds.has(event.home_team_id ?? "") || priorities.teamIds.has(event.away_team_id ?? "") || liveCoverage.distinctEventIds.includes(event.id),
    sliceSize: 24,
    maxPriorityItems: 16,
  });
  let upserted = 0;
  for (const event of eventWindow.items) {
    if (!event.venue) continue;
    const meta = BALLPARK_META[event.venue] ?? { roofType: null, parkFactor: null };
    await upsertRows("mlb_ballparks", [{
      team_id: event.home_team_id,
      venue_name: event.venue,
      city: event.venue_city ?? null,
      state: event.venue_state ?? null,
      roof_type: meta.roofType,
      park_factor: meta.parkFactor,
      metadata: {
        source: "events-schedule",
      },
    }], ["venue_name"], { returning: "minimal" });
    upserted += 1;
  }
  return { league: "MLB", upserted, inspected: eventWindow.items.length, priorityOnlyWindow: eventWindow.priorityOnly };
}

export async function refreshMlbHandednessSplits(now = new Date()) {
  const priorities = await loadLiveSharpPriorities();
  const liveCoverage = await loadLivePropCoverage();
  const pitchers = await selectRows<{ event_id: string | null; team_id: string | null; player_id: string | null; hand: string | null }>("mlb_starting_pitchers", {
    select: "event_id,team_id,player_id,hand",
  });
  const lineups = await selectRows<{ event_id: string | null; player_id: string | null; team_id: string | null }>("lineups", {
    select: "event_id,player_id,team_id",
    filters: [{ column: "league_id", value: config.leagueId }],
  });
  const players = await selectRows<{ id: string; bats: string | null; throws: string | null; primary_position: string | null }>("players", {
    select: "id,bats,throws,primary_position",
    filters: [{ column: "league_id", value: config.leagueId }],
  });
  const playerMap = new Map(players.map((player) => [player.id, player]));
  let inserted = 0;
  const orderedLineups = [...lineups].sort((left, right) => {
    const leftPriority = priorities.teamIds.has(left.team_id ?? "") || liveCoverage.distinctEventIds.includes(left.event_id ?? "") ? 1 : 0;
    const rightPriority = priorities.teamIds.has(right.team_id ?? "") || liveCoverage.distinctEventIds.includes(right.event_id ?? "") ? 1 : 0;
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;
    return String(left.event_id ?? "").localeCompare(String(right.event_id ?? ""));
  });
  const lineupWindow = await takeLiveFirstWindow({
    cacheKey: "knowledge:mlb:handedness:lineups",
    provider: "mlb-stats-api",
    items: orderedLineups,
    isPriority: (lineup) => priorities.teamIds.has(lineup.team_id ?? "") || liveCoverage.distinctEventIds.includes(lineup.event_id ?? ""),
    sliceSize: Math.max(24, Math.min(orderedLineups.length, 48)),
    maxPriorityItems: 24,
  });
  let attempted = 0;
  let failed = 0;
  for (const lineup of lineupWindow.items) {
    if (!lineup.player_id || !lineup.event_id) continue;
    const batter = playerMap.get(lineup.player_id);
    const opposingPitcher = pitchers.find((pitcher) => pitcher.event_id === lineup.event_id && pitcher.team_id !== lineup.team_id);
    if (!batter) continue;
    attempted += 1;
    try {
      await upsertRows("mlb_handedness_splits", [{
        player_id: lineup.player_id,
        event_id: lineup.event_id,
        split_date: easternDate(now),
        batter_side: batter.bats ?? null,
        pitcher_side: opposingPitcher?.hand ?? null,
        stat_type: "handedness_context",
        split_value: batter.bats && opposingPitcher?.hand ? (batter.bats[0] === opposingPitcher.hand[0] ? -1 : 1) : null,
        sample_size: null,
        feature_payload: {
          event_id: lineup.event_id,
          pitcher_id: opposingPitcher?.player_id ?? null,
        },
      }], ["player_id", "event_id", "stat_type"], { returning: "minimal" });
      inserted += 1;
    } catch {
      failed += 1;
    }
  }
  return {
    league: "MLB",
    attempted,
    inserted,
    failed,
    lineupCursor: { start: lineupWindow.start, nextIndex: lineupWindow.nextIndex, total: lineupWindow.total },
    priorityOnlyWindow: lineupWindow.priorityOnly,
  };
}

export async function refreshMlbBullpenContext(now = new Date()) {
  const priorities = await loadLiveSharpPriorities();
  const liveCoverage = await loadLivePropCoverage();
  const pitchers = await selectRows<{ id: string; current_team_id: string | null; primary_position: string | null }>("players", {
    select: "id,current_team_id,primary_position",
    filters: [{ column: "league_id", value: config.leagueId }],
  });
  const recentLogs = await selectRows<{
    player_id: string;
    team_id: string | null;
    game_date: string;
    innings_pitched: number | null;
    earned_runs: number | null;
    hits_allowed: number | null;
    walks_allowed: number | null;
    strikeouts: number | null;
  }>("player_game_logs", {
    select: "player_id,team_id,game_date,innings_pitched,earned_runs,hits_allowed,walks_allowed,strikeouts",
    filters: [{ column: "league_id", value: config.leagueId }],
    orderBy: "game_date.desc",
    limit: 600,
  });
  const teamBuckets = new Map<string, typeof recentLogs>();
  const sinceDate = easternDate(addDays(now, -7));
  const pitcherIds = new Set(pitchers.filter((player) => /pitcher/i.test(player.primary_position ?? "")).map((player) => player.id));
  for (const log of recentLogs) {
    if (!log.team_id || !pitcherIds.has(log.player_id) || log.game_date < sinceDate) continue;
    const bucket = teamBuckets.get(log.team_id) ?? [];
    bucket.push(log);
    teamBuckets.set(log.team_id, bucket);
  }
  let upserted = 0;
  const orderedTeamBuckets = [...teamBuckets.entries()].sort((left, right) => {
    const leftPriority = priorities.teamIds.has(left[0]) ? 1 : 0;
    const rightPriority = priorities.teamIds.has(right[0]) ? 1 : 0;
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;
    return left[0].localeCompare(right[0]);
  });
  const bucketWindow = await takeLiveFirstWindow({
    cacheKey: "knowledge:mlb:bullpen:teams",
    provider: "mlb-stats-api",
    items: orderedTeamBuckets,
    isPriority: ([teamId]) => priorities.teamIds.has(teamId) || liveCoverage.distinctTeamIds.includes(teamId),
    sliceSize: Math.max(12, Math.min(orderedTeamBuckets.length, 24)),
    maxPriorityItems: 12,
  });
  for (const [teamId, logs] of bucketWindow.items) {
    const innings = logs.reduce((sum, log) => sum + (Number(log.innings_pitched) || 0), 0);
    const earnedRuns = logs.reduce((sum, log) => sum + (Number(log.earned_runs) || 0), 0);
    const hitsAllowed = logs.reduce((sum, log) => sum + (Number(log.hits_allowed) || 0), 0);
    const walksAllowed = logs.reduce((sum, log) => sum + (Number(log.walks_allowed) || 0), 0);
    const strikeouts = logs.reduce((sum, log) => sum + (Number(log.strikeouts) || 0), 0);
    const era = innings > 0 ? (earnedRuns * 9) / innings : null;
    const whip = innings > 0 ? (hitsAllowed + walksAllowed) / innings : null;
    const strikeoutRate = innings > 0 ? strikeouts / innings : null;
    const walkRate = innings > 0 ? walksAllowed / innings : null;
    await upsertRows("mlb_bullpen_context", [{
      team_id: teamId,
      context_date: easternDate(now),
      era,
      whip,
      strikeout_rate: strikeoutRate,
      walk_rate: walkRate,
      workload_note: `${logs.length} recent pitcher logs in bullpen sample`,
      context_payload: {
        sample_size: logs.length,
        since_date: sinceDate,
      },
    }], ["team_id", "context_date"], { returning: "minimal" });
    upserted += 1;
  }
  return { league: "MLB", upserted, teamCursor: { start: bucketWindow.start, nextIndex: bucketWindow.nextIndex, total: bucketWindow.total }, priorityOnlyWindow: bucketWindow.priorityOnly };
}

export async function refreshMlbMatchupFeatures(now = new Date(), options?: {
  eventIds?: string[];
  teamIds?: string[];
  missingOrStaleOnly?: boolean;
  limit?: number;
}) {
  const priorities = await loadLiveSharpPriorities();
  const liveCoverage = await loadLivePropCoverage();
  const targetedEventIds = new Set((options?.eventIds ?? []).filter((value): value is string => Boolean(value)));
  const targetedTeamIds = new Set((options?.teamIds ?? []).filter((value): value is string => Boolean(value)));
  const events = await selectRows<{
    id: string;
    scheduled_date: string;
    start_time: string;
    home_team_id: string | null;
    away_team_id: string | null;
  }>("events", {
    select: "id,scheduled_date,start_time,home_team_id,away_team_id",
    filters: [
      { column: "league_id", value: config.leagueId },
      ...(targetedEventIds.size ? [{ column: "id", operator: "in" as const, value: [...targetedEventIds] }] : []),
    ],
    orderBy: "start_time.asc",
  });
  const nowMs = now.getTime();
  const eligibleEvents = events.filter((event) => {
    if (!event.start_time) return false;
    const startMs = new Date(event.start_time).getTime();
    return Number.isFinite(startMs) && startMs >= nowMs - 2 * 60 * 60 * 1000;
  });
  const orderedEvents = [...eligibleEvents].sort((left, right) => {
    const leftPriority = priorities.teamIds.has(left.home_team_id ?? "") || priorities.teamIds.has(left.away_team_id ?? "") || liveCoverage.distinctEventIds.includes(left.id) ? 1 : 0;
    const rightPriority = priorities.teamIds.has(right.home_team_id ?? "") || priorities.teamIds.has(right.away_team_id ?? "") || liveCoverage.distinctEventIds.includes(right.id) ? 1 : 0;
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;
    return left.start_time.localeCompare(right.start_time);
  });
  const scopedEvents = orderedEvents.filter((event) => {
    if (!targetedEventIds.size && !targetedTeamIds.size) return true;
    return targetedEventIds.has(event.id)
      || targetedTeamIds.has(event.home_team_id ?? "")
      || targetedTeamIds.has(event.away_team_id ?? "");
  });
  if (options && !scopedEvents.length) {
    return {
      league: "MLB",
      inserted: 0,
      eventCursor: { start: 0, nextIndex: 0, total: 0 },
      priorityOnlyWindow: false,
    };
  }
  const eventWindow: RefreshWindow<(typeof scopedEvents)[number]> = targetedEventIds.size || targetedTeamIds.size
    ? (() => {
        const targetedItems = scopedEvents.slice(0, typeof options?.limit === "number" && Number.isFinite(options.limit)
          ? Math.max(1, Math.floor(options.limit))
          : Math.min(scopedEvents.length || 1, configuredChunkSize("KNOWLEDGE_MLB_MATCHUP_EVENTS_PER_RUN", 6, 3, 12)));
        return {
          items: targetedItems,
          start: 0,
          end: targetedItems.length,
          nextIndex: 0,
          total: scopedEvents.length,
          priorityOnly: false,
        };
      })()
    : await takeLiveFirstWindow({
        cacheKey: "knowledge:mlb:matchup-features:events",
        provider: "mlb-stats-api",
        items: scopedEvents,
        isPriority: (event) => priorities.teamIds.has(event.home_team_id ?? "") || priorities.teamIds.has(event.away_team_id ?? "") || liveCoverage.distinctEventIds.includes(event.id),
        sliceSize: configuredChunkSize("KNOWLEDGE_MLB_MATCHUP_EVENTS_PER_RUN", 6, 3, 12),
        maxPriorityItems: 6,
      });

  const eventIds = eventWindow.items.map((event) => event.id);
  const teamIds = [...new Set(eventWindow.items.flatMap((event) => [event.home_team_id, event.away_team_id]).filter((value): value is string => Boolean(value)))];
  const [teamRecentRows, lineups, pitchers, weatherRows, bullpenRows, ballparkRows] = await Promise.all([
    teamIds.length
      ? selectRows<{ team_id: string | null; feature_payload: Record<string, unknown> | null; data_quality_score: number | null; updated_at: string | null }>("team_recent_features", {
          select: "team_id,feature_payload,data_quality_score,updated_at",
          filters: [{ column: "team_id", operator: "in", value: teamIds }],
          limit: Math.max(teamIds.length * 2, 24),
        }).catch(() => [])
      : Promise.resolve([]),
    eventIds.length
      ? selectRows<{ event_id: string | null; player_id: string | null; team_id: string | null; batting_order: number | null; confirmed: boolean | null; updated_at: string | null }>("lineups", {
          select: "event_id,player_id,team_id,batting_order,confirmed,updated_at",
          filters: [
            { column: "league_id", value: config.leagueId },
            { column: "event_id", operator: "in", value: eventIds },
          ],
          limit: Math.max(eventIds.length * 8, 80),
        }).catch(() => [])
      : Promise.resolve([]),
    eventIds.length
      ? selectRows<{ event_id: string | null; team_id: string | null; player_id: string | null; hand: string | null; confirmed: boolean | null; raw_payload: Record<string, unknown> | null; updated_at: string | null }>("mlb_starting_pitchers", {
          select: "event_id,team_id,player_id,hand,confirmed,raw_payload,updated_at",
          filters: [{ column: "event_id", operator: "in", value: eventIds }],
          limit: Math.max(eventIds.length * 4, 24),
        }).catch(() => [])
      : Promise.resolve([]),
    eventIds.length
      ? selectRows<{ event_id: string | null; temperature_f: number | null; wind_mph: number | null; precipitation_probability: number | null; weather_note: string | null; updated_at: string | null }>("mlb_weather", {
          select: "event_id,temperature_f,wind_mph,precipitation_probability,weather_note,updated_at",
          filters: [{ column: "event_id", operator: "in", value: eventIds }],
          limit: Math.max(eventIds.length * 2, 24),
        }).catch(() => [])
      : Promise.resolve([]),
    teamIds.length
      ? selectRows<{ team_id: string | null; era: number | null; whip: number | null; strikeout_rate: number | null; walk_rate: number | null; workload_note: string | null; updated_at: string | null }>("mlb_bullpen_context", {
          select: "team_id,era,whip,strikeout_rate,walk_rate,workload_note,updated_at",
          filters: [{ column: "team_id", operator: "in", value: teamIds }],
          limit: Math.max(teamIds.length * 2, 24),
        }).catch(() => [])
      : Promise.resolve([]),
    teamIds.length
      ? selectRows<{ team_id: string | null; venue_name: string | null; roof_type: string | null; park_factor: number | null; updated_at: string | null }>("mlb_ballparks", {
          select: "team_id,venue_name,roof_type,park_factor,updated_at",
          filters: [{ column: "team_id", operator: "in", value: teamIds }],
          limit: Math.max(teamIds.length * 2, 24),
        }).catch(() => [])
      : Promise.resolve([]),
  ]);

  const teamRecentByTeam = new Map<string, { feature_payload: Record<string, unknown> | null; data_quality_score: number | null; updated_at: string | null }>();
  for (const row of teamRecentRows) {
    if (!row.team_id) continue;
    const current = teamRecentByTeam.get(row.team_id);
    if (!current || new Date(String(row.updated_at ?? "")).getTime() >= new Date(String(current.updated_at ?? "")).getTime()) {
      teamRecentByTeam.set(row.team_id, {
        feature_payload: row.feature_payload,
        data_quality_score: row.data_quality_score,
        updated_at: row.updated_at,
      });
    }
  }
  const pitcherByEventTeam = new Map<string, typeof pitchers[number]>();
  for (const row of pitchers) {
    if (!row.event_id || !row.team_id) continue;
    const key = `${row.event_id}:${row.team_id}`;
    const current = pitcherByEventTeam.get(key);
    if (!current || new Date(String(row.updated_at ?? "")).getTime() >= new Date(String(current.updated_at ?? "")).getTime()) {
      pitcherByEventTeam.set(key, row);
    }
  }
  const weatherByEvent = new Map<string, typeof weatherRows[number]>();
  for (const row of weatherRows) {
    if (!row.event_id) continue;
    const current = weatherByEvent.get(row.event_id);
    if (!current || new Date(String(row.updated_at ?? "")).getTime() >= new Date(String(current.updated_at ?? "")).getTime()) {
      weatherByEvent.set(row.event_id, row);
    }
  }
  const bullpenByTeam = new Map<string, typeof bullpenRows[number]>();
  for (const row of bullpenRows) {
    if (!row.team_id) continue;
    const current = bullpenByTeam.get(row.team_id);
    if (!current || new Date(String(row.updated_at ?? "")).getTime() >= new Date(String(current.updated_at ?? "")).getTime()) {
      bullpenByTeam.set(row.team_id, row);
    }
  }
  const ballparkByTeam = new Map<string, typeof ballparkRows[number]>();
  for (const row of ballparkRows) {
    if (!row.team_id) continue;
    const current = ballparkByTeam.get(row.team_id);
    if (!current || new Date(String(row.updated_at ?? "")).getTime() >= new Date(String(current.updated_at ?? "")).getTime()) {
      ballparkByTeam.set(row.team_id, row);
    }
  }
  const lineupCountByEventTeam = new Map<string, number>();
  for (const row of lineups) {
    if (!row.event_id || !row.team_id) continue;
    const key = `${row.event_id}:${row.team_id}`;
    lineupCountByEventTeam.set(key, (lineupCountByEventTeam.get(key) ?? 0) + 1);
  }

  let inserted = 0;
  for (const event of eventWindow.items) {
    if (!event.home_team_id || !event.away_team_id) continue;
    const homeWeather = weatherByEvent.get(event.id) ?? null;
    const homeTeamRecent = teamRecentByTeam.get(event.home_team_id) ?? null;
    const awayTeamRecent = teamRecentByTeam.get(event.away_team_id) ?? null;
    const teamPairs = [
      { teamId: event.home_team_id, opponentTeamId: event.away_team_id, teamRecent: homeTeamRecent, pitcher: pitcherByEventTeam.get(`${event.id}:${event.away_team_id}`) ?? null, bullpen: bullpenByTeam.get(event.away_team_id) ?? null, ballpark: ballparkByTeam.get(event.home_team_id) ?? null },
      { teamId: event.away_team_id, opponentTeamId: event.home_team_id, teamRecent: awayTeamRecent, pitcher: pitcherByEventTeam.get(`${event.id}:${event.home_team_id}`) ?? null, bullpen: bullpenByTeam.get(event.home_team_id) ?? null, ballpark: ballparkByTeam.get(event.away_team_id) ?? null },
    ] as const;

    for (const pair of teamPairs) {
      const lineupCount = lineupCountByEventTeam.get(`${event.id}:${pair.teamId}`) ?? 0;
      await deleteRows("matchup_features", [
        { column: "event_id", value: event.id },
        { column: "team_id", value: pair.teamId },
        { column: "opponent_team_id", value: pair.opponentTeamId },
        { column: "feature_date", value: event.scheduled_date },
        { column: "matchup_type", value: "mlb-hitter-vs-pitching" },
      ]).catch(() => {});
      await insertRows("matchup_features", [{
        sport_id: config.sportId,
        league_id: config.leagueId,
        team_id: pair.teamId,
        opponent_team_id: pair.opponentTeamId,
        event_id: event.id,
        game_id: event.id,
        feature_date: event.scheduled_date,
        matchup_type: "mlb-hitter-vs-pitching",
        feature_payload: {
          lineup_count: lineupCount,
          team_recent: pair.teamRecent?.feature_payload ?? null,
          opposing_starting_pitcher_hand: pair.pitcher?.hand ?? null,
          opposing_starting_pitcher_confirmed: pair.pitcher?.confirmed ?? null,
          opposing_starting_pitcher_raw: pair.pitcher?.raw_payload ?? null,
          opponent_bullpen_era: pair.bullpen?.era ?? null,
          opponent_bullpen_whip: pair.bullpen?.whip ?? null,
          ballpark_factor: pair.ballpark?.park_factor ?? null,
          ballpark_roof: pair.ballpark?.roof_type ?? null,
          temperature_f: homeWeather?.temperature_f ?? null,
          wind_mph: homeWeather?.wind_mph ?? null,
          precipitation_probability: homeWeather?.precipitation_probability ?? null,
        },
        data_quality_score: [
          lineupCount > 0 ? 0.2 : 0,
          pair.pitcher?.confirmed ? 0.2 : 0,
          pair.bullpen?.era !== null ? 0.2 : 0,
          pair.ballpark?.park_factor !== null ? 0.2 : 0,
          homeWeather ? 0.2 : 0,
        ].reduce((sum, value) => sum + value, 0),
      }], { returning: "minimal" });
      inserted += 1;
    }
  }
  return { league: "MLB", inserted, eventCursor: { start: eventWindow.start, nextIndex: eventWindow.nextIndex, total: eventWindow.total }, priorityOnlyWindow: eventWindow.priorityOnly };
}

export async function refreshMlbStatcastForKnownPlayers(now = new Date()) {
  const statcast = new StatcastSavantAdapter();
  const players = await selectRows<{ id: string; canonical_name: string; primary_position: string | null }>("players", {
    select: "id,canonical_name,primary_position",
    filters: [{ column: "league_id", value: config.leagueId }],
    limit: Math.min(configuredPlayerLogBatchSize(), 25),
  });
  let enriched = 0;
  for (const player of players) {
    const probe = await statcast.fetchPlayerContextSummary({
      playerName: player.canonical_name,
      playerType: /pitcher/i.test(player.primary_position ?? "") ? "pitcher" : "batter",
      probeOnly: false,
    }).catch(() => null);
    if (probe?.status !== "ok" || !probe.summary) continue;
    if (/pitcher/i.test(player.primary_position ?? "")) {
      await deleteRows("mlb_pitcher_features", [
        { column: "player_id", value: player.id },
        { column: "feature_date", value: easternDate(now) },
      ]).catch(() => {});
      await insertRows("mlb_pitcher_features", [{
        player_id: player.id,
        event_id: null,
        game_id: null,
        feature_date: easternDate(now),
        recent_strikeouts_avg: null,
        recent_pitch_count_avg: null,
        season_era: null,
        season_whip: null,
        season_k_rate: probe.summary.strikeoutRate,
        season_bb_rate: probe.summary.walkRate,
        swinging_strike_rate: null,
        velocity_trend: null,
        feature_payload: probe.summary,
      }], { returning: "minimal" }).catch(() => {});
    } else {
      await deleteRows("mlb_batter_features", [
        { column: "player_id", value: player.id },
        { column: "feature_date", value: easternDate(now) },
      ]).catch(() => {});
      await insertRows("mlb_batter_features", [{
        player_id: player.id,
        event_id: null,
        game_id: null,
        feature_date: easternDate(now),
        recent_hits_avg: null,
        recent_total_bases_avg: null,
        season_avg: null,
        season_obp: null,
        season_slg: null,
        season_ops: null,
        average_exit_velocity: probe.summary.avgExitVelocity,
        hard_hit_rate: probe.summary.hardHitRate,
        barrel_rate: probe.summary.barrelRate,
        xba: null,
        xslg: null,
        xwoba: probe.summary.xwoba,
        feature_payload: probe.summary,
      }], { returning: "minimal" }).catch(() => {});
    }
    enriched += 1;
  }
  return { league: "MLB", statcastRows: enriched };
}
