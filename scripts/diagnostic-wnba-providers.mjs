#!/usr/bin/env node

/**
 * Read-only reachability diagnostic for the WNBA data providers Covered
 * actually uses: ESPN (current schedule/box scores) and SportsDataverse
 * (historical box scores). No Supabase writes. No production job invocation.
 *
 * Used by the manual-only "wnba-diagnostic" job in
 * .github/workflows/wnba-data-ingestion.yml.
 */

const results = [];

async function timedFetch(label, url, options = {}) {
  const start = performance.now();
  const record = { label, url, status: null, ok: null, durationMs: null, bytes: null, contentType: null, errorName: null, errorMessage: null };
  try {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 15_000;
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { headers: options.headers ?? {}, signal: controller.signal, cache: "no-store" });
    clearTimeout(timeoutHandle);
    const buf = await response.arrayBuffer();
    record.status = response.status;
    record.ok = response.ok;
    record.bytes = buf.byteLength;
    record.contentType = response.headers.get("content-type");
    record.durationMs = Math.round(performance.now() - start);
  } catch (error) {
    record.durationMs = Math.round(performance.now() - start);
    record.errorName = error instanceof Error ? error.name : "UnknownError";
    record.errorMessage = error instanceof Error ? error.message : String(error);
  }
  results.push(record);
  return record;
}

async function main() {
  console.log(`WNBA provider diagnostic (ESPN + SportsDataverse) - ${new Date().toISOString()}`);
  console.log(`Environment: ${process.env.GITHUB_ACTIONS ? "github-actions" : process.env.VERCEL ? "vercel" : "local"}`);
  console.log("");

  const today = new Date();
  const compactDate = `${today.getUTCFullYear()}${String(today.getUTCMonth() + 1).padStart(2, "0")}${String(today.getUTCDate()).padStart(2, "0")}`;

  await timedFetch("ESPN scoreboard (today)", `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=${compactDate}`, { timeoutMs: 15_000 });
  await timedFetch("SportsDataverse schedules (current season)", `https://raw.githubusercontent.com/sportsdataverse/wehoop-wnba-data/main/wnba/schedules/parquet/wnba_schedule_${today.getUTCFullYear()}.parquet`, { timeoutMs: 20_000 });
  await timedFetch("SportsDataverse player_box (current season)", `https://raw.githubusercontent.com/sportsdataverse/wehoop-wnba-data/main/wnba/player_box/parquet/player_box_${today.getUTCFullYear()}.parquet`, { timeoutMs: 20_000 });
  await timedFetch("SportsDataverse team_box (current season)", `https://raw.githubusercontent.com/sportsdataverse/wehoop-wnba-data/main/wnba/team_box/parquet/team_box_${today.getUTCFullYear()}.parquet`, { timeoutMs: 20_000 });

  console.log("Results:");
  console.log(JSON.stringify(results, null, 2));
  console.log("");
  console.log("Summary: label | status | ok | durationMs | bytes | error");
  for (const r of results) {
    console.log(`${r.label} | ${r.status ?? "N/A"} | ${r.ok ?? "N/A"} | ${r.durationMs ?? "N/A"} | ${r.bytes ?? "N/A"} | ${r.errorName ? `${r.errorName}: ${r.errorMessage}` : "none"}`);
  }

  const anyFailed = results.some((r) => !r.ok);
  process.exit(anyFailed ? 1 : 0);
}

main().catch((error) => {
  console.error("Diagnostic crashed:", error);
  process.exit(1);
});
