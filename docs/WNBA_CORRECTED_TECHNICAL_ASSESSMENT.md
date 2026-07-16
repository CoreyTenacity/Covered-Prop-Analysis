# WNBA Data Architecture: Corrected Technical Assessment

**Date:** 2026-07-11  
**Status:** Factual audit complete, architectural options under evaluation

---

## Part 1: Critical Corrections to Prior Analysis

### 1.1 Error: "wehoop is a fake/misleading service"

**CORRECTED:**
- wehoop IS a real SportsDataverse R package: https://github.com/sportsdataverse/wehoop
- It provides ~41 ESPN-backed WNBA data wrappers with full documentation
- The project is actively maintained (latest: v3.0.0, June 2026)
- **The error:** The current code labels this as a wrapper around `NbaComStatsAdapter`, which is misleading. The class name suggests ESPN integration but actually uses stats.nba.com

### 1.2 Error: "nba.com/wehoop does not exist"

**CORRECTED:**
- No such URL exists: `nba.com/wehoop` or `stats.nba.com/wehoop`
- These are not real endpoints
- **The actual architecture:** The current code uses `stats.nba.com` with `LeagueID=10` to access WNBA data
- `WeHoopWnbaAdapter` is merely a naming/wrapper layer; it does NOT call any wehoop service

### 1.3 Error: "Ball Don't Lie has an SLA and five-star reliability"

**CORRECTED:**
- No published SLA found in official Ball Don't Lie documentation
- No uptime commitment stated
- Reliability rating based on assumptions, not evidence
- **Facts only:** Ball Don't Lie is a documented REST API with OpenAPI spec and tiered access

### 1.4 Error: "Ball Don't Lie GOAT tier provides complete WNBA stats"

**CORRECTED:**
- Ball Don't Lie Free tier ($0): Teams, players, games, schedules, standings only
- All-Star tier ($9.99/mo): Adds injuries, play-by-play, standings
- GOAT tier ($39.99/mo): Adds player/team game stats, advanced stats, odds, props
- **Critical distinction:** Player game-by-game statistics are GOAT-tier ONLY. No free tier provides per-game stats.

### 1.5 Error: "Everything should come from one provider"

**CORRECTED:**
- Different data types have different optimal sources
- Ball Don't Lie is strongest for basic catalog (Free), injuries (All-Star), and advanced stats (GOAT)
- ESPN endpoints (direct calls) are free for schedules, rosters, transactions
- SportsDataverse publishes prepared datasets daily
- Covered should use a multi-source architecture based on cost/availability per data type

---

## Part 2: Exact Current Code Behavior

### 2.1 Network Endpoints Actually Used

**WNBA Scoreboard (stats.nba.com):**
```
GET https://stats.nba.com/stats/scoreboardv2
  ?GameDate=MM%2FDD%2FYYYY
  &LeagueID=10
  &DayOffset=0
  Timeout: 12 seconds
  Purpose: Fetch games and scores for a given date
```

**Other WNBA Stats (stats.nba.com, via NbaComStatsAdapter):**
```
GET https://stats.nba.com/stats/commonallplayers?LeagueID=10&...
GET https://stats.nba.com/stats/playergamelog?LeagueID=10&...
GET https://stats.nba.com/stats/leaguedashteamstats?LeagueID=10&...
  Timeout: 18 seconds (all methods)
  Purpose: Player rosters, game logs, team stats
```

**Official WNBA Injury Reports:**
```
GET https://www.wnba.com/api/injury-reports
  Timeout: 12 seconds
  Purpose: Fetch WNBA injury report index (JSON)
  
GET https://www.wnba.com/... (PDF URL from index)
  Timeout: 12 seconds
  Purpose: Fetch injury report PDF
```

**Media (CDN, not network requests):**
```
https://cdn.wnba.com/headshots/wnba/latest/1040x760/{playerId}.png
https://cdn.wnba.com/logos/wnba/{teamId}/primary/L/logo.svg
```

### 2.2 The Real Timeout Problem

