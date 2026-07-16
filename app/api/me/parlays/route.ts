import { NextRequest, NextResponse } from "next/server";

import { clearAuthCookies, resolveRequestSessionUser, setAuthCookies } from "@/lib/auth/supabase-auth";
import { UserTrackingError, listUserParlays, saveUserParlay } from "@/lib/auth/user-tracking";

export const runtime = "nodejs";

function unauthorizedResponse() {
  const response = NextResponse.json({ error: "Login required." }, { status: 401 });
  clearAuthCookies(response);
  return response;
}

export async function GET(request: NextRequest) {
  const { user, refreshedSession } = await resolveRequestSessionUser(request);
  if (!user) return unauthorizedResponse();

  const rows = await listUserParlays(user.id);
  const response = NextResponse.json({ rows });
  if (refreshedSession) setAuthCookies(response, refreshedSession);
  return response;
}

export async function POST(request: NextRequest) {
  const { user, refreshedSession } = await resolveRequestSessionUser(request);
  if (!user) return unauthorizedResponse();

  const body = await request.json().catch(() => null) as {
    stakeUnits?: number;
    combinedOdds?: number;
    status?: string;
    legs?: Array<Record<string, unknown>>;
  } | null;

  try {
    const row = await saveUserParlay({
      userId: user.id,
      stakeUnits: typeof body?.stakeUnits === "number" ? body.stakeUnits : null,
      combinedOdds: typeof body?.combinedOdds === "number" ? body.combinedOdds : null,
      status: typeof body?.status === "string" ? body.status : null,
      legs: Array.isArray(body?.legs) ? body!.legs.map((leg) => ({
        userPickId: typeof leg.userPickId === "string" ? leg.userPickId : null,
        scoredPropId: typeof leg.scoredPropId === "string" ? leg.scoredPropId : null,
        currentPropId: typeof leg.currentPropId === "string" ? leg.currentPropId : null,
        oddsSnapshotId: typeof leg.oddsSnapshotId === "string" ? leg.oddsSnapshotId : null,
        eventId: typeof leg.eventId === "string" ? leg.eventId : null,
        participantId: typeof leg.participantId === "string" ? leg.participantId : null,
        marketInstanceKey: typeof leg.marketInstanceKey === "string" ? leg.marketInstanceKey : null,
        marketType: typeof leg.marketType === "string" ? leg.marketType : null,
        side: typeof leg.side === "string" ? leg.side : null,
        line: typeof leg.line === "number" ? leg.line : null,
        oddsTaken: typeof leg.oddsTaken === "number" ? leg.oddsTaken : null,
        sportsbookId: typeof leg.sportsbookId === "string" ? leg.sportsbookId : null,
      })) : [],
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
