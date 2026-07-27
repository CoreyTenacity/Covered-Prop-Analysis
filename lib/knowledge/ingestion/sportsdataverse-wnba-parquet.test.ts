import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";

// Phase 3 — ZSTD parquet decode repair. The live SportsDataverse files
// (wehoop-wnba-data) are ZSTD-compressed; hyparquet only decodes
// UNCOMPRESSED + SNAPPY natively and threw "parquet unsupported compression
// codec: ZSTD" in production (run 29601049420). The fix passes
// hyparquet-compressors' pure-JS `compressors` map to every parquetReadObjects
// call in sportsdataverse-wnba.ts. These tests decode committed ZSTD fixtures
// with fzstd (no ZSTD *compressor* needed at test time, so no dependency on
// Node's zlib.zstdCompressSync). Regenerate fixtures with
// scripts/generate-sdv-zstd-fixtures.mjs.

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
function fixture(name: string): ArrayBuffer {
  const buf = readFileSync(path.join(FIXTURES, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

test("ZSTD schedule parquet parses with the compressors map (the live SDV codec)", async () => {
  const rows = await parquetReadObjects({
    file: fixture("wnba_schedule_2026.zstd.parquet"),
    compressors,
    columns: ["id", "date", "status_type_completed", "home_display_name", "away_display_name", "home_score", "away_score", "season"],
  }) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  // Newest completed game is 2026-07-14 (the regression watermark target).
  assert.deepEqual(rows.map((r) => String(r.date)).sort(), ["2026-07-10T23:00Z", "2026-07-14T23:30Z"]);
  const latest = rows.find((r) => String(r.date).startsWith("2026-07-14"))!;
  assert.equal(latest.home_display_name, "Toronto Tempo");
  assert.equal(latest.away_display_name, "Atlanta Dream");
  assert.equal(Number(latest.away_score), 88);
  assert.equal(latest.status_type_completed, true);
});

test("ZSTD player_box parquet parses with the compressors map", async () => {
  const rows = await parquetReadObjects({
    file: fixture("wnba_player_box_2026.zstd.parquet"),
    compressors,
    columns: ["game_id", "game_date", "athlete_id", "athlete_display_name", "team_id", "minutes", "points", "starter"],
  }) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => String(r.game_date) === "2026-07-14"));
  const howard = rows.find((r) => r.athlete_display_name === "Rhyne Howard")!;
  assert.equal(Number(howard.points), 24);
  assert.equal(howard.starter, true);
});

test("ZSTD team_box parquet parses with the compressors map", async () => {
  const rows = await parquetReadObjects({
    file: fixture("wnba_team_box_2026.zstd.parquet"),
    compressors,
    columns: ["game_id", "game_date", "team_id", "team_display_name", "team_score", "opponent_team_id", "field_goals_attempted", "offensive_rebounds", "total_turnovers"],
  }) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  const atl = rows.find((r) => r.team_display_name === "Atlanta Dream")!;
  assert.equal(Number(atl.team_score), 88);
  // pace inputs the ingestion reads (FGA/OREB/TOV/FTA) are present.
  assert.equal(Number(atl.field_goals_attempted), 70);
  assert.equal(Number(atl.offensive_rebounds), 9);
  assert.equal(Number(atl.total_turnovers), 12);
});

test("WITHOUT the compressors map, a ZSTD parquet throws the exact production error (proves the fix is load-bearing)", async () => {
  await assert.rejects(
    () => parquetReadObjects({ file: fixture("wnba_schedule_2026.zstd.parquet"), columns: ["id"] }),
    /parquet unsupported compression codec: ZSTD/,
  );
});

test("a non-ZSTD (SNAPPY) parquet still parses with the compressors map (no regression for other codecs)", async () => {
  const rows = await parquetReadObjects({
    file: fixture("wnba_schedule_2026.snappy.parquet"),
    compressors,
    columns: ["id", "date", "home_display_name"],
  }) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].home_display_name, "Toronto Tempo");
});

test("malformed ZSTD input fails cleanly (throws, does not hang or return garbage)", () => {
  // Corrupt bytes that are not a valid ZSTD frame -> the decoder must throw,
  // not loop or silently produce a bad buffer.
  const garbage = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
  assert.throws(() => compressors.ZSTD!(garbage, 64));
});