**Current state:**
- `fetchScoreboardForDate()` (used for WNBA schedules) = **12-second timeout**
- Other `NbaComStatsAdapter` methods (players, stats, teams) = **18-second timeout**
- Diagnostic endpoint = **12-second timeout**
- Official WNBA injury endpoints = **12-second timeout**

**Hypothesis (not confirmed):**
- GitHub Actions network latency to stats.nba.com may exceed 12 seconds
- Local testing shows 471ms (well under 12s)
- Other stat endpoints use 18s successfully
- Timeout mismatch suggests scoreboardv2 may be treated differently or experience higher latency

**Unknown (requires testing):**
- Is it actually a timeout or a different error?
- Are GitHub Actions runners being rate-limited?
- Is the LeagueID=10 query valid on stats.nba.com?
- Does increasing timeout to 18s actually fix the issue?

### 2.3 What the Code Does NOT Do

**Does NOT use:**
- ❌ ESPN endpoints (would require direct HTTP calls or R package)
- ❌ WNBA Stats infrastructure directly (would require stats.wnba.com)
- ❌ Ball Don't Lie (no API key configured)
- ❌ SportsDataverse data releases (no download mechanism)
- ❌ Any wehoop R package (code is TypeScript)

**Does NOT integrate:**
- ❌ Player props from any source
- ❌ Advanced team/player metrics
- ❌ Shot location data
- ❌ Play-by-play data
- ❌ Official WNBA stats (only through stats.nba.com proxy)

---

## Part 3: Available Data Sources for WNBA

### 3.1 Ball Don't Lie (Documented REST API)

| Tier | Cost | Rate Limit | Key Endpoints | Best For |
|------|------|-----------|---------------|----------|
| Free | $0 | 5 req/min | /teams, /players, /games | Basic catalog; reference data |
| All-Star | $9.99/mo | 60 req/min | +/player_injuries, +/plays | Injuries; play-by-play narratives |
| GOAT | $39.99/mo | 600 req/min | +/player_stats, +/team_stats, +/odds | Game statistics; advanced metrics; betting lines |

**Free tier includes:**
- Teams (id, conference, city, abbreviation)
- Players (id, name, position, height, weight, age, team, jersey)
- Games (date, season, status, scores, periods)

**All-Star adds:**
- Active players (current roster status)
- Injuries (player, status, return_date, comment)
- Standings (W-L, seeds, conference records)
- Play-by-play (game events with scores and clock)

**GOAT adds:**
- Player game stats (minutes, FG, 3P, FT, rebounds, assists, steals, blocks, turnovers, points, +/-)
- Team game stats (same categories as players)
- Season aggregates (games played, season averages)
- Advanced stats (PIE, net rating, offensive/defensive rating, usage %)
- Shot locations (by zone or 5-foot range with FG%, FGM, FGA)
- Betting odds (spread, moneyline, total; sportsbook-specific)
- Player props (points, assists, rebounds, 3-pointers, double/triple-doubles)

**Limitations:**
- Player stats only in GOAT tier (no free option)
- Injury data appears current-season only (no historical)
- WNBA coverage started ~2023 (not historical 2002+)

### 3.2 ESPN Endpoints (via Direct HTTP)

**Host:** `site.api.espn.com`, `sports.core.api.espn.com`

**Coverage:**
- ✅ Teams, rosters, schedules (full historical)
- ✅ Scores, standings, news, transactions
- ✅ Player/team season stats (limited advanced)
- ✅ Draft, free agents, coaching staffs
- ✅ Broadcast info, officials, venues
- ❌ Advanced efficiency stats
- ❌ Shot location data
- ❌ Betting odds/props

**Access:**
- No authentication required
- Callable directly from Node.js via HTTP
- Documented by wehoop R package (shows endpoint patterns)
- Rate limit: ~1 req/sec (unofficial; occasional 429 if exceeded)

**Format:** JSON, well-structured

**Advantage:** Free, no API key, historically complete (2002-present)

**Disadvantage:** Undocumented, no SLA, less structured than Ball Don't Lie

