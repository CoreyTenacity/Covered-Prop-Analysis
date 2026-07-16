import { jsonRouteResponse } from "@/lib/api/route-response";
import { cronAuthorized } from "@/lib/providers/cron-auth";

export const runtime = "nodejs";

/**
 * Temporary diagnostic: Test if Vercel can reach stats.nba.com scoreboard endpoint
 *
 * This is Phase 1 of the WNBA schedule relay investigation.
 * It makes no database writes and does not invoke the live pipeline.
 *
 * Used to determine if GitHub Actions network isolation is the root cause of
 * schedule-refresh timeouts.
 */

function headers() {
  return {
    Accept: "application/json, text/plain, */*",
    Origin: "https://www.nba.com",
    Referer: "https://www.nba.com/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "x-nba-stats-origin": "stats",
    "x-nba-stats-token": "true",
  };
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  }).format(date);
}

function isValidDateFormat(dateStr: string): boolean {
  // Accept YYYY-MM-DD format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const date = new Date(`${dateStr}T12:00:00-04:00`);
  return !Number.isNaN(date.getTime());
}

export async function POST(request: Request) {
  // Authenticate
  if (!cronAuthorized(request.headers.get("authorization"))) {
    return jsonRouteResponse(
      "/api/cron/relay-wnba-schedule-diagnostic",
      { error: "Unauthorized" },
      { status: 401, cacheProfile: "no-store", rowsReturned: 0 }
    );
  }

  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const dateStr = body.date ? String(body.date).trim() : null;

    // Validate date
    if (!dateStr || !isValidDateFormat(dateStr)) {
      return jsonRouteResponse(
        "/api/cron/relay-wnba-schedule-diagnostic",
        {
          error: "Invalid date",
          details: "Date must be YYYY-MM-DD format",
          received: dateStr,
        },
        { status: 400, cacheProfile: "no-store", rowsReturned: 0 }
      );
    }

    // Parse and format the date
    const testDate = new Date(`${dateStr}T12:00:00-04:00`);
    const formatted = formatDate(testDate);

    // Build the exact URL used by fetchScoreboardForDate
    const leagueId = "10"; // WNBA only, hardcoded
    const url = `https://stats.nba.com/stats/scoreboardv2?GameDate=${encodeURIComponent(formatted)}&LeagueID=${encodeURIComponent(leagueId)}&DayOffset=0`;

    // Make the request with same headers and timeout as the original
    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutMs = 12_000; // Match the original timeout
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response | null = null;
    let error: Error | null = null;
    let responseText: string | null = null;
    let contentType: string | null = null;

    try {
      response = await fetch(url, {
        headers: headers(),
        signal: controller.signal,
        cache: "no-store",
      });
      clearTimeout(timeoutHandle);

      contentType = response.headers.get("content-type");
      responseText = await response.text().catch(() => null);
    } catch (e) {
      clearTimeout(timeoutHandle);
      error = e instanceof Error ? e : new Error(String(e));
    }

    const endTime = Date.now();
    const duration = endTime - startTime;
    const responseBytes = responseText ? responseText.length : 0;

    // Parse response
    let resultSetCount = 0;
    let parseError: string | null = null;

    if (responseText && !error) {
      try {
        const payload = JSON.parse(responseText) as { resultSets?: unknown[] };
        if (Array.isArray(payload.resultSets)) {
          resultSetCount = payload.resultSets.length;
        }
      } catch (e) {
        parseError = e instanceof Error ? e.message : String(e);
      }
    }

    // Build diagnostic result
    const result = {
      environment: "vercel",
      timestamp: new Date().toISOString(),
      testDate: formatted,
      leagueId,
      url,
      timeoutMs,
      durationMs: duration,
      httpStatus: response?.status ?? null,
      httpStatusText: response?.statusText ?? null,
      contentType,
      responseBytes,
      resultSetCount,
      success: !!response && response.ok && !error && !parseError,
      error: error ? {
        name: error.name,
        message: error.message,
      } : null,
      parseError,
    };

    return jsonRouteResponse(
      "/api/cron/relay-wnba-schedule-diagnostic",
      result,
      {
        status: result.success ? 200 : 502,
        cacheProfile: "no-store",
        rowsReturned: 0,
      }
    );
  } catch (error) {
    return jsonRouteResponse(
      "/api/cron/relay-wnba-schedule-diagnostic",
      {
        error: "Internal error",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500, cacheProfile: "no-store", rowsReturned: 0 }
    );
  }
}
