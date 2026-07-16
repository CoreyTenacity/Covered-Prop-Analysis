import { deleteRows, insertRows, selectRows, updateRows } from "@/lib/db/supabase-server";
import { derivePlayerHeadshotUrl, deriveTeamLogoUrl } from "@/lib/knowledge/media";

type CurrentPropHydration = {
  id: string;
  latest_snapshot_id: string;
  event_id: string | null;
  participant_id: string | null;
  participant_type: string | null;
  player_id: string | null;
  team_id: string | null;
  opponent_team_id: string | null;
  market_instance_key: string | null;
  market_type: string;
  side: string | null;
  line: number;
  sportsbook_id: string | null;
  over_price: number | null;
  under_price: number | null;
  league_id: string;
  sport_id: string;
};

type ScoredPropHydration = {
  id: string;
  current_prop_id: string;
  covered_score: number | null;
  confidence_score: number | null;
  data_quality_score: number | null;
  created_at: string;
};

type ScoreExplanationHydration = {
  scored_prop_id: string;
  score_label: string | null;
  confidence_label: string | null;
  risk_label: string | null;
  summary: string | null;
};

type ParticipantHydration = {
  id: string;
  display_name: string;
  image_url: string | null;
  external_ids: Record<string, unknown> | null;
};

type PlayerHydration = {
  id: string;
  display_name: string | null;
  canonical_name: string;
  headshot_url: string | null;
  external_ids: Record<string, unknown> | null;
};

type TeamHydration = {
  id: string;
  name: string;
  abbreviation: string | null;
  logo_url: string | null;
  external_ids: Record<string, unknown> | null;
};

type EventHydration = {
  id: string;
  display_name: string | null;
  start_time: string | null;
};

type SportsbookHydration = {
  id: string;
  code: string;
  display_name: string;
};

type UserPickBase = {
  id: string;
  user_id: string;
  scored_prop_id: string | null;
  current_prop_id: string | null;
  odds_snapshot_id: string | null;
  event_id: string | null;
  participant_id: string | null;
  market_instance_key: string | null;
  market_type: string | null;
  side: string | null;
  line: number | null;
  odds_taken: number | null;
  sportsbook_id: string | null;
  stake_units: number | null;
  notes?: string | null;
  status: string;
  result: string;
  profit_units: number | null;
  placed_at: string | null;
  settled_at: string | null;
  created_at: string;
  updated_at: string;
};

type UserParlayBase = {
  id: string;
  user_id: string;
  status: string;
  total_legs: number;
  stake_units: number | null;
  notes?: string | null;
  combined_odds: number | null;
  result: string;
  profit_units: number | null;
  created_at: string;
  settled_at: string | null;
  updated_at: string;
};

type UserParlayLegBase = {
  id: string;
  user_parlay_id: string;
  user_pick_id: string | null;
  scored_prop_id: string | null;
  current_prop_id: string | null;
  odds_snapshot_id: string | null;
  event_id: string | null;
  participant_id: string | null;
  market_instance_key: string | null;
  market_type: string | null;
  side: string | null;
  line: number | null;
  odds_taken: number | null;
  sportsbook_id: string | null;
  leg_result: string | null;
  created_at: string;
};

export type HydratedUserPick = UserPickBase & {
  duplicate?: boolean;
  participant_display_name: string | null;
  participant_image_url: string | null;
  player_headshot_url: string | null;
  team_display_name: string | null;
  team_logo_url: string | null;
  opponent_display_name: string | null;
  opponent_logo_url: string | null;
  event_display_name: string | null;
  start_time: string | null;
  sport: string | null;
  league: string | null;
  sportsbook: { id: string; code: string; display_name: string } | null;
  covered_score: number | null;
  confidence_score: number | null;
  data_quality_score: number | null;
  score_label: string | null;
  confidence_label: string | null;
  risk_label: string | null;
  summary: string | null;
};