### 3.3 SportsDataverse Data Releases

**Repository 1: wehoop-wnba-data**
- Source: ESPN
- Format: .rds (R format; can be downloaded via GitHub releases API)
- Content: Schedules, PBP, team box scores, player box scores
- Update: Daily at 08:00 UTC during season
- Node.js access: Yes (download via API; requires .rds parser or R)

**Repository 2: wehoop-wnba-stats-data**
- Source: NBA Stats infrastructure
- Format: .rds
- Content: Season stats, player stats, team stats
- Update: Daily at 08:00 UTC (offset to avoid proxy contention)
- Node.js access: Yes (download via API; requires .rds parser)
- Current-season lag: ~48 hours

**Advantage:** Pre-computed, normalized, free

**Disadvantage:** R format; requires parsing; 48-hour lag for current season

### 3.4 SportsDataverse wehoop R Package

**Purpose:** R package for scraping WNBA and women's college basketball

**Functions:** ~41 espn_wnba_* wrappers

**Data:** Play-by-play, box scores, schedules, standings, player/team detail, transactions, draft

**Access:** R-only (package must be installed and run in R)

**Use case:** GitHub Actions R workflow or Supabase Edge Function (if R runtime available)

**Not directly usable by:** Node.js/TypeScript (would require R subprocess or converting R data to JSON)

---

## Part 4: Data Type Coverage by Source

| Data Type | Ball Don't Lie Free | Ball Don't Lie GOAT | ESPN (Direct) | SportsDataverse Data | Notes |
|-----------|---|---|---|---|---|
| **Teams & Rosters** | ✅ | ✅ | ✅ | ✅ | All free/publish sources work |
| **Player Identities** | ✅ | ✅ | ✅ | ✅ | All sources have current roster |
| **Game Schedules** | ✅ | ✅ | ✅ | ✅ | All free and historical |
| **Game Scores** | ✅ | ✅ | ✅ | ✅ | All sources current; ESPN historical |
| **Box Scores** | ❌ | ✅ | ✅ | ✅ | Paid or free (ESPN/SportsDataverse) |
| **Player Game Stats** | ❌ | ✅ (GOAT) | Limited | ✅ | GOAT required for detailed stats |
| **Team Game Stats** | ❌ | ✅ (GOAT) | Limited | ✅ | GOAT required for per-game stats |
| **Season Aggregates** | ❌ | ✅ (GOAT) | ✅ | ✅ | GOAT or SportsDataverse free |
| **Advanced Metrics** | ❌ | ✅ (GOAT) | ❌ | ❌ | GOAT only |
| **Injuries** | ❌ | ✅ (All-Star) | Sparse | Sparse | Ball Don't Lie All-Star best current |
| **Play-by-Play** | ❌ | ✅ (All-Star) | ✅ | ✅ | All-Star or ESPN/SportsDataverse free |
| **Standings** | ✅ | ✅ | ✅ | ✅ | Free from multiple sources |
| **Draft/Transactions** | ❌ | ❌ | ✅ | ✅ | ESPN or SportsDataverse free |
| **Betting Odds** | ❌ | ✅ (GOAT) | ❌ | ❌ | GOAT only |
| **Player Props** | ❌ | ✅ (GOAT) | ❌ | ❌ | GOAT only |

---

## Part 5: Current Issues to Diagnose

### Issue 1: Timeout on WNBA Schedule Refresh

**Observed:** GitHub Actions WNBA schedule refresh times out

**Current timeout:** 12 seconds in `fetchScoreboardForDate()`

**Questions requiring investigation:**
1. Is the timeout the actual root cause, or a symptom?
2. What does stats.nba.com with LeagueID=10 scoreboardv2 actually return?
3. Is the response valid JSON?
4. Are there HTTP errors (403, 429, 500) before timeout?
5. Does the endpoint work from Vercel infrastructure?
6. Does increasing to 18s fix it?

**Recommended diagnostic:**
- Run the Vercel diagnostic endpoint and inspect the exact response
- Check GitHub Actions runner logs for network errors (DNS, connection refused, etc.)
- Verify LeagueID=10 is correct for WNBA on stats.nba.com

