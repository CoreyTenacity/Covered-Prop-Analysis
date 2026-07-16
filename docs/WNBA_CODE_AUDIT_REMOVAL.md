# WNBA Code Audit and Removal Plan

**Objective:** Identify all code that directly or indirectly relies on invalid endpoints, and determine what to remove, replace, or deprecate.

---

## Section 1: Files to Remove (Invalid/Misleading)

### 1.1 `lib/providers/wehoop-wnba.ts`

**Status:** REMOVE in Phase 3

**Reason:** 
- Class name is misleading (suggests "wehoop" is a real service)
- Currently just wraps `NbaComStatsAdapter` with LeagueID=10
- After Ball Don't Lie integration, `BallDontLieWnbaAdapter` will replace this
- If staying with NBA.com fallback, rename to `NbaComStatsWnbaAdapter` for clarity

**Current content:**
```typescript
export class WeHoopWnbaAdapter {
  readonly id = "wehoop-wnba";
  private readonly nba = new NbaComStatsAdapter();
  // ... all methods delegate to this.nba with leagueId="10"
}
```

**Action Plan:**
- Phase 1: Keep as-is (no change needed yet)
- Phase 2: Create `BallDontLieWnbaAdapter` as replacement
- Phase 3: Remove entirely after BDL proves stable

**Risk:** LOW (only used in 5 files, all with strong type safety)

---

### 1.2 `lib/providers/wnba-league-path.ts`

**Status:** DEPRECATE/REMOVE in Phase 3

**Reason:**
- Attempts to "probe" for correct WNBA League ID by making test requests
- Caches result with 12-hour expiry
- Unnecessary complexity if using Ball Don't Lie (which handles WNBA natively)
- Can be replaced with simple constant `"10"` if using NBA.com fallback

**Current usage:**
```typescript
const selection = await resolveWnbaLeagueId();
// Returns: { leagueId: "10", status: "found", ... }
```

**Action Plan:**
- Phase 1: Keep as-is
- Phase 2: Still use with BDL fallback (LeagueID for NBA.com)
- Phase 3: Replace with simple constant if NBA.com removed, or keep for fallback compatibility

**Risk:** MEDIUM (used in 4 files, adds unnecessary complexity)

---

## Section 2: Files to Modify (Update References)

### 2.1 `lib/providers/provider-registry.ts`

**Current entry (line 160-161):**
```typescript
{
  id: "wehoop-wnba",
  label: "wehoop / WNBA",
  // ...
  description: "WNBA player logs, team context, and recent-form enrichment in a WNBA-specific wrapper"
}
```

**Phase 1 Action:** 
- Update label: `"wehoop / WNBA"` → `"NBA.com stats (WNBA via LeagueID=10)"`
- Update description to clarify this is a wrapper, not a separate data source

**Phase 2 Action:**
- Add new entry for `"ball-dont-lie-wnba"`
- Keep weho op entry as fallback provider

**Phase 3 Action:**
- Remove wehoop entry entirely
- Make BDL the only entry

---

### 2.2 `lib/providers/daily-roster-catalog.ts`

**Current code (line 69):**
```typescript
wnba = new WeHoopWnbaAdapter()
```

**Modifications needed:**
```typescript
// Phase 2: Use BDL if API key available, else fall back to WeHoop
wnba = process.env.BALL_DONT_LIE_API_KEY 
  ? new BallDontLieWnbaAdapter()
  : new WeHoopWnbaAdapter();
```

**Current code (line 96, 100):**
```typescript
const resolvedLeagueId = sport === "WNBA" 
  ? (await resolveWnbaLeagueId(now)).leagueId 
  : leagueId;
```

**Modifications needed (Phase 2+):**
```typescript
const resolvedLeagueId = sport === "WNBA" 
  ? (process.env.BALL_DONT_LIE_API_KEY ? "10" : (await resolveWnbaLeagueId(now)).leagueId)
  : leagueId;
```

**Impact:** Low (single usage point, well-isolated)

---

### 2.3 `lib/providers/live-board.ts`

**Current code (line 2197-2201):**
```typescript
const adapter = opportunity.sport === "WNBA" 
  ? new WeHoopWnbaAdapter() 
  : new NbaComStatsAdapter();

const leagueSelection = opportunity.sport === "WNBA"
  ? await resolveWnbaLeagueId().catch(() => ({ leagueId: "10", ... }))
  : null;
```

**Modifications needed (Phase 2):**
```typescript
const adapter = opportunity.sport === "WNBA"
  ? (process.env.BALL_DONT_LIE_API_KEY 
      ? new BallDontLieWnbaAdapter()
      : new WeHoopWnbaAdapter())
  : new NbaComStatsAdapter();

const leagueSelection = opportunity.sport === "WNBA" && !process.env.BALL_DONT_LIE_API_KEY
  ? await resolveWnbaLeagueId().catch(() => ({ leagueId: "10", ... }))
  : null;
```

**Current code (line 2426):**
```typescript
sourceProvider: opportunity.sport === "WNBA" ? "wehoop / NBA.com" : "NBA.com / nba_api"
```