export type HydratedUserParlayLeg = UserParlayLegBase & {
  participant_display_name: string | null;
  participant_image_url: string | null;
  player_headshot_url: string | null;
  team_display_name: string | null;
  team_logo_url: string | null;
  opponent_display_name: string | null;
  opponent_logo_url: string | null;
  event_display_name: string | null;
  start_time: string | null;
  sport: string | null;
  league: string | null;
  sportsbook: { id: string; code: string; display_name: string } | null;
  covered_score: number | null;
  confidence_score: number | null;
  data_quality_score: number | null;
  score_label: string | null;
  confidence_label: string | null;
  risk_label: string | null;
  summary: string | null;
};

export type HydratedUserParlay = UserParlayBase & {
  legs: HydratedUserParlayLeg[];
};

export class UserTrackingError extends Error {
  status: number;
  code: string;
  payload?: unknown;

  constructor(code: string, message: string, status = 400, payload?: unknown) {
    super(message);
    this.name = "UserTrackingError";
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
}

function parseIdList(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

async function loadMap<T extends { id: string }>(table: string, ids: string[], select: string) {
  if (!ids.length) return new Map<string, T>();
  const rows = await selectRows<T>(table, {
    select,
    filters: [{ column: "id", operator: "in", value: ids }],
    limit: Math.min(ids.length, 1000),
  });
  return new Map(rows.map((row) => [row.id, row]));
}

async function latestScoredByCurrent(currentPropIds: string[]) {
  if (!currentPropIds.length) return new Map<string, ScoredPropHydration>();
  const rows = await selectRows<ScoredPropHydration>("scored_props", {
    select: "id,current_prop_id,covered_score,confidence_score,data_quality_score,created_at",
    filters: [{ column: "current_prop_id", operator: "in", value: currentPropIds }],
    orderBy: "created_at.desc",
    limit: Math.min(currentPropIds.length * 6, 2000),
  });
  const map = new Map<string, ScoredPropHydration>();
  for (const row of rows) {
    if (!map.has(row.current_prop_id)) map.set(row.current_prop_id, row);
  }
  return map;
}

async function explanationsByScored(scoredPropIds: string[]) {
  if (!scoredPropIds.length) return new Map<string, ScoreExplanationHydration>();
  const rows = await selectRows<ScoreExplanationHydration>("score_explanations", {
    select: "scored_prop_id,score_label,confidence_label,risk_label,summary",
    filters: [{ column: "scored_prop_id", operator: "in", value: scoredPropIds }],
    limit: Math.min(scoredPropIds.length, 1000),
  });
  return new Map(rows.map((row) => [row.scored_prop_id, row]));
}

function resolveSideOdds(side: string | null | undefined, current: CurrentPropHydration | null | undefined) {
  const normalizedSide = (side ?? current?.side ?? "").toLowerCase();
  if (!current) return null;
  if (normalizedSide === "more" || normalizedSide === "over") return current.over_price ?? current.under_price ?? null;
  if (normalizedSide === "less" || normalizedSide === "under") return current.under_price ?? current.over_price ?? null;
  return current.over_price ?? current.under_price ?? null;
}

async function buildCurrentPropContext(currentPropIds: string[]) {
  const currentRows = currentPropIds.length
    ? await selectRows<CurrentPropHydration>("current_props", {
      select: "id,latest_snapshot_id,event_id,participant_id,participant_type,player_id,team_id,opponent_team_id,market_instance_key,market_type,side,line,sportsbook_id,over_price,under_price,league_id,sport_id",
      filters: [{ column: "id", operator: "in", value: currentPropIds }],
      limit: Math.min(currentPropIds.length, 1000),
    })
    : [];

  const currentById = new Map(currentRows.map((row) => [row.id, row]));
  const latestScored = await latestScoredByCurrent(currentRows.map((row) => row.id));
  const scoredById = new Map([...latestScored.values()].map((row) => [row.id, row]));
  const explanationMap = await explanationsByScored([...scoredById.keys()]);

  const participantIds = parseIdList(currentRows.map((row) => row.participant_id));
  const playerIds = parseIdList(currentRows.map((row) => row.player_id));
  const teamIds = parseIdList(currentRows.flatMap((row) => [row.team_id, row.opponent_team_id]));
  const eventIds = parseIdList(currentRows.map((row) => row.event_id));
  const sportsbookIds = parseIdList(currentRows.map((row) => row.sportsbook_id));

  const [participants, players, teams, events, sportsbooks] = await Promise.all([
    loadMap<ParticipantHydration>("participants", participantIds, "id,display_name,image_url,external_ids"),
    loadMap<PlayerHydration>("players", playerIds, "id,display_name,canonical_name,headshot_url,external_ids"),
    loadMap<TeamHydration>("teams", teamIds, "id,name,abbreviation,logo_url,external_ids"),
    loadMap<EventHydration>("events", eventIds, "id,display_name,start_time"),
    loadMap<SportsbookHydration>("sportsbooks", sportsbookIds, "id,code,display_name"),
  ]);

  return {
    currentById,
    latestScoredByCurrent: latestScored,
    scoredById,
    explanationMap,
    participants,
    players,
    teams,
    events,
    sportsbooks,
  };
}

function hydratePickLike(input: {
  row: UserPickBase | UserParlayLegBase;
  current: CurrentPropHydration | null;
  scored: ScoredPropHydration | null;
  explanation: ScoreExplanationHydration | null;
  participant: ParticipantHydration | null;
  player: PlayerHydration | null;
  team: TeamHydration | null;
  opponent: TeamHydration | null;
  event: EventHydration | null;
  sportsbook: SportsbookHydration | null;
}) {
  const leagueId = (input.current?.league_id ?? null) as "MLB" | "NBA" | "WNBA" | null;
  const participantDisplayName = input.participant?.display_name ?? input.player?.display_name ?? input.player?.canonical_name ?? null;
  const participantImageUrl = leagueId
    ? derivePlayerHeadshotUrl({
      leagueId,
      participantImageUrl: input.participant?.image_url ?? null,
      storedHeadshotUrl: input.player?.headshot_url ?? null,
      externalIds: input.player?.external_ids ?? input.participant?.external_ids ?? null,
    })
    : (input.participant?.image_url ?? input.player?.headshot_url ?? null);
  const teamLogoUrl = leagueId
    ? deriveTeamLogoUrl({
      leagueId,
      storedLogoUrl: input.team?.logo_url ?? null,
      externalIds: input.team?.external_ids ?? null,
      abbreviation: input.team?.abbreviation ?? null,
    })
    : (input.team?.logo_url ?? null);
  const opponentLogoUrl = leagueId
    ? deriveTeamLogoUrl({
      leagueId,
      storedLogoUrl: input.opponent?.logo_url ?? null,
      externalIds: input.opponent?.external_ids ?? null,
      abbreviation: input.opponent?.abbreviation ?? null,
    })
    : (input.opponent?.logo_url ?? null);

  return {
    participant_display_name: participantDisplayName,
    participant_image_url: participantImageUrl,
    player_headshot_url: input.player?.headshot_url ?? participantImageUrl,
    team_display_name: input.team?.name ?? null,
    team_logo_url: teamLogoUrl,
    opponent_display_name: input.opponent?.name ?? null,
    opponent_logo_url: opponentLogoUrl,
    event_display_name: input.event?.display_name ?? null,
    start_time: input.event?.start_time ?? null,
    sport: input.current?.sport_id ?? null,
    league: input.current?.league_id ?? null,
    sportsbook: input.sportsbook ? {
      id: input.sportsbook.id,
      code: input.sportsbook.code,
      display_name: input.sportsbook.display_name,
    } : null,
    covered_score: input.scored?.covered_score ?? null,
    confidence_score: input.scored?.confidence_score ?? null,
    data_quality_score: input.scored?.data_quality_score ?? null,
    score_label: input.explanation?.score_label ?? null,
    confidence_label: input.explanation?.confidence_label ?? null,
    risk_label: input.explanation?.risk_label ?? null,
    summary: input.explanation?.summary ?? null,
  };
}

export async function listUserPicks(userId: string): Promise<HydratedUserPick[]> {
  const picks = await selectRows<UserPickBase>("user_picks", {
    select: "*",
    filters: [{ column: "user_id", value: userId }],
    orderBy: "created_at.desc",
    limit: 200,
  });

  const currentPropIds = parseIdList(picks.map((pick) => pick.current_prop_id));
  const context = await buildCurrentPropContext(currentPropIds);

  return picks.map((pick) => {
    const current = pick.current_prop_id ? context.currentById.get(pick.current_prop_id) ?? null : null;
    const scored = current ? context.latestScoredByCurrent.get(current.id) ?? null : null;
    const explanation = scored ? context.explanationMap.get(scored.id) ?? null : null;
    const participant = current?.participant_id ? context.participants.get(current.participant_id) ?? null : null;
    const player = current?.player_id ? context.players.get(current.player_id) ?? null : null;
    const team = current?.team_id ? context.teams.get(current.team_id) ?? null : null;
    const opponent = current?.opponent_team_id ? context.teams.get(current.opponent_team_id) ?? null : null;
    const event = current?.event_id ? context.events.get(current.event_id) ?? null : null;
    const sportsbook = current?.sportsbook_id ? context.sportsbooks.get(current.sportsbook_id) ?? null : null;

    return {
      ...pick,
      ...hydratePickLike({ row: pick, current, scored, explanation, participant, player, team, opponent, event, sportsbook }),
    };
  });
}

export async function listUserParlays(userId: string): Promise<HydratedUserParlay[]> {
  const parlays = await selectRows<UserParlayBase>("user_parlays", {
    select: "*",
    filters: [{ column: "user_id", value: userId }],
    orderBy: "created_at.desc",
    limit: 100,
  });

  const parlayIds = parlays.map((parlay) => parlay.id);
  const legs = parlayIds.length ? await selectRows<UserParlayLegBase>("user_parlay_legs", {
    select: "*",
    filters: [{ column: "user_parlay_id", operator: "in", value: parlayIds }],
    orderBy: "created_at.asc",
    limit: Math.min(parlayIds.length * 10, 1000),
  }) : [];

  const currentPropIds = parseIdList(legs.map((leg) => leg.current_prop_id));
  const context = await buildCurrentPropContext(currentPropIds);

  const legsByParlay = new Map<string, HydratedUserParlayLeg[]>();
  for (const leg of legs) {
    const current = leg.current_prop_id ? context.currentById.get(leg.current_prop_id) ?? null : null;
    const scored = current ? context.latestScoredByCurrent.get(current.id) ?? null : null;
    const explanation = scored ? context.explanationMap.get(scored.id) ?? null : null;
    const participant = current?.participant_id ? context.participants.get(current.participant_id) ?? null : null;
    const player = current?.player_id ? context.players.get(current.player_id) ?? null : null;
    const team = current?.team_id ? context.teams.get(current.team_id) ?? null : null;
    const opponent = current?.opponent_team_id ? context.teams.get(current.opponent_team_id) ?? null : null;
    const event = current?.event_id ? context.events.get(current.event_id) ?? null : null;
    const sportsbook = current?.sportsbook_id ? context.sportsbooks.get(current.sportsbook_id) ?? null : null;

    const hydrated: HydratedUserParlayLeg = {
      ...leg,
      ...hydratePickLike({ row: leg, current, scored, explanation, participant, player, team, opponent, event, sportsbook }),
    };

    const bucket = legsByParlay.get(leg.user_parlay_id) ?? [];
    bucket.push(hydrated);
    legsByParlay.set(leg.user_parlay_id, bucket);
  }

  return parlays.map((parlay) => ({
    ...parlay,
    legs: legsByParlay.get(parlay.id) ?? [],
  }));
}

export async function saveUserPick(input: {
  userId: string;
  currentPropId?: string | null;
  scoredPropId?: string | null;
  oddsSnapshotId?: string | null;
  eventId?: string | null;
  participantId?: string | null;
  marketInstanceKey?: string | null;
  marketType?: string | null;
  side?: string | null;
  line?: number | null;
  oddsTaken?: number | null;
  sportsbookId?: string | null;
  stakeUnits?: number | null;
  status?: string | null;
  placedAt?: string | null;
}) {
  let hydratedCurrent: CurrentPropHydration | null = null;
  let hydratedScored: ScoredPropHydration | null = null;

  if (!input.currentPropId && !(input.marketInstanceKey && input.marketType && input.side && input.line !== null && input.line !== undefined)) {
    throw new UserTrackingError("missing_pick_identity", "Covered needs a resolved prop before it can save this pick.", 400);
  }

  if (input.currentPropId) {
    const currentRows = await selectRows<CurrentPropHydration>("current_props", {
      select: "id,latest_snapshot_id,event_id,participant_id,participant_type,player_id,team_id,opponent_team_id,market_instance_key,market_type,side,line,sportsbook_id,over_price,under_price,league_id,sport_id",
      filters: [{ column: "id", value: input.currentPropId }],
      limit: 1,
    });
    hydratedCurrent = currentRows[0] ?? null;
  }

  if (!input.scoredPropId && input.currentPropId) {
    const scoredRows = await selectRows<ScoredPropHydration>("scored_props", {
      select: "id,current_prop_id,covered_score,confidence_score,data_quality_score,created_at",
      filters: [{ column: "current_prop_id", value: input.currentPropId }],
      orderBy: "created_at.desc",
      limit: 1,
    });
    hydratedScored = scoredRows[0] ?? null;
  }

  const duplicateRows = input.currentPropId
    ? await selectRows<UserPickBase>("user_picks", {
      select: "*",
      filters: [
        { column: "user_id", value: input.userId },
        { column: "current_prop_id", value: input.currentPropId },
      ],
      orderBy: "created_at.desc",
      limit: 1,
    })
    : await selectRows<UserPickBase>("user_picks", {
      select: "*",
      filters: [
        { column: "user_id", value: input.userId },
        ...(input.marketInstanceKey ? [{ column: "market_instance_key", value: input.marketInstanceKey }] : []),
        ...(input.side ? [{ column: "side", value: input.side }] : []),
        ...(typeof input.line === "number" ? [{ column: "line", value: input.line }] : []),
      ],
      orderBy: "created_at.desc",
      limit: 1,
    });

  if (duplicateRows[0]) {
    const existing = (await listUserPicks(input.userId)).find((row) => row.id === duplicateRows[0].id) ?? null;
    throw new UserTrackingError("duplicate_pick", "You already saved this pick.", 409, existing);
  }

  const oddsTaken = input.oddsTaken ?? resolveSideOdds(input.side, hydratedCurrent);

  const rows = await insertRows<{
    id?: string;
    user_id: string;
    scored_prop_id: string | null;
    current_prop_id: string | null;
    odds_snapshot_id: string | null;
    event_id: string | null;
    participant_id: string | null;
    market_instance_key: string | null;
    market_type: string | null;
    side: string | null;
    line: number | null;
    odds_taken: number | null;
    sportsbook_id: string | null;
    stake_units: number | null;
    notes: string | null;
    status: string;
    placed_at: string;
  }>("user_picks", [{
    user_id: input.userId,
    scored_prop_id: input.scoredPropId ?? hydratedScored?.id ?? null,
    current_prop_id: input.currentPropId ?? hydratedCurrent?.id ?? null,
    odds_snapshot_id: input.oddsSnapshotId ?? hydratedCurrent?.latest_snapshot_id ?? null,
    event_id: input.eventId ?? hydratedCurrent?.event_id ?? null,
    participant_id: input.participantId ?? hydratedCurrent?.participant_id ?? null,
    market_instance_key: input.marketInstanceKey ?? hydratedCurrent?.market_instance_key ?? null,
    market_type: input.marketType ?? hydratedCurrent?.market_type ?? null,
    side: input.side ?? hydratedCurrent?.side ?? null,
    line: input.line ?? hydratedCurrent?.line ?? null,
    odds_taken: oddsTaken,
    sportsbook_id: input.sportsbookId ?? hydratedCurrent?.sportsbook_id ?? null,
    stake_units: input.stakeUnits ?? 1,
    notes: null,
    status: input.status ?? "open",
    placed_at: input.placedAt ?? new Date().toISOString(),
  }]);

  const row = rows[0] ?? null;
  if (!row?.id) return null;
  return (await listUserPicks(input.userId)).find((pick) => pick.id === row.id) ?? null;
}

export async function saveUserParlay(input: {
  userId: string;
  stakeUnits?: number | null;
  combinedOdds?: number | null;
  status?: string | null;
  legs: Array<{
    userPickId?: string | null;
    scoredPropId?: string | null;
    currentPropId?: string | null;
    oddsSnapshotId?: string | null;
    eventId?: string | null;
    participantId?: string | null;
    marketInstanceKey?: string | null;
    marketType?: string | null;
    side?: string | null;
    line?: number | null;
    oddsTaken?: number | null;
    sportsbookId?: string | null;
  }>;
}) {
  if (!input.legs.length) {
    throw new UserTrackingError("empty_parlay", "Covered needs at least two resolved legs before it can save a parlay.", 400);
  }
  if (input.legs.length < 2) {
    throw new UserTrackingError("single_leg_parlay", "A parlay needs at least two resolved legs. Save this as a single pick instead.", 400);
  }

  const parlays = await insertRows<{
    id?: string;
    user_id: string;
    status: string;
    total_legs: number;
    stake_units: number | null;
    notes: string | null;
    combined_odds: number | null;
  }>("user_parlays", [{
    user_id: input.userId,
    status: input.status ?? "open",
    total_legs: input.legs.length,
    stake_units: input.stakeUnits ?? 1,
    notes: null,
    combined_odds: input.combinedOdds ?? null,
  }]);

  const parlay = parlays[0];
  if (!parlay?.id) return null;

  if (input.legs.length) {
    const currentPropIds = parseIdList(input.legs.map((leg) => leg.currentPropId));
    const currentRows = currentPropIds.length ? await selectRows<CurrentPropHydration>("current_props", {
      select: "id,latest_snapshot_id,event_id,participant_id,participant_type,player_id,team_id,opponent_team_id,market_instance_key,market_type,side,line,sportsbook_id,over_price,under_price,league_id,sport_id",
      filters: [{ column: "id", operator: "in", value: currentPropIds }],
      limit: currentPropIds.length,
    }) : [];
    const currentById = new Map(currentRows.map((row) => [row.id, row]));

    await insertRows("user_parlay_legs", input.legs.map((leg) => {
      const current = leg.currentPropId ? currentById.get(leg.currentPropId) ?? null : null;
      return {
        user_parlay_id: parlay.id,
        user_pick_id: leg.userPickId ?? null,
        scored_prop_id: leg.scoredPropId ?? null,
        current_prop_id: leg.currentPropId ?? null,
        odds_snapshot_id: leg.oddsSnapshotId ?? current?.latest_snapshot_id ?? null,
        event_id: leg.eventId ?? current?.event_id ?? null,
        participant_id: leg.participantId ?? current?.participant_id ?? null,
        market_instance_key: leg.marketInstanceKey ?? current?.market_instance_key ?? null,
        market_type: leg.marketType ?? current?.market_type ?? null,
        side: leg.side ?? current?.side ?? null,
        line: leg.line ?? current?.line ?? null,
        odds_taken: leg.oddsTaken ?? resolveSideOdds(leg.side, current),
        sportsbook_id: leg.sportsbookId ?? current?.sportsbook_id ?? null,
      };
    }), { returning: "minimal" });
  }

  return (await listUserParlays(input.userId)).find((saved) => saved.id === parlay.id) ?? null;
}

export async function deleteUserPick(userId: string, pickId: string) {
  const rows = await selectRows<UserPickBase>("user_picks", {
    select: "id,user_id,current_prop_id",
    filters: [
      { column: "id", value: pickId },
      { column: "user_id", value: userId },
    ],
    limit: 1,
  });

  const row = rows[0] ?? null;
  if (!row) {
    throw new UserTrackingError("pick_not_found", "That saved pick could not be found.", 404);
  }

  await deleteRows("user_picks", [
    { column: "id", value: pickId },
    { column: "user_id", value: userId },
  ]);

  return { id: pickId, currentPropId: row.current_prop_id ?? null };
}

export async function deleteUserParlay(userId: string, parlayId: string) {
  const rows = await selectRows<UserParlayBase>("user_parlays", {
    select: "id,user_id",
    filters: [
      { column: "id", value: parlayId },
      { column: "user_id", value: userId },
    ],
    limit: 1,
  });

  if (!rows[0]) {
    throw new UserTrackingError("parlay_not_found", "That saved parlay could not be found.", 404);
  }

  await deleteRows("user_parlays", [
    { column: "id", value: parlayId },
    { column: "user_id", value: userId },
  ]);

  return { id: parlayId };
}

function normalizeTrackingNotes(value: string | null | undefined) {
  const trimmed = (value ?? "").trim();
  return trimmed.length ? trimmed.slice(0, 2000) : null;
}

function validateStakeUnits(value: number | null | undefined) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new UserTrackingError("invalid_stake_units", "Stake units must be a non-negative number.", 400);
  }
  return value;
}

