/**
 * The public workflow validates this same small contract before it invokes the
 * private pipeline. Keeping the contract here lets the private CLI reject a
 * malformed repository_dispatch even if the public YAML is changed later.
 */
export const COVERED_HEARTBEAT_EVENT = "covered-production-heartbeat";
export const COVERED_HEARTBEAT_SCHEMA = "covered-production-heartbeat/v1";
export const COVERED_HEARTBEAT_SOURCE = "cloudflare-cron";

const UTC_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/;

export type RepositoryDispatchHeartbeat = {
  slot: string;
};

/** Repository dispatch gets scheduling *selection*, never scheduled-only Policy C. */
export function repositoryDispatchPipelineTriggerType(): "manual" {
  return "manual";
}

export function isUtcMinute(value: string | null | undefined): value is string {
  if (!value || !UTC_MINUTE.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 16) + "Z" === value;
}

/**
 * This is deliberately narrower than a generic automation flag. Only the
 * exact public repository_dispatch contract may request scheduler resolution.
 * It does not change the pipeline's triggerType, so scheduled-only Policy C
 * behavior remains inactive.
 */
export function resolveRepositoryDispatchHeartbeat(input: {
  trigger: string | null | undefined;
  schedulerHeartbeat: string | boolean | null | undefined;
  league: string | null | undefined;
  slot: string | null | undefined;
}): RepositoryDispatchHeartbeat | null {
  const requested = input.schedulerHeartbeat === true || input.schedulerHeartbeat === "true";
  if (!requested) return null;
  if (input.trigger !== "repository_dispatch") {
    throw new Error("--schedulerHeartbeat true is only valid for repository_dispatch.");
  }
  if (input.league?.trim().toLowerCase() !== "auto") {
    throw new Error("repository_dispatch heartbeat requires --league auto.");
  }
  if (!isUtcMinute(input.slot)) {
    throw new Error("repository_dispatch heartbeat requires a canonical UTC --slot.");
  }
  return { slot: input.slot };
}
