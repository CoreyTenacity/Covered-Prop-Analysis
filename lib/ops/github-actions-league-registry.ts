import registryData from "./github-actions-league-registry.json" with { type: "json" };

export type GitHubActionsLeague = "MLB" | "WNBA" | "NBA" | "NFL" | "TENNIS";
export type GitHubActionsLeagueSelection = GitHubActionsLeague | "all";
export type GitHubActionsTriggerType = "scheduled" | "manual";
export type GitHubActionsLeagueOperationalStatus = "production" | "orchestration-only" | "disabled";
export type GitHubActionsPipelineStage = "sharp" | "score" | "board";
export type GitHubActionsLeagueEventModel = "game" | "match" | "tournament";
export type GitHubActionsLeagueParticipantModel = "team" | "player" | "mixed";

export type GitHubActionsLeagueCapability = {
  league: GitHubActionsLeague;
  aliases: string[];
  scheduledEnabled: boolean;
  sharpIngestionSupported: boolean;
  scoringSupported: boolean;
  boardBuildingSupported: boolean;
  gradingSupported: boolean;
  activeWindowSupported: boolean;
  activeWindowHoursBefore: number;
  activeWindowHoursAfter: number;
  eventModel: GitHubActionsLeagueEventModel;
  participantModel: GitHubActionsLeagueParticipantModel;
  supportsConcurrentEvents: boolean;
  supportsMultiDayEvents: boolean;
  operationalStatus: GitHubActionsLeagueOperationalStatus;
  seasonStatus: "in-season" | "offseason" | "unknown";
};

export type GitHubActionsLeagueStageRequirements = {
  sharp: boolean;
  score: boolean;
  board: boolean;
};

export type GitHubActionsLeagueSelectionResolution = {
  known: boolean;
  requestedSelection: GitHubActionsLeagueSelection;
  requestedLeague: GitHubActionsLeague | null;
  selectedLeagues: GitHubActionsLeagueCapability[];
  skippedLeagues: GitHubActionsLeagueCapability[];
  blockedLeagues: GitHubActionsLeagueCapability[];
  status: "ok" | "skipped" | "failed";
  reason: string;
};

const DEFAULT_CAPABILITIES = registryData as readonly GitHubActionsLeagueCapability[];

function normalizeToken(value: string | null | undefined) {
  return (value ?? "").trim().toUpperCase();
}

export function getGitHubActionsLeagueRegistry() {
  return DEFAULT_CAPABILITIES.map((capability) => ({ ...capability }));
}

export function normalizeGitHubActionsLeagueSelection(value: string | null | undefined): GitHubActionsLeagueSelection | null {
  const normalized = normalizeToken(value);
  if (!normalized || normalized === "ALL") return "all";
  const match = DEFAULT_CAPABILITIES.find((capability) => capability.aliases.some((alias) => normalizeToken(alias) === normalized));
  return match?.league ?? null;
}

export function getGitHubActionsLeagueCapability(league: string, registry: readonly GitHubActionsLeagueCapability[] = DEFAULT_CAPABILITIES) {
  const normalized = normalizeToken(league);
  return registry.find((capability) => capability.aliases.some((alias) => normalizeToken(alias) === normalized)) ?? null;
}

export function requestedStagesToRequirements(input: { runScoring: boolean; runBoard: boolean }): GitHubActionsLeagueStageRequirements {
  return {
    sharp: true,
    score: Boolean(input.runScoring),
    board: Boolean(input.runScoring && input.runBoard),
  };
}

export function leagueSupportsRequestedStages(
  capability: GitHubActionsLeagueCapability,
  requirements: GitHubActionsLeagueStageRequirements,
) {
  if (requirements.sharp && !capability.sharpIngestionSupported) return false;
  if (requirements.score && !capability.scoringSupported) return false;
  if (requirements.board && !capability.boardBuildingSupported) return false;
  return true;
}

export function resolveGitHubActionsLeagueSelection(input: {
  selection: GitHubActionsLeagueSelection;
  triggerType: GitHubActionsTriggerType;
  requirements: GitHubActionsLeagueStageRequirements;
  registry?: readonly GitHubActionsLeagueCapability[];
}): GitHubActionsLeagueSelectionResolution {
  const registry = input.registry ?? DEFAULT_CAPABILITIES;
  const requestedSelection = input.selection;
  const requestedLeague = requestedSelection === "all" ? null : getGitHubActionsLeagueCapability(requestedSelection, registry);

  if (requestedSelection !== "all" && !requestedLeague) {
    return {
      known: false,
      requestedSelection,
      requestedLeague: null,
      selectedLeagues: [],
      skippedLeagues: [],
      blockedLeagues: [],
      status: "failed",
      reason: `Unknown league selection: ${requestedSelection}.`,
    };
  }

  if (requestedLeague) {
    if (input.triggerType === "scheduled" && !requestedLeague.scheduledEnabled) {
      return {
        known: true,
        requestedSelection,
        requestedLeague: requestedLeague.league,
        selectedLeagues: [],
        skippedLeagues: [requestedLeague],
        blockedLeagues: [requestedLeague],
        status: "skipped",
        reason: `${requestedLeague.league} is known to the orchestrator but scheduled execution is disabled.`,
      };
    }

    if (!leagueSupportsRequestedStages(requestedLeague, input.requirements)) {
      return {
        known: true,
        requestedSelection,
        requestedLeague: requestedLeague.league,
        selectedLeagues: [],
        skippedLeagues: [],
        blockedLeagues: [requestedLeague],
        status: "failed",
        reason: `${requestedLeague.league} does not support the requested pipeline stages yet.`,
      };
    }

    return {
      known: true,
      requestedSelection,
      requestedLeague: requestedLeague.league,
      selectedLeagues: [requestedLeague],
      skippedLeagues: [],
      blockedLeagues: [],
      status: "ok",
      reason: `${requestedLeague.league} is ready for the requested pipeline stages.`,
    };
  }

  const selectedLeagues = registry.filter((capability) => capability.scheduledEnabled && leagueSupportsRequestedStages(capability, input.requirements));
  const skippedLeagues = registry.filter((capability) => !capability.scheduledEnabled);
  const blockedLeagues = registry.filter((capability) => capability.scheduledEnabled && !leagueSupportsRequestedStages(capability, input.requirements));

  if (!selectedLeagues.length) {
    return {
      known: true,
      requestedSelection,
      requestedLeague: null,
      selectedLeagues,
      skippedLeagues,
      blockedLeagues,
      status: input.triggerType === "scheduled" ? "skipped" : "failed",
      reason: input.triggerType === "scheduled"
        ? "No leagues are currently enabled for scheduled execution with the requested pipeline stages."
        : "No leagues are currently available for the requested pipeline stages.",
    };
  }

  return {
    known: true,
    requestedSelection,
    requestedLeague: null,
    selectedLeagues,
    skippedLeagues,
    blockedLeagues,
    status: "ok",
    reason: `Selected leagues: ${selectedLeagues.map((capability) => capability.league).join(", ")}.`,
  };
}
