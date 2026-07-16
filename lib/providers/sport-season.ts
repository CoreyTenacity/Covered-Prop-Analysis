import type { Sport } from "@/lib/types";

type MonthRange = [start: number, end: number];

const seasonWindows: Record<Sport, MonthRange[]> = {
  MLB: [[3, 10]],
  WNBA: [[4, 10]],
  NFL: [[8, 1]],
  NBA: [[9, 6]],
  Tennis: [[1, 12]],
};

const priorityCoverageOrder: Sport[] = ["MLB", "WNBA"];

function inWindow(month: number, [start, end]: MonthRange) {
  if (start <= end) return month >= start && month <= end;
  return month >= start || month <= end;
}

export function isSportInSeason(sport: Sport, now = new Date()) {
  const month = now.getMonth() + 1;
  return seasonWindows[sport].some((window) => inWindow(month, window));
}

export function activeSports(now = new Date()) {
  return (Object.keys(seasonWindows) as Sport[]).filter((sport) => isSportInSeason(sport, now));
}

export function priorityCoverageSports(now = new Date()): Array<Extract<Sport, "MLB" | "WNBA">> {
  return priorityCoverageOrder.filter((sport) => isSportInSeason(sport, now)) as Array<Extract<Sport, "MLB" | "WNBA">>;
}
