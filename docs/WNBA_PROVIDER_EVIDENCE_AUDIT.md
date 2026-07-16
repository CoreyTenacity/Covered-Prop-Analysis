# WNBA Provider Evidence Audit

**Date:** 2026-07-11
**Method:** Direct code inspection + live GitHub Actions runs (29170734654, 29170827236) + local network tests + live GitHub API calls to SportsDataverse repos. No speculation — every claim below is sourced.

---

## 1. Findings Summary

- **stats.nba.com is not reachable from GitHub Actions or this local sandbox, at all — full timeout, zero bytes, both endpoints tested.** This is not a "12s vs 18s" problem: with an 18-second timeout, both requests still consumed the full 18s and returned `AbortError`. Increasing the timeout further would not fix this on current evidence; the connection never completes.
- **ESPN's public WNBA endpoints (`site.api.espn.com`) work perfectly from GitHub Actions**: 88ms and 36ms response times, 200 OK, full player-level box score data including minutes, starter status, and all core box-score stats.
- **SportsDataverse's `wehoop-wnba-data` GitHub repo serves fresh parquet files directly** (no R required to fetch them) — 89ms download from GitHub Actions, and the most recent completed game in the file was played ~9 hours before the file's last commit. This is not a 48-hour lag; that number was unverified in the prior report and is now corrected by direct measurement.
- **The WNBA official injury endpoint (`www.wnba.com/api/injury-reports`) is real, documented nowhere officially, but works** — 75ms, 200 OK, valid JSON, from GitHub Actions. It is a different host from `stats.nba.com` and is not affected by whatever is blocking `stats.nba.com`.
- **`WeHoopWnbaAdapter` calls stats.nba.com exclusively.** It does not call ESPN, SportsDataverse, or any wehoop package/service. The name is an internal label only.
- **Ball Don't Lie requires an API key for every tier, including Free.** I do not have a key, so BDL could not be tested. This is a real unknown, not resolved by this audit.
- **I found and fixed a real safety bug** in `covered-live-pipeline.yml`: the diagnostic-only dispatch path did not actually skip `schedule-refresh` (which holds Supabase write credentials) on `workflow_dispatch` events — only on `schedule` events. Confirmed live: run `29170734654` executed `schedule-refresh` in parallel with the diagnostic despite the flag being set. No write occurred (the job failed at the fetch stage before any write step), but the isolation guarantee was broken. Fixed and re-verified in run `29170827236` — `schedule-refresh`, `gate`, and `pipeline` all correctly skipped.
- **Covered Score currently reads very little basketball data**, and none of it is "advanced stats." No PIE, net rating, usage%, four factors, or shot-location data is read anywhere in scoring or enrichment code, for either NBA or WNBA. This directly bears on whether BDL's GOAT tier ($39.99/mo) would produce any measurable improvement in the current scoring model.

---

## 2. Exact Endpoint Table (Test 1 — from code, not inferred)

