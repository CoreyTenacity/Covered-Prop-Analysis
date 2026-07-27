// Dev-only generator for the SportsDataverse ZSTD parquet test fixtures.
// Run once with: node scripts/generate-sdv-zstd-fixtures.mjs
//
// The fixtures reproduce the failed-live shape (production run 29601049420):
// a completed game on 2026-07-14 for the referenced teams, so the ingestion +
// stale-only planner regression test can prove the watermark advances 07-10 ->
// 07-14 and the next plan then skips. They are ZSTD-compressed to exercise the
// hyparquet-compressors decode path the live SDV files require.
//
// Fixtures are decoded in tests with fzstd (pure JS, always available); only
// this generator needs a ZSTD *compressor*, so it uses Node's built-in
// zlib.zstdCompressSync (Node >= 22.15). The generator is not part of the app
// or the test run - regenerate only if the fixture shape must change.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import zlib from "node:zlib";
import { parquetWriteBuffer } from "hyparquet-writer";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "knowledge", "ingestion", "__fixtures__");
mkdirSync(OUT_DIR, { recursive: true });

if (typeof zlib.zstdCompressSync !== "function") {
  console.error("This Node lacks zlib.zstdCompressSync (need >= 22.15). Cannot generate ZSTD fixtures.");
  process.exit(1);
}
const zstdCompressors = { ZSTD: (bytes) => new Uint8Array(zlib.zstdCompressSync(bytes)) };

function writeParquet(name, columnData, { codec = "ZSTD" } = {}) {
  const buf = parquetWriteBuffer({ columnData, codec, compressors: codec === "ZSTD" ? zstdCompressors : undefined });
  const file = path.join(OUT_DIR, name);
  writeFileSync(file, Buffer.from(buf));
  console.log(`wrote ${name} (${Buffer.from(buf).length} bytes, codec=${codec})`);
}

// Synthetic external ids. INT32 (returned as JS number by hyparquet) matches the
// real wehoop-wnba-data schedule schema, which safeText() reads via String(number).
const ATL = 1611661330; // Atlanta Dream
const TOR = 1611661331; // Toronto Tempo
const col = (name, data, type) => ({ name, data, type });

// --- schedules: two completed games; newest is 2026-07-14 for ATL@TOR ---
writeParquet("wnba_schedule_2026.zstd.parquet", [
  col("id", [401700010, 401700011], "INT32"),
  col("date", ["2026-07-10T23:00Z", "2026-07-14T23:30Z"], "STRING"),
  col("status_type_completed", [true, true], "BOOLEAN"),
  col("home_id", [TOR, TOR], "INT32"),
  col("home_display_name", ["Toronto Tempo", "Toronto Tempo"], "STRING"),
  col("home_abbreviation", ["TOR", "TOR"], "STRING"),
  col("home_score", [78, 81], "INT32"),
  col("away_id", [ATL, ATL], "INT32"),
  col("away_display_name", ["Atlanta Dream", "Atlanta Dream"], "STRING"),
  col("away_abbreviation", ["ATL", "ATL"], "STRING"),
  col("away_score", [74, 88], "INT32"),
  col("venue_full_name", ["Coca-Cola Coliseum", "Coca-Cola Coliseum"], "STRING"),
  col("venue_address_city", ["Toronto", "Toronto"], "STRING"),
  col("venue_address_state", ["ON", "ON"], "STRING"),
  col("season", [2026, 2026], "INT32"),
]);

// --- player_box: a few athletes for the 2026-07-14 game (game_id 401700011) ---
writeParquet("wnba_player_box_2026.zstd.parquet", [
  col("game_id", [401700011, 401700011, 401700011], "INT32"),
  col("game_date", ["2026-07-14", "2026-07-14", "2026-07-14"], "STRING"),
  col("athlete_id", [3149391, 4066533, 4398674], "INT32"),
  col("athlete_display_name", ["Rhyne Howard", "Allisha Gray", "Cheyenne Parker"], "STRING"),
  col("team_id", [ATL, ATL, TOR], "INT32"),
  col("minutes", [34, 31, 28], "DOUBLE"),
  col("points", [24, 18, 15], "INT32"),
  col("rebounds", [6, 4, 9], "INT32"),
  col("assists", [5, 7, 2], "INT32"),
  col("steals", [2, 1, 0], "INT32"),
  col("blocks", [0, 0, 1], "INT32"),
  col("turnovers", [3, 2, 1], "INT32"),
  col("field_goals_made", [8, 6, 6], "INT32"),
  col("field_goals_attempted", [17, 13, 11], "INT32"),
  col("three_point_field_goals_made", [4, 2, 0], "INT32"),
  col("three_point_field_goals_attempted", [9, 5, 0], "INT32"),
  col("free_throws_made", [4, 4, 3], "INT32"),
  col("free_throws_attempted", [4, 5, 4], "INT32"),
  col("starter", [true, true, true], "BOOLEAN"),
]);

// --- team_box: both teams for the 2026-07-14 game ---
writeParquet("wnba_team_box_2026.zstd.parquet", [
  col("game_id", [401700011, 401700011], "INT32"),
  col("game_date", ["2026-07-14", "2026-07-14"], "STRING"),
  col("team_id", [ATL, TOR], "INT32"),
  col("team_display_name", ["Atlanta Dream", "Toronto Tempo"], "STRING"),
  col("team_score", [88, 81], "INT32"),
  col("opponent_team_id", [TOR, ATL], "INT32"),
  col("opponent_team_score", [81, 88], "INT32"),
  col("rebounds", [38, 34], "INT32"),
  col("offensive_rebounds", [9, 7], "INT32"),
  col("defensive_rebounds", [29, 27], "INT32"),
  col("assists", [21, 18], "INT32"),
  col("steals", [8, 5], "INT32"),
  col("blocks", [3, 4], "INT32"),
  col("turnovers", [12, 14], "INT32"),
  col("total_turnovers", [12, 14], "INT32"),
  col("field_goals_made", [32, 30], "INT32"),
  col("field_goals_attempted", [70, 68], "INT32"),
  col("free_throws_attempted", [18, 15], "INT32"),
]);

// --- a non-ZSTD (SNAPPY) schedule to prove other codecs still parse ---
writeParquet("wnba_schedule_2026.snappy.parquet", [
  col("id", [401700011], "INT32"),
  col("date", ["2026-07-14T23:30Z"], "STRING"),
  col("status_type_completed", [true], "BOOLEAN"),
  col("home_id", [TOR], "INT32"),
  col("home_display_name", ["Toronto Tempo"], "STRING"),
  col("home_abbreviation", ["TOR"], "STRING"),
  col("home_score", [81], "INT32"),
  col("away_id", [ATL], "INT32"),
  col("away_display_name", ["Atlanta Dream"], "STRING"),
  col("away_abbreviation", ["ATL"], "STRING"),
  col("away_score", [88], "INT32"),
  col("venue_full_name", ["Coca-Cola Coliseum"], "STRING"),
  col("venue_address_city", ["Toronto"], "STRING"),
  col("venue_address_state", ["ON"], "STRING"),
  col("season", [2026], "INT32"),
], { codec: "SNAPPY" });

console.log("done.");
