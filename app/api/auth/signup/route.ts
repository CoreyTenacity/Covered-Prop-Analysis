import { NextRequest, NextResponse } from "next/server";

import { ensureProfile, setAuthCookies, signUpWithPassword } from "@/lib/auth/supabase-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { email?: string; password?: string; displayName?: string } | null;
  const email = body?.email?.trim().toLowerCase();
  const password = body?.password ?? "";
  const displayName = body?.displayName?.trim() || null;

  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }

  try {
    const payload = await signUpWithPassword({ email, password, displayName });
    if (!payload.user) {
      return NextResponse.json({ error: "Could not create the account." }, { status: 400 });
    }

    const profile = await ensureProfile(payload.user);
    const response = NextResponse.json({
      user: {
        id: payload.user.id,
        email: payload.user.email ?? null,
        displayName: profile.display_name ?? payload.user.email?.split("@")[0] ?? "Covered User",
      },
      requiresEmailConfirmation: !payload.session,
    });

    if (payload.session) setAuthCookies(response, payload.session);

    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not create the account." }, { status: 400 });
  }
}
