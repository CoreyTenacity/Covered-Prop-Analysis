/**
 * Explicit, DST-safe Eastern calendar-day bounds for the "prepared slate":
 * remaining-today + all-tomorrow, Eastern, nothing further. This is the
 * single source of truth for that boundary -- both the private pipeline
 * gate (lib/ops/github-actions-pipeline.ts, which event IDs to prepare) and
 * the public read layer (lib/knowledge/read-service.ts, which rows a public
 * reader/snapshot/relational-fallback may return) import this same
 * calculation rather than each computing their own. Do not duplicate this
 * math elsewhere -- import preparedSlateEventWindow instead.
 */

function easternDateStr(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Pure calendar-date arithmetic (Y/M/D integers via Date.UTC's day-overflow
 * normalization) -- deliberately NOT "+24h in absolute ms", which can land on
 * the wrong Eastern calendar date on a DST-transition day (a 23h or 25h day
 * in absolute terms). */
function addEasternCalendarDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** How far Eastern local time is from UTC at this exact instant (negative,
 * e.g. -4h during EDT, -5h during EST) -- correct across DST because it asks
 * for the offset AT this specific moment, not a fixed constant. */
function easternOffsetMsAt(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtcIfLocal = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtcIfLocal - utcMs;
}

/** The exact UTC instant of 00:00:00.000 Eastern on the given Y-M-D date.
 * DST-safe: the offset is evaluated at the naive midnight-UTC guess, and US
 * DST transitions always occur at 2am local, never at midnight, so there is
 * no ambiguity at the boundary this function computes. */
function easternMidnightUtcMs(dateStr: string): number {
  const naiveUtcMs = Date.parse(`${dateStr}T00:00:00.000Z`);
  return naiveUtcMs - easternOffsetMsAt(naiveUtcMs);
}

export type PreparedSlateEventWindow = {
  startMs: number;
  startIso: string;
  endMs: number;
  endIso: string;
  todayEastern: string;
  tomorrowEastern: string;
  dayAfterTomorrowEastern: string;
};

/**
 * Explicit, DST-safe bounds for the prepared-slate scope: from "now" (so
 * already-started events are excluded) through the exclusive start of the
 * day after tomorrow, Eastern. This is deliberately NOT a rolling "+48h"
 * window -- a rolling window can include part of the day after tomorrow, or
 * exclude tomorrow-night games, depending on what hour "now" happens to be.
 */
export function preparedSlateEventWindow(now: Date): PreparedSlateEventWindow {
  const todayEastern = easternDateStr(now);
  const tomorrowEastern = addEasternCalendarDays(todayEastern, 1);
  const dayAfterTomorrowEastern = addEasternCalendarDays(todayEastern, 2);
  const endMs = easternMidnightUtcMs(dayAfterTomorrowEastern);
  return {
    startMs: now.getTime(),
    startIso: now.toISOString(),
    // Exclusive upper bound: the instant day-after-tomorrow begins, Eastern.
    endMs,
    endIso: new Date(endMs).toISOString(),
    todayEastern,
    tomorrowEastern,
    dayAfterTomorrowEastern,
  };
}
