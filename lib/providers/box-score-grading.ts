import type { Sport } from "../types/index.ts";
import { getProviderCache } from "../db/provider-cache.ts";
import type { HighlightlyPlayerStatsPayload, HighlightlyPlayersPayload } from "./highlightly-mlb.ts";
import { MlbStatsApiAdapter } from "./mlb-stats-api.ts";
import { NbaComStatsAdapter } from "./nba-com-stats.ts";
import { StatcastSavantAdapter } from "./statcast-savant.ts";

export type BoxScoreResolution = {
  status: "resolved" | "pending" | "unsupported";
  actualValue: number | null;
  source: string;
  note: string;
};

const comboSplit = /(?:\+|\/| and |,)/i;

const statAliases: Record<string, string[]> = {
  points: ["points", "pts", "point", "scoring"],
  rebounds: ["rebounds", "rebound", "boards", "rebs"],
  assists: ["assists", "assist", "ast"],
  steals: ["steals", "steal", "stl"],
  blocks: ["blocks", "block", "blk"],
  hits: ["hits", "hit"],
  singles: ["singles", "single", "1b"],
  "runs": ["runs", "run"],
  "runs batted in": ["runs batted in", "rbi", "rbis", "rib"],
  "home runs": ["home runs", "hr", "hrs"],
  "doubles": ["doubles", "2b"],
  "triples": ["triples", "3b"],
  "total bases": ["total bases", "tb"],
  "walks": ["walks", "bb"],
  "hit by pitch": ["hit by pitch", "hbp"],
  "stolen bases": ["stolen bases", "sb", "steals"],
  "outs recorded": ["outs recorded", "outs", "outs pitched"],
  "earned runs": ["earned runs", "er"],
  "hits allowed": ["hits allowed", "hits against", "ha"],
  "walks allowed": ["walks allowed", "walks against", "bb allowed"],
  strikeouts: ["strikeouts", "strikeout", "ks", "k"],
  "fantasy score": ["fantasy score", "fantasy", "fpts", "fp"],
  "field goals made": ["field goals made", "fgm", "field goals"],
  "field goals attempted": ["field goals attempted", "fga"],
  "3-pointers made": ["3-pointers made", "three pointers made", "3pm", "threes"],
  "3-pointers attempted": ["3-pointers attempted", "three pointers attempted", "3pa"],
  "free throws made": ["free throws made", "ftm"],
  "free throws attempted": ["free throws attempted", "fta"],
  "minutes": ["minutes", "min"],
  "turnovers": ["turnovers", "tov"],
  "steals + blocks": ["steals + blocks", "stocks"],
};

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9+,\/ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function statComponents(statType: string) {
  const parts = normalize(statType).split(comboSplit).map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [normalize(statType)];
}

function stripStatPrefixes(value: string) {
  return normalize(value).replace(/^(player|batter|pitcher|team|opponent)\s+/, "").trim();
}

function aliasesFor(statType: string) {
  const stat = stripStatPrefixes(statType);
  const direct = statAliases[stat] ?? statAliases[stripStatPrefixes(stat.replace(/\s+/g, " "))] ?? [];
  const fallback = stat.split(" ").filter(Boolean);
  return [...direct, ...fallback, stat, stripStatPrefixes(statType)].map((value) => normalize(value)).filter(Boolean);
}

function isPlayerMatch(value: unknown, playerName: string) {
  return typeof value === "string" && normalize(value).includes(normalize(playerName));
}

type Candidate = { value: number; confidence: number };

function pushCandidate(target: Candidate[], value: unknown, confidence: number) {
  if (typeof value === "number" && Number.isFinite(value)) target.push({ value, confidence });
}

