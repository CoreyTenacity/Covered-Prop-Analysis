// The single canonical work set for one pipeline run. Every stage consumes THIS
// - no downstream stage may independently reconstruct "the active props" with a
// different limit, ordering, or window. This replaces the three divergent
// coverage loaders (loadActivePropCoverage in jobs.ts, loadLivePropCoverage in
// mlb.ts + basketball.ts) whose different fixed limits/orders/null handling
// produced the coverage-truncation class of bugs.
//
// Row selection is a PURE function (selectActiveWorkSet) so its behaviour is
// characterized directly in tests, and buildRunManifest only adds the bounded
// Supabase read around it.

import { selectRows } from "@/lib/db/supabase-server";

export type ManifestLeague = "MLB" | "WNBA";

// Exact columns the manifest carries - never select("*"). These are the
// identity + market fields every downstream stage needs to scope its work and
// decide field applicability.
export type ManifestProp = {
  id: string;
  player_id: string | null;
  participant_id: string | null;
  team_id: string | null;
  opponent_team_id: string | null;
  event_id: string | null;
  start_time: string | null;
  market_type: string | null;
  provider_market_type: string | null;
  line: number | null;
  direction: string | null;
  side: string | null;
  player_name: string | null;
  team_name: string | null;
  opponent_name: string | null;
  match_status: string | null;
  match_confidence: number | null;
  updated_at: string | null;
};

export const MANIFEST_PROP_COLUMNS =
  "id,player_id,participant_id,team_id,opponent_team_id,event_id,start_time,market_type,provider_market_type,line,direction,side,player_name,team_name,opponent_name,match_status,match_confidence,updated_at";

// Default live window: matches the effective window both legacy loaders used
// (now-2h .. now+36h). Kept as constants so the manifest is the single source of
// truth for the scoring window.
export const DEFAULT_LOOKBACK_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_LOOKAHEAD_MS = 36 * 60 * 60 * 1000;

// A generous safety bound. The start_time window already bounds the result to a
// slate's worth of props (low hundreds), so this is never expected to be hit;
// if it ever is, `truncated` is set true so truncation can NEVER be silent
// (the exact failure mode of the old asc+limit-400 loader).
export const WORK_SET_SAFETY_LIMIT = 5000;

export const PIPELINE_VERSION = "pipeline-2026.07-A";
export const CONTRACT_VERSION = "contracts-2026.07-A";

export type WorkSetSelection = {
  props: ManifestProp[];
  excludedNullStart: number;
  excludedOutOfWindow: number;
  truncated: boolean;
};

// PURE selection. Given already-fetched active rows, apply the canonical window,
// null-start handling, deterministic ordering, and truncation detection. No I/O.
//
// Decisions (explicit, per the redesign contract):
// - null start_time -> EXCLUDED from the scoreable work set and COUNTED. A
//   null start_time means the prop is not resolved to an event, so it cannot be
//   placed in the window or enriched with event/matchup context; the identity
//   stage will classify it identity_failed. It is never silently dropped.
// - out-of-window (before now-lookback or after now+lookahead) -> EXCLUDED and
//   COUNTED.
// - ordering is deterministic: start_time asc, then id asc as a stable tiebreak.
// - truncation is detected against the safety limit, never silent.
export function selectActiveWorkSet(
  rows: ManifestProp[],
  input: { now: number; lookbackMs?: number; lookaheadMs?: number; safetyLimit?: number },
): WorkSetSelection {
  const lookbackMs = input.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const lookaheadMs = input.lookaheadMs ?? DEFAULT_LOOKAHEAD_MS;
  const safetyLimit = input.safetyLimit ?? WORK_SET_SAFETY_LIMIT;
  const earliest = input.now - lookbackMs;
  const latest = input.now + lookaheadMs;

  let excludedNullStart = 0;
  let excludedOutOfWindow = 0;
  const inWindow: ManifestProp[] = [];
  for (const row of rows) {
    if (!row.start_time) {
      excludedNullStart += 1;
      continue;
    }
    const startMs = new Date(row.start_time).getTime();
    if (!Number.isFinite(startMs)) {
      excludedNullStart += 1;
      continue;
    }
    if (startMs < earliest || startMs > latest) {
      excludedOutOfWindow += 1;
      continue;
    }
    inWindow.push(row);
  }

  inWindow.sort((a, b) => {
    const at = new Date(a.start_time as string).getTime();
    const bt = new Date(b.start_time as string).getTime();
    if (at !== bt) return at - bt;
    return a.id.localeCompare(b.id);
  });

  const truncated = inWindow.length >= safetyLimit;
  return {
    props: truncated ? inWindow.slice(0, safetyLimit) : inWindow,
    excludedNullStart,
    excludedOutOfWindow,
    truncated,
  };
}

