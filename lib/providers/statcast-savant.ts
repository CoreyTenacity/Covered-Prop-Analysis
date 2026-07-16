import type { ProviderFetchResult } from "./provider-adapter";
import { getProviderCache, putProviderCache, touchTodayBoardContext } from "@/lib/db/provider-cache";
import { MlbStatsApiAdapter } from "./mlb-stats-api.ts";

export type StatcastRow = Record<string, string | number | null>;

export type StatcastSummary = {
  playerName: string;
  playerId?: string;
  source: "baseball-savant";
  sampleSize: number;
  dateRange: { from: string; to: string };
  avgExitVelocity: number | null;
  hardHitRate: number | null;
  barrelRate: number | null;
  xwoba: number | null;
  sweetSpotRate: number | null;
  strikeoutRate: number | null;
  walkRate: number | null;
  contextConfidence: "low" | "medium" | "high";
  lastUpdated: string;
  sourceUrl: string;
};

export type StatcastProbeSteps = {
  "resolve-player": "ok" | "skipped" | "failed";
  "build-request": "ok" | "failed";
  fetch: "ok" | "timeout" | "failed";
  "parse-csv": "ok" | "failed";
  summarize: "ok" | "failed";
  cache: "ok" | "failed" | "skipped";
};

export type StatcastCheckResponse = {
  mode: "statcast-savant-check";
  status: "ok" | "provider-error" | "timeout" | "parse-error" | "cache-error";
  playerName: string;
  rows: number;
  probeOnly: boolean;
  elapsedMs: number;
  endpoint: string;
  requestUrl: string;
  requestStatus: number | null;
  steps: StatcastProbeSteps;
  summary?: StatcastSummary;
  cache?: {
    status: "ok" | "failed" | "skipped";
    cacheKey?: string;
    error?: string;
  };
  failedStep?: "resolve-player" | "build-request" | "fetch" | "parse-csv" | "summarize" | "cache-write";
  error?: string;
  message?: string;
};

type StatcastInput = {
  playerName: string;
  playerId?: string;
  probeOnly?: boolean;
  playerType?: "batter" | "pitcher";
  daysBack?: number;
  maxRows?: number;
};

function normalize(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function slugify(value: string) {
  return normalize(value).replace(/\s+/g, "-");
}

function safeDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i += 1) {
    const values = splitCsvLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values.map((value) => value.trim());
}

function toNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function average(values: Array<number | null>) {
  const filtered = values.filter((value): value is number => typeof value === "number");
  if (!filtered.length) return null;
  return Math.round((filtered.reduce((sum, value) => sum + value, 0) / filtered.length) * 10) / 10;
}

function countRate(rows: StatcastRow[], predicate: (row: StatcastRow) => boolean) {
  if (!rows.length) return null;
  return Math.round((rows.filter(predicate).length / rows.length) * 1000) / 10;
}

function mapRow(row: Record<string, string>): StatcastRow {
  const result: StatcastRow = {};
  for (const [key, value] of Object.entries(row)) {
    const numeric = toNumber(value);
    result[key] = numeric ?? value;
  }
  return result;
}

function summarizeRows(input: { playerName: string; playerId?: string; rows: StatcastRow[]; sourceUrl: string; from: string; to: string }): StatcastSummary {
  const exitVelos = input.rows.map((row) => typeof row.launch_speed === "number" ? row.launch_speed : typeof row.exit_velocity === "number" ? row.exit_velocity : null);
  const hardHitRate = countRate(input.rows, (row) => {
    const velo = typeof row.launch_speed === "number" ? row.launch_speed : typeof row.exit_velocity === "number" ? row.exit_velocity : null;
    return typeof velo === "number" && velo >= 95;
  });
  const barrelRate = countRate(input.rows, (row) => row.barrel === 1 || row.barrel === "1" || row.barrels === 1 || row.barrels === "1");
  const sweetSpotRate = countRate(input.rows, (row) => {
    const angle = typeof row.launch_angle === "number" ? row.launch_angle : null;
    return typeof angle === "number" && angle >= 8 && angle <= 32;
  });
  const strikeoutRate = countRate(input.rows, (row) => /strikeout|swinging strike|called strike/i.test(String(row.description ?? row.events ?? "")));
  const walkRate = countRate(input.rows, (row) => /walk/i.test(String(row.description ?? row.events ?? "")));
  const xwoba = average(input.rows.map((row) => {
    const value = row.estimated_woba_using_speedangle ?? row.xwoba ?? row.xwOBA ?? null;
    return typeof value === "number" ? value : null;
  }));
  const sampleSize = input.rows.length;
  const contextConfidence: StatcastSummary["contextConfidence"] = sampleSize >= 50 ? "high" : sampleSize >= 15 ? "medium" : "low";

  return {
    playerName: input.playerName,
    playerId: input.playerId,
    source: "baseball-savant",
    sampleSize,
    dateRange: { from: input.from, to: input.to },
    avgExitVelocity: average(exitVelos),
    hardHitRate,
    barrelRate,
    xwoba,
    sweetSpotRate,
    strikeoutRate,
    walkRate,
    contextConfidence,
    lastUpdated: new Date().toISOString(),
    sourceUrl: input.sourceUrl,
  };
}