function inspectNode(node: unknown, aliases: string[], playerName: string, candidates: Candidate[], depth = 0) {
  if (!node || depth > 5) return;
  if (Array.isArray(node)) {
    node.forEach((value) => inspectNode(value, aliases, playerName, candidates, depth + 1));
    return;
  }
  if (typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const keys = Object.keys(record).map((key) => normalize(key));
  const playerHit = Object.values(record).some((value) => isPlayerMatch(value, playerName));
  const keyHit = aliases.some((alias) => keys.some((key) => key.includes(alias)));
  const scope = playerHit ? 2 : keyHit ? 1 : 0;

  for (const [key, value] of Object.entries(record)) {
    const normalizedKey = normalize(key);
    const keyMatches = aliases.some((alias) => normalizedKey.includes(alias));
    if (keyMatches) {
      if (typeof value === "number") pushCandidate(candidates, value, 6 + scope);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const nested = value as Record<string, unknown>;
        pushCandidate(candidates, nested.value ?? nested.actual ?? nested.statValue ?? nested.total ?? nested.points ?? nested.rebounds ?? nested.assists, 6 + scope);
      }
    }

    if ((key === "value" || key === "actual" || key === "statValue" || key === "points" || key === "rebounds" || key === "assists" || key === "hits" || key === "strikeouts" || key === "totals" || key === "total") && typeof value === "number") {
      candidates.push({ value, confidence: 2 + scope });
    }

    if ((key === "name" || key === "stat" || key === "label" || key === "type") && typeof value === "string" && aliases.some((alias) => normalize(value).includes(alias))) {
      const numeric = record.value ?? record.actual ?? record.statValue;
      pushCandidate(candidates, numeric, 4 + scope);
    }

    inspectNode(value, aliases, playerName, candidates, depth + 1);
  }
}

function chooseBestCandidate(candidates: Candidate[]) {
  return [...candidates].sort((a, b) => b.confidence - a.confidence || b.value - a.value)[0]?.value ?? null;
}

function valueFromKnownColumns(row: Record<string, unknown>, statType: string) {
  const stat = stripStatPrefixes(statType);
  const rows = row as Record<string, unknown>;
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const textToNumber = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const column = (...keys: string[]) => {
    for (const key of keys) {
      const value = rows[key];
      const parsed = textToNumber(value);
      if (parsed !== null) return parsed;
    }
    return null;
  };

  if (/(points|pts)/.test(stat) && !/(rebounds|assists|threes|field goals|free throws|turnovers|steals|blocks)/.test(stat)) return column("PTS", "points", "PTS_PG");
  if (/(rebounds|rebs|boards)/.test(stat)) return column("REB", "rebounds", "TOTAL_REB");
  if (/(assists|ast)/.test(stat)) return column("AST", "assists");
  if (/(steals|stl)/.test(stat) && !/blocks/.test(stat)) return column("STL", "steals");
  if (/(blocks|blk)/.test(stat)) return column("BLK", "blocks");
  if (/(turnovers|tov)/.test(stat)) return column("TOV", "turnovers");
  if (/(minutes|min)/.test(stat)) return column("MIN", "minutes");
  if (/(field goals made|fgm)/.test(stat)) return column("FGM", "fieldGoalsMade");
  if (/(field goals attempted|fga)/.test(stat)) return column("FGA", "fieldGoalsAttempted");
  if (/(3-pointers made|three pointers made|threes|3pm)/.test(stat)) return column("FG3M", "FG3M", "threePointersMade");
  if (/(3-pointers attempted|three pointers attempted|3pa)/.test(stat)) return column("FG3A", "FG3A", "threePointersAttempted");
  if (/(free throws made|ftm)/.test(stat)) return column("FTM", "freeThrowsMade");
  if (/(free throws attempted|fta)/.test(stat)) return column("FTA", "freeThrowsAttempted");
  if (/(double double|triple double|fantasy)/.test(stat)) return null;
  return null;
}

function rowTimestamp(row: Record<string, unknown>) {
  const game = row.game as Record<string, unknown> | undefined;
  const raw = String(
    row.date ??
    row.gameDate ??
    row.GAME_DATE ??
    row.GAME_DATE_EST ??
    game?.gameDate ??
    game?.officialDate ??
    game?.date ??
    "",
  );
  const timestamp = new Date(raw).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function extractRows(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload.flatMap((value) => extractRows(value));
  }
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.resultSets)) {
    const rows: Array<Record<string, unknown>> = [];
    for (const resultSet of record.resultSets as Array<Record<string, unknown>>) {
      if (Array.isArray(resultSet.rowSet) && Array.isArray(resultSet.headers)) {
        for (const row of resultSet.rowSet as unknown[][]) {
          rows.push(Object.fromEntries((resultSet.headers as string[]).map((header, index) => [header, row[index]])));
        }
      }
    }
    if (rows.length) return rows;
  }
  if (Array.isArray(record.rowSet) && Array.isArray(record.headers)) {
    return (record.rowSet as unknown[][]).map((row) => Object.fromEntries((record.headers as string[]).map((header, index) => [header, row[index]])));
  }
  const stats = Array.isArray(record.stats) ? (record.stats as Array<Record<string, unknown>>) : [];
  const rows: Array<Record<string, unknown>> = [];
  for (const stat of stats) {
    const splits = Array.isArray(stat.splits) ? (stat.splits as Array<Record<string, unknown>>) : [];
    for (const split of splits) rows.push(split);
  }
  if (rows.length) return rows;
  const splits = Array.isArray(record.splits) ? (record.splits as Array<Record<string, unknown>>) : [];
  return splits;
}

