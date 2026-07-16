import { NextResponse } from "next/server";

import { selectRows } from "@/lib/db/supabase-server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const result = url.searchParams.get("result");
  const league = url.searchParams.get("league");
  const gradeStatus = url.searchParams.get("gradeStatus");
  const eventId = url.searchParams.get("eventId");
  const rows = await selectRows<Record<string, unknown>>("grading_results", {
    select: "id,scored_prop_id,current_prop_id,odds_snapshot_id,participant_id,participant_type,player_id,event_id,game_id,market_type,side,line,actual_value,final_stat,result,grade_status,grade_reason,grading_flags,grading_source,model_version_id,league_id,sport_id,notes,graded_at,created_at",
    filters: [
      ...(result ? [{ column: "result", value: result }] : []),
      ...(league ? [{ raw: `league_id=eq.${encodeURIComponent(league)}` }] : []),
      ...(gradeStatus ? [{ column: "grade_status", value: gradeStatus }] : []),
      ...(eventId ? [{ column: "event_id", value: eventId }] : []),
    ],
    orderBy: "graded_at.desc",
    limit: 100,
  });
  return NextResponse.json({ count: rows.length, rows });
}
