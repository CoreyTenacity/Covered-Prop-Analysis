import { NextRequest, NextResponse } from "next/server";

import { clearAuthCookies, resolveRequestSessionUser, setAuthCookies } from "@/lib/auth/supabase-auth";
import { runAutomaticUserSettlement } from "@/lib/auth/user-settlement";

export const runtime = "nodejs";

function unauthorizedResponse() {
  const response = NextResponse.json({ error: "Login required." }, { status: 401 });
  clearAuthCookies(response);
  return response;
}

export async function POST(request: NextRequest) {
  const { user, refreshedSession } = await resolveRequestSessionUser(request);
  if (!user) return unauthorizedResponse();

  try {
    const summary = await runAutomaticUserSettlement({
      userId: user.id,
      limit: 100,
    });

    const response = NextResponse.json({
      status: "ok",
      ...summary,
    });
    if (refreshedSession) setAuthCookies(response, refreshedSession);
    return response;
  } catch (error) {
    const response = NextResponse.json({
      error: error instanceof Error ? error.message : "Could not refresh your saved results.",
    }, { status: 500 });
    if (refreshedSession) setAuthCookies(response, refreshedSession);
    return response;
  }
}