export function resolveActualValueFromPayload(payload: unknown, statType: string, playerName: string) {
  const aliases = aliasesFor(statType);
  const candidates: Candidate[] = [];
  inspectNode(payload, aliases, playerName, candidates);

  if (!candidates.length && normalize(statType).includes("fantasy")) {
    inspectNode(payload, aliasesFor("fantasy score"), playerName, candidates);
  }

  if (!candidates.length && payload && typeof payload === "object" && !Array.isArray(payload)) {
    const direct = valueFromKnownColumns(payload as Record<string, unknown>, statType);
    if (typeof direct === "number") return direct;
  }

  const components = statComponents(statType);
  if (components.length > 1) {
    const componentValues = components.map((component) => {
      const componentCandidates: Candidate[] = [];
      inspectNode(payload, aliasesFor(component), playerName, componentCandidates);
      if (componentCandidates.length) return chooseBestCandidate(componentCandidates);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) return valueFromKnownColumns(payload as Record<string, unknown>, component);
      return null;
    });
    if (componentValues.every((value) => typeof value === "number")) {
      return componentValues.reduce((sum, value) => sum + (value as number), 0);
    }
  }

  if (!candidates.length) return null;
  return chooseBestCandidate(candidates);
}

export function extractRecentValuesFromPayload(payload: unknown, statType: string, playerName: string, limit = 5) {
  const rows = extractRows(payload)
    .map((row) => ({ row, timestamp: rowTimestamp(row) }))
    .sort((a, b) => b.timestamp - a.timestamp)
    .map(({ row }) => row);

  const recentValues: number[] = [];
  for (const row of rows) {
    const value = resolveActualValueFromPayload(row, statType, playerName);
    if (typeof value === "number" && Number.isFinite(value)) {
      recentValues.push(value);
    }
    if (recentValues.length >= limit) break;
  }
  return recentValues;
}

async function lookupHighlightlyPlayer(playerName: string, playerId?: string) {
  const playersCache = await getProviderCache<HighlightlyPlayersPayload>("highlightly:players:MLB");
  const players = playersCache?.payload.data ?? [];
  const normalized = normalize(playerName);
  const byId = playerId ? players.find((player) => String(player.id ?? "") === String(playerId)) : null;
  const byName = players.find((player) => normalize(player.fullName ?? "").includes(normalized) || normalized.includes(normalize(player.fullName ?? "")));
  const player = byId ?? byName ?? null;
  if (!player?.id) return null;
  return { id: player.id, fullName: player.fullName ?? playerName };
}