function sanitizeUrl(url: URL) {
  const safe = new URL(url.toString());
  if (safe.searchParams.has("player_name")) safe.searchParams.set("player_name", "[redacted]");
  if (safe.searchParams.has("player_id")) safe.searchParams.set("player_id", "[redacted]");
  return safe.toString();
}

export class StatcastSavantAdapter {
  readonly id = "statcast-savant";
  private readonly baseUrl: string;
  private readonly searchPath: string;

  constructor(
    baseUrl = process.env.STATCAST_SAVANT_BASE_URL || "https://baseballsavant.mlb.com",
    searchPath = process.env.STATCAST_SAVANT_SEARCH_PATH || "/statcast_search/csv",
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.searchPath = searchPath.startsWith("/") ? searchPath : `/${searchPath}`;
  }

  configured() {
    return true;
  }

  private buildRequestUrl(input: StatcastInput, from: string, to: string) {
    const url = new URL(`${this.baseUrl}${this.searchPath}`);
    url.searchParams.set("all", "true");
    url.searchParams.set("player_type", input.playerType ?? "batter");
    url.searchParams.set("player_name", input.playerName);
    url.searchParams.set("game_date_gt", from);
    url.searchParams.set("game_date_lt", to);
    if (input.playerId) url.searchParams.set("player_id", input.playerId);
    return url;
  }

  async probePlayerContext(input: StatcastInput): Promise<StatcastCheckResponse> {
    return this.run(input, true);
  }

  async fetchPlayerContextSummary(input: StatcastInput): Promise<StatcastCheckResponse> {
    return this.run(input, false);
  }

