import { NextResponse } from "next/server";
import { analyzeParlaySelectionRemote } from "@/lib/knowledge/scoring-engine-client";
import { classifyProp } from "@/lib/knowledge/pipeline/readiness-classifier";
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

  // Per-leg readiness from the SAME canonical scored record (no re-enrichment /
  // re-scoring): the Manual Analyzer surfaces score_ready / score_limited /
  // score_blocked + the exact blocked-context reasons per leg, so a score_blocked
  // leg is never presented as fully analyzed. Unlike Covered Picks, the analyzer
  // does NOT apply the >=70 floor - it shows the true score, including sub-70.
  const readinessByPropId = Object.fromEntries(
    selected
      .filter((row) => row && typeof row.current_prop_id === "string")
      .map((row) => {
        const classified = classifyProp({ propId: row.current_prop_id, publishabilityReasons: row.publishability_reasons ?? [] });
        return [row.current_prop_id, { state: classified.state, blockers: classified.blockers.map((b) => ({ field: b.field, cause: b.cause })) }];
      }),
  );

  return NextResponse.json({ ...outcome.result, readinessByPropId });
}
