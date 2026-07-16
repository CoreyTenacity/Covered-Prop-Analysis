/**
 * ESPN WNBA adapter.
 *
 * Source: site.api.espn.com (ESPN's public, unauthenticated site API).
 * Verified reachable and fast from GitHub Actions runners in
 * docs/WNBA_PROVIDER_EVIDENCE_AUDIT.md (Section 4) - 88ms scoreboard,
 * 36ms box score, both 200 OK, from the same environment where
 * stats.nba.com fully times out (18s, zero bytes, both endpoints).
 *
 * Does not call stats.nba.com. Does not require an API key. Does not
 * scrape HTML - only calls ESPN's JSON site API.
 */

export type EspnWnbaGameStatus = "scheduled" | "in_progress" | "final" | "postponed" | "canceled" | "unknown";

export type EspnWnbaScheduledGame = {
  gameId: string;
  status: EspnWnbaGameStatus;
  statusDetail: string;
  startTimeUtc: string;
  homeTeamId: string;
  homeTeamName: string;
  homeTeamAbbreviation: string;
  homeScore: number | null;
  awayTeamId: string;
  awayTeamName: string;
  awayTeamAbbreviation: string;
  awayScore: number | null;
  venueName: string | null;
  venueCity: string | null;
  venueState: string | null;
};

export type EspnWnbaPlayerBoxScoreRow = {
  gameId: string;
  teamId: string;
  athleteId: string;
  athleteName: string;
  starter: boolean;
  didNotPlay: boolean;
  minutes: number | null;
  points: number | null;
  rebounds: number | null;
  assists: number | null;
  steals: number | null;
  blocks: number | null;
  turnovers: number | null;
  fieldGoalsMade: number | null;
  fieldGoalsAttempted: number | null;
  threePointersMade: number | null;
  threePointersAttempted: number | null;
  freeThrowsMade: number | null;
  freeThrowsAttempted: number | null;
};

export type EspnWnbaTeamBoxScoreRow = {
  gameId: string;
  teamId: string;
  teamName: string;
  score: number | null;
  rebounds: number | null;
  offensiveRebounds: number | null;
  defensiveRebounds: number | null;
  assists: number | null;
  steals: number | null;
  blocks: number | null;
  turnovers: number | null;
  fieldGoalsMade: number | null;
  fieldGoalsAttempted: number | null;
  threePointersMade: number | null;
  threePointersAttempted: number | null;
  freeThrowsMade: number | null;
  freeThrowsAttempted: number | null;
};

export type EspnWnbaBoxScore = {
  gameId: string;
  status: EspnWnbaGameStatus;
  statusDetail: string;
  homeTeamId: string;
  awayTeamId: string;
  players: EspnWnbaPlayerBoxScoreRow[];
  teams: EspnWnbaTeamBoxScoreRow[];
};

const ESPN_BASE_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba";
const USER_AGENT = "Covered/1.0 (+https://github.com/CoreyTenacity/Covered)";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 1_000;

function log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}) {
  const payload = { provider: "espn-wnba", level, message, ...fields, timestamp: new Date().toISOString() };
  if (level === "error") console.error(JSON.stringify(payload));
  else if (level === "warn") console.warn(JSON.stringify(payload));
  else console.log(JSON.stringify(payload));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function mapEspnStatus(stateName: string | undefined, state: string | undefined): EspnWnbaGameStatus {
  const name = (stateName ?? "").toUpperCase();
  if (name.includes("FINAL")) return "final";
  if (name.includes("POSTPON")) return "postponed";
  if (name.includes("CANCEL") || name.includes("FORFEIT")) return "canceled";
  if (name.includes("PROGRESS") || name.includes("HALFTIME") || state === "in") return "in_progress";
  if (name.includes("SCHEDULED") || state === "pre") return "scheduled";
  return "unknown";
}

class EspnResponseShapeError extends Error {
  constructor(context: string) {
    super(`ESPN WNBA response did not match the expected shape: ${context}`);
    this.name = "EspnResponseShapeError";
  }
}

async function fetchWithRetry(url: string, options: { timeoutMs?: number; maxAttempts?: number; backoffMs?: number } = {}): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseBackoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now();
    try {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
          signal: controller.signal,
          cache: "no-store",
        });
      } finally {
        clearTimeout(timeoutHandle);
      }
      const durationMs = Date.now() - startedAt;
      if (!response.ok) {
        log("warn", "ESPN WNBA request returned non-2xx status", { url, status: response.status, attempt, durationMs });
        throw new Error(`ESPN WNBA request failed with status ${response.status}.`);
      }
      const payload = await response.json().catch(() => {
        throw new EspnResponseShapeError("response body was not valid JSON");
      });
      log("info", "ESPN WNBA request succeeded", { url, status: response.status, attempt, durationMs });
      return payload;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const durationMs = Date.now() - startedAt;
      log("warn", "ESPN WNBA request attempt failed", { url, attempt, maxAttempts, durationMs, errorName: lastError.name, errorMessage: lastError.message });
      if (attempt < maxAttempts) {
        const backoff = baseBackoffMs * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }
  log("error", "ESPN WNBA request exhausted retries", { url, maxAttempts, errorName: lastError?.name, errorMessage: lastError?.message });
  throw lastError ?? new Error("ESPN WNBA request failed for an unknown reason.");
}

