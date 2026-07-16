type BroadAction = "execute-props" | "execute-board" | "execute-enrichment";

const broadActionRouteMap: Record<BroadAction, string> = {
  "execute-props": "/api/cron/sharp-ingest or /api/cron/refresh-odds-api or /api/cron/refresh-sports-game-odds",
  "execute-board": "/api/cron/score-props and the product read endpoints",
  "execute-enrichment": "/api/cron/knowledge-refresh?job=...",
};

export function broadOperationsEnabled() {
  return process.env.ENABLE_BROAD_CRON_OPERATIONS === "true";
}

export function broadOperationPausedPayload(input: {
  route: string;
  action: BroadAction;
  reason?: string;
  durationMs?: number;
}) {
  return {
    mode: "free-tier-safety",
    status: "paused",
    route: input.route,
    action: input.action,
    durationMs: input.durationMs ?? 0,
    reason: input.reason ?? "This broad orchestration route is paused by default on the free-tier deployment path.",
    enableWith: "Set ENABLE_BROAD_CRON_OPERATIONS=true only if you intentionally want broad multi-step jobs.",
    recommendedRoute: broadActionRouteMap[input.action],
  };
}

export function cappedPositiveInteger(value: string | null, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}