  private async run(input: StatcastInput, probeOnly: boolean): Promise<StatcastCheckResponse> {
    const startedAt = Date.now();
    let resolvedPlayerName = input.playerName;
    let resolvedPlayerId = input.playerId;
    const steps: StatcastProbeSteps = {
      "resolve-player": input.playerId ? "skipped" : "ok",
      "build-request": "ok",
      fetch: "failed",
      "parse-csv": "failed",
      summarize: "failed",
      cache: probeOnly ? "skipped" : "failed",
    };

    if (!resolvedPlayerId) {
      try {
        const mlbStats = new MlbStatsApiAdapter();
        const player = await mlbStats.searchPlayer(input.playerName);
        if (player?.id) {
          resolvedPlayerId = String(player.id);
          resolvedPlayerName = player.fullName;
          steps["resolve-player"] = "ok";
        } else {
          steps["resolve-player"] = "skipped";
        }
      } catch {
        steps["resolve-player"] = "skipped";
      }
    }

    const daysBack = probeOnly ? Math.max(3, input.daysBack ?? 7) : Math.max(7, input.daysBack ?? 14);
    const end = new Date();
    const from = safeDate(new Date(end.getTime() - daysBack * 24 * 60 * 60 * 1000));
    const to = safeDate(end);
    const requestUrl = this.buildRequestUrl({ ...input, playerName: resolvedPlayerName, playerId: resolvedPlayerId }, from, to);
    const endpoint = "statcast_search/csv";
    let responseStatus: number | null = null;

    try {
      const timeoutMs = probeOnly ? 7_000 : 12_000;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(requestUrl, {
        headers: { Accept: "text/csv, text/plain, */*;q=0.8" },
        signal: controller.signal,
        cache: "no-store",
      }).finally(() => clearTimeout(timeout));
      responseStatus = response.status;
      steps.fetch = "ok";
      const text = await response.text();
      if (!response.ok) {
        return {
          mode: "statcast-savant-check",
          status: "provider-error",
          playerName: resolvedPlayerName,
          rows: 0,
          probeOnly,
          elapsedMs: Date.now() - startedAt,
          endpoint,
          requestUrl: sanitizeUrl(requestUrl),
          requestStatus: responseStatus,
          steps,
          failedStep: "fetch",
          error: `Statcast / Baseball Savant request failed with status ${response.status}.`,
        };
      }

      let rows: StatcastRow[];
      try {
        const parsed = parseCsv(text);
        rows = parsed.slice(0, probeOnly ? Math.min(input.maxRows ?? 25, 50) : Math.min(input.maxRows ?? 75, 150)).map(mapRow);
        steps["parse-csv"] = "ok";
      } catch (error) {
        return {
          mode: "statcast-savant-check",
          status: "parse-error",
          playerName: resolvedPlayerName,
          rows: 0,
          probeOnly,
          elapsedMs: Date.now() - startedAt,
          endpoint,
          requestUrl: sanitizeUrl(requestUrl),
          requestStatus: responseStatus,
          steps,
          failedStep: "parse-csv",
          error: error instanceof Error ? error.message : "Failed to parse Baseball Savant CSV.",
        };
      }

      let summary: StatcastSummary;
      try {
        summary = summarizeRows({ playerName: resolvedPlayerName, playerId: resolvedPlayerId, rows, sourceUrl: sanitizeUrl(requestUrl), from, to });
        steps.summarize = "ok";
      } catch (error) {
        return {
          mode: "statcast-savant-check",
          status: "provider-error",
          playerName: input.playerName,
          rows: rows.length,
          probeOnly,
          elapsedMs: Date.now() - startedAt,
          endpoint,
          requestUrl: sanitizeUrl(requestUrl),
          requestStatus: responseStatus,
          steps,
          failedStep: "summarize",
          error: error instanceof Error ? error.message : "Failed to summarize Baseball Savant rows.",
        };
      }

      if (!probeOnly) {
        try {
          const cacheKey = `statcast_summary:mlb:${slugify(input.playerName)}:${from}:${to}`;
          const cachePayload = summary;
          const safeSize = JSON.stringify(cachePayload).length;
          if (safeSize > 15_000) {
            steps.cache = "failed";
            return {
              mode: "statcast-savant-check",
              status: "cache-error",
              playerName: resolvedPlayerName,
              rows: rows.length,
              probeOnly,
              elapsedMs: Date.now() - startedAt,
              endpoint,
              requestUrl: sanitizeUrl(requestUrl),
              requestStatus: responseStatus,
              steps,
              summary,
              cache: { status: "failed", cacheKey, error: "Summary payload exceeded safe cache size." },
              failedStep: "cache-write",
              error: "Summary payload exceeded safe cache size.",
            };
          }
          await putProviderCache({ cacheKey, provider: "statcast-savant", payload: cachePayload, expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString() });
          await touchTodayBoardContext(`statcast-savant ${resolvedPlayerName}`);
          steps.cache = "ok";
          return {
            mode: "statcast-savant-check",
            status: "ok",
              playerName: resolvedPlayerName,
            rows: rows.length,
            probeOnly,
            elapsedMs: Date.now() - startedAt,
            endpoint,
            requestUrl: sanitizeUrl(requestUrl),
            requestStatus: responseStatus,
            steps,
            summary,
            cache: { status: "ok", cacheKey },
          };
        } catch (error) {
          steps.cache = "failed";
          return {
            mode: "statcast-savant-check",
            status: "ok",
            playerName: resolvedPlayerName,
            rows: rows.length,
            probeOnly,
            elapsedMs: Date.now() - startedAt,
            endpoint,
            requestUrl: sanitizeUrl(requestUrl),
            requestStatus: responseStatus,
            steps,
            summary,
            cache: { status: "failed", error: error instanceof Error ? error.message : "Unknown cache error" },
          };
        }
      }

      return {
        mode: "statcast-savant-check",
        status: "ok",
        playerName: resolvedPlayerName,
        rows: rows.length,
        probeOnly,
        elapsedMs: Date.now() - startedAt,
        endpoint,
        requestUrl: sanitizeUrl(requestUrl),
        requestStatus: responseStatus,
        steps,
        summary,
        cache: { status: "skipped" },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Baseball Savant error";
      const timeout = /aborted|timeout/i.test(message);
      steps.fetch = timeout ? "timeout" : "failed";
      return {
        mode: "statcast-savant-check",
        status: timeout ? "timeout" : "provider-error",
        playerName: input.playerName,
        rows: 0,
        probeOnly,
        elapsedMs: Date.now() - startedAt,
        endpoint,
        requestUrl: sanitizeUrl(requestUrl),
        requestStatus: responseStatus,
        steps,
        failedStep: "fetch",
        message: timeout ? "Baseball Savant request timed out" : undefined,
        error: timeout ? undefined : message,
      };
    }
  }
}
