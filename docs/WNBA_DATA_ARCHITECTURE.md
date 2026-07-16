# WNBA Data Architecture: Correction and Expansion

**Status:** Architecture redesign in progress

**Context:** The current implementation relies on stats.nba.com with LeagueID=10, which is undocumented and fragile. This document outlines the replacement architecture using industry-standard, documented sources.

---

## Part A: Data Source Matrix

| Data Type | Ball Don't Lie | stats.nba.com (LeagueID=10) | wehoop R | WNBA.com | Recommendation |
|-----------|---|---|---|---|---|
| **Schedule** | ✓ Full season, real-time | ✓ Real-time via scoreboardv2 | ✓ Historical | ✗ No JSON API | **BDL Primary** + NBA fallback |
| **Live Games** | ✓ Live scoreboard, box score | ✓ Real-time | ✗ Delayed | ✗ No API | **BDL Primary** |
| **Game Box Scores** | ✓ Complete stats | ✓ Via scoreboard + game endpoints | ✓ Historical | ✗ No API | **BDL Primary** |
| **Players** | ✓ Current roster, career stats | ✓ Via league endpoints | ✓ Historical roster | ✗ No JSON API | **BDL Primary** |
| **Player Game Logs** | ✓ Per-game stats, trends | ✓ Via player stats endpoints | ✓ Historical | ✗ No API | **BDL Primary** |
| **Team Stats** | ✓ Aggregate stats | ✓ Via team endpoints | ✓ Historical | ✗ No API | **BDL Primary** |
| **Advanced Stats** | ✓ PER, TS%, etc. | ✗ Limited (basic only) | ✓ Advanced metrics | ✗ No API | **BDL Primary** |
| **Standings** | ✓ Current season | ✓ Via game results | ✓ Historical | ✗ No API | **BDL Primary** |
| **Play-by-Play** | ✓ Quarter-by-quarter | ✗ Not available | ✓ Available | ✗ No API | **BDL Primary** |
| **Injuries** | ✗ Not available | ✗ Not available | ✗ Not available | ✓ Manual tracking | **WNBA.com manual** |
| **Odds/Props** | ✓ Real-time, multiple books | ✗ Not available | ✗ Not available | ✗ Not available | **BDL Primary** |

**Cost Summary:**
- **Ball Don't Lie (GOAT Tier):** $40/month (covers WNBA + test tier)
- **stats.nba.com:** Free (undocumented, no SLA)
- **wehoop:** Free (R package, web scraping, fragile)

---

## Part B: Recommended Architecture by Feature

### Historical Player Logs

**Recommendation:** Ball Don't Lie API

**Implementation:**
```typescript
GET https://api.balldontlie.io/wnba/v1/stats
?player_ids[]=<player_id>
&start_date=YYYY-MM-DD
&end_date=YYYY-MM-DD
```

**Fallback:** statsn.nba.com player stats (18s timeout, free)
**Validation:** wehoop R package (nightly historical check)

**Caching:**
- Completed games: Cache indefinitely (immutable)
- Current season: Refresh daily for in-progress season
- Off-season: Cache for 30 days

---

### Last 5 Games

**Recommendation:** Ball Don't Lie API (most recent games)

**Implementation:**
```typescript
GET https://api.balldontlie.io/wnba/v1/player_stats
?player_ids[]=<player_id>
&per_page=5
&order_by=date
&sort=desc
```

**Fallback:** Build from stats.nba.com game logs
**Latency:** <500ms from BDL, variable from NBA.com

**Caching:**
- Completed games: Immutable
- In-progress: Refresh every 2 minutes during season
- Off-season: Static data

---

### Last 10 Games

**Same as Last 5** (same API, increase `per_page=10`)

**Additional use:** Calculate rolling averages (PPG, RPG, APG trends)

---

### Minutes Trends

**Recommendation:** Ball Don't Lie API player stats (includes minutes per game)

**Implementation:**
```typescript
GET https://api.balldontlie.io/wnba/v1/stats
?player_ids[]=<id>
&per_page=50
```

**Fallback:** Build from stats.nba.com player game logs