**Modifications needed (Phase 2):**
```typescript
sourceProvider: opportunity.sport === "WNBA" 
  ? (process.env.BALL_DONT_LIE_API_KEY ? "Ball Don't Lie" : "wehoop / NBA.com")
  : "NBA.com / nba_api"
```

**Impact:** Medium (high-importance file, affects live board generation)

---

### 2.4 `lib/knowledge/enrichment/basketball.ts`

**CRITICAL: Current timeout issue (line 132):**
```typescript
const response = await fetch(url, { 
  headers: headers(), 
  signal: AbortSignal.timeout(12_000), // ← TOO SHORT
  cache: "no-store" 
});
```

**Phase 1 Action (URGENT):**
```typescript
const response = await fetch(url, { 
  headers: headers(), 
  signal: AbortSignal.timeout(18_000), // ← Match other NBA.com calls
  cache: "no-store" 
});
```

**Phase 2 Actions:**

Import BDL adapter:
```typescript
import { BallDontLieWnbaAdapter } from "@/lib/providers/ball-dont-lie-wnba";
```

Update `leagueAdapter()` function (line 188-202):
```typescript
async function leagueAdapter(scope: LeagueScope) {
  if (scope === "WNBA") {
    if (process.env.BALL_DONT_LIE_API_KEY) {
      return {
        leagueId: "10", // BDL uses WNBA natively
        provider: "ball-dont-lie" as const,
        adapter: new BallDontLieWnbaAdapter(),
      };
    }
    
    const selection = await resolveWnbaLeagueId();
    return {
      leagueId: selection.leagueId,
      provider: "wehoop-wnba" as const,
      adapter: new WeHoopWnbaAdapter(),
    };
  }
  
  return {
    leagueId: "00",
    provider: "nba-com-stats" as const,
    adapter: new NbaComStatsAdapter(),
  };
}
```

Update type union (line 336):
```typescript
// Phase 2+:
adapter: NbaComStatsAdapter | WeHoopWnbaAdapter | BallDontLieWnbaAdapter;
```

**Impact:** CRITICAL (core enrichment file, affects all WNBA data refresh jobs)

---

### 2.5 `lib/knowledge/enrichment/shared.ts`

**Current WNBA config (line 59-68):**
```typescript
WNBA: {
  league: "WNBA",
  leagueId: "wnba",
  sportId: "basketball",
  sportName: "WNBA",
  providerId: "wehoop-wnba", // ← Hardcoded provider
  participantTypeForPosition() { return "player"; },
},
```

**Phase 2 Action:**
```typescript
WNBA: {
  league: "WNBA",
  leagueId: "wnba",
  sportId: "basketball",
  sportName: "WNBA",
  providerId: process.env.BALL_DONT_LIE_API_KEY ? "ball-dont-lie" : "wehoop-wnba",
  participantTypeForPosition() { return "player"; },
},
```

**Impact:** Medium (used in type definitions and configuration)

---

### 2.6 `lib/knowledge/media.ts`

**Current code (line 61, 68):**
```typescript
firstExternalId(externalIds, ["nba-com-stats", "wehoop-wnba"])
```

**Phase 2 Action:**
```typescript
firstExternalId(externalIds, [
  "ball-dont-lie",
  "nba-com-stats",
  "wehoop-wnba" // fallback
])
```

**Impact:** Low (asset/media utilities, nice-to-have but not critical)

---

### 2.7 `lib/slips/official-enrichment.ts`

**Current code (line 39-40):**
```typescript
const leagueId = leg.sport === "WNBA" ? "10" : "00";
const season = leg.sport === "WNBA" ? String(new Date().getFullYear()) : undefined;
```

**Phase 2 Action:** No change needed (generic league ID handling, not provider-specific)

**Impact:** None (already generic)

---

## Section 3: Documentation Updates

### 3.1 Update Comments and Docstrings

**Files to update:**
- `lib/providers/wehoop-wnba.ts` — Add deprecation notice with Phase 3 timeline
- `lib/knowledge/enrichment/basketball.ts` — Update WNBA-specific comments
- `lib/knowledge/enrichment/shared.ts` — Clarify provider selection logic

**Example comment to add:**
```typescript
/**
 * WeHoopWnbaAdapter is a temporary wrapper over NbaComStatsAdapter.
 * 
 * This adapter uses stats.nba.com with LeagueID=10 to fetch WNBA data.
 * Note: "wehoop" is not a separate data source; it's a legacy naming convention.
 * 
 * STATUS: Deprecated in favor of BallDontLieWnbaAdapter (Phase 2+)
 * REMOVAL: Scheduled for Phase 3 after BDL stability confirmed
 * 
 * See docs/WNBA_DATA_ARCHITECTURE.md for migration plan.
 */
```

---

### 3.2 Update Provider Registry Documentation

