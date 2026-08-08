import type { GitHubActionsLeague } from "@/lib/ops/github-actions-league-registry";

export type ScheduledLeagueResolution = {
  trigger: string;
  dueLeagues: GitHubActionsLeague[];
  leagueSelection: "all" | "MLB" | "WNBA" | null;
  reason: string;
};

/**
 * Pure UTC heartbeat routing. Event-level eligibility remains the pipeline's
 * existing pregame gate; this only makes sure a reliable scheduled heartbeat
 * reaches every league whose operating window is open.
 */
export function resolveScheduledLeagues(input: {
  trigger: string | null | undefined;
  now: Date | string;
  requestedLeague?: string | null;
  schedulerEnabled: boolean;
  wnbaEnabled: boolean;
}): ScheduledLeagueResolution {
  const requested = input.requestedLeague?.trim().toUpperCase();
  if (input.trigger !== "schedule" && input.trigger !== "scheduled") {
    const dueLeagues: GitHubActionsLeague[] = requested && requested !== "ALL" ? [requested as GitHubActionsLeague] : ["MLB", "WNBA"];
    return { trigger: input.trigger ?? "manual", dueLeagues, leagueSelection: dueLeagues.length === 1 ? dueLeagues[0] as "MLB" | "WNBA" : "all", reason: "manual behavior is unchanged" };
  }
  if (!input.schedulerEnabled) return { trigger: "schedule", dueLeagues: [], leagueSelection: null, reason: "scheduler disabled" };

  const now = new Date(input.now);
  if (Number.isNaN(now.getTime())) throw new Error("resolveScheduledLeagues requires a valid UTC timestamp");
  const hour = now.getUTCHours();
  const mlbDue = hour >= 16 || hour <= 4;
  const wnbaDue = input.wnbaEnabled && (hour >= 22 || hour <= 4);
  // WNBA first during overlap so MLB's larger catalog cannot consume the shared
  // request budget before WNBA receives an attempted turn.
  const dueLeagues: GitHubActionsLeague[] = [
    ...(wnbaDue ? ["WNBA" as const] : []),
    ...(mlbDue ? ["MLB" as const] : []),
  ];
  return {
    trigger: "schedule",
    dueLeagues,
    leagueSelection: dueLeagues.length === 2 ? "all" : (dueLeagues[0] as "MLB" | "WNBA" | undefined) ?? null,
    reason: dueLeagues.length ? "UTC operating-window heartbeat" : "outside all league operating windows",
  };
}
