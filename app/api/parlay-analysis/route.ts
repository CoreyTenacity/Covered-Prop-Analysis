import { NextResponse } from "next/server";
import { analyzeParlaySelectionRemote } from "@/lib/knowledge/scoring-engine-client";
import type { ParlayOptionRow } from "@/lib/knowledge/read-types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let selected: ParlayOptionRow[] = [];
  try {
    const body = await request.json() as { selected?: unknown };
    if (!Array.isArray(body.selected)) throw new Error("`selected` must be an array.");
    selected = body.selected as ParlayOptionRow[];
  } catch {
    return NextResponse.json({ error: "Send a valid parlay selection." }, { status: 400 });
  }

  const outcome = await analyzeParlaySelectionRemote(selected);
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });

  return NextResponse.json(outcome.result);
}