export async function resolveProviderBoxScore(input: {
  sport: Sport;
  playerName: string;
  statType: string;
  playerId?: string;
  gameId?: string;
}): Promise<BoxScoreResolution> {
  if (input.sport === "MLB") {
    const mlbStats = new MlbStatsApiAdapter();
    try {
      const player = await mlbStats.searchPlayer(input.playerName);
      if (player?.id) {
        const gameLog = await mlbStats.fetchPlayerGameLog({ playerId: player.id, playerName: player.fullName, statType: input.statType, gameId: input.gameId });
        if (gameLog) {
          const best = mlbStats.extractBestSplit(gameLog.data, input.gameId);
          const actualValue = resolveActualValueFromPayload(best, input.statType, player.fullName);
          if (typeof actualValue === "number") {
            return {
              status: "resolved",
              actualValue,
              source: "mlb-stats-api",
              note: `Resolved from the official MLB Stats API for ${player.fullName}.`,
            };
          }
          const statcast = new StatcastSavantAdapter();
          try {
            const pitchContext = await statcast.fetchPlayerContextSummary({ playerName: player.fullName, playerId: String(player.id), playerType: "batter" });
            const summary = pitchContext.summary;
            if (!summary) throw new Error("Statcast summary was not generated.");
            return {
              status: "pending",
              actualValue: null,
              source: "statcast-savant",
              note: `The official MLB Stats API did not expose a clean ${input.statType} value for ${player.fullName}, but Baseball Savant pitch context is available (${summary.sampleSize} rows, avg exit velo ${summary.avgExitVelocity ?? "n/a"}, whiff rate ${summary.strikeoutRate ?? "n/a"}%).`,
            };
          } catch {
            // fall through to the generic pending note below
          }
          return {
            status: "pending",
            actualValue: null,
            source: "mlb-stats-api",
            note: `The official MLB Stats API returned context for ${player.fullName}, but it did not expose a clearly mapped ${input.statType} value yet.`,
          };
        }
      }
    } catch {
      // fall through to Highlightly fallback
    }

    const highlightlyResolution = await resolveHighlightlyMlbBoxScore(input);
    if (highlightlyResolution.status !== "unsupported") return highlightlyResolution;
    return highlightlyResolution;
  }

  if (input.sport === "NBA") {
    const nbaStats = new NbaComStatsAdapter();
    try {
      const player = await nbaStats.searchPlayer(input.playerName, "00");
      if (player?.id) {
        const gameLog = await nbaStats.fetchPlayerGameLog({ playerId: player.id, playerName: player.displayFirstLast, statType: input.statType, gameId: input.gameId, leagueId: "00" });
        if (gameLog) {
          const row = nbaStats.extractBestGame(gameLog.data, input.gameId);
          const actualValue = resolveActualValueFromPayload(row, input.statType, player.displayFirstLast);
          if (typeof actualValue === "number") {
            return {
              status: "resolved",
              actualValue,
              source: "nba-com-stats",
              note: `Resolved from nba_api-style NBA.com stats for ${player.displayFirstLast}.`,
            };
          }
          return {
            status: "pending",
            actualValue: null,
            source: "nba-com-stats",
            note: `NBA.com stats returned a row for ${player.displayFirstLast}, but it did not expose a clearly mapped ${input.statType} value yet.`,
          };
        }
      }
    } catch {
      return {
        status: "pending",
        actualValue: null,
        source: "nba-com-stats",
        note: "NBA.com stats lookup is optional and could not be completed for this pick yet.",
      };
    }

    return {
      status: "pending",
      actualValue: null,
      source: "nba-com-stats",
      note: "NBA.com stats could not resolve this pick yet, so it stays pending until a confirmed actual value is available.",
    };
  }

  return {
    status: "unsupported",
    actualValue: null,
    source: "provider-box-score",
    note: "Provider-based box-score grading is not connected for this sport yet, so the pick stays pending until a confirmed actual value is available.",
  };
}

async function resolveHighlightlyMlbBoxScore(input: {
  sport: Sport;
  playerName: string;
  statType: string;
  playerId?: string;
  gameId?: string;
}): Promise<BoxScoreResolution> {
  const player = await lookupHighlightlyPlayer(input.playerName, input.playerId);
  if (!player) {
    return {
      status: "pending",
      actualValue: null,
      source: "highlightly",
      note: "No cached Highlightly player identity matched this pick yet, so the app cannot grade it from provider data.",
    };
  }

  const statsCache = await getProviderCache<HighlightlyPlayerStatsPayload>(`highlightly:player-stats:${player.id}`);
  if (!statsCache) {
    return {
      status: "pending",
      actualValue: null,
      source: "highlightly",
      note: `Cached Highlightly box-score data is not available yet for ${player.fullName}.`,
    };
  }

  const actualValue = resolveActualValueFromPayload(statsCache.payload, input.statType, input.playerName);
  if (typeof actualValue !== "number") {
    return {
      status: "pending",
      actualValue: null,
      source: "highlightly",
      note: `A cached Highlightly payload exists for ${player.fullName}, but it does not expose a clearly mapped ${input.statType} box-score value yet.`,
    };
  }

  return {
    status: "resolved",
    actualValue,
    source: "highlightly",
    note: `Resolved from cached Highlightly box-score data for ${player.fullName}.`,
  };
}
