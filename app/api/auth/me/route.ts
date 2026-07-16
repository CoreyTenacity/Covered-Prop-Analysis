import { NextRequest, NextResponse } from "next/server";

import { clearAuthCookies, resolveRequestSessionUser, setAuthCookies } from "@/lib/auth/supabase-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { user, refreshedSession } = await resolveRequestSessionUser(request);
  const response = NextResponse.json({ user });

  if (refreshedSession) setAuthCookies(response, refreshedSession);
  if (!user) clearAuthCookies(response);

  return response;
}