**Enrichment Logic:**
- Calculate 5-game rolling average of minutes
- Flag unexplained drops (injury indicator)
- Correlate with box score bench time if available

**Caching:** Daily refresh during season

---

### Opponent Defensive Metrics

**Recommendation:** Ball Don't Lie API advanced stats

**Implementation:**
```typescript
GET https://api.balldontlie.io/wnba/v1/team_stats
?team_ids[]=<opponent_team_id>
&stat_type=defense
```

**Fallback:** Aggregate from game box scores (points allowed, defensive rebounds, etc.)

**Covered enrichment:**
- Store in `team_defense_metrics` table
- Refresh daily
- Calculate per-game averages
- Segment by: home/away, recent form (L10 games), season total

---

### Pace

**Recommendation:** Ball Don't Lie API team stats + game log aggregation

**Implementation:**
```typescript
// Team pace (possessions per game, typically 90+ for WNBA)
GET https://api.balldontlie.io/wnba/v1/team_stats
?team_ids[]=<id>
&stat_type=pace
```

**Fallback:** Derive from game logs (total points / total field goals attempted)

**Covered enrichment:**
- Calculate possessions per game (slower pace = fewer scoring opportunities)
- Segment: home/away, recent (L10), season total
- Use for projection scaling (slower pace = lower game total)

---

### Team Context

**Recommendation:** Ball Don't Lie API (multiple queries)

**Implementation stack:**
1. **Team info:** `GET /teams` (rosters, city, conference)
2. **Recent form:** `GET /stats` filtered by team (last 10 games)
3. **Standings:** `GET /standings` (seed, games back)
4. **Injuries:** Manual tracking via WNBA.com or injury reports API (if available)

**Fallback:** Aggregate from game logs + standings

**Covered enrichment:**
- Store in `team_context` table (updated nightly)
- Include: W-L record, recent form, key injuries, rest patterns
- Use for game quality filtering (playoff teams vs tanking)

---

### Completed Game Grading

**Recommendation:** Ball Don't Lie API box scores + manual verification

**Implementation:**
1. Fetch box score after game completes: `GET /games/<game_id>`
2. Extract official final score
3. Compare with Covered prop payouts
4. Grade accuracy of projections

**Validation:** 
- Cross-check with stats.nba.com game result (free fallback)
- Optional: wehoop historical verification (R subprocess, nightly)

**Caching:**
- Completed games: Immutable (cache indefinitely)
- Final scores: Used for grading (no refresh needed)

---

### Projection Inputs

**Recommendation:** Ball Don't Lie API (multi-source)

**Data needed for WNBA props:**
1. **Player recent form:** `GET /stats` (last 10 games trending)
2. **Team strength:** `GET /team_stats` (offensive/defensive efficiency)
3. **Matchup dynamics:** `GET /games` (opponent, location, spread if available)
4. **Player minutes:** `GET /player_stats` (role stability)
5. **Pace/scoring environment:** `GET /team_stats` (scoring volume)

**Fallback:** Rebuild from stats.nba.com game logs

**Covered enrichment:**
- Cache all inputs in `projection_inputs` table
- Refresh daily pre-season
- Refresh every 4 hours in-season
- Use for feature engineering (offensive rebound %, floor models, ceiling models)

---

### Covered Score Enrichment

**Recommendation:** Ball Don't Lie API + manual tagging

**Scoring model inputs:**
1. **Quality of player usage:** `GET /stats` (minutes, shot attempts, role)
2. **Team strength:** `GET /team_stats` (pace, scoring efficiency)
3. **Opponent defense:** `GET /team_stats` for opponent (points allowed, defensive rating)
4. **Rest/travel:** Manual enrichment (home/away, games since last game)
5. **Injury status:** Manual tracking (no API source)

**Fallback:** Simplified scoring using only available data

**Caching:**
- Player usage: Daily cache
- Team stats: Nightly refresh
- Manual enrichments: Cache for season

---

## Part C: Implementation Roadmap

### Phase 1: Immediate Timeout Fix (1-2 hours)

**Goal:** Fix the current GitHub Actions timeout issue without architectural changes

