import { NextResponse } from "next/server";
import { getDailyRosterCatalog } from "@/lib/providers/daily-roster-catalog";

export const runtime = "nodejs";

export async function GET() {
  try {
    const catalog = await getDailyRosterCatalog();
    return NextResponse.json(catalog);
  } catch (error) {
    return NextResponse.json({ players: [], providerErrors: [{ message: error instanceof Error ? error.message : "Roster catalog unavailable." }] }, { status: 200 });
  }
}