export type RunManifest = {
  runId: string;
  league: ManifestLeague;
  builtAt: string;
  now: number;
  window: { lookbackMs: number; lookaheadMs: number; earliestMs: number; latestMs: number };
  props: ManifestProp[];
  propIds: string[];
  eventIds: string[];
  teamIds: string[];
  playerIds: string[];
  meta: {
    scannedRows: number;
    truncated: boolean;
    excludedNullStart: number;
    excludedOutOfWindow: number;
    pipelineVersion: string;
    contractVersion: string;
  };
};

function leagueId(league: ManifestLeague): string {
  return league.toLowerCase();
}

function uniq(values: Array<string | null>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))];
}

export async function buildRunManifest(
  input: {
    league: ManifestLeague;
    now?: number;
    runId?: string;
    lookbackMs?: number;
    lookaheadMs?: number;
  },
  deps: {
    loadActiveRows?: (league: ManifestLeague, earliestIso: string) => Promise<ManifestProp[]>;
  } = {},
): Promise<RunManifest> {
  const now = input.now ?? Date.now();
  const lookbackMs = input.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const lookaheadMs = input.lookaheadMs ?? DEFAULT_LOOKAHEAD_MS;
  const earliestIso = new Date(now - lookbackMs).toISOString();

  const loadActiveRows = deps.loadActiveRows ?? (async (league, earliest) =>
    selectRows<ManifestProp>("current_props", {
      select: MANIFEST_PROP_COLUMNS,
      filters: [
        { column: "league_id", value: leagueId(league) },
        { column: "active", value: true },
        // Bound the read to the window at the query level so a stale-active
        // backlog can never fill the page and truncate current props.
        { column: "start_time", operator: "gte", value: earliest },
      ],
      orderBy: "start_time.asc",
      limit: WORK_SET_SAFETY_LIMIT,
    }).catch(() => [] as ManifestProp[]));

  const rows = await loadActiveRows(input.league, earliestIso);
  const selection = selectActiveWorkSet(rows, { now, lookbackMs, lookaheadMs });

  return {
    runId: input.runId ?? (globalThis.crypto?.randomUUID?.() ?? `run-${now}`),
    league: input.league,
    builtAt: new Date(now).toISOString(),
    now,
    window: { lookbackMs, lookaheadMs, earliestMs: now - lookbackMs, latestMs: now + lookaheadMs },
    props: selection.props,
    propIds: selection.props.map((p) => p.id),
    eventIds: uniq(selection.props.map((p) => p.event_id)),
    teamIds: uniq(selection.props.flatMap((p) => [p.team_id, p.opponent_team_id])),
    playerIds: uniq(selection.props.map((p) => p.player_id)),
    meta: {
      scannedRows: rows.length,
      truncated: selection.truncated,
      excludedNullStart: selection.excludedNullStart,
      excludedOutOfWindow: selection.excludedOutOfWindow,
      pipelineVersion: PIPELINE_VERSION,
      contractVersion: CONTRACT_VERSION,
    },
  };
}
