import type { ParlayOptionRow } from "@/lib/knowledge/read-types";
import type { AnalyzedParlay } from "@/lib/knowledge/parlay-analysis";
import type { ScoreInput, ScoreResult } from "@/lib/scoring/covered-score";

// Server-to-server only, same convention as lib/providers/cron-proxy.ts: the
// bearer secret lives in this process's environment and is never sent to the
// browser. The client calls our own /api/parlay-analysis route (same-origin,
// no secret needed), which calls this.
export async function analyzeParlaySelectionRemote(selected: ParlayOptionRow[]): Promise<
  | { ok: true; result: AnalyzedParlay }
  | { ok: false; status: number; error: string }
> {
  const secret = process.env.SCORING_ENGINE_SECRET;
  const baseUrl = process.env.SCORING_ENGINE_URL;
  if (!secret || !baseUrl) {
    return { ok: false, status: 503, error: "SCORING_ENGINE_URL/SCORING_ENGINE_SECRET is not configured." };
  }

  let response: Response;
  try {
    response = await fetch(new URL("/analyze-parlay", baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ selected }),
      cache: "no-store",
    });
  } catch (error) {
    return { ok: false, status: 502, error: error instanceof Error ? error.message : "Scoring engine request failed." };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { ok: false, status: response.status, error: text || "Scoring engine returned an error." };
  }

  const result = await response.json() as AnalyzedParlay;
  return { ok: true, result };
}

export async function scoreOpportunitiesRemote(inputs: ScoreInput[]): Promise<
  | { ok: true; scores: ScoreResult[] }
  | { ok: false; status: number; error: string }
> {
  const secret = process.env.SCORING_ENGINE_SECRET;
  const baseUrl = process.env.SCORING_ENGINE_URL;
  if (!secret || !baseUrl) {
    return { ok: false, status: 503, error: "SCORING_ENGINE_URL/SCORING_ENGINE_SECRET is not configured." };
  }

  let response: Response;
  try {
    response = await fetch(new URL("/score-opportunities", baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs }),
      cache: "no-store",
    });
  } catch (error) {
    return { ok: false, status: 502, error: error instanceof Error ? error.message : "Scoring engine request failed." };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { ok: false, status: response.status, error: text || "Scoring engine returned an error." };
  }

  const body = await response.json() as { scores?: ScoreResult[] };
  if (!Array.isArray(body.scores) || body.scores.length !== inputs.length) {
    return { ok: false, status: 502, error: "Scoring engine returned an invalid batch." };
  }
  return { ok: true, scores: body.scores };
}