### Issue 2: Architectural Mismatch

**Current state:** Code labeled "wehoop" but actually uses stats.nba.com with LeagueID=10

**Misalignment:** 
- The class name and documentation suggest ESPN data, but actual source is NBA.com WNBA endpoint
- This is confusing for future maintainers
- No integration with real SportsDataverse wehoop package or ESPN endpoints

**Options:**
1. Rename `WeHoopWnbaAdapter` to `NbaComStatsWnbaAdapter` (clarify actual source)
2. Replace with actual SportsDataverse/ESPN integration
3. Add Ball Don't Lie as primary source (if budget approved)

### Issue 3: Coverage Gaps

**Current implementation provides:**
- Basic rosters (via stats.nba.com)
- Player game logs (via stats.nba.com)
- Team stats (via stats.nba.com)

**Not provided:**
- Betting odds (SharpAPI handles this)
- Advanced metrics (PIE, net rating, etc.)
- Shot location data
- Play-by-play narratives
- Historical injury data

**Assessment:** Sufficient for basic Covered Score inputs, but missing advanced enrichment options

---

## Part 6: Architectural Options to Evaluate

### Option A: Fix Current Architecture (Minimal Change)

**Changes:**
1. Increase timeout from 12s to 18s in `fetchScoreboardForDate()`
2. Rename `WeHoopWnbaAdapter` to `NbaComStatsWnbaAdapter` (clarify source)
3. Update documentation to acknowledge stats.nba.com as the source

**Cost:** $0

