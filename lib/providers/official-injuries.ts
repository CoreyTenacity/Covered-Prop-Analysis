import type { Sport } from "@/lib/types";

export type OfficialInjuryRecord = {
  id: string;
  sport: Sport;
  playerName: string;
  team: string | null;
  status: string;
  note: string | null;
  reportDate: string | null;
  sourceUrl: string;
};

export type OfficialInjuryPayload = {
  sport: Sport;
  sourceUrl: string;
  sourceType: "json" | "html" | "pdf" | "unknown";
  records: OfficialInjuryRecord[];
  errors: string[];
};

export type InjurySourceConfig = {
  NBA?: string;
  WNBA?: string;
  NFL?: string;
};

type InjurySport = keyof InjurySourceConfig;

function compact(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function normalizeName(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const text = compact(value);
    if (text) return text;
  }
  return "";
}

export function parseReportDate(value: string | null | undefined, fallback = new Date()) {
  const text = compact(value);
  if (!text) return null;
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return text;
  const monthDayYearMatch = text.match(/^([A-Za-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?$/);
  if (monthDayYearMatch) {
    const year = monthDayYearMatch[3] ?? String(fallback.getFullYear());
    const parsed = new Date(`${monthDayYearMatch[1]} ${monthDayYearMatch[2]}, ${year} 12:00:00 GMT`);
    if (!Number.isNaN(parsed.getTime())) {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(parsed);
    }
  }
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(parsed);
  }
  return null;
}

export function parseRecord(raw: Record<string, unknown>, sport: Sport, sourceUrl: string, index: number): OfficialInjuryRecord | null {
  const playerName = firstText(raw.playerName, raw.player_name, raw.player, raw.name, raw.fullName, raw.full_name, raw.athlete);
  if (!playerName) return null;
  const team = firstText(raw.team, raw.teamName, raw.team_name, raw.club, raw.abbreviation) || null;
  const status = firstText(raw.status, raw.injuryStatus, raw.gameStatus, raw.reportStatus, raw.availability) || "unknown";
  const note = firstText(raw.note, raw.notes, raw.description, raw.injury, raw.reason, raw.comment) || null;
  const reportDate = parseReportDate(firstText(raw.reportDate, raw.report_date, raw.updatedAt, raw.updated_at, raw.timestamp, raw.date), new Date()) || null;
  return {
    id: `official-injuries:${sport}:${normalizeName(playerName)}:${index}`,
    sport,
    playerName,
    team,
    status,
    note,
    reportDate,
    sourceUrl,
  };
}

export function extractRecords(payload: unknown, sport: Sport, sourceUrl: string, errors: string[]): { sourceType: OfficialInjuryPayload["sourceType"]; records: OfficialInjuryRecord[] } {
  const records: OfficialInjuryRecord[] = [];
  if (Array.isArray(payload)) {
    payload.forEach((item, index) => {
      if (item && typeof item === "object") {
        const record = parseRecord(item as Record<string, unknown>, sport, sourceUrl, index);
        if (record) records.push(record);
      }
    });
    return { sourceType: "json", records };
  }
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    const candidates = ["data", "injuries", "items", "results", "report"];
    for (const key of candidates) {
      const value = obj[key];
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (item && typeof item === "object") {
            const record = parseRecord(item as Record<string, unknown>, sport, sourceUrl, index);
            if (record) records.push(record);
          }
        });
        if (records.length) return { sourceType: "json", records };
      }
    }
  }

  const html = typeof payload === "string" ? payload : "";
  if (html) {
    const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    for (const [index, match] of rows.entries()) {
      const cells = [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => cell[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
      if (cells.length < 2) continue;
      const playerName = cells[0];
      const status = cells[1] ?? "unknown";
      const note = cells.slice(2).join(" ") || null;
      if (!playerName) continue;
      records.push({
        id: `official-injuries:${sport}:${normalizeName(playerName)}:${index}`,
        sport,
        playerName,
        team: null,
        status,
        note,
        reportDate: null,
        sourceUrl,
      });
    }
    if (records.length) return { sourceType: "html", records };
  }

  errors.push("No injury records could be extracted from the source payload.");
  return { sourceType: "unknown", records };
}

export function officialInjuryReportConfigured(sport: Sport, urls: InjurySourceConfig = {
  NBA: process.env.NBA_INJURY_REPORT_URL?.trim() || "",
  WNBA: process.env.WNBA_INJURY_REPORT_URL?.trim() || "https://www.wnba.com/api/injury-reports",
  NFL: process.env.NFL_INJURY_REPORT_URL?.trim() || "",
}) {
  return sport === "NBA" || sport === "WNBA" || sport === "NFL" ? Boolean(urls[sport as InjurySport]) : false;
}

export function summarizeOfficialInjuryReport(payload: OfficialInjuryPayload) {
  const statuses = [...new Set(payload.records.map((record) => record.status).filter(Boolean))].slice(0, 10);
  return {
    records: payload.records.length,
    statuses,
    sourceType: payload.sourceType,
    errors: payload.errors.slice(0, 3),
  };
}

export function matchOfficialInjuryRecord(payload: OfficialInjuryPayload | null, playerName: string, team?: string) {
  if (!payload?.records?.length) return null;
  const target = normalizeName(playerName);
  const teamNeedle = normalizeName(team ?? "");
  return payload.records.find((record) => {
    const playerHit = normalizeName(record.playerName).includes(target) || target.includes(normalizeName(record.playerName));
    const teamHit = !teamNeedle || (record.team ? normalizeName(record.team).includes(teamNeedle) || teamNeedle.includes(normalizeName(record.team)) : false);
    return playerHit && teamHit;
  }) ?? null;
}
