# Project State — 2026-07-14 (audit appended 2026-07-15; superseded current-state 2026-07-18 below)

This document tracks known data population issues and operational state.
The 2026-07-15 audit section below is VERIFIED with read-only code inspection + live Supabase reads
and CORRECTS several 2026-07-14 hypotheses (notably: headshots are NOT a covered-score input).

---

## CURRENT STATE — 2026-07-27 (Session 61) — LIVE AND CERTIFIED

Go-live complete. Public PR `CoreyTenacity/Covered-Prop-Analysis#11` merged (public `main` =
`b3c33b47bfb89d01366f3fea3973f60e42f2cc3b`), Cloudflare deployment healthy, `COVERED_PRIVATE_PIPELINE_SHA_V2`
promoted to `182f6caf1a50c7d6cbcd64c1921f3832f153e8f2`. Natural run `30291332625`
(2026-07-27T17:54Z–17:58Z, success) published Covered Picks (5 rows, floor 71), Parlay (100 rows), Model
Performance (244 rows) — the Session 59 empty-snapshot symptom is resolved and proven live. See
`docs/AGENT_HANDOFF.md` Session 61 for full evidence. Rollback SHA on file:
`6d58a3aab8cc9e9d1da1c82887dc39434c9c0c1f` (not needed this session).

## SUPERSEDED — 2026-07-26/27 (Session 60) — SNAPSHOT-FIX READY, PROMOTION PENDING

