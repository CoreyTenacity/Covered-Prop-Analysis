import { jsonRouteResponse } from "@/lib/api/route-response";
import { selectRows } from "@/lib/db/supabase-server";
import { refreshAuthorized } from "@/lib/providers/refresh-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!refreshAuthorized(request.headers.get("authorization"))) {
    return jsonRouteResponse("/api/knowledge/provider-audit", {
      error: "Unauthorized.",
      route: "/api/knowledge/provider-audit",
      reason: "Provider audit is an operational endpoint and is not public on the free-tier deployment path.",
    }, { status: 401, cacheProfile: "no-store", rowsReturned: 0 });
  }

  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") ?? "sharpapi";
  const league = url.searchParams.get("league");
  const matchStatus = url.searchParams.get("matchStatus");
  const includeRows = url.searchParams.get("includeRows") === "true";
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? (includeRows ? 100 : 25)), 1), includeRows ? 200 : 50);

  const [snapshots, currentProps] = await Promise.all([
    selectRows<Record<string, unknown>>("odds_snapshots", {
      select: "id,provider,sport_id,league_id,event_id,participant_id,participant_type,provider_event_id,provider_prop_key,player_name,market_type,line,direction,match_status,match_confidence,pulled_at",
      filters: [
        { column: "provider", value: provider },
        ...(league ? [{ column: "league_id", value: league }] : []),
        ...(matchStatus ? [{ column: "match_status", value: matchStatus }] : []),
      ],
      orderBy: "pulled_at.desc",
      limit,
    }),
    selectRows<Record<string, unknown>>("current_props", {
      select: "id,provider,sport_id,league_id,event_id,participant_id,participant_type,provider_event_id,provider_prop_key,player_name,market_type,line,direction,match_status,match_confidence,active,updated_at",
      filters: [
        { column: "provider", value: provider },
        ...(league ? [{ column: "league_id", value: league }] : []),
        ...(matchStatus ? [{ column: "match_status", value: matchStatus }] : []),
      ],
      orderBy: "updated_at.desc",
      limit,
    }),
  ]);

  const payload = {
    provider,
    league,
    snapshotCount: snapshots.length,
    currentPropCount: currentProps.length,
    snapshots: includeRows ? snapshots : snapshots.slice(0, 10),
    currentProps: includeRows ? currentProps : currentProps.slice(0, 10),
  };

  return jsonRouteResponse("/api/knowledge/provider-audit", payload, {
    cacheProfile: "private-debug",
    rowsReturned: payload.snapshotCount + payload.currentPropCount,
  });
}
