import { NextRequest, NextResponse } from "next/server";

import { clearAuthCookies } from "@/lib/auth/supabase-auth";

export const runtime = "nodejs";

export async function POST(_request: NextRequest) {
  const response = NextResponse.json({ ok: true });
  clearAuthCookies(response);
  return response;
}
