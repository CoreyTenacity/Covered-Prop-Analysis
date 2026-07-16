import { deleteRows, insertRows, selectRows, updateRows, upsertRows } from "@/lib/db/supabase-server";
import type { SupabaseFilter } from "@/lib/db/supabase-server";
import { derivePlayerHeadshotUrl, deriveTeamLogoUrl } from "@/lib/knowledge/media";
import type {
  ActiveKnowledgeLeagueCode,
  EntityAliasRow,
  EventRow,
  ParticipantRow,
  ParticipantType,
  PlayerRow,
  SourceMappingRow,
  TeamRow,
} from "@/lib/knowledge/types";
import { getProviderCache, getProviderCacheWithStatus, putProviderCache, type ProviderCacheReadStatus } from "@/lib/db/provider-cache";

type TeamRecord = TeamRow & { id: string; external_ids?: Record<string, unknown>; metadata?: Record<string, unknown> };
type PlayerRecord = PlayerRow & { id: string; external_ids?: Record<string, unknown>; metadata?: Record<string, unknown> };
type EventRecord = EventRow & { id: string; external_ids?: Record<string, unknown>; metadata?: Record<string, unknown> };

export type RefreshWindow<T> = {
  items: T[];
  start: number;
  end: number;
  nextIndex: number;
  total: number;
  priorityOnly: boolean;
};

export type LeagueConfig = {
  league: ActiveKnowledgeLeagueCode;
  leagueId: "mlb" | "nba" | "wnba";
  sportId: "baseball" | "basketball";
  sportName: "MLB" | "NBA" | "WNBA";
  providerId: string;
  participantTypeForPosition(position?: string | null): ParticipantType;
};

export const ACTIVE_LEAGUES: Record<ActiveKnowledgeLeagueCode, LeagueConfig> = {
  MLB: {
    league: "MLB",
    leagueId: "mlb",
    sportId: "baseball",
    sportName: "MLB",
    providerId: "mlb-stats-api",
    participantTypeForPosition(position) {
      return /(^|[^a-z])p(itcher)?([^a-z]|$)/i.test(position ?? "") ? "pitcher" : "batter";
    },
  },
  NBA: {
    league: "NBA",
    leagueId: "nba",
    sportId: "basketball",
    sportName: "NBA",
    providerId: "nba-com-stats",
    participantTypeForPosition() {
      return "player";
    },
  },
  WNBA: {
    league: "WNBA",
    leagueId: "wnba",
    sportId: "basketball",
    sportName: "WNBA",
    providerId: "wehoop-wnba",
    participantTypeForPosition() {
      return "player";
    },
  },
};

/**
 * WNBA data provider selection.
 *
 * `stats.nba.com` (the legacy path, WeHoopWnbaAdapter) is confirmed
 * unreachable from GitHub Actions (docs/WNBA_PROVIDER_EVIDENCE_AUDIT.md) -
 * it must never be the silent default. This is the single source of truth
 * for provider selection; every WNBA-specific job branch reads it through
 * this function rather than checking `process.env.WNBA_DATA_PROVIDER`
 * directly, so there is exactly one place that can get this decision wrong.
 *
 * - Unset or empty -> "espn-sportsdataverse" (the safe default).
 * - Recognized non-default value -> that value (explicit opt-in required
 *   to use the legacy path).
 * - Any other value (typo, stray whitespace-only difference, etc.) ->
 *   throws. A misspelled env var must be loud, not a silent fallback to
 *   the endpoint already proven to fail.
 */
export type WnbaDataProvider = "espn-sportsdataverse" | "legacy-stats-nba";

const WNBA_DATA_PROVIDER_VALUES: readonly WnbaDataProvider[] = ["espn-sportsdataverse", "legacy-stats-nba"];

export function resolveWnbaDataProvider(): WnbaDataProvider {
  const raw = process.env.WNBA_DATA_PROVIDER?.trim();
  if (!raw) return "espn-sportsdataverse";
  if ((WNBA_DATA_PROVIDER_VALUES as readonly string[]).includes(raw)) return raw as WnbaDataProvider;
  throw new Error(
    `Invalid WNBA_DATA_PROVIDER value "${raw}". Expected one of: ${WNBA_DATA_PROVIDER_VALUES.join(", ")}. ` +
    `Unset the variable entirely to use the safe default (espn-sportsdataverse).`,
  );
}

