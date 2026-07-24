import { filterParlayOptionsSnapshotRows } from "@/lib/knowledge/public-snapshots";
import type { ParlayOptionRow } from "@/lib/knowledge/read-types";

export const manualSortOptions = [
  { label: "Best score", value: "score" },
  { label: "Earliest start", value: "start" },
  { label: "Highest match confidence", value: "match" },
  { label: "Player A–Z", value: "player" },
] as const;

export type ManualSortValue = (typeof manualSortOptions)[number]["value"];

export const manualScoreBandOptions = [
  { label: "All scores", value: "" },
  { label: "Sub-70", value: "sub70" },
  { label: "70+", value: "70+" },
  { label: "80+", value: "80+" },
  { label: "90+", value: "90+" },
] as const;

export type ManualScoreBandValue = (typeof manualScoreBandOptions)[number]["value"];

function easternDateKey(value: string | null | undefined) {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

export function manualScoreBandMatches(score: number | null | undefined, band: ManualScoreBandValue) {
  if (!band) return true;
  if (score == null || !Number.isFinite(score)) return false;
  if (band === "sub70") return score < 70;
  if (band === "70+") return score >= 70;
  if (band === "80+") return score >= 80;
  return score >= 90;
}

function manualCatalogGroupingKey(option: ParlayOptionRow) {
  const dateKey = option.start_time ? easternDateKey(option.start_time) : "date:unknown";
  return [
    option.league,
    option.event_id ?? option.event_display_name ?? "event:unknown",
    option.participant_id ?? option.participant_display_name,
    option.market_type,
    dateKey,
  ].join("|");
}

function collapseManualCatalog(rows: ParlayOptionRow[]) {
  const grouped = new Map<string, ParlayOptionRow[]>();
  for (const row of rows) {
    const key = manualCatalogGroupingKey(row);
    const bucket = grouped.get(key) ?? [];
    bucket.push(row);
    grouped.set(key, bucket);
  }

  return [...grouped.values()].map((bucket) => {
    const representative = [...bucket].sort((left, right) =>
      Number(right.covered_score ?? -Infinity) - Number(left.covered_score ?? -Infinity)
      || Number(right.match_confidence ?? 0) - Number(left.match_confidence ?? 0)
      || new Date(left.start_time ?? 0).getTime() - new Date(right.start_time ?? 0).getTime(),
    )[0];

    const sportsbookMap = new Map(
      bucket
        .flatMap((row) => row.sportsbooks?.length ? row.sportsbooks : row.sportsbook ? [row.sportsbook] : [])
        .map((book) => [book.id, book]),
    );

    return {
      ...representative,
      sportsbooks: [...sportsbookMap.values()],
      sportsbook_count: sportsbookMap.size,
      grouped_variant_count: bucket.length,
    };
  }).sort((left, right) =>
    Number(right.covered_score ?? -Infinity) - Number(left.covered_score ?? -Infinity)
    || Number(right.match_confidence ?? 0) - Number(left.match_confidence ?? 0)
    || new Date(left.start_time ?? 0).getTime() - new Date(right.start_time ?? 0).getTime()
    || left.participant_display_name.localeCompare(right.participant_display_name),
  );
}

export function buildManualCatalogRows(
  rows: ParlayOptionRow[],
  options: {
    date: string;
    league: string;
    marketType: string;
    search: string;
    scoreBand: ManualScoreBandValue;
    sortBy: ManualSortValue;
    limit?: number;
  },
) {
  const filtered = filterParlayOptionsSnapshotRows(rows, {
    date: options.date,
    sport: null,
    league: options.league,
    eventId: null,
    marketType: options.marketType,
    sportsbook: null,
    participantSearch: options.search,
    onlyScored: true,
    onlyMatched: false,
    excludeStaleOdds: false,
    excludeLowConfidenceMatches: false,
    limit: 250,
    includeVariantBooks: false,
  });

  const scoredOnly = filtered.filter((row) => row.covered_score != null && manualScoreBandMatches(row.covered_score, options.scoreBand));
  const collapsed = collapseManualCatalog(scoredOnly);
  const sorted = [...collapsed];
  sorted.sort((left, right) => {
    if (options.sortBy === "start") {
      return new Date(left.start_time ?? 0).getTime() - new Date(right.start_time ?? 0).getTime()
        || Number(right.covered_score ?? -Infinity) - Number(left.covered_score ?? -Infinity);
    }
    if (options.sortBy === "match") {
      return Number(right.match_confidence ?? 0) - Number(left.match_confidence ?? 0)
        || Number(right.covered_score ?? -Infinity) - Number(left.covered_score ?? -Infinity);
    }
    if (options.sortBy === "player") {
      return left.participant_display_name.localeCompare(right.participant_display_name)
        || new Date(left.start_time ?? 0).getTime() - new Date(right.start_time ?? 0).getTime();
    }
    return Number(right.covered_score ?? -Infinity) - Number(left.covered_score ?? -Infinity)
      || Number(right.match_confidence ?? 0) - Number(left.match_confidence ?? 0)
      || new Date(left.start_time ?? 0).getTime() - new Date(right.start_time ?? 0).getTime();
  });
  return sorted.slice(0, options.limit ?? 25);
}