Add to `lib/providers/provider-registry.ts` comments:
```typescript
/**
 * WNBA Provider Status (as of 2026-07-11):
 * 
 * Current: "wehoop-wnba" (stats.nba.com with LeagueID=10)
 * - Status: Working but fragile (undocumented API)
 * - Timeout: 18 seconds (increased from 12s due to GitHub Actions latency)
 * - Cost: Free
 * - Recommendation: Temporary fallback only
 * 
 * Upcoming: "ball-dont-lie" (Ball Don't Lie API)
 * - Status: In development (Phase 2)
 * - Cost: $40/month (WNBA tier)
 * - Recommendation: Primary WNBA data source
 * 
 * See docs/WNBA_DATA_ARCHITECTURE.md for details.
 */
```

---

## Section 4: Testing Changes

### 4.1 Update Provider Tests

**File:** `lib/providers/*.test.ts`

Any tests referencing `WeHoopWnbaAdapter`:
```typescript
// Phase 1: Keep existing tests
test("WeHoopWnbaAdapter delegates to NbaComStatsAdapter", () => {
  // ... existing test
});

// Phase 2: Add deprecation notice
// NOTE: These tests will be removed in Phase 3
// See docs/WNBA_DATA_ARCHITECTURE.md
```

---

### 4.2 Add BDL Tests (Phase 2)

Create: `lib/providers/ball-dont-lie-wnba.test.ts`
```typescript
test("BallDontLieWnbaAdapter fetches WNBA player stats", async () => {
  // Test implementation
});

test("BallDontLieWnbaAdapter respects rate limits", async () => {
  // Test rate limiting
});

test("BallDontLieWnbaAdapter falls back to stats.nba.com on error", async () => {
  // Test fallback behavior
});
```

---

## Section 5: Deployment Checklist

### Phase 1 (Week 1): Timeout Fix

- [ ] Increase timeout from 12s to 18s in `basketball.ts:132`
- [ ] Test WNBA schedule refresh from GitHub Actions
- [ ] Confirm no timeouts with Vercel diagnostic route
- [ ] Commit and push: "fix: increase WNBA scoreboard timeout from 12s to 18s"

### Phase 2 (Week 2-3): BDL Integration

- [ ] Create `lib/providers/ball-dont-lie-wnba.ts`
- [ ] Create `lib/providers/ball-dont-lie-config.ts`
- [ ] Update all adapter selection points (5 files)
- [ ] Add BDL tests
- [ ] Update provider registry
- [ ] Update documentation comments
- [ ] Deploy with feature flag (BDL off by default)
- [ ] Run parallel testing (BDL vs stats.nba.com)
- [ ] Gradual rollout (10% → 50% → 100%)
- [ ] Commit and push: "feat: add Ball Don't Lie adapter for WNBA data"

### Phase 3 (Week 4): Cleanup

- [ ] Remove `lib/providers/wehoop-wnba.ts`
- [ ] Remove `lib/providers/wnba-league-path.ts` (if not needed)
- [ ] Remove fallback references from 5 adapter-selection files
- [ ] Clean up provider registry
- [ ] Update documentation
- [ ] Run full test suite
- [ ] Commit and push: "refactor: remove legacy wehoop WNBA adapter"

### Phase 4 (Optional): Nightly Validation

- [ ] Implement wehoop R subprocess validation
- [ ] Add nightly comparison job
- [ ] Set up alerts for stat discrepancies
- [ ] Commit and push: "feat: add wehoop nightly WNBA stat validation"

---

## Section 6: Risk Assessment

| Phase | Risk Level | Mitigation | Rollback Plan |
|-------|-----------|-----------|---------------|
| 1: Timeout | LOW | Timeout matches other NBA.com calls | Revert timeout to 12s |
| 2: BDL Integration | MEDIUM | Feature flag, parallel testing, gradual rollout | Disable BDL, use old adapter |
| 3: Cleanup | LOW | Remove only after Phase 2 proven stable | Not applicable (cleanup only) |
| 4: Validation | LOW | Optional, non-critical | Skip if issues arise |

---

## Section 7: Cost Impact

| Phase | Action | Cost |
|-------|--------|------|
| 1 | Timeout fix | $0 |
| 2 | BDL integration | $40/month (trial: free 48h) |
| 3 | Cleanup | $0 (removal only) |
| 4 | Validation | $0 (R, open source) |

**Total ongoing cost:** $40/month for BDL WNBA tier

**Savings:** 
- Eliminated debugging fragile scrapers
- Eliminated GitHub Actions timeout incidents
- Enables premium prop/odds features
- Professional API support

---

## Section 8: Success Criteria

✅ **Phase 1 Success:**
- WNBA schedule refresh no longer times out
- Diagnostic route confirms successful endpoint reach

✅ **Phase 2 Success:**
- BDL adapter successfully fetches WNBA player stats
- Parallel testing shows parity with stats.nba.com
- Rate limiting works within budget
- Fallback to stats.nba.com works if BDL fails

✅ **Phase 3 Success:**
- All references to wehoop removed
- No broken imports or dangling references
- All tests pass
- Architecture documented

✅ **Phase 4 Success (optional):**
- Wehoop R validation finds zero significant discrepancies
- Nightly job completes successfully
- Alerts configured for stat mismatches
