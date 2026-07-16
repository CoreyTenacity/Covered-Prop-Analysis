import { selectRows } from "@/lib/db/supabase-server";
import type { KnowledgeJobLeague } from "@/lib/knowledge/types";

// Informational completeness checks. These never throw and never fail a job:
// a validation outage must not take down an otherwise healthy enrichment run.

export type CompletenessCheck = {
  key: string;
  label: string;
  covered: number;
  total: number;
  pct: number | null;
};

export type CompletenessReport = {
  scope: string;
  league: KnowledgeJobLeague | null;
  checkedAt: string;
  checks: CompletenessCheck[];
  error?: string;
};

// external_ids keys are the identity keys each league's log ingestion reads.
// Verified against lib/knowledge/enrichment/basketball.ts and mlb.ts.
const PLAYER_IDENTITY_KEY: Record<KnowledgeJobLeague, string> = {
  WNBA: "wehoop-wnba",
  NBA: "nba-com-stats",
  MLB: "mlb-stats-api",
};

const PLAYER_SCAN_LIMIT = 1000;
const PROP_SCAN_LIMIT = 1000;

function check(key: string, label: string, covered: number, total: number): CompletenessCheck {
  return {
    key,
    label,
    covered,
    total,
    pct: total ? Number(((100 * covered) / total).toFixed(1)) : null,
  };
}

function hasExternalId(externalIds: Record<string, unknown> | null | undefined, key: string) {
  const value = externalIds?.[key];
  return value !== null && value !== undefined && String(value).trim().length > 0;
}

export async function collectPlayerIdentityCompleteness(league: KnowledgeJobLeague): Promise<CompletenessReport> {
  const checkedAt = new Date().toISOString();
  try {
    const identityKey = PLAYER_IDENTITY_KEY[league];
    const rows = await selectRows<{
      id: string;
      external_ids: Record<string, unknown> | null;
      headshot_url: string | null;
      current_team_id: string | null;
    }>("players", {
      select: "id,external_ids,headshot_url,current_team_id",
      filters: [{ column: "league_id", value: league.toLowerCase() }],
      limit: PLAYER_SCAN_LIMIT,
    });

    const total = rows.length;
    return {
      scope: "players",
      league,
      checkedAt,
      checks: [
        check(
          `external_ids.${identityKey}`,
          `${league} players with ${identityKey} id (gates player-log ingestion)`,
          rows.filter((row) => hasExternalId(row.external_ids, identityKey)).length,
          total,
        ),
        check(
          "current_team_id",
          `${league} players with a current team`,
          rows.filter((row) => Boolean(row.current_team_id)).length,
          total,
        ),
        check(
          "headshot_url",
          `${league} players with a stored headshot (display only, not a scoring input)`,
          rows.filter((row) => Boolean(row.headshot_url?.trim())).length,
          total,
        ),
      ],
    };
  } catch (error) {
    return {
      scope: "players",
      league,
      checkedAt,
      checks: [],
      error: error instanceof Error ? error.message : "Unknown validation error",
    };
  }
}

export async function collectPublishableCompleteness(league: KnowledgeJobLeague): Promise<CompletenessReport> {
  const checkedAt = new Date().toISOString();
  try {
    const rows = await selectRows<{
      id: string;
      prop_state: string | null;
      player_id: string | null;
      team_id: string | null;
      opponent_team_id: string | null;
      start_time: string | null;
    }>("current_props", {
      select: "id,prop_state,player_id,team_id,opponent_team_id,start_time",
      filters: [
        { column: "league_id", value: league.toLowerCase() },
        { column: "active", value: true },
      ],
      orderBy: "updated_at.desc",
      limit: PROP_SCAN_LIMIT,
    });

    const total = rows.length;
    const now = Date.now();
    return {
      scope: "current_props",
      league,
      checkedAt,
      checks: [
        check("publishable", `${league} active props that are publishable`, rows.filter((row) => row.prop_state === "publishable").length, total),
        check("raw_current", `${league} active props never scored`, rows.filter((row) => row.prop_state === "raw_current").length, total),
        check("future_start_time", `${league} active props for future games`, rows.filter((row) => row.start_time && new Date(row.start_time).getTime() > now).length, total),
        check("player_id", `${league} active props matched to a player`, rows.filter((row) => Boolean(row.player_id)).length, total),
        check("team_and_opponent", `${league} active props with both team and opponent`, rows.filter((row) => Boolean(row.team_id && row.opponent_team_id)).length, total),
      ],
    };
  } catch (error) {
    return {
      scope: "current_props",
      league,
      checkedAt,
      checks: [],
      error: error instanceof Error ? error.message : "Unknown validation error",
    };
  }
}

export function formatCompletenessLines(report: CompletenessReport) {
  if (report.error) return [`- ${report.scope}: validation unavailable (${report.error})`];
  return report.checks.map((entry) => `- ${entry.label}: ${entry.covered}/${entry.total}${entry.pct === null ? "" : ` (${entry.pct}%)`}`);
}

export function formatCompletenessMarkdown(reports: CompletenessReport[]) {
  const sections = reports.flatMap((report) => [
    `#### ${report.scope}${report.league ? ` · ${report.league}` : ""}`,
    ...formatCompletenessLines(report),
    "",
  ]);
  return ["### Data completeness", ...sections].join("\n");
}