**Action:**
1. Update `lib/knowledge/enrichment/basketball.ts:132` from `12_000ms` to `18_000ms`
2. Verify timeout matches other NBA.com calls
3. Test from GitHub Actions diagnostic route
4. Confirm WNBA schedule refresh succeeds

**Risk:** Low (timeout already used by other NBA.com methods)
**Cost:** $0

---

### Phase 2: Ball Don't Lie Integration (1-2 weeks)

**Goal:** Add BDL as primary WNBA source while keeping NBA.com as fallback

**Files to create:**
1. `lib/providers/ball-dont-lie-wnba.ts` — BDL adapter class
2. `lib/providers/ball-dont-lie-config.ts` — API key management, rate limiting
3. `lib/knowledge/enrichment/wnba-jobs.ts` — WNBA-specific refresh jobs
4. Database migrations for new tables (if needed)

**Implementation approach:**
- Parallel adapter (don't remove NFL wrapper initially)
- Implement as `BallDontLieWnbaAdapter` (same interface as `NbaComStatsAdapter`)
- Toggle via feature flag or league registry
- Fallback to stats.nba.com if BDL fails

**Requires:**
- Ball Don't Lie API key (setup and testing)
- Rate limiting implementation (5 req/min free, 60 req/min for paid)
- Error handling for quota exhaustion

**Cost:** $40/month (trial first: 48h free full GOAT tier access)

---

### Phase 3: Remove Invalid Endpoints (1 week)

**Goal:** Remove all dead code, comments, and references to broken endpoints

**Files to audit and clean:**
1. `lib/providers/wehoop-wnba.ts` — Replace or remove
2. `lib/knowledge/enrichment/basketball.ts` — Update adapter selection logic
3. Remove `resolveWnbaLeagueId()` if not needed (or keep as fallback config)
4. Update documentation and comments

**Deprecation strategy:**
- If BDL succeeds in Phase 2: Remove WeHoopWnbaAdapter entirely
- If BDL fails or is too expensive: Keep NBA.com wrapper (document as temporary)

---

### Phase 4: Nightly Validation with wehoop (optional)

**Goal:** Add R-based validation layer for data quality assurance

**Implementation:**
- Subprocess call to wehoop R package (nightly after game completion)
- Compare player stats between BDL and wehoop
- Flag discrepancies for manual review
- Cost: $0 (open source, but requires R runtime)

**Risk:** R dependency adds complexity; skip if not needed

---

## Part D: Database Schema Changes

### New tables (Ball Don't Lie integration):

```sql
-- Cached from BDL API
CREATE TABLE wnba_player_stats_cache (
  id uuid PRIMARY KEY,
  player_id text NOT NULL,
  game_id text NOT NULL,
  date date NOT NULL,
  minutes numeric,
  points numeric,
  rebounds numeric,
  assists numeric,
  steals numeric,
  blocks numeric,
  turnovers numeric,
  field_goals_made numeric,
  field_goals_attempted numeric,
  three_pointers_made numeric,
  three_pointers_attempted numeric,
  free_throws_made numeric,
  free_throws_attempted numeric,
  cached_at timestamp NOT NULL,
  UNIQUE(player_id, game_id)
);

CREATE TABLE wnba_team_stats_cache (
  id uuid PRIMARY KEY,
  team_id text NOT NULL,
  season integer NOT NULL,
  points_per_game numeric,
  rebounds_per_game numeric,
  assists_per_game numeric,
  pace numeric,
  offensive_rating numeric,
  defensive_rating numeric,
  field_goal_percentage numeric,
  three_point_percentage numeric,
  free_throw_percentage numeric,
  cached_at timestamp NOT NULL,
  UNIQUE(team_id, season)
);

CREATE TABLE wnba_schedule_cache (
  id uuid PRIMARY KEY,
  game_id text UNIQUE NOT NULL,
  game_date timestamp NOT NULL,
  home_team_id text NOT NULL,
  away_team_id text NOT NULL,
  home_team_name text,
  away_team_name text,
  status text, -- 'scheduled', 'in_progress', 'final'
  home_score numeric,
  away_score numeric,
  source_provider text, -- 'ball-dont-lie', 'nba-com-stats'
  cached_at timestamp NOT NULL
);
```

### Modified tables:

```sql
-- Add BDL provider column
ALTER TABLE enrichment_metadata ADD COLUMN bdl_sync_status text; -- 'pending', 'success', 'failed'
ALTER TABLE enrichment_metadata ADD COLUMN bdl_sync_error text;
ALTER TABLE enrichment_metadata ADD COLUMN bdl_sync_timestamp timestamp;
```

---

## Part E: Rate Limiting Strategy

### Ball Don't Lie (Paid: 60 req/min)

```typescript
// Per-minute bucket
const rateLimiter = new RateLimiter({
  maxRequests: 60,
  windowMs: 60_000, // 1 minute
  keyGenerator: () => 'bdl-wnba', // Single shared bucket
});

// Estimated usage:
// - Player stats: ~20 players × 2 requests/player = 40 req/season
// - Team stats: ~12 teams × 1 request = 12 req/season
// - Game schedule: 1 request/day = ~40 req/season
// - Total: ~92 requests per WNBA season (6 months)
// - Daily average: <1 request/day off-season, 3-5 requests/day in-season
// Easily within 60 req/min limit
```

### Fallback: stats.nba.com (18s timeout)

```typescript
// No official rate limit but conservative approach:
// - Avoid repeated calls during same game
// - Cache aggressively (completed games immutable)
// - Use exponential backoff on failure
```

---

## Part F: Migration Strategy

### Option 1: Parallel Adapter (Recommended)

```typescript
// lib/knowledge/enrichment/basketball.ts

async function leagueAdapter(scope: LeagueScope) {
  if (scope === "WNBA") {
    // Try BDL first
    if (process.env.BALL_DONT_LIE_API_KEY) {
      return {
        leagueId: "10",
        provider: "ball-dont-lie" as const,
        adapter: new BallDontLieWnbaAdapter(),
      };
    }
    
    // Fallback to stats.nba.com
    const selection = await resolveWnbaLeagueId();
    return {
      leagueId: selection.leagueId,
      provider: "nba-com-stats-fallback" as const,
      adapter: new NbaComStatsAdapter(),
    };
  }
  
  // NBA unchanged
  return {
    leagueId: "00",
    provider: "nba-com-stats" as const,
    adapter: new NbaComStatsAdapter(),
  };
}
```

### Option 2: Feature Flag

```typescript
// Use league registry to toggle
const useBallDontLie = registry
  .find(e => e.league === "WNBA")
  ?.enableBallDontLieAdapter === true;
```

---

## Part G: Cost-Benefit Analysis

### Current State (stats.nba.com only)
- **Cost:** $0
- **Reliability:** ⭐⭐☆☆☆ (undocumented, fragile)
- **Features:** Basic stats only
- **Support:** None

### Recommended State (BDL Primary + NBA Fallback)
- **Cost:** $40/month (WNBA tier)
- **Reliability:** ⭐⭐⭐⭐⭐ (SLA-backed, documented)
- **Features:** Advanced stats, odds, play-by-play, props
- **Support:** Professional API support

### ROI
- **Benefit:** Eliminate timeouts, add odds/props data, professional support
- **Cost:** $40/month × 12 months = $480/year
- **Payoff:** Enables premium prop scoring features, eliminates debugging fragile scrapers

---

## Part H: Success Criteria

Phase 1 (Timeout Fix):
- ✓ WNBA schedule refresh succeeds from GitHub Actions
- ✓ No more 12-second timeouts

Phase 2 (BDL Integration):
- ✓ BDL adapter successfully fetches WNBA player stats
- ✓ Fallback to stats.nba.com works if BDL fails
- ✓ Rate limiting works within 60 req/min budget
- ✓ Caching reduces redundant API calls

Phase 3 (Cleanup):
- ✓ All references to invalid endpoints removed
- ✓ No dangling wehoop references
- ✓ Architecture documented in this file

---

## Next Steps

1. **Immediate:** Increase timeout to 18 seconds (Phase 1)
2. **Decision:** Approve BDL integration cost ($40/month)
3. **Development:** Implement BDL adapter (Phase 2)
4. **Cleanup:** Remove invalid endpoints (Phase 3)
5. **Validation:** Add wehoop nightly checks (Phase 4, optional)
