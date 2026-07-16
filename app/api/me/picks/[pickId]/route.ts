import { NextRequest, NextResponse } from "next/server";

import { clearAuthCookies, resolveRequestSessionUser, setAuthCookies } from "@/lib/auth/supabase-auth";
import { UserTrackingError, deleteUserPick, updateUserPickTracking } from "@/lib/auth/user-tracking";

export const runtime = "nodejs";

function unauthorizedResponse() {
  const response = NextResponse.json({ error: "Login required." }, { status: 401 });
  clearAuthCookies(response);
  return response;
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ pickId: string }> },
) {
  const { user, refreshedSession } = await resolveRequestSessionUser(request);
  if (!user) return unauthorizedResponse();

  const { pickId } = await params;

  try {
    const result = await deleteUserPick(user.id, pickId);
    const response = NextResponse.json({ ok: true, ...result });
    if (refreshedSession) setAuthCookies(response, refreshedSession);
    return response;
  } catch (error) {
    if (error instanceof UserTrackingError) {
      const response = NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
      if (refreshedSession) setAuthCookies(response, refreshedSession);
      return response;
    }
    throw error;
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ pickId: string }> },
) {
  const { user, refreshedSession } = await resolveRequestSessionUser(request);
  if (!user) return unauthorizedResponse();

  const { pickId } = await params;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;

  try {
    const row = await updateUserPickTracking({
      userId: user.id,
      pickId,
      stakeUnits: typeof body?.stakeUnits === "number" ? body.stakeUnits : body?.stakeUnits === null ? null : undefined,
      notes: typeof body?.notes === "string" ? body.notes : body?.notes === null ? null : undefined,
    });

    const response = NextResponse.json({ row });
    if (refreshedSession) setAuthCookies(response, refreshedSession);
    return response;
  } catch (error) {
    if (error instanceof UserTrackingError) {
      const response = NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
      if (refreshedSession) setAuthCookies(response, refreshedSession);
      return response;
    }
    throw error;
  }
}
