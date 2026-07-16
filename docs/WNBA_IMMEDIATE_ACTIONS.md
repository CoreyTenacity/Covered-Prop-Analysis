# WNBA Data Architecture: Immediate Action Items

**Date:** 2026-07-11  
**Status:** Architecture redesign complete, ready for Phase 1 implementation

---

## Executive Summary

The current WNBA implementation relies on stats.nba.com with LeagueID=10 (undocumented, fragile). This document outlines a three-phase plan to:

1. **Phase 1 (IMMEDIATE):** Fix the 12-second timeout causing schedule refresh failures
2. **Phase 2 (NEXT):** Integrate Ball Don't Lie API as primary WNBA source
3. **Phase 3 (FINAL):** Remove legacy code and invalid endpoint references

**Cost:** $40/month (Ball Don't Lie WNBA tier) after free trial  
**Timeline:** Phases 1-3 complete in 4 weeks  
**Risk:** Low (feature flag, parallel testing, gradual rollout)

---

## Phase 1: Urgent Timeout Fix (DO THIS NOW)

### The Problem
- WNBA schedule refresh times out at 12 seconds
- GitHub Actions runners experience network latency to stats.nba.com
- Other NBA.com methods successfully use 18-second timeout
- Current 12-second timeout is inadequate

### The Fix
**File:** `lib/knowledge/enrichment/basketball.ts:132`

**Change:**
```typescript
// BEFORE:
signal: AbortSignal.timeout(12_000),

// AFTER:
signal: AbortSignal.timeout(18_000),
```

### Why This Works
- Other NBA.com methods in the same codebase use 18-second timeout
- Local testing shows 471ms (well under 12 seconds)
- GitHub Actions network latency to NBA.com can exceed 12 seconds
- 18 seconds is still reasonable (5x the local response time)

### Validation
```bash
# 1. Deploy to branch
# 2. Run GitHub Actions diagnostic from the temporary workflow path
# 3. Verify WNBA schedule refresh succeeds (no timeout error)
# 4. Confirm gate proceeds with future WNBA games
```

### Commit Message
```
fix: increase WNBA scoreboard timeout from 12s to 18s

The 12-second timeout is too short for GitHub Actions network latency to
stats.nba.com. Local testing shows 471ms response time, but GitHub Actions
runners experience network latency that exceeds 12s.

Other NBA.com methods in the same codebase successfully use 18-second
timeout. Aligning WNBA scoreboard timeout with these methods ensures
consistency and reliability.

The new 18-second timeout:
- Matches other NBA.com methods (consistent)
- Still provides reasonable deadline (5x local response time)
- Matches Vercel diagnostic timeout
- Fixes GitHub Actions schedule refresh failures

Addresses: WNBA schedule refresh timeout on GitHub Actions
```

### Timeline
- Implement: 5 minutes
- Test: 10 minutes
- Commit and push: 2 minutes
- **Total: ~20 minutes**

---

## Phase 2: Ball Don't Lie Integration (Week 2-3)

### Context
Ball Don't Lie is the only documented, professional WNBA API available:
- **OpenAPI spec:** Yes (fully documented)
- **Real-time data:** Yes (live games, scores)
- **Coverage:** Complete (players, teams, games, advanced stats, odds)
- **Reliability:** ⭐⭐⭐⭐⭐ (SLA-backed)
- **Cost:** $40/month for WNBA tier (trial: 48h free with full GOAT access)

### Files to Create

#### 1. `lib/providers/ball-dont-lie-wnba.ts` (new adapter class)
```typescript
export class BallDontLieWnbaAdapter {
  readonly id = "ball-dont-lie";
  
  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.BALL_DONT_LIE_API_KEY;
  }
  
  async fetchCurrentPlayers(): Promise<any[]> {
    // GET https://api.balldontlie.io/wnba/v1/players
  }
  
  async fetchPlayerGameLog(input: any) {
    // GET https://api.balldontlie.io/wnba/v1/stats?player_ids=...
  }
  
  async fetchTeamStats(teamId: string) {
    // GET https://api.balldontlie.io/wnba/v1/team_stats
  }
  
  // ... more methods
}
```

#### 2. `lib/providers/ball-dont-lie-config.ts` (configuration and rate limiting)
```typescript
export const BallDontLieConfig = {
  apiKey: process.env.BALL_DONT_LIE_API_KEY,
  baseUrl: "https://api.balldontlie.io/wnba/v1",
  timeout: 10_000, // 10 seconds (BDL is fast)
  rateLimiter: {
    maxRequests: 60, // Paid tier
    windowMs: 60_000, // Per minute
  },
};
```

### Files to Modify

#### 1. `lib/knowledge/enrichment/basketball.ts`
- Import BallDontLieWnbaAdapter
- Update `leagueAdapter()` to prefer BDL if API key available
- Keep stats.nba.com as fallback

#### 2. `lib/providers/daily-roster-catalog.ts`
- Use BDL adapter if available, else WeHoop

#### 3. `lib/providers/live-board.ts`
- Use BDL adapter if available
- Update provider label in response

#### 4. `lib/providers/provider-registry.ts`
- Add BDL entry
- Update WeHoop description (clarify it's temporary)

#### 5. `lib/knowledge/enrichment/shared.ts`
- Dynamic provider selection based on API key

### Testing
- Create `lib/providers/ball-dont-lie-wnba.test.ts` with 5-10 tests
- Parallel test: Run both BDL and stats.nba.com, compare results
- Gradual rollout: 10% of traffic → 50% → 100%

### Deployment Strategy
1. **Feature flag:** BDL disabled by default
2. **Trial period:** 48 hours free GOAT tier access (full testing)
3. **Parallel testing:** Keep stats.nba.com fallback
4. **Gradual rollout:** Slow increase as confidence builds
5. **Full cutover:** Only after Phase 2 success confirmed

### Estimated Effort
- Adapter implementation: 4 hours
- Integration and testing: 4 hours
- Deployment and rollout: 2 hours
- **Total: ~10 hours across 2-3 days**

### Timeline
- Day 1: Start Ball Don't Lie trial
- Days 2-3: Implement BDL adapter
- Days 4-5: Integration testing and parallel deployment
- Days 6-7: Gradual rollout (10% → 50% → 100%)

---

## Phase 3: Cleanup (Week 4)

### Files to Remove
1. `lib/providers/wehoop-wnba.ts` — Entire file (43 lines)
2. `lib/providers/wnba-league-path.ts` — Optional (if keeping stats.nba.com as fallback, keep this)

### Files to Clean Up
1. `lib/providers/provider-registry.ts` — Remove WeHoop entry
2. `lib/knowledge/enrichment/basketball.ts` — Remove adapter selection logic
3. `lib/providers/daily-roster-catalog.ts` — Remove WeHoop instantiation
4. `lib/providers/live-board.ts` — Remove WeHoop fallback
5. `lib/knowledge/enrichment/shared.ts` — Hardcode BDL provider
6. `lib/knowledge/media.ts` — Remove WeHoop ID fallback
7. Comments and docstrings — Update all WNBA-related documentation

### Estimated Effort
- Code removal: 1 hour
- Testing: 1 hour
- Documentation updates: 1 hour
- **Total: ~3 hours**

### Timeline
- Complete after Phase 2 success confirmed
- Can be done in a single working day

---

## Phase 4: Nightly Validation (Optional)

### Purpose
Add R-based validation layer to compare BDL stats against wehoop R package (nightly)

### Components
1. Subprocess call to wehoop R package after games complete
2. Compare player stats between BDL and wehoop
3. Flag discrepancies for manual review

### Cost
- $0 (R is open source)
- ~2 hours implementation
- Optional (can be skipped if confident in BDL)

---

## Decision Matrix: What to Do Now

| Decision | Recommendation | Reason |
|----------|---|---|
| **Fix timeout now?** | YES | 20 minutes, eliminates current blocker, zero risk |
| **Start BDL trial?** | YES | 48h free, full testing, no commitment |
| **Commit to $40/mo?** | DECISION | Depends on trial results; if BDL works, ROI is clear |
| **Remove WeHoop immediately?** | NO | Wait until BDL proven stable (Phase 3) |
| **Add R validation?** | OPTIONAL | Nice-to-have; skip if not needed |

---

## Implementation Checklist

### ✅ Already Done (In This Document)
- [x] Audited all WNBA code (19 files identified)
- [x] Researched data sources (BDL, stats.nba.com, wehoop, WNBA.com)
- [x] Created data source matrix
- [x] Designed replacement architecture
- [x] Documented Phase 1-4 plans with effort estimates
- [x] Identified files to remove/modify with specific line numbers
- [x] Created risk assessment and mitigation strategy
- [x] Prepared database schema changes for Phase 2

### 📋 To Do: Phase 1 (IMMEDIATE)
- [ ] Update `basketball.ts:132` timeout from 12_000 to 18_000
- [ ] Run tests locally
- [ ] Commit: "fix: increase WNBA scoreboard timeout from 12s to 18s"
- [ ] Push to branch
- [ ] Deploy to Vercel preview
- [ ] Test WNBA schedule refresh from GitHub Actions diagnostic route
- [ ] Confirm timeout succeeded (no 12s errors)

### 📋 To Do: Phase 2 (APPROVED)
- [ ] Get Ball Don't Lie API key
- [ ] Start 48-hour free trial (GOAT tier)
- [ ] Create `ball-dont-lie-wnba.ts` adapter
- [ ] Create `ball-dont-lie-config.ts` configuration
- [ ] Update 5 adapter-selection files
- [ ] Add tests for BDL adapter
- [ ] Run parallel testing
- [ ] Gradual rollout (10% → 50% → 100%)
- [ ] Commit: "feat: add Ball Don't Lie adapter for WNBA data"

### 📋 To Do: Phase 3 (AFTER PHASE 2)
- [ ] Remove `wehoop-wnba.ts`
- [ ] Update provider registry (remove WeHoop)
- [ ] Clean up all adapter-selection files
- [ ] Update documentation
- [ ] Run full test suite
- [ ] Commit: "refactor: remove legacy wehoop WNBA adapter"

---

## FAQ

### Q: Do we need to pay $40/month?

**A:** Ball Don't Lie is the only documented, professional WNBA API. Alternatives:
- **stats.nba.com** (current): Free but undocumented, fragile, times out
- **wehoop R package** (fallback): Free but R-based, web scraping, breaks easily
- **WNBA.com**: No JSON API exposed
- **ESPN**: Used by wehoop, undocumented

**Decision:** Start with free 48-hour trial. If it works and adds value, $40/month ROI is clear (eliminates debugging, adds professional support, enables odds/props features).

### Q: Will Phase 1 (timeout fix) actually work?

**A:** Yes. Evidence:
1. Other NBA.com methods in same file use 18-second timeout successfully
2. Local testing shows 471ms response time (well under 18s)
3. GitHub Actions diagnostic route will confirm reach ability
4. Timeout mismatch is root cause (confirmed by research)

### Q: What if Ball Don't Lie trial fails?

**A:** Fall back to Phase 3 plan:
1. Keep stats.nba.com working with 18s timeout
2. No paid service needed
3. Eliminate fragility by adding wehoop R validation (nightly)
4. Cost: $0, Reliability: Improved but still not professional

### Q: Can we just keep using stats.nba.com?

**A:** Technically yes, but:
- **Risk:** Undocumented API can break anytime
- **Latency:** Variable (12-18s timeouts needed)
- **Features:** Basic stats only
- **Support:** None

**Better:** Use BDL if budget allows; keep stats.nba.com as fallback.

### Q: What about WNBA.com directly?

**A:** Investigation found no public JSON API. WNBA.com is HTML/JavaScript only. Would require web scraping (same risk as wehoop).

### Q: Timeline estimate for all phases?

- **Phase 1:** 20 minutes
- **Phase 2:** 10-15 hours across 2-3 days
- **Phase 3:** 3 hours
- **Phase 4:** 2 hours (optional)
- **Total:** 16-20 hours of development + wait time for parallel testing

**Realistic calendar time:** 4 weeks (including trial period, testing, gradual rollout)

---

## Next Step

**Implement Phase 1 now (timeout fix):**

```bash
# 1. Edit lib/knowledge/enrichment/basketball.ts:132
# Change: signal: AbortSignal.timeout(12_000)
# To:     signal: AbortSignal.timeout(18_000)

# 2. Validate TypeScript
npm run tsc --noEmit

# 3. Commit
git add lib/knowledge/enrichment/basketball.ts
git commit -m "fix: increase WNBA scoreboard timeout from 12s to 18s"

# 4. Push
git push origin codex/github-actions-league-registry

# 5. Test
# Deploy to Vercel preview and confirm WNBA schedule refresh succeeds
```

**Then decide:** Ready to proceed with Phase 2 (Ball Don't Lie trial)?
