import type { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { selectRows, upsertRows } from "@/lib/db/supabase-server";

const ACCESS_COOKIE = "covered-access-token";
const REFRESH_COOKIE = "covered-refresh-token";

type AuthApiUser = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

type AuthSession = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: number | null;
  user: AuthApiUser;
};

export type SessionUser = {
  id: string;
  email: string | null;
  displayName: string;
};

function authConfiguration() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !publishableKey) {
    throw new Error("Supabase Auth requires NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY).");
  }
  return { url, publishableKey };
}

function normalizeAuthError(detail: string, status: number) {
  if (detail) {
    try {
      const parsed = JSON.parse(detail) as { error_code?: string; msg?: string; error?: string };
      if (parsed.error_code === "over_email_send_rate_limit") {
        return "confirmation email rate limit reached, please try again later";
      }
      if (parsed.error_code === "email_not_confirmed") {
        return "Email not confirmed. Please use the confirmation link in your inbox before logging in.";
      }
      if (typeof parsed.msg === "string" && parsed.msg.trim()) return parsed.msg.trim();
      if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    } catch {
      // Fall through to plain-text handling below.
    }

    return detail.slice(0, 400);
  }

  return `Auth request failed with status ${status}.`;
}

async function authRequest(path: string, init: RequestInit = {}) {
  const { url, publishableKey } = authConfiguration();
  const response = await fetch(`${url}/auth/v1/${path}`, {
    ...init,
    headers: {
      apikey: publishableKey,
      "Content-Type": "application/json",
      ...init.headers,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const message = normalizeAuthError(detail, response.status);
    throw new Error(message);
  }

  return response;
}

function authCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

export function setAuthCookies(response: NextResponse, session: AuthSession) {
  response.cookies.set(ACCESS_COOKIE, session.access_token, authCookieOptions(session.expires_in));
  response.cookies.set(REFRESH_COOKIE, session.refresh_token, authCookieOptions(60 * 60 * 24 * 30));
}

export function clearAuthCookies(response: NextResponse) {
  response.cookies.set(ACCESS_COOKIE, "", authCookieOptions(0));
  response.cookies.set(REFRESH_COOKIE, "", authCookieOptions(0));
}

export async function signUpWithPassword(input: { email: string; password: string; displayName?: string | null }) {
  const response = await authRequest("signup", {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      data: input.displayName ? { display_name: input.displayName } : undefined,
    }),
  });

  return response.json() as Promise<{ user: AuthApiUser | null; session: AuthSession | null }>;
}

export async function signInWithPassword(input: { email: string; password: string }) {
  const response = await authRequest("token?grant_type=password", {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      password: input.password,
    }),
  });

  return response.json() as Promise<AuthSession>;
}

export async function refreshSession(refreshToken: string) {
  const response = await authRequest("token?grant_type=refresh_token", {
    method: "POST",
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  return response.json() as Promise<AuthSession>;
}

export async function fetchAuthUser(accessToken: string) {
  const response = await authRequest("user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return response.json() as Promise<AuthApiUser>;
}

export async function ensureProfile(user: AuthApiUser) {
  const displayName = String(
    user.user_metadata?.display_name ??
      user.user_metadata?.full_name ??
      user.email?.split("@")[0] ??
      "Covered User",
  );

  await upsertRows("profiles", [{
    id: user.id,
    display_name: displayName,
  }], ["id"], { returning: "minimal" });

  const rows = await selectRows<{ id: string; display_name: string | null }>("profiles", {
    select: "id,display_name",
    filters: [{ column: "id", value: user.id }],
    limit: 1,
  });

  return rows[0] ?? { id: user.id, display_name: displayName };
}

export function readSessionCookiesFromRequest(request: NextRequest) {
  return {
    accessToken: request.cookies.get(ACCESS_COOKIE)?.value ?? null,
    refreshToken: request.cookies.get(REFRESH_COOKIE)?.value ?? null,
  };
}

export async function getServerSessionUser() {
  const store = await cookies();
  const accessToken = store.get(ACCESS_COOKIE)?.value;
  if (!accessToken) return null;

  try {
    const user = await fetchAuthUser(accessToken);
    const profile = await ensureProfile(user);
    return {
      id: user.id,
      email: user.email ?? null,
      displayName: profile.display_name ?? user.email?.split("@")[0] ?? "Covered User",
    } satisfies SessionUser;
  } catch {
    return null;
  }
}

export async function requireServerSessionUser(nextPath = "/my-picks") {
  const user = await getServerSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  return user;
}

export async function requireServerSession(nextPath = "/my-picks") {
  const store = await cookies();
  const accessToken = store.get(ACCESS_COOKIE)?.value;
  const refreshToken = store.get(REFRESH_COOKIE)?.value;
  if (!accessToken && !refreshToken) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }
}

export async function resolveRequestSessionUser(request: NextRequest) {
  const { accessToken, refreshToken } = readSessionCookiesFromRequest(request);

  if (!accessToken && !refreshToken) {
    return { user: null, refreshedSession: null };
  }

  try {
    if (accessToken) {
      const authUser = await fetchAuthUser(accessToken);
      const profile = await ensureProfile(authUser);
      return {
        user: {
          id: authUser.id,
          email: authUser.email ?? null,
          displayName: profile.display_name ?? authUser.email?.split("@")[0] ?? "Covered User",
        } satisfies SessionUser,
        refreshedSession: null,
      };
    }
  } catch {
    // Try refresh below.
  }

  if (!refreshToken) {
    return { user: null, refreshedSession: null };
  }

  try {
    const session = await refreshSession(refreshToken);
    const profile = await ensureProfile(session.user);
    return {
      user: {
        id: session.user.id,
        email: session.user.email ?? null,
        displayName: profile.display_name ?? session.user.email?.split("@")[0] ?? "Covered User",
      } satisfies SessionUser,
      refreshedSession: session,
    };
  } catch {
    return { user: null, refreshedSession: null };
  }
}

export type { AuthApiUser, AuthSession };