export class EspnWnbaAdapter {
  readonly id = "espn-wnba";

  configured() {
    return true;
  }

  /**
   * Fetch the WNBA schedule for a single date (YYYY-MM-DD).
   * Verified endpoint: GET https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=YYYYMMDD
   */
  async fetchScheduleForDate(date: string): Promise<EspnWnbaScheduledGame[]> {
    const compactDate = date.replace(/-/g, "");
    const url = `${ESPN_BASE_URL}/scoreboard?dates=${encodeURIComponent(compactDate)}`;
    const payload = await fetchWithRetry(url);
    if (!isRecord(payload) || !Array.isArray(payload.events)) {
      throw new EspnResponseShapeError("missing events array");
    }

    const games: EspnWnbaScheduledGame[] = [];
    for (const event of payload.events) {
      if (!isRecord(event)) continue;
      const competitions = Array.isArray(event.competitions) ? event.competitions : [];
      const competition = competitions[0];
      if (!isRecord(competition)) continue;
      const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
      const home = competitors.find((c) => isRecord(c) && c.homeAway === "home");
      const away = competitors.find((c) => isRecord(c) && c.homeAway === "away");
      if (!isRecord(home) || !isRecord(away)) continue;
      const homeTeam = isRecord(home.team) ? home.team : {};
      const awayTeam = isRecord(away.team) ? away.team : {};
      const status = isRecord(competition.status) ? competition.status : {};
      const statusType = isRecord(status.type) ? status.type : {};
      const venue = isRecord(competition.venue) ? competition.venue : {};
      const venueAddress = isRecord(venue.address) ? venue.address : {};

      const gameId = safeText(event.id);
      if (!gameId) continue;

      games.push({
        gameId,
        status: mapEspnStatus(safeText(statusType.name), safeText(statusType.state)),
        statusDetail: safeText(statusType.detail) || safeText(statusType.description),
        startTimeUtc: safeText(event.date),
        homeTeamId: safeText(homeTeam.id),
        homeTeamName: safeText(homeTeam.displayName),
        homeTeamAbbreviation: safeText(homeTeam.abbreviation),
        homeScore: safeNumber(home.score),
        awayTeamId: safeText(awayTeam.id),
        awayTeamName: safeText(awayTeam.displayName),
        awayTeamAbbreviation: safeText(awayTeam.abbreviation),
        awayScore: safeNumber(away.score),
        venueName: safeText(venue.fullName) || null,
        venueCity: safeText(venueAddress.city) || null,
        venueState: safeText(venueAddress.state) || null,
      });
    }
    return games;
  }