export function normalizeName(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeCode(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function teamNameVariants(input: {
  name: string;
  abbreviation?: string | null;
  city?: string | null;
  nickname?: string | null;
}) {
  const variants = new Set<string>();
  const push = (value?: string | null) => {
    if (!value) return;
    const normalized = normalizeName(value);
    if (normalized) variants.add(normalized);
  };
  push(input.name);
  push(input.abbreviation ?? null);
  push(input.city ?? null);
  push(input.nickname ?? null);
  if (input.city && input.nickname) push(`${input.city} ${input.nickname}`);
  if (input.abbreviation && input.nickname) push(`${input.abbreviation} ${input.nickname}`);
  return variants;
}

export function titleCaseWords(value: string) {
  return value.split(/\s+/).filter(Boolean).map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

export function easternDate(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function currentBasketballSeason(now = new Date()) {
  const year = now.getFullYear();
  const startYear = now.getMonth() >= 9 ? year : year - 1;
  return `${startYear}-${String(startYear + 1).slice(-2)}`;
}

export function currentWnbaSeason(now = new Date()) {
  const year = now.getFullYear();
  return String(now.getMonth() < 3 ? year - 1 : year);
}

export function currentMlbSeason(now = new Date()) {
  return String(now.getFullYear());
}

export function configuredScheduleLookaheadDays() {
  const raw = Number(process.env.KNOWLEDGE_SCHEDULE_DAYS_AHEAD ?? "2");
  return Number.isFinite(raw) ? Math.max(1, Math.min(7, Math.floor(raw))) : 2;
}

export function configuredPlayerLogBatchSize() {
  const raw = Number(process.env.KNOWLEDGE_PLAYER_LOG_BATCH_SIZE ?? "60");
  return Number.isFinite(raw) ? Math.max(10, Math.min(400, Math.floor(raw))) : 60;
}

export function configuredRecentWindowDays() {
  const raw = Number(process.env.KNOWLEDGE_RECENT_LOOKBACK_DAYS ?? "21");
  return Number.isFinite(raw) ? Math.max(7, Math.min(90, Math.floor(raw))) : 21;
}

export function configuredChunkSize(envName: string, fallback: number, min = 1, max = 500) {
  const raw = Number(process.env[envName] ?? String(fallback));
  return Number.isFinite(raw) ? Math.max(min, Math.min(max, Math.floor(raw))) : fallback;
}

export function selectRotatingSlice<T>(input: {
  items: T[];
  sliceSize: number;
  nextIndex?: unknown;
}) {
  const total = input.items.length;
  if (!total) {
    return { items: [] as T[], start: 0, end: 0, nextIndex: 0, total: 0 };
  }
  const size = Math.max(1, Math.min(total, Math.floor(input.sliceSize) || 1));
  const cachedIndex = Number(input.nextIndex ?? 0);
  const start = Number.isFinite(cachedIndex) && cachedIndex >= 0 ? cachedIndex % total : 0;
  const items = Array.from({ length: size }, (_, offset) => input.items[(start + offset) % total]);
  const nextIndex = (start + size) % total;
  return { items, start, end: start + items.length, nextIndex, total };
}

export type RotatingSliceReadStatus = "not-attempted" | ProviderCacheReadStatus | "malformed";
export type RotatingSliceWriteStatus = "not-attempted" | "persisted" | "failed";

export type RotatingSliceResult<T> = ReturnType<typeof selectRotatingSlice<T>> & {
  cursorReadStatus: RotatingSliceReadStatus;
  cursorWriteStatus: RotatingSliceWriteStatus;
  cursorPersisted: boolean;
  cursorRecovered: boolean;
};

type RotationCursorRecord = { nextIndex?: unknown; total?: number; sliceSize?: number; updatedAt?: string };
type RotationCursorRead = (cacheKey: string) => Promise<{
  payload: RotationCursorRecord | null;
  status: ProviderCacheReadStatus;
}>;
type RotationCursorWrite = (input: {
  cacheKey: string;
  provider: string;
  payload: RotationCursorRecord;
}) => Promise<boolean>;

const readRotationCursor: RotationCursorRead = async (cacheKey) => {
  const result = await getProviderCacheWithStatus<RotationCursorRecord>(cacheKey);
  return { payload: result.record?.payload ?? null, status: result.status };
};

const writeRotationCursor: RotationCursorWrite = async (input) => putProviderCache({
  cacheKey: input.cacheKey,
  provider: input.provider as never,
  payload: input.payload,
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
});

export async function takeRotatingSlice<T>(input: {
  cacheKey: string;
  provider: string;
  items: T[];
  sliceSize: number;
  readCursor?: RotationCursorRead;
  writeCursor?: RotationCursorWrite;
}): Promise<RotatingSliceResult<T>> {
  if (!input.items.length) {
    return {
      ...selectRotatingSlice({ items: input.items, sliceSize: input.sliceSize }),
      cursorReadStatus: "not-attempted",
      cursorWriteStatus: "not-attempted",
      cursorPersisted: false,
      cursorRecovered: false,
    };
  }
  const readCursor = input.readCursor ?? readRotationCursor;
  const writeCursor = input.writeCursor ?? writeRotationCursor;
  const cached = await readCursor(input.cacheKey).catch(() => ({ payload: null, status: "failed" as const }));
  const rawNextIndex = cached.payload?.nextIndex;
  const malformed = cached.status === "hit"
    && (typeof rawNextIndex !== "number" || !Number.isSafeInteger(rawNextIndex) || rawNextIndex < 0);
  const selection = selectRotatingSlice({
    items: input.items,
    sliceSize: input.sliceSize,
    nextIndex: malformed ? 0 : rawNextIndex,
  });
  const persisted = await writeCursor({
    cacheKey: input.cacheKey,
    provider: input.provider,
    payload: { nextIndex: selection.nextIndex, total: selection.total, sliceSize: selection.items.length, updatedAt: new Date().toISOString() },
  }).catch(() => false);
  return {
    ...selection,
    cursorReadStatus: malformed ? "malformed" : cached.status,
    cursorWriteStatus: persisted ? "persisted" : "failed",
    cursorPersisted: persisted,
    cursorRecovered: cached.status !== "hit" || malformed,
  };
}

export function providerExternalKey(provider: string, id: string | number | null | undefined) {
  return id === null || id === undefined || `${id}`.trim() === "" ? null : `${provider}:${id}`;
}

export async function saveAlias(row: EntityAliasRow) {
  const existing = await selectRows<{ id: string }>("entity_aliases", {
    select: "id",
    filters: [
      { column: "entity_type", value: row.entity_type },
      { column: "entity_id", value: row.entity_id },
      { column: "provider", value: row.provider ?? null },
      { column: "normalized_alias", value: row.normalized_alias },
    ],
    limit: 1,
  });
  if (existing[0]?.id) {
    await updateRows("entity_aliases", [{ column: "id", value: existing[0].id }], row, { returning: "minimal" });
    return;
  }
  await insertRows("entity_aliases", [row], { returning: "minimal" });
}

export async function saveSourceMapping(row: SourceMappingRow) {
  const externalId = row.external_id === undefined || row.external_id === "" ? null : row.external_id;
  const externalKey = row.external_key === undefined || row.external_key === "" ? null : row.external_key;
  const filters = [
    { column: "provider", value: row.provider },
    { column: "entity_type", value: row.entity_type },
    { column: "entity_id", value: row.entity_id },
    ...(externalId !== null ? [{ column: "external_id", value: externalId }] : [{ raw: "external_id=is.null" }]),
    ...(externalKey !== null ? [{ column: "external_key", value: externalKey }] : [{ raw: "external_key=is.null" }]),
  ];
  const existing = await selectRows<{ id: string }>("source_mappings", {
    select: "id",
    filters: filters as SupabaseFilter[],
    limit: 1,
  });
  if (existing[0]?.id) {
    await updateRows("source_mappings", [{ column: "id", value: existing[0].id }], row, { returning: "minimal" });
    return;
  }
  await insertRows("source_mappings", [row], { returning: "minimal" });
}

export async function findTeamByMapping(provider: string, leagueId: string, externalId: string | null | undefined) {
  if (!externalId) return null;
  const mapped = await selectRows<{ entity_id: string }>("source_mappings", {
    select: "entity_id",
    filters: [
      { column: "provider", value: provider },
      { column: "entity_type", value: "team" },
      { column: "league_id", value: leagueId },
      { column: "external_id", value: externalId },
    ],
    limit: 1,
  });
  return mapped[0]?.entity_id ?? null;
}

export async function findPlayerByMapping(provider: string, leagueId: string, externalId: string | null | undefined) {
  if (!externalId) return null;
  const mapped = await selectRows<{ entity_id: string }>("source_mappings", {
    select: "entity_id",
    filters: [
      { column: "provider", value: provider },
      { column: "entity_type", value: "player" },
      { column: "league_id", value: leagueId },
      { column: "external_id", value: externalId },
    ],
    limit: 1,
  });
  return mapped[0]?.entity_id ?? null;
}

export async function ensureTeam(input: {
  league: ActiveKnowledgeLeagueCode;
  provider: string;
  externalId?: string | null;
  name: string;
  abbreviation?: string | null;
  city?: string | null;
  nickname?: string | null;
  logoUrl?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const config = ACTIVE_LEAGUES[input.league];
  const normalized = normalizeName(input.name);
  const existingId = await findTeamByMapping(input.provider, config.leagueId, input.externalId);
  const aliasLookup = existingId
    ? []
    : await selectRows<{ entity_id: string }>("entity_aliases", {
        select: "entity_id",
        filters: [
          { column: "entity_type", value: "team" },
          { column: "league_id", value: config.leagueId },
          { column: "normalized_alias", value: normalized },
        ],
        limit: 1,
      });
  const fallbackRows = !existingId && !aliasLookup[0]?.entity_id
    ? await selectRows<TeamRecord>("teams", {
        select: "id,name,abbreviation,city,nickname,logo_url,external_ids,metadata",
        filters: [{ column: "league_id", value: config.leagueId }],
      })
    : [];
  const inputVariants = teamNameVariants({
    name: input.name,
    abbreviation: input.abbreviation ?? null,
    city: input.city ?? null,
    nickname: input.nickname ?? null,
  });
  const fallbackMatch = fallbackRows.find((row) => {
    const rowVariants = teamNameVariants({
      name: row.name,
      abbreviation: row.abbreviation ?? null,
      city: row.city ?? null,
      nickname: row.nickname ?? null,
    });
    return [...rowVariants].some((variant) => inputVariants.has(variant));
  }) ?? null;
  const teamId = existingId ?? aliasLookup[0]?.entity_id ?? fallbackMatch?.id ?? null;
  const resolvedLogoUrl = deriveTeamLogoUrl({
    leagueId: input.league,
    storedLogoUrl: input.logoUrl ?? fallbackMatch?.logo_url ?? null,
    externalIds: {
      ...(fallbackMatch?.external_ids ?? {}),
      ...(input.externalId ? { [input.provider]: input.externalId } : {}),
    },
    abbreviation: input.abbreviation ?? fallbackMatch?.abbreviation ?? null,
  });

  if (teamId) {
    const existing = fallbackMatch ?? (await selectRows<TeamRecord>("teams", {
      select: "id,name,abbreviation,city,nickname,logo_url,external_ids,metadata",
      filters: [{ column: "id", value: teamId }],
      limit: 1,
    }))[0];
    await updateRows("teams", [{ column: "id", value: teamId }], {
      name: input.name,
      abbreviation: input.abbreviation ?? existing?.abbreviation ?? null,
      city: input.city ?? existing?.city ?? null,
      nickname: input.nickname ?? existing?.nickname ?? null,
      logo_url: resolvedLogoUrl ?? existing?.logo_url ?? null,
      external_ids: {
        ...(existing?.external_ids ?? {}),
        ...(input.externalId ? { [input.provider]: input.externalId } : {}),
      },
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      updated_at: new Date().toISOString(),
    }, { returning: "minimal" });
    await saveAlias({
      entity_type: "team",
      entity_id: teamId,
      provider: input.provider as never,
      league_id: config.leagueId,
      alias: input.name,
      normalized_alias: normalized,
      alias_type: "provider_name",
      confidence: 1,
      metadata: {},
    });
    if (input.abbreviation) {
      await saveAlias({
        entity_type: "team",
        entity_id: teamId,
        provider: input.provider as never,
        league_id: config.leagueId,
        alias: input.abbreviation,
        normalized_alias: normalizeName(input.abbreviation),
        alias_type: "abbreviation",
        confidence: 1,
        metadata: {},
      });
    }
    if (input.abbreviation && input.nickname) {
      await saveAlias({
        entity_type: "team",
        entity_id: teamId,
        provider: input.provider as never,
        league_id: config.leagueId,
        alias: `${input.abbreviation} ${input.nickname}`,
        normalized_alias: normalizeName(`${input.abbreviation} ${input.nickname}`),
        alias_type: "provider_name",
        confidence: 0.95,
        metadata: {},
      });
    }
    if (input.externalId) {
      await saveSourceMapping({
        provider: input.provider as never,
        entity_type: "team",
        entity_id: teamId,
        external_id: input.externalId,
        external_key: input.name,
        league_id: config.leagueId,
        metadata: {},
      });
    }
    await ensureParticipant({
      sport_id: config.sportId,
      league_id: config.leagueId,
      participant_type: "team",
      display_name: input.name,
      normalized_name: normalized,
      team_id: teamId,
      image_url: resolvedLogoUrl ?? null,
      active: true,
      external_ids: input.externalId ? { [input.provider]: input.externalId } : {},
      metadata: { source: input.provider },
    });
    return teamId;
  }

  const code = normalizeCode(input.abbreviation || input.nickname || input.name);
  const inserted = await insertRows<TeamRow>("teams", [{
    sport_id: config.sportId,
    league_id: config.leagueId,
    code,
    name: input.name,
    city: input.city ?? null,
    nickname: input.nickname ?? null,
    abbreviation: input.abbreviation ?? null,
    logo_url: resolvedLogoUrl ?? null,
    external_ids: input.externalId ? { [input.provider]: input.externalId } : {},
    metadata: input.metadata ?? {},
  }]);
  const newId = (inserted[0] as { id?: string } | undefined)?.id;
  if (!newId) throw new Error(`Could not create team ${input.name}.`);

  await ensureParticipant({
    sport_id: config.sportId,
    league_id: config.leagueId,
    participant_type: "team",
    display_name: input.name,
    normalized_name: normalized,
    team_id: newId,
    image_url: resolvedLogoUrl ?? null,
    active: true,
    external_ids: input.externalId ? { [input.provider]: input.externalId } : {},
    metadata: { source: input.provider },
  });
  await saveAlias({
    entity_type: "team",
    entity_id: newId,
    provider: input.provider as never,
    league_id: config.leagueId,
    alias: input.name,
    normalized_alias: normalized,
    alias_type: "provider_name",
    confidence: 1,
    metadata: {},
  });
  if (input.abbreviation) {
    await saveAlias({
      entity_type: "team",
      entity_id: newId,
      provider: input.provider as never,
      league_id: config.leagueId,
      alias: input.abbreviation,
      normalized_alias: normalizeName(input.abbreviation),
      alias_type: "abbreviation",
      confidence: 1,
      metadata: {},
    });
  }
  if (input.abbreviation && input.nickname) {
    await saveAlias({
      entity_type: "team",
      entity_id: newId,
      provider: input.provider as never,
      league_id: config.leagueId,
      alias: `${input.abbreviation} ${input.nickname}`,
      normalized_alias: normalizeName(`${input.abbreviation} ${input.nickname}`),
      alias_type: "provider_name",
      confidence: 0.95,
      metadata: {},
    });
  }
  if (input.externalId) {
    await saveSourceMapping({
      provider: input.provider as never,
      entity_type: "team",
      entity_id: newId,
      external_id: input.externalId,
      external_key: input.name,
      league_id: config.leagueId,
      metadata: {},
    });
  }
  return newId;
}

export async function ensurePlayer(input: {
  league: ActiveKnowledgeLeagueCode;
  provider: string;
  externalId?: string | null;
  canonicalName: string;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  currentTeamId?: string | null;
  primaryPosition?: string | null;
  bats?: string | null;
  throws?: string | null;
  shoots?: string | null;
  active?: boolean;
  headshotUrl?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const config = ACTIVE_LEAGUES[input.league];
  const normalized = normalizeName(input.canonicalName);
  const existingId = await findPlayerByMapping(input.provider, config.leagueId, input.externalId);
  const aliasLookup = existingId
    ? []
    : await selectRows<{ entity_id: string }>("entity_aliases", {
        select: "entity_id",
        filters: [
          { column: "entity_type", value: "player" },
          { column: "league_id", value: config.leagueId },
          { column: "normalized_alias", value: normalized },
        ],
      });
  const aliasMatches = [...new Set(aliasLookup.map((row) => row.entity_id))];
  const fallbackRows = !existingId && aliasMatches.length !== 1
    ? await selectRows<PlayerRecord>("players", {
        select: "id,canonical_name,normalized_name,current_team_id,primary_position,headshot_url,external_ids,metadata",
        filters: [{ column: "league_id", value: config.leagueId }],
      })
    : [];
  const fallbackMatch = fallbackRows.find((row) => {
    const sameName = row.normalized_name === normalized;
    const sameTeam = input.currentTeamId && row.current_team_id && row.current_team_id === input.currentTeamId;
    return sameName && (sameTeam || !input.currentTeamId);
  }) ?? null;
  const playerId = existingId ?? (aliasMatches.length === 1 ? aliasMatches[0] : null) ?? fallbackMatch?.id ?? null;

  const participantType = config.participantTypeForPosition(input.primaryPosition);
  const resolvedHeadshotUrl = derivePlayerHeadshotUrl({
    leagueId: input.league,
    storedHeadshotUrl: input.headshotUrl ?? fallbackMatch?.headshot_url ?? null,
    externalIds: {
      ...(fallbackMatch?.external_ids ?? {}),
      ...(input.externalId ? { [input.provider]: input.externalId } : {}),
    },
  });

  if (playerId) {
    const existing = fallbackMatch ?? (await selectRows<PlayerRecord>("players", {
      select: "id,canonical_name,normalized_name,current_team_id,primary_position,headshot_url,external_ids,metadata",
      filters: [{ column: "id", value: playerId }],
      limit: 1,
    }))[0];
    await updateRows("players", [{ column: "id", value: playerId }], {
      canonical_name: input.canonicalName,
      first_name: input.firstName ?? null,
      last_name: input.lastName ?? null,
      normalized_name: normalized,
      display_name: input.displayName ?? input.canonicalName,
      current_team_id: input.currentTeamId ?? existing?.current_team_id ?? null,
      primary_position: input.primaryPosition ?? existing?.primary_position ?? null,
      bats: input.bats ?? null,
      throws: input.throws ?? null,
      shoots: input.shoots ?? null,
      active: input.active ?? true,
      headshot_url: resolvedHeadshotUrl ?? existing?.headshot_url ?? null,
      external_ids: {
        ...(existing?.external_ids ?? {}),
        ...(input.externalId ? { [input.provider]: input.externalId } : {}),
      },
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      updated_at: new Date().toISOString(),
    }, { returning: "minimal" });
    await ensureParticipant({
      sport_id: config.sportId,
      league_id: config.leagueId,
      participant_type: participantType,
      display_name: input.displayName ?? input.canonicalName,
      normalized_name: normalized,
      player_id: playerId,
      team_id: input.currentTeamId ?? existing?.current_team_id ?? null,
      image_url: resolvedHeadshotUrl ?? null,
      active: input.active ?? true,
      external_ids: input.externalId ? { [input.provider]: input.externalId } : {},
      metadata: { source: input.provider, participant_type: participantType },
    });
    await saveAlias({
      entity_type: "player",
      entity_id: playerId,
      provider: input.provider as never,
      league_id: config.leagueId,
      alias: input.displayName ?? input.canonicalName,
      normalized_alias: normalized,
      alias_type: "provider_name",
      confidence: 1,
      metadata: {},
    });
    if (input.externalId) {
      await saveSourceMapping({
        provider: input.provider as never,
        entity_type: "player",
        entity_id: playerId,
        external_id: input.externalId,
        external_key: input.displayName ?? input.canonicalName,
        league_id: config.leagueId,
        metadata: { participant_type: participantType },
      });
    }
    return playerId;
  }

  let newId: string | null = null;
  try {
    const inserted = await insertRows<PlayerRow>("players", [{
      sport_id: config.sportId,
      league_id: config.leagueId,
      current_team_id: input.currentTeamId ?? null,
      canonical_name: input.canonicalName,
      first_name: input.firstName ?? null,
      last_name: input.lastName ?? null,
      normalized_name: normalized,
      display_name: input.displayName ?? input.canonicalName,
      primary_position: input.primaryPosition ?? null,
      bats: input.bats ?? null,
      throws: input.throws ?? null,
      shoots: input.shoots ?? null,
      active: input.active ?? true,
      headshot_url: resolvedHeadshotUrl ?? null,
      external_ids: input.externalId ? { [input.provider]: input.externalId } : {},
      metadata: input.metadata ?? {},
    }]);
    newId = (inserted[0] as { id?: string } | undefined)?.id ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/players_identity_unique_idx|duplicate key value violates unique constraint/i.test(message)) {
      throw error;
    }
    const retryRows = await selectRows<PlayerRecord>("players", {
      select: "id,canonical_name,normalized_name,current_team_id,primary_position,headshot_url,external_ids,metadata",
      filters: [{ column: "league_id", value: config.leagueId }],
    });
    const retryMatch = retryRows.find((row) => {
      const sameName = row.normalized_name === normalized;
      const sameTeam = input.currentTeamId && row.current_team_id && row.current_team_id === input.currentTeamId;
      return sameName && (sameTeam || !input.currentTeamId);
    }) ?? null;
    newId = retryMatch?.id ?? null;
  }
  if (!newId) throw new Error(`Could not create player ${input.canonicalName}.`);

  await ensureParticipant({
    sport_id: config.sportId,
    league_id: config.leagueId,
    participant_type: participantType,
    display_name: input.displayName ?? input.canonicalName,
    normalized_name: normalized,
    player_id: newId,
    team_id: input.currentTeamId ?? null,
    image_url: resolvedHeadshotUrl ?? null,
    active: input.active ?? true,
    external_ids: input.externalId ? { [input.provider]: input.externalId } : {},
    metadata: { source: input.provider, participant_type: participantType },
  });
  await saveAlias({
    entity_type: "player",
    entity_id: newId,
    provider: input.provider as never,
    league_id: config.leagueId,
    alias: input.displayName ?? input.canonicalName,
    normalized_alias: normalized,
    alias_type: "provider_name",
    confidence: 1,
    metadata: {},
  });
  if (input.externalId) {
    await saveSourceMapping({
      provider: input.provider as never,
      entity_type: "player",
      entity_id: newId,
      external_id: input.externalId,
      external_key: input.displayName ?? input.canonicalName,
      league_id: config.leagueId,
      metadata: { participant_type: participantType },
    });
  }
  return newId;
}

export async function ensureParticipant(input: ParticipantRow) {
  const normalizedInput: ParticipantRow = input.player_id
    ? {
        ...input,
        team_id: null,
        metadata: {
          ...(input.metadata ?? {}),
          current_team_id: input.team_id ?? null,
        },
      }
    : input;
  const existing = input.player_id
    ? await selectRows<{ id: string; image_url?: string | null; external_ids?: Record<string, unknown>; metadata?: Record<string, unknown> }>("participants", {
        select: "id,image_url,external_ids,metadata",
        filters: [{ column: "player_id", value: input.player_id }],
        limit: 1,
      })
    : input.team_id
      ? await selectRows<{ id: string; image_url?: string | null; external_ids?: Record<string, unknown>; metadata?: Record<string, unknown> }>("participants", {
          select: "id,image_url,external_ids,metadata",
          filters: [{ column: "team_id", value: input.team_id }],
          limit: 1,
        })
      : [];
  if (existing[0]?.id) {
    await updateRows("participants", [{ column: "id", value: existing[0].id }], {
      participant_type: normalizedInput.participant_type,
      display_name: normalizedInput.display_name,
      normalized_name: normalizedInput.normalized_name,
      team_id: normalizedInput.player_id ? null : normalizedInput.team_id ?? null,
      image_url: normalizedInput.image_url ?? existing[0].image_url ?? null,
      active: normalizedInput.active ?? true,
      external_ids: {
        ...(existing[0].external_ids ?? {}),
        ...(normalizedInput.external_ids ?? {}),
      },
      metadata: {
        ...(existing[0].metadata ?? {}),
        ...(normalizedInput.metadata ?? {}),
      },
      updated_at: new Date().toISOString(),
    }, { returning: "minimal" });
    return existing[0].id;
  }
  const participantId =
    normalizedInput.id
    ?? normalizedInput.player_id
    ?? normalizedInput.team_id
    ?? crypto.randomUUID();
  const inserted = await insertRows<ParticipantRow>("participants", [{
    ...normalizedInput,
    id: participantId,
  }]);
  return (inserted[0] as { id?: string } | undefined)?.id ?? null;
}

export async function ensureEvent(input: {
  league: ActiveKnowledgeLeagueCode;
  provider: string;
  externalId?: string | null;
  season?: string | null;
  scheduledDate: string;
  startTime: string;
  status: string;
  displayName: string;
  homeTeamId?: string | null;
  awayTeamId?: string | null;
  venue?: string | null;
  venueCity?: string | null;
  venueState?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const config = ACTIVE_LEAGUES[input.league];
  const existingId = input.externalId
    ? (await selectRows<{ entity_id: string }>("source_mappings", {
        select: "entity_id",
        filters: [
          { column: "provider", value: input.provider },
          { column: "entity_type", value: "event" },
          { column: "league_id", value: config.leagueId },
          { column: "external_id", value: input.externalId },
        ],
        limit: 1,
      }))[0]?.entity_id ?? null
    : null;
  const fallback = !existingId && input.homeTeamId && input.awayTeamId
    ? await selectRows<EventRecord>("events", {
        select: "id,metadata,provider_event_ids",
        filters: [
          { column: "league_id", value: config.leagueId },
          { column: "scheduled_date", value: input.scheduledDate },
          { column: "home_team_id", value: input.homeTeamId },
          { column: "away_team_id", value: input.awayTeamId },
        ],
        limit: 1,
      })
    : [];
  const eventId = existingId ?? fallback[0]?.id ?? null;

  if (eventId) {
    const existing = fallback[0] ?? (await selectRows<EventRecord>("events", {
      select: "id,metadata,provider_event_ids",
      filters: [{ column: "id", value: eventId }],
      limit: 1,
    }))[0];
    await updateRows("events", [{ column: "id", value: eventId }], {
      season: input.season ?? null,
      start_time: input.startTime,
      status: input.status,
      display_name: input.displayName,
      venue: input.venue ?? null,
      venue_city: input.venueCity ?? null,
      venue_state: input.venueState ?? null,
      provider_event_ids: {
        ...(existing?.provider_event_ids ?? {}),
        ...(input.externalId ? { [input.provider]: input.externalId } : {}),
      },
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      updated_at: new Date().toISOString(),
    }, { returning: "minimal" });
    if (input.externalId) {
      await saveSourceMapping({
        provider: input.provider as never,
        entity_type: "event",
        entity_id: eventId,
        external_id: input.externalId,
        external_key: input.displayName,
        league_id: config.leagueId,
        metadata: {},
      });
    }
    await syncLegacyGame(eventId, input);
    await syncEventParticipants(eventId, config, input.homeTeamId, input.awayTeamId);
    return eventId;
  }

  const inserted = await insertRows<EventRow>("events", [{
    sport_id: config.sportId,
    league_id: config.leagueId,
    event_type: "game",
    season: input.season ?? null,
    scheduled_date: input.scheduledDate,
    start_time: input.startTime,
    status: input.status,
    display_name: input.displayName,
    home_team_id: input.homeTeamId ?? null,
    away_team_id: input.awayTeamId ?? null,
    venue: input.venue ?? null,
    venue_city: input.venueCity ?? null,
    venue_state: input.venueState ?? null,
    provider_event_ids: input.externalId ? { [input.provider]: input.externalId } : {},
    metadata: input.metadata ?? {},
  }]);
  const newId = (inserted[0] as { id?: string } | undefined)?.id;
  if (!newId) throw new Error(`Could not create event ${input.displayName}.`);
  if (input.externalId) {
    await saveSourceMapping({
      provider: input.provider as never,
      entity_type: "event",
      entity_id: newId,
      external_id: input.externalId,
      external_key: input.displayName,
      league_id: config.leagueId,
      metadata: {},
    });
  }
  await syncLegacyGame(newId, input);
  await syncEventParticipants(newId, config, input.homeTeamId, input.awayTeamId);
  return newId;
}

async function syncLegacyGame(eventId: string, input: {
  league: ActiveKnowledgeLeagueCode;
  season?: string | null;
  scheduledDate: string;
  startTime: string;
  status: string;
  homeTeamId?: string | null;
  awayTeamId?: string | null;
  venue?: string | null;
  venueCity?: string | null;
  venueState?: string | null;
  externalId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  if (!input.homeTeamId || !input.awayTeamId) return;
  const config = ACTIVE_LEAGUES[input.league];
  const existing = await selectRows<{ id: string; provider_event_ids?: Record<string, unknown>; metadata?: Record<string, unknown> }>("games", {
    select: "id,provider_event_ids,metadata",
    filters: [{ column: "id", value: eventId }],
    limit: 1,
  });
  if (existing[0]?.id) {
    await updateRows("games", [{ column: "id", value: eventId }], {
      season: input.season ?? null,
      scheduled_date: input.scheduledDate,
      start_time: input.startTime,
      status: input.status,
      home_team_id: input.homeTeamId,
      away_team_id: input.awayTeamId,
      venue: input.venue ?? null,
      venue_city: input.venueCity ?? null,
      venue_state: input.venueState ?? null,
      provider_event_ids: {
        ...(existing[0].provider_event_ids ?? {}),
        ...(input.externalId ? { [config.providerId]: input.externalId } : {}),
      },
      metadata: {
        ...(existing[0].metadata ?? {}),
        ...(input.metadata ?? {}),
        event_id: eventId,
      },
      updated_at: new Date().toISOString(),
    }, { returning: "minimal" });
    return;
  }

  await insertRows("games", [{
    id: eventId,
    sport_id: config.sportId,
    league_id: config.leagueId,
    season: input.season ?? null,
    scheduled_date: input.scheduledDate,
    start_time: input.startTime,
    status: input.status,
    home_team_id: input.homeTeamId,
    away_team_id: input.awayTeamId,
    venue: input.venue ?? null,
    venue_city: input.venueCity ?? null,
    venue_state: input.venueState ?? null,
    provider_event_ids: input.externalId ? { [config.providerId]: input.externalId } : {},
    metadata: {
      ...(input.metadata ?? {}),
      event_id: eventId,
    },
  }], { returning: "minimal" });
}

async function syncEventParticipants(eventId: string, config: LeagueConfig, homeTeamId?: string | null, awayTeamId?: string | null) {
  const rows: Array<Record<string, unknown>> = [];
  if (homeTeamId) {
    const homeParticipantId = await ensureParticipant({
      sport_id: config.sportId,
      league_id: config.leagueId,
      participant_type: "team",
      display_name: "home",
      normalized_name: "home",
      team_id: homeTeamId,
      active: true,
      external_ids: {},
      metadata: { role: "home" },
    });
    if (homeParticipantId) {
      rows.push({
        event_id: eventId,
        participant_id: homeParticipantId,
        participant_type: "team",
        team_id: homeTeamId,
        role: "home",
        display_name: "home",
        sort_order: 1,
        metadata: {},
      });
    }
  }
  if (awayTeamId) {
    const awayParticipantId = await ensureParticipant({
      sport_id: config.sportId,
      league_id: config.leagueId,
      participant_type: "team",
      display_name: "away",
      normalized_name: "away",
      team_id: awayTeamId,
      active: true,
      external_ids: {},
      metadata: { role: "away" },
    });
    if (awayParticipantId) {
      rows.push({
        event_id: eventId,
        participant_id: awayParticipantId,
        participant_type: "team",
        team_id: awayTeamId,
        role: "away",
        display_name: "away",
        sort_order: 2,
        metadata: {},
      });
    }
  }
  if (rows.length) {
    await upsertRows("event_participants", rows, ["event_id", "participant_id", "role"], { returning: "minimal" });
  }
}

export async function replaceRowsForEvent(table: string, eventId: string) {
  await deleteRows(table, [{ column: "event_id", value: eventId }]);
}

export async function findEventByProviderId(provider: string, leagueId: string, externalId: string) {
  const rows = await selectRows<{ entity_id: string }>("source_mappings", {
    select: "entity_id",
    filters: [
      { column: "provider", value: provider },
      { column: "entity_type", value: "event" },
      { column: "league_id", value: leagueId },
      { column: "external_id", value: externalId },
    ],
    limit: 1,
  });
  return rows[0]?.entity_id ?? null;
}

export async function currentEventsForLeague(leagueId: string, statuses: string[] = ["scheduled", "pre", "live", "in_progress"]) {
  return selectRows<EventRecord>("events", {
    select: "*",
    filters: [
      { column: "league_id", value: leagueId },
      { column: "status", operator: "in", value: statuses },
    ],
    orderBy: "start_time.asc",
  });
}

export type LiveRefreshDateRange = {
  dates: string[];
  current: string;
  next?: string;
};

export function getLiveRefreshDateRange(now = new Date()): LiveRefreshDateRange {
  const current = easternDate(now);
  const next = easternDate(addDays(now, 1));
  return { dates: [current, next], current, next };
}

export type RetryAttempt<T> = {
  success: true;
  value: T;
  attempts: number;
  timeouts: number;
} | {
  success: false;
  error: Error;
  attempts: number;
  timeouts: number;
};

export async function withRetryAndTimeout<T>(
  work: () => Promise<T>,
  options: {
    maxAttempts?: number;
    timeoutMs?: number;
    backoffMs?: number;
  } = {},
): Promise<RetryAttempt<T>> {
  const maxAttempts = options.maxAttempts ?? 2;
  const timeoutMs = options.timeoutMs ?? 12000;
  const backoffMs = options.backoffMs ?? 2000;
  let lastError: Error | null = null;
  let timeoutCount = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const promise = work();
        const result = await promise;
        clearTimeout(timeoutHandle);
        return {
          success: true,
          value: result,
          attempts: attempt,
          timeouts: timeoutCount,
        };
      } catch (error) {
        clearTimeout(timeoutHandle);
        throw error;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isTimeout = lastError.name === "AbortError" || lastError.message.includes("abort");
      if (isTimeout) {
        timeoutCount += 1;
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  return {
    success: false,
    error: lastError ?? new Error("Unknown retry error"),
    attempts: maxAttempts,
    timeouts: timeoutCount,
  };
}