| File | Function | Exact URL | Parameters | Timeout | Headers | Runtime caller |
|---|---|---|---|---:|---|---|
| `lib/knowledge/enrichment/basketball.ts:131-132` | `fetchScoreboardForDate()` | `https://stats.nba.com/stats/scoreboardv2` | `GameDate=MM/DD/YYYY`, `LeagueID=10`, `DayOffset=0` | **12,000ms** | `Accept`, `Origin: nba.com`, `Referer`, `User-Agent`, `x-nba-stats-origin`, `x-nba-stats-token` | `refreshBasketballSchedulesLiveGate`, `refreshBasketballSchedules`, `refreshBasketballCompletedGames` |
| `lib/providers/nba-com-stats.ts:193` | `searchPlayer()` | `https://stats.nba.com/stats/commonallplayers` | `LeagueID=10`, `Season`, `IsOnlyCurrentSeason=0` | 18,000ms | same as above | `WeHoopWnbaAdapter.searchPlayer` → `daily-roster-catalog.ts` |
| `lib/providers/nba-com-stats.ts:218` | `fetchCurrentPlayers()` | `https://stats.nba.com/stats/commonallplayers` | `LeagueID=10`, `Season`, `IsOnlyCurrentSeason=1` | 18,000ms | same | `refreshBasketballPlayers` |
| `lib/providers/nba-com-stats.ts:250` | `fetchPlayerGameLog()` | `https://stats.nba.com/stats/playergamelog` | `PlayerID`, `Season`, `LeagueID=10`, `PerMode=PerGame` | 18,000ms | same | `refreshBasketballPlayerLogs` |
| `lib/providers/nba-com-stats.ts:269` | `fetchLeagueTeamStats()` | `https://stats.nba.com/stats/leaguedashteamstats` | `LeagueID=10`, `Season`, +30 params | 18,000ms | same | `refreshBasketballMatchupFeatures` |
| `lib/providers/nba-com-stats.ts:283` | `fetchLeagueGameFinder()` | `https://stats.nba.com/stats/leaguegamefinder` | `LeagueID=10`, `Season` | 18,000ms | same | `refreshBasketballTeamLogs` |
| `lib/providers/official-injuries.ts:162,176-185` | `fetchReport("WNBA")` | `https://www.wnba.com/api/injury-reports` (index), then dynamic PDF URL | none / PDF link from index | 12,000ms (each) | `Accept: application/json`, `User-Agent: Mozilla/5.0 Covered/1.0` | `refreshBasketballInjuries` |
| `lib/knowledge/media.ts:63,70` | asset URL builders | `cdn.wnba.com/headshots/...`, `cdn.wnba.com/logos/...` | n/a (not fetched, only linked) | n/a | n/a | display only |

**Confirmed NOT present anywhere in the codebase:** `stats.wnba.com`, any ESPN endpoint, any SportsDataverse download, any Ball Don't Lie call, any ESPN or wehoop R invocation.

---

## 3. `WeHoopWnbaAdapter` Call Chain (Test 2)

```
caller (e.g. daily-roster-catalog.ts, live-board.ts, basketball.ts leagueAdapter())
  → WeHoopWnbaAdapter.method(..., leagueId = "10")
  → this.nba.method(...)          [private NbaComStatsAdapter instance]
  → NbaComStatsAdapter.fetchJson(url)
  → fetch("https://stats.nba.com/stats/...", { ...headers, signal: AbortSignal.timeout(18_000) })
```

**Confirmed:** `WeHoopWnbaAdapter` calls **stats.nba.com exclusively**, via a private `NbaComStatsAdapter` instance, using `LeagueID=10`. It does not call SportsDataverse, ESPN, or any wehoop package. It is a naming/wrapper layer only — the class name does not reflect the actual provider.

---

## 4. Live Test Results (Test 3 — actual GitHub Actions runs)

Script: `scripts/TEMP-diagnostic-wnba-multi-provider.mjs`, run via `.github/workflows/covered-live-pipeline.yml` (`wnba-diagnostic` job), triggered with `gh workflow run` and observed directly.