  /**
   * Fetch the box score (player + team stats) for a completed or in-progress game.
   * Verified endpoint: GET https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/summary?event={id}
   * Returns null for games with no box score available yet (e.g. far-future scheduled games).
   */
  async fetchBoxScore(gameId: string): Promise<EspnWnbaBoxScore | null> {
    const url = `${ESPN_BASE_URL}/summary?event=${encodeURIComponent(gameId)}`;
    const payload = await fetchWithRetry(url);
    if (!isRecord(payload)) throw new EspnResponseShapeError("summary response was not an object");

    const header = isRecord(payload.header) ? payload.header : {};
    const competitions = Array.isArray(header.competitions) ? header.competitions : [];
    const competition = competitions[0];
    const statusType = isRecord(competition) && isRecord(competition.status) && isRecord(competition.status.type)
      ? competition.status.type
      : {};
    const status = mapEspnStatus(safeText(statusType.name), safeText(statusType.state));
    const statusDetail = safeText(statusType.detail) || safeText(statusType.description);

    const boxscore = isRecord(payload.boxscore) ? payload.boxscore : null;
    if (!boxscore || !Array.isArray(boxscore.players) || !Array.isArray(boxscore.teams) || boxscore.players.length === 0) {
      // No box score published yet (common for games far in the future, or ESPN
      // returns empty arrays rather than omitting the key). Not an error.
      log("info", "ESPN WNBA box score not yet available", { gameId, status });
      return null;
    }

    const teamScores = new Map<string, number | null>();
    if (isRecord(competition)) {
      const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
      for (const c of competitors) {
        if (isRecord(c) && isRecord(c.team)) teamScores.set(safeText(c.team.id), safeNumber(c.score));
      }
    }

    const teams: EspnWnbaTeamBoxScoreRow[] = [];
    for (const teamEntry of boxscore.teams) {
      if (!isRecord(teamEntry) || !isRecord(teamEntry.team)) continue;
      const teamId = safeText(teamEntry.team.id);
      if (!teamId) continue;
      const statsByName = new Map<string, string>();
      if (Array.isArray(teamEntry.statistics)) {
        for (const stat of teamEntry.statistics) {
          if (isRecord(stat)) statsByName.set(safeText(stat.name), safeText(stat.displayValue));
        }
      }
      const splitPair = (key: string): [number | null, number | null] => {
        const raw = statsByName.get(key) ?? "";
        const [made, attempted] = raw.split("-");
        return [safeNumber(made), safeNumber(attempted)];
      };
      const [fgMade, fgAttempted] = splitPair("fieldGoalsMade-fieldGoalsAttempted");
      const [tpMade, tpAttempted] = splitPair("threePointFieldGoalsMade-threePointFieldGoalsAttempted");
      const [ftMade, ftAttempted] = splitPair("freeThrowsMade-freeThrowsAttempted");

      teams.push({
        gameId,
        teamId,
        teamName: safeText(teamEntry.team.displayName),
        score: teamScores.get(teamId) ?? null,
        rebounds: safeNumber(statsByName.get("totalRebounds")),
        offensiveRebounds: safeNumber(statsByName.get("offensiveRebounds")),
        defensiveRebounds: safeNumber(statsByName.get("defensiveRebounds")),
        assists: safeNumber(statsByName.get("assists")),
        steals: safeNumber(statsByName.get("steals")),
        blocks: safeNumber(statsByName.get("blocks")),
        turnovers: safeNumber(statsByName.get("totalTurnovers") ?? statsByName.get("turnovers")),
        fieldGoalsMade: fgMade,
        fieldGoalsAttempted: fgAttempted,
        threePointersMade: tpMade,
        threePointersAttempted: tpAttempted,
        freeThrowsMade: ftMade,
        freeThrowsAttempted: ftAttempted,
      });
    }

    const players: EspnWnbaPlayerBoxScoreRow[] = [];
    for (const teamEntry of boxscore.players) {
      if (!isRecord(teamEntry) || !isRecord(teamEntry.team)) continue;
      const teamId = safeText(teamEntry.team.id);
      const statGroups = Array.isArray(teamEntry.statistics) ? teamEntry.statistics : [];
      const statGroup = statGroups[0];
      if (!isRecord(statGroup) || !Array.isArray(statGroup.labels) || !Array.isArray(statGroup.athletes)) continue;
      const labels: string[] = statGroup.labels.map((l) => safeText(l));
      const indexOf = (label: string) => labels.indexOf(label);
      const minIdx = indexOf("MIN");
      const ptsIdx = indexOf("PTS");
      const fgIdx = indexOf("FG");
      const tpIdx = indexOf("3PT");
      const ftIdx = indexOf("FT");
      const rebIdx = indexOf("REB");
      const astIdx = indexOf("AST");
      const toIdx = indexOf("TO");
      const stlIdx = indexOf("STL");
      const blkIdx = indexOf("BLK");

      for (const athleteEntry of statGroup.athletes) {
        if (!isRecord(athleteEntry) || !isRecord(athleteEntry.athlete)) continue;
        const athleteId = safeText(athleteEntry.athlete.id);
        if (!athleteId) continue;
        const stats: string[] = Array.isArray(athleteEntry.stats) ? athleteEntry.stats.map((s) => safeText(s)) : [];
        const didNotPlay = Boolean(athleteEntry.didNotPlay) || stats.length === 0;
        const splitPair = (idx: number): [number | null, number | null] => {
          if (idx < 0 || !stats[idx]) return [null, null];
          const [made, attempted] = stats[idx].split("-");
          return [safeNumber(made), safeNumber(attempted)];
        };
        const [fgMade, fgAttempted] = splitPair(fgIdx);
        const [tpMade, tpAttempted] = splitPair(tpIdx);
        const [ftMade, ftAttempted] = splitPair(ftIdx);

        players.push({
          gameId,
          teamId,
          athleteId,
          athleteName: safeText(athleteEntry.athlete.displayName),
          starter: Boolean(athleteEntry.starter),
          didNotPlay,
          minutes: minIdx >= 0 ? safeNumber(stats[minIdx]) : null,
          points: ptsIdx >= 0 ? safeNumber(stats[ptsIdx]) : null,
          rebounds: rebIdx >= 0 ? safeNumber(stats[rebIdx]) : null,
          assists: astIdx >= 0 ? safeNumber(stats[astIdx]) : null,
          steals: stlIdx >= 0 ? safeNumber(stats[stlIdx]) : null,
          blocks: blkIdx >= 0 ? safeNumber(stats[blkIdx]) : null,
          turnovers: toIdx >= 0 ? safeNumber(stats[toIdx]) : null,
          fieldGoalsMade: fgMade,
          fieldGoalsAttempted: fgAttempted,
          threePointersMade: tpMade,
          threePointersAttempted: tpAttempted,
          freeThrowsMade: ftMade,
          freeThrowsAttempted: ftAttempted,
        });
      }
    }

    const homeTeamId = isRecord(competition)
      ? safeText((Array.isArray(competition.competitors) ? competition.competitors : []).find((c) => isRecord(c) && c.homeAway === "home")?.team?.id)
      : "";
    const awayTeamId = isRecord(competition)
      ? safeText((Array.isArray(competition.competitors) ? competition.competitors : []).find((c) => isRecord(c) && c.homeAway === "away")?.team?.id)
      : "";

    return { gameId, status, statusDetail, homeTeamId, awayTeamId, players, teams };
  }
}
