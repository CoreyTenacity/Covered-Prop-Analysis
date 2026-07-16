import { NextRequest, NextResponse } from "next/server";

import { clearAuthCookies, resolveRequestSessionUser, setAuthCookies } from "@/lib/auth/supabase-auth";
import { UserTrackingError, listUserPicks, saveUserPick } from "@/lib/auth/user-tracking";

export const runtime = "nodejs";

function unauthorizedResponse() {
  const response = NextResponse.json({ error: "Login required." }, { status: 401 });
  clearAuthCookies(response);
  return response;
}

export async function GET(request: NextRequest) {
  const { user, refreshedSession } = await resolveRequestSessionUser(request);
  if (!user) return unauthorizedResponse();

  const rows = await listUserPicks(user.id);
  const response = NextResponse.json({ rows });
  if (refreshedSession) setAuthCookies(response, refreshedSession);
  return response;
}

export async function POST(request: NextRequest) {
  const { user, refreshedSession } = await resolveRequestSessionUser(request);
  if (!user) return unauthorizedResponse();

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  try {
    const row = await saveUserPick({
      userId: user.id,
      currentPropId: typeof body?.currentPropId === "string" ? body.currentPropId : null,
      scoredPropId: typeof body?.scoredPropId === "string" ? body.scoredPropId : null,
      oddsSnapshotId: typeof body?.oddsSnapshotId === "string" ? body.oddsSnapshotId : null,
      eventId: typeof body?.eventId === "string" ? body.eventId : null,
      participantId: typeof body?.participantId === "string" ? body.participantId : null,
      marketInstanceKey: typeof body?.marketInstanceKey === "string" ? body.marketInstanceKey : null,
      marketType: typeof body?.marketType === "string" ? body.marketType : null,
      side: typeof body?.side === "string" ? body.side : null,
      line: typeof body?.line === "number" ? body.line : null,
      oddsTaken: typeof body?.oddsTaken === "number" ? body.oddsTaken : null,
      sportsbookId: typeof body?.sportsbookId === "string" ? body.sportsbookId : null,
      stakeUnits: typeof body?.stakeUnits === "number" ? body.stakeUnits : null,
      status: typeof body?.status === "string" ? body.status : null,
      placedAt: typeof body?.placedAt === "string" ? body.placedAt : null,
    });

    const response = NextResponse.json({ row }, { status: 201 });
    if (refreshedSession) setAuthCookies(response, refreshedSession);
    return response;
  } catch (error) {
    if (error instanceof UserTrackingError) {
      const response = NextResponse.json({ error: error.message, code: error.code, row: error.payload ?? null }, { status: error.status });
      if (refreshedSession) setAuthCookies(response, refreshedSession);
      return response;
    }
    throw error;
  }
}
