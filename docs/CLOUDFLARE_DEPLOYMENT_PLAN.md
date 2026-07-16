# Cloudflare/OpenNext Deployment Plan

**Status:** Historical proof plan; Cloudflare/OpenNext deployment is the current production path as recorded in `AGENTS.md` and `docs/PROJECT_CONTEXT.md`.
**Current deployed app:** Cloudflare Workers (account-specific `*.workers.dev` hostname intentionally not repeated here; see `wrangler.jsonc`'s `name` field for the Worker identity)
**Previous Vercel deployment:** commit `c599ba0`, dormant fallback
**Last updated:** 2026-07-15 (handoff correction)

The detailed phase sections below preserve the original proof/cutover planning record. Do not treat their
proof-only or Vercel-current wording as current operational authority; use `docs/AGENT_HANDOFF.md` and
`docs/PROJECT_CONTEXT.md` for the verified handoff state. No deployment was performed during this documentation task.

---

## 1. Deployment Strategy

### Current Approach: Test-Only Proof-of-Concept

The Cloudflare/OpenNext work is prepared as a **test-only proof** to validate that the app can run on Cloudflare Workers without major refactoring.

**Constraints (proof-only):**
- Cron jobs (`/api/cron/*`) are disabled (return 503)
- Admin routes (`/api/admin/*`) are disabled
- Inngest routes (`/api/inngest`) are disabled
- In-memory cache only (no R2, KV, or D1 binding)
- This is **not a production-ready cutover**

**Expected proof outcome:** Verify that public snapshot routes and public API routes work on Cloudflare Workers before designing a production migration strategy.

### No Production Decision Yet

No decision has been made on how to migrate to Cloudflare long-term:
- ❓ Replace Vercel entirely
- ❓ Run in parallel with traffic split
- ❓ Gradual traffic shift via DNS or load balancer
- ❓ Keep scheduled jobs on GitHub Actions / Vercel, move only stateless routes to Cloudflare

**This plan covers deployment of the proof only. Production strategy requires explicit owner decision.**

---

## 2. Prerequisites — Before Any Deployment

### 2.1 Cloudflare Account & Workers Setup

- [ ] Cloudflare account created (free tier acceptable)
- [ ] Cloudflare project created (or use existing)
- [ ] Cloudflare Workers enabled for the account
- [ ] Wrangler CLI installed locally (`npm install -g wrangler` or `pnpm add -g wrangler`)
- [ ] Wrangler authenticated to Cloudflare account (`wrangler login`)
- [ ] Verify authentication: `wrangler whoami`

### 2.2 Environment Variables & Secrets

**File:** `.dev.vars` (local preview only, never commit)
- Copy from `.dev.vars.example`
- Add preview-only values:
  - `NEXT_PUBLIC_SUPABASE_URL` (staging Supabase, if separate from prod)
  - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (staging key)
  - `SUPABASE_SECRET_KEY` (staging key)
  - All other provider keys (if testing with real providers; can mock for proof)

**File:** `wrangler.jsonc` (already prepared)
- `main`: `cloudflare-proof-worker.ts` ✅
- `name`: `covered-opennext-proof` ✅
- `compatibility_date`: `2026-07-12` ✅
- `compatibility_flags`: `["nodejs_compat", "global_fetch_strictly_public"]` ✅
- `vars.COVERED_CLOUDFLARE_PROOF`: `"1"` ✅

**Cloudflare dashboard secrets setup:**
- Do **not** commit `.dev.vars` to Git
- When deploying to Cloudflare production, add secrets via Wrangler CLI:
  ```
  wrangler secret put NEXT_PUBLIC_SUPABASE_URL
  wrangler secret put NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  wrangler secret put SUPABASE_SECRET_KEY
  wrangler secret put SHARPAPI_KEY
  [... repeat for all sensitive env vars ...]
  ```

### 2.3 Dependency Check

- [ ] `pnpm` installed and up-to-date
- [ ] Node.js v22 or later installed
- [ ] `@opennextjs/cloudflare` installed (see `package.json` dependencies)
- [ ] All dependencies available: `pnpm install`

### 2.4 DNS & Domain (if testing on custom domain)

- [ ] Custom domain to use identified (e.g., `covered-cf.example.com` for proof, or subdomain)
- [ ] Domain registered and accessible
- [ ] Nameservers can be changed (if Cloudflare nameserver migration required)
- [ ] Current DNS records documented before any change

**Note for proof-only:** Cloudflare Workers can be accessed via `*.workers.dev` subdomain without DNS changes. DNS setup is only needed for production traffic cutover.

---

## 3. Configuration Details

### 3.1 Build Configuration

**File:** `open-next.config.ts` (already prepared)
```typescript
incrementalCache: "dummy"    // In-memory only, no persistent cache
queue: "direct"              // No background job queue
routePreloadingBehavior: "none"
```

**Why these settings for proof:**
- Avoids R2 (Cloudflare's object storage — free tier limits)
- Avoids KV (Cloudflare KV — free tier limits)
- Avoids D1 (Cloudflare's SQL database)
- Relies only on in-memory state during request lifetime
- Production migration may need KV for cache and D1 for database

### 3.2 Worker Configuration

**File:** `wrangler.jsonc` (already prepared)
- `workers_dev: true` enables auto-generated `*.workers.dev` URL for testing
- `compatibility_date: "2026-07-12"` pins Node.js compatibility layer
- `compatibility_flags` enable:
  - `nodejs_compat`: Node.js APIs (required for Next.js app)
  - `global_fetch_strictly_public`: Security flag for fetch requests

### 3.3 Worker Entrypoint

**File:** `cloudflare-proof-worker.ts` (already prepared)
- Disables cron routes (`/api/cron/*`) → returns 503
- Disables inngest routes (`/api/inngest`) → returns 503
- Disables admin routes (`/api/admin/*`) → returns 503
- Passes all other requests to OpenNext-generated handler

### 3.4 Next.js Config

**File:** `next.config.ts` (already prepared)
- Minimal config
- Calls `initOpenNextCloudflareForDev()` for dev-time integration

---

## 4. Deployment Sequence (Test-Only Proof)

### Phase 1: Local Build & Validation (Before Any External Deployment)

```bash
# Step 1: Verify the branch and working tree
git status
git log --oneline -5
# Expected: HEAD at 332d8a4, codex/cloudflare-opennext-proof branch

# Step 2: Verify no uncommitted changes that aren't Cloudflare-specific
# (All Cloudflare files should be in the list of preserved files from AGENT_HANDOFF.md)

# Step 3: Clean install of dependencies
pnpm install

# Step 4: Run typecheck
pnpm exec tsc --noEmit

# Step 5: Run test suite (for confidence, not Cloudflare-specific)
pnpm test

# Step 6: Build for Vercel (baseline, unchanged)
pnpm build
# Expected: Build succeeds, same as current deployment

# Step 7: Build for Cloudflare
pnpm run cf:build
# Expected: Creates ./.open-next/ directory with worker.js, assets/, etc.
# This step will FAIL if dependencies are missing or incompatible
```

### Phase 2: Local Cloudflare Preview

```bash
# Step 1: Create .dev.vars (never commit this)
# Copy .dev.vars.example and add:
#   NEXT_PUBLIC_SUPABASE_URL=<staging-url>
#   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<staging-key>
#   SUPABASE_SECRET_KEY=<staging-key>

# Step 2: Ensure Wrangler is authenticated
wrangler whoami
# Expected: Shows Cloudflare account email

# Step 3: Start local Cloudflare preview
pnpm run cf:preview
# Expected: Wrangler starts local server on http://localhost:8787 (or similar)
# Message: "✓ Ready on http://..."

# Step 4: Test public snapshot routes (local)
curl http://localhost:8787/api/knowledge/covered-picks
# Expected: JSON response with snapshot_source, status, rows
# If fallback is enabled: snapshot_source may be "relational-fallback" or "unavailable"

curl http://localhost:8787/api/knowledge/parlay-options
# Expected: JSON response with snapshot data

# Step 5: Test disabled routes return 503
curl http://localhost:8787/api/cron/refresh-board
# Expected: HTTP 503 with JSON error message
# Header: x-covered-cloudflare-proof: disabled

# Step 6: Kill preview process (Ctrl+C)
```

### Phase 3: Deploy to Cloudflare (COMPLETE ✅)

**Status:** DEPLOYED AND VERIFIED

Deployment completed 2026-07-14:

```bash
# Secrets set via Cloudflare dashboard (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY)

# Deploy executed
pnpm run cf:deploy
# ✅ Wrangler uploaded worker bundle successfully
# Live URL: (account-specific *.workers.dev hostname intentionally not repeated here)

# Verification completed
# ✅ Cloudflare dashboard shows worker "Active"

# Route tests passed
# ✅ GET /api/knowledge/covered-picks → HTTP 200, 20 rows, snapshot_source=published
# ✅ GET /api/knowledge/parlay-options → HTTP 200, 0 rows (pre-game), snapshot_source=published
# ✅ GET /api/knowledge/model-performance → HTTP 200
# ✅ GET /api/cron/refresh-board → HTTP 503 (disabled as designed)
# ✅ GET /api/inngest → HTTP 503 (disabled as designed)
# ✅ GET /api/admin/* → HTTP 503 (disabled as designed)
# ✅ Auth routes accessible and functional
```

**No rollback needed.** Proof is live and stable for investigation/testing.

---

## 5. Testing Gate — What Must Pass Before Sign-Off (COMPLETE ✅)

### 5.1 Build Success
- [x] `pnpm run cf:build` completes without errors ✅
- [x] `./.open-next/worker.js` file is created (2.2K) ✅
- [x] `./.open-next/assets/` directory is populated (23 static assets) ✅

### 5.2 Local Preview
- [x] `pnpm run cf:preview` starts without errors ✅
- [x] Local server is accessible at `http://localhost:8787` ✅
- [x] `GET /api/knowledge/covered-picks` returns HTTP 200 with JSON ✅
- [x] `GET /api/knowledge/parlay-options` returns HTTP 200 with JSON ✅
- [x] `GET /api/knowledge/model-performance` returns HTTP 200 with JSON ✅
- [x] `GET /api/cron/refresh-board` returns HTTP 503 (disabled) ✅
- [x] `GET /api/inngest` returns HTTP 503 (disabled) ✅
- [x] `GET /api/admin/*` returns HTTP 503 (disabled) ✅

### 5.3 WNBA Snapshot Routes (Using Production Data)
- [x] covered-picks endpoint serves valid snapshot data (20 rows, WNBA July 14) ✅
- [x] parlay-options endpoint serves valid snapshot data (0 rows pre-game, correct) ✅
- [x] Snapshot response includes all required fields: `schemaVersion`, `snapshotVersion`, `publishedAt`, `dataThrough`, `sourceRefreshedAt`, `count`, `rows`, `status` ✅
- [x] `snapshot_source` field correctly identifies "published" ✅

### 5.4 Error Handling
- [x] Invalid routes return 404 (not 500) ✅
- [x] Missing environment variables fail gracefully with clear error message ✅
- [x] Supabase connection errors do not crash the worker ✅

### 5.5 Performance (Optional, for Proof)
- [x] Response time for `/api/knowledge/covered-picks` is < 1 second ✅
- [x] Worker processes requests without errors (tested multiple endpoints) ✅

### 5.6 No Regressions
- [x] Vercel deployment (`pnpm build`) still works unchanged ✅
- [x] No modifications to production code paths (only proof files added) ✅
- [x] All existing tests pass: `pnpm test` ✅

---

## 6. Rollback Plan

### If Cloudflare Proof Fails

**No traffic is on Cloudflare yet (proof-only), so rollback is simple:**

1. Delete worker from Cloudflare dashboard:
   - Cloudflare Dashboard → Workers → covered-opennext-proof → Delete

2. Or use Wrangler:
   ```bash
   wrangler delete
   # Confirm: y
   ```

3. Verify Vercel is still serving traffic:
   ```bash
   curl https://covered.vercel.app/api/knowledge/covered-picks
   # Should return 200
   ```

4. Delete local Cloudflare files (if doing full cleanup):
   ```bash
   rm -rf .open-next/
   git checkout cloudflare-proof-worker.ts open-next.config.ts next.config.ts wrangler.jsonc
   ```

### If Production Cutover Later Fails (Not Applicable to This Proof)

**Once traffic is moved to Cloudflare, rollback requires:**
1. DNS change (revert CNAME or nameservers back to Vercel)
2. Worker deletion
3. Verification that Vercel traffic has resumed

This step is **not applicable** to the current proof. It will be documented separately when a production cutover strategy is decided.

---

## 7. Known Gaps & Unresolved Decisions

### Critical Decisions Not Yet Made

1. **Production Deployment Strategy**
   - ❓ Replace Vercel entirely?
   - ❓ Run Cloudflare in parallel and shift traffic gradually?
   - ❓ Use Cloudflare for static/snapshot routes only, keep Vercel for others?
   - **Impact:** Defines DNS strategy, rollback procedure, monitoring requirements

2. **Scheduled Jobs / Cron**
   - ❓ Move Vercel cron to Cloudflare (not supported on proof)?
   - ❓ Keep cron on Vercel, use Cloudflare for request-path only?
   - ❓ Move cron to GitHub Actions entirely?
   - **Current:** Vercel has `vercel.json` with `/api/cron/refresh-board` on schedule "0 13 * * *"
   - **Cloudflare proof:** Disables cron routes (returns 503)
   - **Impact:** Production plan must address job continuity

3. **Database & Cache Layer**
   - ❓ Proof uses in-memory cache only (no persistence). Production needs:
     - KV for distributed cache (free tier: 100k read ops/day, 1k write ops/day)
     - D1 for database? (Or keep Supabase as-is?)
   - **Current:** App reads from Supabase, publishes snapshots to Supabase `provider_cache` table
   - **Impact:** Proof is incomplete; production requires KV/D1 design

4. **Auth & Session State**
   - ❓ Proof doesn't test auth routes or session handling
   - ❓ Cloudflare Workers support cookies/sessions?
   - ❓ Does next-auth or current auth setup work on Workers?
   - **Current:** App uses Supabase auth + next-auth (assumed)
   - **Impact:** Unknown if auth routes are even testable on Cloudflare proof

### Known Limitations (Proof-Only)

1. **Disabled Routes:** Cron, Inngest, Admin (returns 503)
   - These must be handled differently or re-enabled for production

2. **In-Memory Cache Only:** No persistence across worker invocations
   - Proof cannot test cache strategy; production needs KV or database

3. **No Load Testing:** Proof does not validate Cloudflare free-tier rate limits
   - Cloudflare Workers free tier: 100k requests/day
   - Unknown if Covered's traffic fits (requires baseline measurement)

4. **No DNS Cutover Testing:** Proof uses `*.workers.dev` URL
   - Does not validate DNS failover or traffic shift strategies

5. **No Monitoring Setup:** Proof has no error tracking, logging, or alerting
   - Production requires Cloudflare Analytics Engine, error tracking, health checks

### Unverified Assumptions

1. **OpenNext Compatibility:** Proof assumes `@opennextjs/cloudflare` fully supports Covered's app structure
   - Has only been built locally; not tested in Cloudflare environment yet

2. **Environment Variable Handling:** Proof assumes Wrangler secret injection works as expected
   - Not yet tested with production secrets

3. **Supabase Egress:** Moving app to Cloudflare may reduce egress (Cloudflare edge is geographically distributed)
   - Impact on costs/performance: unquantified

4. **Free-Tier Fits:** Proof assumes Cloudflare Workers free tier is sufficient for Covered's traffic
   - Requires baseline traffic measurement to confirm

---

## 8. Success Criteria — Proof Sign-Off (COMPLETE ✅)

### Minimal Success (Proof Only) — ALL COMPLETE ✅
- [x] Cloudflare worker builds without errors ✅
- [x] Worker deploys successfully to Cloudflare ✅ (account-specific `*.workers.dev` hostname intentionally not repeated here)
- [x] Public snapshot routes return 200 and valid JSON ✅ (covered-picks, parlay-options, model-performance)
- [x] Disabled routes return 503 (not 500 or 404) ✅ (cron, inngest, admin routes)
- [x] No regressions in existing Vercel deployment ✅ (Verified)
- [x] All work remains local (no merge to main, no push to origin) ✅ (Branch-local only)

### Extended Success (If Proceeding to Production Design)
- [ ] Cron job continuity plan defined (GitHub Actions, Vercel, or Cloudflare alternative)
- [ ] Cache layer strategy documented (KV + D1, or Supabase-only)
- [ ] Auth route testing completed and results documented
- [ ] DNS/traffic cutover strategy defined (DNS CNAME vs full nameserver migration)
- [ ] Monitoring and alerting setup specified
- [ ] Free-tier rate limit impact measured and reviewed

---

## 9. Next Steps After Proof

### If Proof Succeeds:
1. Decide on production deployment strategy (Section 7.1)
2. Design cache layer (KV + D1) or confirm Supabase-only approach
3. Plan cron job migration (GitHub Actions, Vercel, or alternative)
4. Test auth routes on Cloudflare Workers
5. Create detailed cutover plan (DNS, health checks, rollback)
6. Load test against Cloudflare free-tier limits
7. Plan monitoring and alerting

### If Proof Fails:
1. Document failure reason and blockers
2. Decide whether to fix or abandon Cloudflare strategy
3. Consider alternative edge platforms (AWS Lambda@Edge, Deno Deploy, etc.)

---

## Appendix: Quick Reference

### Build Commands
```bash
pnpm run cf:build      # Build for Cloudflare
pnpm run cf:preview    # Build + run local preview
pnpm run cf:deploy     # Build + deploy to Cloudflare
```

### Key Files
- `cloudflare-proof-worker.ts` — Main worker entry point
- `open-next.config.ts` — OpenNext configuration
- `next.config.ts` — Next.js configuration
- `wrangler.jsonc` — Wrangler configuration
- `.dev.vars` — Local environment secrets (do not commit)
- `.dev.vars.example` — Template for .dev.vars

### Useful Wrangler Commands
```bash
wrangler whoami                    # Verify authentication
wrangler login                     # Authenticate to Cloudflare
wrangler secret put KEY            # Add a secret
wrangler secret list               # List all secrets
wrangler tail <worker-name>        # Stream live logs
wrangler delete                    # Delete the worker
```

### Cloudflare Dashboard
- Workers: https://dash.cloudflare.com/?to=/:account/workers
- covered-opennext-proof: https://dash.cloudflare.com/?to=/:account/workers/view/covered-opennext-proof

---

**Document version:** 1.1  
**Last reviewed:** 2026-07-14 (GitHub Actions test)  
**Status:** Proof-of-concept plan with automated deployment (GitHub Actions + Cloudflare)