**Benefit:**
- Immediate fix for timeout issue (if that's the root cause)
- Clearer naming
- Minimal code changes

**Risk:**
- stats.nba.com is undocumented; could break anytime
- No fallback if stats.nba.com fails
- No advanced metrics or betting data

**Timeline:** 1-2 hours

### Option B: Add Ball Don't Lie Free + Keep stats.nba.com Fallback

**Changes:**
1. Fix timeout (same as Option A)
2. Add Ball Don't Lie Free tier for: teams, players, games, schedules, standings
3. Keep stats.nba.com as fallback for player/team stats
4. Create adapter layer for Ball Don't Lie

**Cost:** $0 (Free tier only)

**Benefit:**
- Basic catalog from documented, maintained API
- Documented API reduces breakage risk
- No cost

**Limitation:**
- Player game stats still come from stats.nba.com
- No advanced metrics or injuries without paid tier
- Must handle stats.nba.com as semi-primary source

**Timeline:** 2-3 days (create adapter, test, fallback logic)

### Option C: Add Ball Don't Lie All-Star ($9.99/month)

**Changes:**
1. Fix timeout
2. Ball Don't Lie All-Star for: teams, players, games, schedules, standings, injuries, play-by-play
3. Keep stats.nba.com fallback for player/team game stats

**Cost:** $9.99/month

**Benefit:**
- Full basic catalog coverage
- Current injury data
- Play-by-play for enrichment
- Documented API

**Gap:**
- Player game stats still require stats.nba.com
- No advanced metrics without GOAT tier

**Timeline:** 3-4 days

### Option D: Add Ball Don't Lie GOAT ($39.99/month)

**Changes:**
1. Fix timeout
2. Ball Don't Lie GOAT for: all catalog, injuries, play-by-play, stats, advanced metrics, odds
3. Minimal stats.nba.com dependency

**Cost:** $39.99/month

**Benefit:**
- Complete documented API coverage
- Advanced metrics (net rating, efficiency, usage %)
- Shot location data
- Betting odds (though Covered uses SharpAPI)
- Zero stats.nba.com dependency

**Gap:**
- Highest cost
- Must justify $40/month ROI

**Timeline:** 4-5 days

### Option E: Integrate SportsDataverse (Free, Requires GitHub Actions)

**Changes:**
1. Fix timeout
2. Create GitHub Actions workflow that downloads SportsDataverse data releases daily
3. Parse .rds files or use R package
4. Write normalized data to Supabase
5. Application reads from Supabase, not external API

**Cost:** $0

**Benefit:**
- Free (open source)
- Complete coverage (ESPN-backed)
- Prepared datasets (less processing)
- Move API calls out of production Next.js

**Complexity:**
- Requires .rds parsing or R runtime setup
- 48-hour lag for current-season stats (unacceptable for live props)
- Requires GitHub Actions workflow development

**Timeline:** 5-7 days

### Option F: Hybrid (Ball Don't Lie All-Star + SportsDataverse)

**Changes:**
1. Fix timeout
2. Ball Don't Lie All-Star for: current-season schedule, scores, injuries, play-by-play
3. SportsDataverse nightly for: historical validation, background enrichment
4. Use Supabase as unified cache

**Cost:** $9.99/month

**Benefit:**
- Current data from BDL (low latency)
- Historical/validation data from free SportsDataverse
- Reduced dependency on stats.nba.com
- Balanced cost/coverage

**Complexity:** Requires two ingestion paths

**Timeline:** 6-8 days

---

## Part 7: Critical Unknowns Requiring Testing

1. **Does increasing timeout actually fix the issue?**
   - Need to test from GitHub Actions with actual 18s timeout
   - Need to confirm response is valid JSON
   - Need to confirm scores are correct

2. **Is LeagueID=10 still valid on stats.nba.com?**
   - Verify endpoint still works
   - Confirm WNBA data is returned

3. **What does Ball Don't Lie Free tier quality look like?**
   - Test actual API responses
   - Compare data completeness with stats.nba.com
   - Measure latency and rate limit behavior

4. **Can SportsDataverse .rds files be parsed in Node.js?**
   - Test file download via GitHub API
   - Test parsing options
   - Measure setup/parsing time

5. **What is Covered's actual need for advanced metrics?**
   - Review Covered Score inputs
   - Identify which advanced stats are actually used
   - Determine if GOAT tier ROI is justified

---

## Part 8: Recommended Next Steps (Before Code Changes)

1. **Run the timeout diagnostic** (already created in Vercel route)
   - Deploy to preview
   - Confirm actual error (timeout vs. HTTP error vs. invalid data)
   - Test with 18s timeout

2. **Test Ball Don't Lie Free tier** (5 minutes)
   - Curl a Free endpoint: `curl -H "Accept: application/json" https://api.balldontlie.io/wnba/v1/teams`
   - Verify response quality
   - No API key needed

3. **Audit Covered Score inputs** (1-2 hours)
   - Identify which WNBA data inputs are actually used
   - Determine if advanced stats are needed
   - Clarify ROI for paid tiers

4. **Decide on architectural direction** (user decision)
   - Option A: Quick fix + document risk
   - Option B/C/D: Add Ball Don't Lie (which tier?)
   - Option E/F: Integrate SportsDataverse
   - Hybrid approach?

---

## Part 9: What NOT to Do

**❌ Do not:**
- Delete `WeHoopWnbaAdapter` yet (need to understand all callers first)
- Assume timeout increase fixes the issue (need diagnosis)
- Commit to $40/month Ball Don't Lie without testing ROI
- Run R subprocess inside Next.js production app
- Assume stats.nba.com is permanent/stable

**✅ Do:**
- Test the actual error first
- Evaluate each option based on Covered's actual use cases
- Run free trials before paying
- Separate ingestion (GitHub Actions) from serving (Next.js)
- Document why each data source was chosen

---

## Summary

The current WNBA implementation uses **stats.nba.com with LeagueID=10**, which is:
- ✅ Working (mostly)
- ❌ Undocumented
- ❌ Timeout issues on GitHub Actions
- ❌ Confusingly labeled as "wehoop"

The architecture can be improved by:
1. Fixing the immediate timeout issue (low risk, high value)
2. Adding a documented, maintained API as primary source (Ball Don't Lie or ESPN)
3. Removing dependency on undocumented stats.nba.com

**Next step:** Confirm the actual error via Vercel diagnostic, then decide on architectural path.
