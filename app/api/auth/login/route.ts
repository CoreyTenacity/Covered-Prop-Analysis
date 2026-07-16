import { NextRequest, NextResponse } from "next/server";

import { ensureProfile, setAuthCookies, signInWithPassword } from "@/lib/auth/supabase-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { email?: string; password?: string } | null;
  const email = body?.email?.trim().toLowerCase();
  const password = body?.password ?? "";

  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }

  try {
    const session = await signInWithPassword({ email, password });
    const profile = await ensureProfile(session.user);
    const response = NextResponse.json({
      user: {
        id: session.user.id,
        email: session.user.email ?? null,
        displayName: profile.display_name ?? session.user.email?.split("@")[0] ?? "Covered User",
      },
    });
    setAuthCookies(response, session);
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not log in." }, { status: 400 });
  }
}
