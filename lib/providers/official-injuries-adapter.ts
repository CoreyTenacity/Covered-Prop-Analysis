import type { ProviderFetchResult } from "./provider-adapter";
import type { Sport } from "@/lib/types";
// The package root executes a bundled test harness under Turbopack. Importing
// the server parser directly avoids that side effect in production builds.
// @ts-expect-error pdf-parse does not publish types for this internal entry.
import pdfParse from "pdf-parse/lib/pdf-parse.js";

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

function normalizeName(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const text = compact(value);
    if (text) return text;
  }
  return "";
}

function parseReportDate(value: string | null | undefined, fallback = new Date()) {
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

function parseRecord(raw: Record<string, unknown>, sport: Sport, sourceUrl: string, index: number): OfficialInjuryRecord | null {
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

function extractRecords(payload: unknown, sport: Sport, sourceUrl: string, errors: string[]): { sourceType: OfficialInjuryPayload["sourceType"]; records: OfficialInjuryRecord[] } {
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

function officialInjuryReportConfigured(sport: Sport, urls: InjurySourceConfig = {
  NBA: process.env.NBA_INJURY_REPORT_URL?.trim() || "",
  WNBA: process.env.WNBA_INJURY_REPORT_URL?.trim() || "https://www.wnba.com/api/injury-reports",
  NFL: process.env.NFL_INJURY_REPORT_URL?.trim() || "",
}) {
  return sport === "NBA" || sport === "WNBA" || sport === "NFL" ? Boolean(urls[sport as InjurySport]) : false;
}

function summarizeOfficialInjuryReport(payload: OfficialInjuryPayload) {
  const statuses = [...new Set(payload.records.map((record) => record.status).filter(Boolean))].slice(0, 10);
  return {
    records: payload.records.length,
    statuses,
    sourceType: payload.sourceType,
    errors: payload.errors.slice(0, 3),
  };
}

export class OfficialInjuryReportAdapter {
  readonly id = "official-injuries";
  private readonly urls: InjurySourceConfig;

  constructor(urls: InjurySourceConfig = {
    NBA: process.env.NBA_INJURY_REPORT_URL?.trim() || "",
    WNBA: process.env.WNBA_INJURY_REPORT_URL?.trim() || "https://www.wnba.com/api/injury-reports",
    NFL: process.env.NFL_INJURY_REPORT_URL?.trim() || "",
  }) {
    this.urls = urls;
  }

  configured(sport: Sport) {
    return officialInjuryReportConfigured(sport, this.urls);
  }

  async fetchReport(sport: Sport): Promise<ProviderFetchResult<OfficialInjuryPayload>> {
    const sourceUrl = sport === "NBA" || sport === "WNBA" || sport === "NFL" ? this.urls[sport] : "";
    if (!sourceUrl) throw new Error(`${sport} injury report URL is not configured.`);
    if (sport === "WNBA" && /wnba\.com\/api\/injury-reports/i.test(sourceUrl)) {
      const indexResponse = await fetch(sourceUrl, {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 Covered/1.0" },
        signal: AbortSignal.timeout(12_000),
        cache: "no-store",
      });
      if (!indexResponse.ok) throw new Error(`Official WNBA injury index request failed with status ${indexResponse.status}.`);
      const reportIndex = await indexResponse.json() as { dateLabel?: string; links?: Array<{ href?: string; label?: string }> };
      const latest = (reportIndex.links ?? []).filter((link) => typeof link.href === "string" && /\.pdf(?:$|\?)/i.test(link.href)).at(-1);
      if (!latest?.href) throw new Error("Official WNBA injury index returned no PDF reports.");
      const pdfResponse = await fetch(latest.href, { headers: { Accept: "application/pdf" }, signal: AbortSignal.timeout(12_000), cache: "no-store" });
      if (!pdfResponse.ok) throw new Error(`Official WNBA injury PDF request failed with status ${pdfResponse.status}.`);
      const parsed = await pdfParse(Buffer.from(await pdfResponse.arrayBuffer()));
      const text = parsed.text.replace(/\s+/g, "");
      const matches = [...text.matchAll(/([A-Za-zÀ-ÿ'’.-]+),([A-Za-zÀ-ÿ'’.-]+)(Questionable|Doubtful|Probable|Out|Available)/g)];
      const records = matches.map((match, index): OfficialInjuryRecord => {
        const nextIndex = matches[index + 1]?.index ?? text.length;
        const reason = text.slice((match.index ?? 0) + match[0].length, nextIndex)
          .split(/\d{2}\/\d{2}\/\d{4}|\d{2}:\d{2}\(ET\)|NOTYETSUBMITTED/)[0]
          .replace(/^(Injury\/Illness-)?/, "")
          .slice(0, 180);
        const playerName = `${match[2]} ${match[1]}`.replace(/([a-z])([A-Z])/g, "$1 $2");
        return {
          id: `official-injuries:WNBA:${normalizeName(playerName)}:${index}`,
          sport: "WNBA",
          playerName,
          team: null,
          status: match[3],
          note: reason || null,
          reportDate: parseReportDate(reportIndex.dateLabel, new Date()) ?? null,
          sourceUrl: latest.href!,
        };
      });
      return {
        data: { sport: "WNBA", sourceUrl: latest.href, sourceType: "pdf", records, errors: records.length ? [] : ["The latest official WNBA PDF contained no submitted player rows."] },
        cost: 0,
        remaining: null,
        fetchedAt: new Date().toISOString(),
      };
    }
    const response = await fetch(sourceUrl, {
      headers: { Accept: "application/json, text/html;q=0.9, */*;q=0.8" },
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) throw new Error(`Official ${sport} injury report request failed with status ${response.status}.`);
    const contentType = response.headers.get("content-type") ?? "";
    let parsed: unknown = text;
    if (/json/i.test(contentType) || /^[\s]*[\[{]/.test(text)) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    const errors: string[] = [];
    const extracted = extractRecords(parsed, sport, sourceUrl, errors);
    return {
      data: {
        sport,
        sourceUrl,
        sourceType: extracted.sourceType,
        records: extracted.records,
        errors,
      },
      cost: 0,
      remaining: null,
      fetchedAt: new Date().toISOString(),
    };
  }
}
