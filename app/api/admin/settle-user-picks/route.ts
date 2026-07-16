import { NextResponse } from "next/server";

import { runAutomaticUserSettlement } from "@/lib/auth/user-settlement";
import { refreshAuthorized } from "@/lib/providers/refresh-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const startedAt = Date.now();
  if (!refreshAuthorized(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized.", route: "/api/admin/settle-user-picks", durationMs: Date.now() - startedAt }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({})) as {
      limit?: unknown;
      userId?: unknown;
    };

    const summary = await runAutomaticUserSettlement({
      limit: typeof body.limit === "number" ? body.limit : undefined,
      userId: typeof body.userId === "string" ? body.userId : undefined,
    });

    return NextResponse.json({
      mode: "user-pick-settlement",
      route: "/api/admin/settle-user-picks",
      status: "ok",
      ...summary,
      durationMs: summary.durationMs ?? Date.now() - startedAt,
    });
  } catch (error) {
    return NextResponse.json({
      mode: "user-pick-settlement",
      route: "/api/admin/settle-user-picks",
      status: "error",
      processedPicks: 0,
      settledPicks: 0,
      processedParlays: 0,
      settledParlays: 0,
      skippedOrPending: 0,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Unknown settlement error.",
    }, { status: 500 });
  }
}