The 2026-07-22 certification below described production as certified and healthy. Session 59 (2026-07-25)
found the live public snapshots (`covered-picks`, `parlay-options`) empty (`published`/`count=0`) despite
nonzero relational MLB supply — the certification below is superseded and should not be read as current.
The fix is committed on `codex/public-repo-repair` at `ef54794080e7014fd5247d250b59de1f25991cf8` (pushed) but
**not yet promoted** to `COVERED_PRIVATE_PIPELINE_SHA_V2` (still Session 58's `6d58a3aab8cc9e9d1da1c82887dc39434c9c0c1f`)
or proven live. See `docs/AGENT_HANDOFF.md` Session 60 for full detail.

## CURRENT STATE — 2026-07-22 (CERTIFIED FINAL PRODUCTION) — SUPERSEDED BY SESSION 59/60 ABOVE

- **Production certified:** `COVERED_PRIVATE_PIPELINE_SHA_V2=974593870ae0cec3b1ddc9152ffbd8b0694d3269`,
  `COVERED_PRIVATE_PIPELINE_SHA=RETIRED_STALE_RUN_GUARD`, `COVERED_GITHUB_SCHEDULER_ENABLED=true`.
  Private schedulers remain disabled; private `origin/main` remains `23f665955b55a9e862f7f2efa8205538c5426013`.
- **Certified natural run:** `29964366478` (`schedule`, success) checked out the certified V2 exactly and completed
  the bounded early-discovery / scoring / board / publication path without regressions.
- **Certified outputs:** Covered Picks `published` / 2 rows; Parlay `published` / 104 rows; Model Performance
  `published` / 116 rows.
- **Certified operational result:** early discovery, bounded Sharp request budgeting, identity repair, and
  WNBA background-ingest skip behavior remained healthy; the old whole-league Covered Picks suppression defect
  did not reproduce.
- **Do NOT** treat the older 2026-07-18 proof-in-flight notes below as current state; they are historical record
  only. The certified live state is the one above.

## CURRENT STATE — 2026-07-18 (Session 44 final-completion audit, read-only)

- **Production:** SHA `3087979d…`, scheduler `true`. Output **frozen at 2026-07-17T23:08Z** — the `events`
  horizon is stale (0 rows for 7/18–7/19, both leagues) because the authoritative schedule writers lived only in
  disabled private workflows. `scored_props`=475 (WNBA publishable 174, MLB 4); `covered_score>=70`=29.
- **Fix built, unproven:** candidate `8b266f4` (= `4404521` enrichment repairs + bounded pre-gate schedule
  refresh, 30-min TTL) makes the sole enabled public executor self-heal the horizon. Not pinned/proved.
- **Open known issues (dependency-ordered):**
  1. (Critical) schedule population unproven in production → nothing runs, output frozen.
  2. (High) MLB weather `game_id`, WNBA ZSTD decode, coverage/recent-features/matchup — code-fixed in `4404521`,
     production-unproven.
  3. (**Medium, NEW**) **model grader `gradeCompletedScoredProps` is unwired** (0 callers; `grading_results`=0
     rows) → model-performance + provider-backed user settlement have no graded data. See
     `docs/AUTO_GRADING_STATUS.md` correction. Small wiring fix, bundle into the final candidate.
  4. (Low) inert `lib/knowledge/pipeline` scaffolding (run-manifest/boundary-validation/module-reconciliation/
     contracts runtime) — 0 wired call sites; cost-free; wire-or-prune later.
  5. (Low) `ensureEvent` rewrites unchanged rows; bounded by the 30-min schedule TTL; change-detection deferred.
- **Classification: B — SMALL FINITE FIX SET REMAINS.** Finish line = one bundled final candidate
  (`8b266f4` + grading wiring) + one coordinated owner-gated MLB+WNBA proof. Detail + DONE criteria:
  `docs/AGENT_HANDOFF.md` Session 44. No production changes without explicit owner approval.

---

## Data Completeness & Covered-Score Audit — 2026-07-15 (VERIFIED, read-only)

**Method:** read-only code trace + bounded `selectRows` Supabase reads (JS-side aggregation), no writes.
**Scoring path of record:** per-sport adapters (`lib/knowledge/adapters/basketball.ts`) invoked by
`scoreCurrentProps()` in `lib/knowledge/scoring-service.ts:1051`. The hard publish gate is
`publishabilityAssessment()` (`scoring-service.ts:898`). `lib/scoring/covered-score.ts` is a generic
helper used only by the older `live-board.ts` path, NOT the production board.

### Two root causes (both currently active)

1. **CONFIG — scheduler disabled.** `COVERED_GITHUB_SCHEDULER_ENABLED = false` (repo Variable, confirmed
   via `gh variable list`). The 30-min `covered-live-pipeline.yml` schedule is gated off, so no
   enrichment/scoring/snapshot publish has run since a manual local test run on 2026-07-14 ~21:29.
   - `basketball_team_context.updated_at` newest = 2026-07-12 (~3 days stale).
   - 347/430 active WNBA props are in `prop_state=raw_current` (never scored).
   - Live `getParlayOptions('wnba')` returns **3 rows NOW**, but the published
     `parlay-options:latest` snapshot has **0 rows** (`status:"fallback"`, published 2026-07-14 21:29).
     → Re-enabling the scheduler would repopulate the parlay builder immediately.

2. **DATA GAP — WNBA player identity enrichment.** `players.external_ids['wehoop-wnba']` = **10/227 (4.4%)**.
   This is the key used to ingest player game logs → recent features → projection. At 4.4% coverage,
   ~95% of WNBA players can't get fresh logs, so few scored props clear the `missing_recent_logs` /
   `stale_features` publish blockers. This is why Covered Picks (needs `publishable`) stays thin even
   though the parlay builder (needs only `scored`) can populate.

### Live completeness snapshot (2026-07-15 00:40 UTC)

WNBA:
- players: 227 total | wehoop-wnba id **4.4%** | nba-com-stats id 2.6% | headshot_url 2.6% | current_team_id 99.6%
- basketball_team_context: 15 teams, defensive_rating/pace/offensive_rating **100%** (but newest updated 2026-07-12)
- current_props: 430 active, **only 4 future start_time** | player_id 91.6% | team_id/opponent 73.7% | event_id 100%
  | prop_state: publishable 69, candidate 14, raw_current 347

MLB:
- players: 371 | current_props: 396 active, **0 future** | team_id/opponent **0%** | all 396 raw_current, 0 publishable
- MLB slate is stale (0 future props) — consistent with prior MLB gating findings.

### Covered-score required fields (traced from adapter + publishability code)

WNBA — SCORE accuracy: current_props(line, direction, side, over/under_price, data_quality_score, match_confidence),
basketball_player_features OR player_recent_features(recent_/season_ points/rebounds/assists/minutes, usage_trend),
basketball_team_context(pace), basketball_opponent_context(opponent_pace, opponent_defensive_rating),
odds_snapshots(pulled_at).
WNBA — PUBLISHABLE gate: player_id+participant_id, event_id, team_id, opponent_team_id,
match_confidence≥0.75 & strong match_status, recent player features present & not stale, team context present, matchup/opponent context present.
MLB — SCORE: mlb_batter/pitcher_features, mlb_weather, mlb_starting_pitchers, mlb_bullpen_context, mlb_ballparks, mlb_handedness_splits, matchup_features; same identity publish gate.
Minimum viable (all sports): strong identity match + non-stale recent player features + team context + opponent/matchup context + fresh odds snapshot.

**NOT required for score accuracy:** `headshot_url`, `participant_image_url`, `team_logo_url`, `external_ids`
(external_ids matters only INDIRECTLY, as the log-ingestion key). This corrects the 2026-07-14 "Issue 1" framing.

### Approved-only next steps (nothing done yet — read-only so far)

- (Config) Re-enable `COVERED_GITHUB_SCHEDULER_ENABLED=true` → republishes snapshots, fills parlay builder. Cheapest.
- (Data) Run `refresh_players` for WNBA to raise wehoop-wnba coverage → widens publishable Covered Picks pool. Requires a write job — must be explicitly approved.
- (Code, Part C) Add in-job completeness validation + `docs/DATA_COMPLETENESS.md`. No data writes.
- Owner has NOT yet chosen a direction; do not execute writes/scheduler changes without explicit approval.

---

## Known Issues (2026-07-14 — see audit above for verified resolutions)

### Issue 1: Picture URLs NULL in Published Snapshots

**Status (UPDATED 2026-07-15):** RESOLVED as a display-only data gap. Derivation IS applied at publish time
(`read-service.ts:591-608`); NULLs occur only where a player has no `external_ids['wehoop-wnba']` (4.4% coverage) —
verified live: 10/20 covered-picks rows have headshots, team logos 20/20. **These fields are NOT covered-score inputs**,
so this has zero impact on score accuracy. Downgraded from High to cosmetic. Fix = raise wehoop coverage (see audit).

**Severity:** Low (cosmetic; not a scoring defect)

**Evidence:**
- `lib/knowledge/read-service.ts` (950-967): `getParlayOptions()` applies derivation logic for `derivePlayerHeadshotUrl()` and `deriveTeamLogoUrl()` at runtime
- `lib/knowledge/public-snapshots.ts` (421-424): `coveredPicksSourceRow()` function creates snapshots from `CoveredPickRow`, preserving all fields including image URLs
- `lib/ops/public-snapshots.test.ts` (80-122): Test fixtures consistently show all image URL fields as NULL
- **Unverified:** Whether published snapshots in `provider_cache` actually contain NULL values or whether test fixtures are stale

**Root Cause Unconfirmed:**
- Hypothesis A: Image URL derivation is not applied during snapshot build (only at read-time for fallback path)
- Hypothesis B: Snapshot source rows themselves have NULL values before derivation is applied
- Hypothesis C: Test fixtures are stale; live snapshots may contain populated URLs

**Investigation Required:**
1. Trace actual snapshot build flow in GitHub Actions (does derivation happen pre-publication or only at read-time?)
2. Query live `provider_cache` snapshots and inspect image URL fields
3. If NULL confirmed in live snapshots, add logging to identify where derivation is dropped

**Blocking:**
- Parlay Builder display quality
- Covered Picks card UX (player headshots)
- Model Performance dashboard

**Related Files:**
- `lib/knowledge/read-service.ts` (image derivation logic)
- `lib/knowledge/public-snapshots.ts` (snapshot publication)
- `lib/ops/github-actions-pipeline.ts` (board build and publication orchestration)
- `lib/ops/public-snapshots.test.ts` (test fixtures)

---

### Issue 2: Defensive Context Exposure Status

**Status (UPDATED 2026-07-15):** RESOLVED. `basketball_team_context.defensive_rating` and
`basketball_opponent_context.opponent_defensive_rating` ARE genuine covered-score inputs (matchup score in
`adapters/basketball.ts`), populated 100% for 15 WNBA teams. They are intentionally NOT surfaced in the public
API response (internal scoring only). Both facts coexist — not a regression. No action needed unless a product
decision is made to expose them in the UI.

**Severity:** Low (working as designed)

**Evidence:**
- `lib/db/supabase-schema.sql`: `basketball_team_context` table exists with defensive ratings (internal-only)
- `lib/knowledge/read-service.ts`: No defensive context fields exposed in public read methods
- Public snapshot types do not include defensive context
- **Unverified:** Whether frontend expects these fields or whether they were never part of the public API

**Root Cause Unconfirmed:**
- Hypothesis A: Frontend never relied on defensive context (internal analysis feature only)
- Hypothesis B: Recent refactoring removed defensive context exposure (regression)
- Hypothesis C: Defensive context is per-sport and WNBA doesn't have equivalent data model

**Investigation Required:**
1. Search git history for when (if ever) defensive context was part of public API
2. Search frontend code for references to defensive rating fields
3. Determine whether field is missing-by-design or regression
4. If regression, identify the change and evaluate re-exposure

**Related Files:**
- `lib/db/supabase-schema.sql` (basketball_team_context table)
- `lib/knowledge/read-service.ts` (public read methods)
- `lib/knowledge/read-types.ts` (public type contracts)
- `app/(dashboard)/props/` (frontend prop display components)

---

### Issue 3: Parlay Save Functionality Verification

**Status (UPDATED 2026-07-15, refined 2026-07-16):** Empty parlay builder ROOT-CAUSED to the stale snapshot, NOT
a code bug: live `getParlayOptions('wnba')` returns rows while the published snapshot has 0. **Refinement
(2026-07-16, read-only diagnosis):** "scheduler off" alone is no longer the full picture -- `covered-picks` WAS
successfully republished on 2026-07-16 (14 rows) in what appears to be the same nominal orchestrator call that
left `parlay-options` still at its 2026-07-14 publish, meaning `parlay-options`'s own build/write step most
likely failed silently during that run. The exact historical exception is unrecoverable (an unlogged local
run); this is a supported inference, not a proven exact exception. `lib/knowledge/public-snapshots.ts` now
emits a structured, logged failure per route (`errorStage`, `publicationAttempted`, `publicationCompleted`,
`priorLatestSnapshotRetained`, one `console.error` line) so a future occurrence is caught immediately -- see
`docs/AGENT_HANDOFF.md`'s "Session 13". **Restoring the Parlay Builder still requires a separate,
explicitly owner-approved live publication; none occurred in session 13.** The user save POST routes
(`/api/me/parlays`, `/api/me/picks`) exist and are wired in `parlay-builder-shell.tsx`; a live Cloudflare
auth roundtrip test is still the one open verification item here.

**Severity:** Medium (auth-dependent feature; display path root-caused to config)

**Evidence:**
- Parlay options public snapshot is operational: `/api/knowledge/parlay-options` returns HTTP 200, correct row count
- `getParlayOptions()` derives image URLs at read-time (for fallback path)
- Parlay builder publishes options correctly into snapshot
- **Clarified:** Public snapshot publishes parlay options (display data); user parlay saves are a separate auth feature

**Root Cause Unconfirmed:**
- No defect confirmed; the distinction is architectural:
  - Public snapshot serves pre-built parlay options for display
  - User save flow is a separate POST route requiring authentication
  - These are intentionally separate concerns

**Investigation Required:**
1. Verify user parlay save POST route works on Cloudflare (auth, database writes)
2. Test full user flow: login → view options → save parlay → retrieve saved parlay
3. Confirm response envelope and error handling

**Status After Clarification:**
- Public parlay options: Working (snapshot-first)
- User parlay saves: Requires functional test on Cloudflare with live login

**Related Files:**
- `app/api/knowledge/parlay-options/route.ts` (public snapshot route)
- `app/api/parlay/` (user save routes, if present)
- `lib/knowledge/parlay-types.ts` (shared types)

---

## Deployment Status

**Cloudflare/OpenNext Proof:** COMPLETE
- Live (account-specific `*.workers.dev` hostname intentionally not repeated here; see `wrangler.jsonc`'s `name` field)
- Public snapshot routes operational
- Auth routes accessible
- Admin/cron routes disabled as designed

**Production Decision Pending:**
- Domain strategy (custom domain vs. preview URL)
- Whether to replace Vercel entirely or run parallel deployments
- Cutover plan and rollback procedure

---

## Next Steps (superseded by the 2026-07-15 audit — read that section first)

Priority order after the audit:
1. **Config:** decide whether to re-enable `COVERED_GITHUB_SCHEDULER_ENABLED=true` (fills parlay builder immediately). Owner has not yet chosen.
2. **Data:** WNBA `wehoop-wnba` external-id backfill via `refresh_players` (widens publishable Covered Picks). Write job — needs explicit approval.
3. **Parlay saves:** live Cloudflare auth roundtrip test (`/api/me/parlays`, `/api/me/picks`).
4. (Optional) Part C in-job completeness validation + `docs/DATA_COMPLETENESS.md`.

Issues 1 and 2 above are RESOLVED (see per-issue UPDATE notes). Do not execute writes or scheduler changes without explicit owner approval.
