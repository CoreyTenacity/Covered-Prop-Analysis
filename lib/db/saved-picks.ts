import type { PickRecord, PickResult } from "@/lib/types";
import { describeGradingResult } from "./grading.ts";
import { resolveProviderBoxScore } from "@/lib/providers/box-score-grading.ts";

type SavedPickRow = {
  id: string;
  opportunity_id: string;
  saved_at: string;
  sport: PickRecord["sport"];
  player_name: string;
  team: string;
  opponent: string;
  stat_type: string;
  line: number;
  direction: PickRecord["direction"];
  covered_score: number;
  recommendation_label: PickRecord["recommendationLabel"];
  confidence: PickRecord["confidence"] | null;
  result: PickResult;
  notes: string;
  source: PickRecord["source"];
  player_id: string | null;
  game_id: string | null;
  actual_value: number | null;
  graded_at: string | null;
  grading_note: string | null;
  grading_status: PickRecord["gradingStatus"];
  created_at?: string;
  updated_at?: string;
};

function configuration() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Supabase saved picks is not configured.");
  if (!key.startsWith("sb_secret_") && !key.startsWith("eyJ")) {
    throw new Error("Supabase saved picks requires a secret or service-role key, not a publishable key.");
  }
  return { url, key };
}

function headers(key: string) {
  const result: Record<string, string> = { apikey: key, "Content-Type": "application/json" };
  if (key.startsWith("eyJ")) result.Authorization = `Bearer ${key}`;
  return result;
}

async function request(path: string, init: RequestInit = {}) {
  const { url, key } = configuration();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...headers(key),
      ...init.headers,
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Saved picks request failed with status ${response.status}${detail ? `: ${detail}` : "."}`);
  }
  return response;
}

function encode(value: string) {
  return encodeURIComponent(value);
}

export async function listSavedPicks(): Promise<PickRecord[]> {
  const response = await request("saved_picks?select=*&order=saved_at.desc");
  const rows = await response.json() as SavedPickRow[];
  return rows.map((row) => ({
    id: row.id,
    opportunityId: row.opportunity_id,
    savedAt: row.saved_at,
    sport: row.sport as PickRecord["sport"],
    playerName: row.player_name,
    team: row.team,
    opponent: row.opponent,
    statType: row.stat_type,
    line: Number(row.line),
    direction: row.direction as PickRecord["direction"],
    coveredScore: row.covered_score,
    recommendationLabel: row.recommendation_label as PickRecord["recommendationLabel"],
    confidence: row.confidence ?? undefined,
    result: row.result as PickResult,
    notes: row.notes,
    source: row.source as PickRecord["source"],
    playerId: row.player_id ?? undefined,
    gameId: row.game_id ?? undefined,
    actualValue: typeof row.actual_value === "number" ? row.actual_value : undefined,
    gradedAt: row.graded_at ?? undefined,
    gradingNote: row.grading_note ?? undefined,
    gradingStatus: row.grading_status as PickRecord["gradingStatus"],
  }));
}

export async function upsertSavedPick(pick: PickRecord) {
  await request("saved_picks?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      id: pick.id,
      opportunity_id: pick.opportunityId,
      saved_at: pick.savedAt,
      sport: pick.sport,
      player_name: pick.playerName,
      team: pick.team,
      opponent: pick.opponent,
      stat_type: pick.statType,
      line: pick.line,
      direction: pick.direction,
      covered_score: pick.coveredScore,
      recommendation_label: pick.recommendationLabel,
      confidence: pick.confidence ?? null,
      result: pick.result,
      notes: pick.notes,
      source: pick.source,
      player_id: pick.playerId ?? null,
      game_id: pick.gameId ?? null,
      actual_value: pick.actualValue ?? null,
      graded_at: pick.gradedAt ?? null,
      grading_note: pick.gradingNote ?? null,
      grading_status: pick.gradingStatus ?? "manual",
      updated_at: new Date().toISOString(),
    }),
  });
}

export async function gradeSavedPick(input: {
  id: string;
  actualValue: number;
  line: number;
  direction: PickRecord["direction"];
  gradingNote?: string;
}) {
  const result = input.direction === "More"
    ? (input.actualValue > input.line ? "hit" : input.actualValue < input.line ? "miss" : "push")
    : (input.actualValue < input.line ? "hit" : input.actualValue > input.line ? "miss" : "push");
  await request(`saved_picks?id=eq.${encode(input.id)}`, {
    method: "PATCH",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      actual_value: input.actualValue,
      result,
      graded_at: new Date().toISOString(),
      grading_note: input.gradingNote ?? describeGradingResult(input.actualValue, input.line, input.direction, result),
      grading_status: "graded-auto",
      updated_at: new Date().toISOString(),
    }),
  });
  return result;
}

export async function gradePendingSavedPicks() {
  const errors: string[] = [];
  let rows: SavedPickRow[] = [];
  try {
    const response = await request("saved_picks?grading_status=in.(manual,pending-auto)&select=*");
    rows = await response.json() as SavedPickRow[];
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load pending saved picks.";
    errors.push(message);
    return { graded: [] as Array<{ id: string; result: PickResult }>, errors, pending: 0 };
  }

  const graded: Array<{ id: string; result: PickResult }> = [];
  for (const row of rows) {
    try {
      const explicitActual = typeof row.actual_value === "number" ? row.actual_value : null;
      const providerResolution = explicitActual === null
        ? await resolveProviderBoxScore({
          sport: row.sport,
          playerName: row.player_name,
          playerId: row.player_id ?? undefined,
          gameId: row.game_id ?? undefined,
          statType: row.stat_type,
        })
        : null;

      if (explicitActual !== null) {
        const result = await gradeSavedPick({
          id: row.id,
          actualValue: explicitActual,
          line: Number(row.line),
          direction: row.direction as PickRecord["direction"],
        });
        graded.push({ id: row.id, result });
        continue;
      }

      if (providerResolution?.status === "resolved" && typeof providerResolution.actualValue === "number") {
        const result = await gradeSavedPick({
          id: row.id,
          actualValue: providerResolution.actualValue,
          line: Number(row.line),
          direction: row.direction as PickRecord["direction"],
          gradingNote: providerResolution.note,
        });
        graded.push({ id: row.id, result });
        continue;
      }

      await request(`saved_picks?id=eq.${encode(row.id)}`, {
        method: "PATCH",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          grading_status: "pending-auto",
          grading_note: providerResolution?.note ?? "Waiting for a confirmed provider box-score value.",
          updated_at: new Date().toISOString(),
        }),
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Failed to grade ${row.id}.`);
    }
  }
  return { graded, errors, pending: Math.max(0, rows.length - graded.length) };
}