**Run:** [29170827236](https://github.com/CoreyTenacity/Covered/actions/runs/29170827236) — GitHub Actions, `ubuntu-latest`, 2026-07-11T22:37:54Z

| Provider | URL | Status | Duration | Bytes | Content-Type | Error |
|---|---|---:|---:|---:|---|---|
| stats.nba.com scoreboardv2 | `.../scoreboardv2?...LeagueID=10...` | — | 18,003ms | — | — | `AbortError: This operation was aborted` |
| stats.nba.com commonallplayers | `.../commonallplayers?LeagueID=10...` | — | 18,001ms | — | — | `AbortError: This operation was aborted` |
| ESPN scoreboard | `site.api.espn.com/.../wnba/scoreboard` | 200 | **88ms** | 53,842 | application/json | none |
| ESPN game summary/box score | `site.api.espn.com/.../wnba/summary?event=...` | 200 | **36ms** | 437,674 | application/json | none |
| SportsDataverse wehoop-wnba-data (parquet) | `raw.githubusercontent.com/.../wnba_schedule_2026.parquet` | 200 | **89ms** | 211,547 | application/octet-stream | none |
| wnba.com injury-reports index | `www.wnba.com/api/injury-reports` | 200 | **75ms** | 9,649 | application/json | none |

**Ball Don't Lie:** not tested — requires an API key I do not have. Confirmed via direct local `curl` (no key) → `401 Unauthorized` on `/wnba/v1/teams`, and with a garbage key → same `401`. This confirms the user's correction: **Free tier requires a valid key**, it cannot be tested key-less.

**Local sandbox cross-check (this machine, not GitHub Actions):** stats.nba.com timed out identically (three consecutive 15s attempts, zero bytes), while Google, ESPN, and Ball Don't Lie (401, but reachable) all responded in under 200ms. This is independent corroboration that the failure is specific to stats.nba.com's infrastructure, not GitHub Actions' network specifically — both cloud/datacenter-class IPs are affected the same way.

**Conclusion on the timeout hypothesis:** Disproven as a sufficient fix. An 18-second timeout was tested live and stats.nba.com still returned nothing. The failure mode is a connection that never completes (consistent with upstream bot-detection/IP blocking of datacenter ranges), not a slow-but-working endpoint.

---

## 5. SportsDataverse Freshness (Test 4 — measured, not assumed)

Source: `sportsdataverse/wehoop-wnba-data` (ESPN-backed), inspected directly via GitHub's Contents/Commits API.

- **Formats available:** `parquet`, `rds`, and (for player_box) `csv` — confirmed by directory listing (`wnba/schedules/{parquet,rds}`, `wnba/player_box/{csv,parquet,rds}`).
- **2026 season files exist** and are actively growing (`wnba_schedule_2026.parquet` = 211,547 bytes vs. ~55–98KB for prior seasons).
- **Last commit to `wnba_schedule_2026.parquet` and `player_box_2026.parquet`:** both `2026-07-11T10:44:34Z` (same workflow run updates both).
- **Most recent completed game in the schedule file:** `2026-07-11T02:00Z` (LA Sparks 102–87 Chicago Sky), with final score populated — i.e., a game that ended ~8–9 hours before the commit was already fully reflected.
- **Most recent game_date in player_box file:** `2026-07-10`, with 74 player rows for that date including full box-score fields (points, rebounds, assists, minutes, starter status) — sample verified directly (e.g., Kamilla Cardoso: 15 PTS, 8 REB, 2 AST, 28 MIN, starter=true).
- **Observed actual delay: same-day, on the order of single-digit hours** — not 48 hours. The 48-hour figure in the prior report was unverified and is now corrected.
- **Node.js can ingest these files directly** without R: confirmed via `pyarrow.parquet` reading the file with no conversion step required (schema: 74 columns for schedules, 30 for player_box, fully self-describing). A Node.js equivalent (e.g. `parquetjs` or `hyparquet`) would work the same way — no R runtime needed to consume the *published* files (R is only used by SportsDataverse's own pipeline to *produce* them).
- **Workflow schedule oddity:** `wehoop-wnba-data/.github/workflows/daily_wnba.yml` cron only literally covers Oct 18–31, Nov–Dec, Jan–Jun, and July 1–12 — it does not have a cron line covering July 13–October 17 (the back half of the season + playoffs, since ESPN's own schedule shows the 2026 season running April 3–October 20). However, the upstream `wehoop-wnba-raw` repo also fires on `push` via `repository_dispatch`, and I *observed real daily commits every single day from June 13–30* (outside any cron window my literal reading would predict), so there is a trigger mechanism (self-hosted runner and/or dispatch chaining) not fully visible from the YAML alone. **I cannot fully explain the discrepancy between the literal cron text and the observed daily cadence — this is a genuine unknown**, but the empirical evidence (daily commits, same-day freshness through 2026-07-11) is stronger than the static YAML reading, so I weight the observed behavior as reliable and flag the cron text as a documentation/config oddity worth watching, not a proven gap.

---

## 6. Data Field Comparison (Test 5)

Completed game used: New York Liberty vs. Minnesota Lynx, 2026-07-11 (ESPN event `401857057`).

| Required Covered field | Current source (stats.nba.com playergamelog) | ESPN / SportsDataverse | Ball Don't Lie |
|---|---|---|---|
| Minutes | `row.MIN` | `stats[0]` (label `MIN`) — confirmed present | Untested (no key) |
| Points | `row.PTS` | `stats[1]` (label `PTS`) — confirmed present | Untested |
| Rebounds | `row.REB` | `stats[5]` (label `REB`) — confirmed present | Untested |
| Assists | `row.AST` | `stats[6]` (label `AST`) — confirmed present | Untested |
| Steals | `row.STL` | `stats[8]` (label `STL`) — confirmed present | Untested |
| Blocks | `row.BLK` | `stats[9]` (label `BLK`) — confirmed present | Untested |
| Turnovers | `row.TOV` | `stats[7]` (label `TO`) — confirmed present | Untested |
| Three-pointers | not read by Covered today | `stats[2]` (label `3PT`, made-attempted format) — confirmed present | Untested |
| Field-goal attempts | not read by Covered today | `stats[2]`-adjacent (label `FG`, made-attempted) — confirmed present | Untested |
| Free-throw attempts | not read by Covered today | `stats[4]` (label `FT`, made-attempted) — confirmed present | Untested |
| Starter status | not available from stats.nba.com path in current code | `athlete.starter` boolean — confirmed present (verified `true`/`false` per player) | Untested |
| Team / opponent | via separate team lookup | `team.displayName` in same payload | Untested |
| Game date | `GameDate` param | `event.date` in same payload | Untested |
| Game ID | `GAME_ID` | `event.id` | Untested |

**Note:** ESPN's box score payload also includes `injuries` (team-level, per-game) and an `odds`/`pickcenter` section in the same response (empty for this particular game, but present as a field) — meaning a single ESPN request can carry box score + injury + odds-availability signals together, something the current stats.nba.com path does not do in one call.

**Ball Don't Lie column is entirely unverified** — this is a hard gap in this audit, not an assumption. It requires the user to supply an API key before any BDL claim (including field-level completeness) can be verified.

---

## 7. Current Covered Dependencies (Test 6)

Full detail from direct code trace (see prior message for file:line detail). Summary:

| Data type | Classification | Notes |
|---|---|---|
| `events` / schedules | **required now** | scoring reads `events` for matchup context |
| `players` / identity | **required now** | scoring selects `players` for identity matching |
| `basketball_player_features`, `player_recent_features` (L5/L10 avgs) | **required now** | scoring adapter reads these directly |
| `basketball_team_context` (`.pace`) | **required now** | adapter reads `.pace` |
| `basketball_opponent_context` (`.opponent_pace`, `.opponent_defensive_rating`) | **required now** | adapter reads both |
| `matchup_features` | **required now (fallback)** | used when opponent_context missing |
| `injuries` (`.status`, `.note`) | **required now** | adapter reads both |
| `player_game_logs` (points/rebounds/assists/minutes) | **useful enrichment** | rolled up into `player_recent_features`, not read raw |
| `player_game_logs` (steals/blocks/turnovers/fantasy_score) | **unused** | fetched and stored, never rolled up or read downstream |
| `team_game_logs` (pace/off/def rating) | **useful enrichment** | rolled into `team_recent_features` |
| `rest_context` (days_rest, back_to_back) | **unused** | loaded into scoring context object, never read by the basketball adapter |
| `refreshBasketballLineups` | **planned only** | function body literally returns `{ implemented: false }` — WNBA/NBA lineups are not populated at all |
| `games` table | **unused for scoring** | written, never selected by scoring-service |

**Advanced stats check:** No PIE, net rating, usage%, four factors, or shot-location fields appear anywhere in scoring or enrichment code for NBA or WNBA. Only `pace`, `offensive_rating`, `defensive_rating` are stored, and of those, scoring only ever reads `pace` and the *opponent's* `defensive_rating` — the team's own `offensive_rating`/`defensive_rating` are fetched but not read by the scoring adapter.

**Odds/props source check:** Both paths that populate `current_props` (`sharp-ingestion.ts`, `sharp-odds-ingestion.ts`) are hardcoded to `provider: "sharpapi"`. No other odds/props source feeds the live scoring pipeline. (`live-board.ts` references `sports-game-odds`/`the-odds-api` adapters but is a separate, disconnected pipeline that doesn't write `current_props` and isn't used by `scoring-service.ts`.)

**Direct implication for the BDL GOAT tier ($39.99/mo) decision:** its headline features — advanced stats and shot locations — would currently have **no consumer** in the scoring code. Its player/team game-stat endpoints would be useful only insofar as they replace the currently-broken stats.nba.com player-log path; its odds/props endpoints are redundant with the already-integrated SharpAPI.

---

## 8. Remaining Unknowns Requiring Further Testing

1. **Ball Don't Lie — completely unverified.** Requires a real API key (even Free tier) before any field-level, latency, or reliability claim can be made. This blocks a full "GOAT vs Free vs All-Star" ROI comparison.
2. **Whether stats.nba.com is blocked by IP range (datacenter/cloud) specifically, or by some other signal** (missing TLS fingerprint, missing cookies, etc.) — I have strong correlational evidence (identical failure from two independent cloud/CI environments, success from the same environments against every other tested host) but did not attempt to fingerprint the exact blocking mechanism (e.g., testing from a residential IP, or with a cookie-bearing browser session).
3. **The `wehoop-wnba-data` cron/dispatch discrepancy** (Section 5) — observed daily updates don't match the literal cron text; root mechanism not fully traced (likely a self-hosted runner or external dispatch not visible in the YAML I could read).
4. **`.rds` parsing from Node.js** — not tested (parquet was sufficient and is directly Node-consumable; `.rds` would need a dedicated library or R).
5. **wehoop-wnba-stats-data repo (NBA-Stats-backed, separate from the ESPN-backed repo tested above)** — not inspected in this pass; Section 5 findings apply only to the ESPN-backed `wehoop-wnba-data` repo, not the Stats-backed one the user separately flagged with the "daily workflow + proxy list" caveat.

---

## 9. Recommendation

**Add SportsDataverse ingestion (free, ESPN-backed) as the primary path for schedule/box-score/player-log data, with the existing WNBA official injury endpoint kept as-is.**

Reasoning, strictly from evidence above:

- stats.nba.com is confirmed unreachable from GitHub Actions with no timeout that fixes it — it cannot remain the primary path for anything.
- ESPN direct and SportsDataverse's published ESPN-backed files both work, are free, and carry every field Covered currently uses (minutes, points, rebounds, assists, steals, blocks, turnovers) plus fields it doesn't yet use but could (starter status, 3PT/FG/FT attempts, per-game injuries).
- SportsDataverse's published files are same-day fresh (not 48h), require no R runtime to consume, and are a lower-maintenance integration than scraping ESPN endpoints directly (no rate-limit risk, versioned by git commit, downloadable in one HTTP GET per file).
- Covered's actual scoring code does not consume anything that would require Ball Don't Lie's paid tiers (no advanced stats, no shot locations consumed; odds/props already come from SharpAPI). Paying $39.99/month today would fund capabilities Covered has no read path for.
- Ball Don't Lie Free/All-Star remain untested and could still be a reasonable low-cost catalog/injury source later, but there's no evidence-based case for prioritizing it over the free SportsDataverse path given the two produce comparable coverage for what Covered currently needs.

This recommendation is scoped to *data sourcing*, not implementation — no adapters, renames, or deletions have been made. `WeHoopWnbaAdapter` and `wnba-league-path.ts` are untouched pending a decision on migration approach.