export async function updateUserPickTracking(input: {
  userId: string;
  pickId: string;
  stakeUnits?: number | null;
  notes?: string | null;
}) {
  const existingRows = await selectRows<UserPickBase>("user_picks", {
    select: "*",
    filters: [
      { column: "id", value: input.pickId },
      { column: "user_id", value: input.userId },
    ],
    limit: 1,
  });

  if (!existingRows[0]) {
    throw new UserTrackingError("pick_not_found", "That saved pick could not be found.", 404);
  }

  const patch: Record<string, unknown> = {};
  if (input.stakeUnits !== undefined) patch.stake_units = validateStakeUnits(input.stakeUnits);
  if (input.notes !== undefined) patch.notes = normalizeTrackingNotes(input.notes);

  if (!Object.keys(patch).length) {
    throw new UserTrackingError("no_tracking_changes", "No tracking changes were provided.", 400);
  }

  await updateRows("user_picks", [
    { column: "id", value: input.pickId },
    { column: "user_id", value: input.userId },
  ], patch, { returning: "minimal" });

  return (await listUserPicks(input.userId)).find((pick) => pick.id === input.pickId) ?? null;
}

export async function updateUserParlayTracking(input: {
  userId: string;
  parlayId: string;
  stakeUnits?: number | null;
  notes?: string | null;
}) {
  const existingRows = await selectRows<UserParlayBase>("user_parlays", {
    select: "*",
    filters: [
      { column: "id", value: input.parlayId },
      { column: "user_id", value: input.userId },
    ],
    limit: 1,
  });

  if (!existingRows[0]) {
    throw new UserTrackingError("parlay_not_found", "That saved parlay could not be found.", 404);
  }

  const patch: Record<string, unknown> = {};
  if (input.stakeUnits !== undefined) patch.stake_units = validateStakeUnits(input.stakeUnits);
  if (input.notes !== undefined) patch.notes = normalizeTrackingNotes(input.notes);

  if (!Object.keys(patch).length) {
    throw new UserTrackingError("no_tracking_changes", "No tracking changes were provided.", 400);
  }

  await updateRows("user_parlays", [
    { column: "id", value: input.parlayId },
    { column: "user_id", value: input.userId },
  ], patch, { returning: "minimal" });

  return (await listUserParlays(input.userId)).find((parlay) => parlay.id === input.parlayId) ?? null;
}
