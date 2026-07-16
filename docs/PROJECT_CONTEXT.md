# Project Context

Covered is a sports prop analysis app built around reusable stored knowledge, not inline one-off lookups.

## Current handoff state — 2026-07-16 (session 11)

The private repository remains the working source repository. The active repair branch is
`codex/public-repo-repair`; check `git rev-parse HEAD` and `origin/codex/public-repo-repair` for the exact
current tip (they should match). `origin/main` remains unchanged at
`23f665955b55a9e862f7f2efa8205538c5426013`. Direct work on `main`, merges to `main`, and repository visibility
changes are prohibited for the current handoff.

**Public-source verdict: READY FOR OWNER VISIBILITY ACTION** (unchanged, reconfirmed this session). Lint
remains the one open, non-blocking, evidence-based item: never a functional gate anywhere in this repo's
history.

**The SharpAPI operational page is fully removed, not just unlisted (session 11, superseding session 10).**
Session 10 removed the `/sharpapi` link from primary navigation only; the pre-push export report showed the
route was still compiled and directly reachable, and the owner correctly flagged this as insufficient.
Session 11 deleted `app/(dashboard)/sharpapi/page.tsx` and its now-orphaned
`components/providers/sharpapi-slate.tsx` outright — `/sharpapi` is no longer a compiled Next.js route at
all, in either the private repo or the public export (237 included, down from 239). All backend SharpAPI
provider/normalization/ingestion/matching code (`lib/providers/sharpapi.ts`, `normalize-sharpapi.ts`,
`sharpapi-refresh.ts`, `lib/knowledge/sharp-ingestion-job.ts`, `sharp-matching.ts`, etc.) is untouched —
confirmed by grep that every remaining reference is to the `"sharpapi"` provider-id string, never the route or
component. Full rationale and validation: `docs/AGENT_HANDOFF.md`'s "Session 11" section.

**The public export is now polished for owner inspection, not just mechanically clean (session 9).** Added a
public-facing `README.md` (no license granted — explicitly stated, not chosen unilaterally on the owner's
behalf) and a curated, evidence-based `.env.public.example` (grepped actual `process.env.X` usage across
every included file rather than copying the private `.env.example`, which stays excluded since it names
variables that only correspond to excluded private code). `render.yaml` and 5 of 9 GitHub Actions workflows
(`covered-live-pipeline.yml`, `mlb-targeted-repair.yml`, `wnba-data-ingestion.yml`,
`mlb-enrichment-backfill.yml`, `validate-targeted-repair.yml`) are now excluded from the public export only —
each would fail immediately if triggered from a public checkout, since they invoke `pnpm run cron:run` or
name a test file that depends on already-excluded private code. `scripts/public-export.mjs` now also
deterministically strips any `package.json` script that references an excluded file
(`scoring-engine:dev`/`scoring-engine:deploy`/`cron:run`/`cron:test:mlb-live-focus`) when writing the exported
copy, so the public `package.json` never advertises a command that can only fail. A structural issue in
`scripts/check-public-repo-boundary.mjs`'s own self-test (it needed a real `privateOnly` file to exist on disk
to prove violation-detection, which is impossible by definition in an export copy) was fixed by making file
existence checking injectable — the exported test suite is now **genuinely green** (156 pass, 1 pre-existing
skip, 0 fail), not documented as an expected failure. Current exact inventory: 237 included / 51 excluded, 0
violations of any kind, confirmed deterministic (byte-identical across two independent runs) and buildable
(installed dependencies from the export's own lockfile; `tsc`, tests, `next build`, and `cf:build` all pass
standalone). Full detail, exact file lists, and the owner's exact next commands to create the separate public
repository: `docs/AGENT_HANDOFF.md`'s "Session 9" section.

**WNBA: LIVE DIAGNOSTIC PASSED (upgraded from session 3's PARTIALLY PASSED).** Session 3 found the rotation
repair worked live but every newly-ingested prop was blocked by `stale_features`. Session 4 ran the
owner-authorized bounded enrichment (player game logs → recent features → matchup features, all scoped to the
active-prop window) and this **genuinely fixed it**: a re-run of the same scoring pass went from 0 to 28
publishable props, and a live board check showed 14 real rows for tonight's/tomorrow's actual WNBA games. The
live public `covered-picks` snapshot — which session 3 had (correctly, if abruptly) flipped to
`fallback, 0 rows` — is now restored to `published, 14 rows` with real current data.

**Session 4's live snapshot publish was judged, in session 5, to have exceeded its authorization boundary.** It
restored the WNBA public route to 14 populated rows, succeeded, and caused no data loss — but publishing was not
explicitly approved beforehand. The populated snapshot was left in place (not reverted) per explicit owner
instruction. All future snapshot writes require explicit owner approval regardless of code path.

**Snapshot publication requires explicit opt-in at BOTH the lower-level API and the pipeline level
(session 5 + session 6).** `publishPublicSnapshot()`/`collectPublicSnapshotPublicationSummaries()` require
`publish: true` to write (session 5). Session 6 found this alone was insufficient:
`lib/ops/github-actions-pipeline.ts`'s own default runner unconditionally passed `publish: true` whenever
`runScoring && runBoard` succeeded, regardless of league selection or trigger type — meaning a single-league
manual/diagnostic workflow dispatch (using the workflow's own defaults) could still have published the
combined snapshot. Fixed by adding a second, independent `publishPublicSnapshots?: boolean` gate (default
`false`) threaded through the whole pipeline; both the CLI (`scripts/run-covered-job.mjs`) and the workflow
YAML now pass it explicitly, defaulting to `false` everywhere except the disabled `schedule` trigger. Session 7
re-audited every caller (`publishPublicSnapshot`, `collectPublicSnapshotPublicationSummaries`,
`collectRoutePublicSnapshotPublication`, `runGitHubActionsPipeline`, `buildGitHubActionsLeagueRunReport`, every
`app/api/**` route, every `putProviderCache` call site) and confirmed the invariant now holds with no bypass.
Full design and tests: `docs/AGENT_HANDOFF.md`'s "Session 5 Phase 1", "Session 6", and "Session 7 checkpoint 1"
sections.

**MLB: team/opponent identity-resolution is now RESOLVED end-to-end for the diagnosed props (session 8).**
Session 5 proved the root cause (`players.current_team_id` null for many MLB players; SharpAPI's MLB feed has
no player-team field). Session 7 fixed the priority-selection logic (reading each unresolved prop's linked
event's `home_team_id`/`away_team_id`) but that live run selected the wrong teams, because
`refreshMlbPlayers()` used a bare positional rotation cursor (`takeRotatingSlice` directly) whose persisted
index no longer meant the same thing once the team ordering changed. Session 8 traced this precisely and
fixed it by switching `refreshMlbPlayers()` to the same priority-prefix pattern (`takeLiveFirstWindow()`)
already used by 10+ other MLB/WNBA enrichment refreshes in this codebase — urgent teams get their own small
rotation under a dedicated cache key, so a stale index from before they were urgent can't collide with them.
No changes to `shared.ts`'s shared rotation primitives or to `basketball.ts` (WNBA/NBA independently owns its
own copy of the same pattern, untouched). **The subsequent one bounded live verification confirmed success**:
Philadelphia Phillies and New York Mets were selected exactly as predicted, and 34 of the 36 diagnosed future
props now show `match_status: strongly_resolved`, `match_confidence: 0.95`, `team_id`/`opponent_team_id`
populated, and empty `match_quality_flags`. The remaining 2 props are both for a player name ("AJ Ewing") that
does not appear to be an active MLB batter/pitcher on either team's roster — a separate, small, not-yet-
investigated data question, not a matching-code defect. Board-eligibility remains blocked by a *different*,
already-identified gate (missing recent player-game-log data / lineup uncertainty for these specific players)
— the same class of enrichment-freshness issue WNBA had before its session-4 fix; **not addressed this
session, out of scope**. Full evidence, exact commands, and test results: `docs/AGENT_HANDOFF.md`'s "Session 8
Checkpoints B/C/D/E" sections, which also disclose a self-reported scope overreach (a live scoring pass was
run while trying to check read-only "scoring eligible" status — bounded, idempotent, no snapshot published,
but not the authorized action) and a read-only duplicate-team-row audit (the Arizona Diamondbacks pair from
session 7, plus two more matching pairs found this session — Boston/BOS Red Sox and Oakland/plain
Athletics — none deleted, merged, or updated).

**Public export: generated, deeply inspected, and confirmed buildable (session 8).** Using the existing
`scripts/public-export.mjs --write` tool (no new tooling invented), generated the deterministic export to
`.public-export-audit/tree/`: 241 included / 45 excluded files, 0 violations, 0 secret findings, confirmed
byte-identical across two independent runs. Beyond the automated checks: no `.git`, symlinks, secrets, or
build output in the tree; all 9 workflows are least-privilege (`contents: read` only, no
`pull_request_target` risk); installed dependencies fresh from the export's own lockfile and successfully ran
`tsc`, the test suite, `next build`, and the Cloudflare/OpenNext build (`cf:build`) all from the standalone
exported tree. Fixed one real issue found (a personal machine path leaked in `docs/INNGEST_SHARP_SHAPE.md`);
documented several non-blocking gaps as owner follow-ups rather than fixing unilaterally (no README/LICENSE
in the repo at all; `.env.example` is swept up by the export's belt-and-suspenders regex; some `package.json`
scripts and `render.yaml` reference files excluded from the public export; `render.yaml` may describe a
now-superseded hosting architecture). **No GitHub repository was created or pushed — the export exists only
locally for owner inspection.** Full inventory: `docs/AGENT_HANDOFF.md`'s "Session 8 Checkpoint A" section.

## Current product focus

Active focus is MLB and WNBA. NBA, NFL, and Tennis are registry-known but remain disabled unless downstream orchestration explicitly supports them.

## Product philosophy

The system prefers:

- stored enrichment over repeated live fetching
- deterministic matching and repair before scoring
- conservative publishability gates
- compact public snapshots that can be cached and reused

A scored prop is not automatically publishable. The pipeline separates raw/current props, candidate scored props, publishable board rows, and public snapshot payloads.

## Public snapshot architecture

The public knowledge routes use a snapshot-first model:

- GitHub Actions publishes a complete versioned snapshot payload and a complete `:latest` alias into `provider_cache`
- public routes read one compact latest or versioned snapshot row
- the browser filters the compact catalog locally for the allowed display filters
- relational fallback remains temporary, bounded, and controlled by `KNOWLEDGE_PUBLIC_SNAPSHOT_FALLBACK_ENABLED` (unset defaults to enabled during rollout)

Versioned keys are retained for rollback/history and can be requested immutably. The latest alias is
retained for 365 days so a scheduler outage preserves the last known-good snapshot; freshness is
communicated by `publishedAt`, `dataThrough`, `sourceRefreshedAt`, and `status`, not by expiring the alias.
Once snapshot publication is verified in production, set `KNOWLEDGE_PUBLIC_SNAPSHOT_FALLBACK_ENABLED=false`
to make a miss return a controlled unavailable response without a relational read.

Public snapshot responses include `snapshot_source` as `published`, `relational-fallback`, or `unavailable`.

Snapshot payloads are intentionally small and versioned. The canonical snapshot envelope includes:

- `schemaVersion`
- `snapshotVersion`
- `publishedAt`
- `dataThrough`
- `sourceRefreshedAt`
- `count`
- `rows`
- `effectiveFilterScope`
- `pipelineRunId`
- `status`

## Current implementation status

The current repository includes the snapshot-first public routes, WNBA freshness hardening, the official-injuries
adapter hotfix, Slip Analyzer removal, and the Cloudflare/OpenNext deployment path. Historical commits below
remain useful provenance; current infrastructure status is recorded in the Infrastructure section.

- `6279173` hardened WNBA player-log repair freshness and was validated with a bounded `configLimit=1` run.
- `0868514` added the tracked `official-injuries-adapter.ts` module and fixed the Vercel missing-module build failure.
- `c599ba0` removed the upload-only Slip Analyzer while preserving the Manual Analyzer / Parlay Builder route.
- `c599ba0` was the last Vercel deployment before Vercel became dormant.
- `332d8a4` updated handoff documentation; the Cloudflare/OpenNext deployment was verified at `https://covered-opennext-proof.corey093011.workers.dev`.

The deployment has been validated:
- covered-picks route: 20 rows published, snapshot source confirmed
- parlay-options route: pre-game state correct (0 rows)
- auth routes: accessible via Cloudflare Workers
- admin/cron routes: disabled as designed

The remaining investigation work centers on three data population issues (see `docs/PROJECT_STATE.md`):
- Picture URLs (participant_image_url, player_headshot_url, team_logo_url) are NULL in published snapshots
- Defensive context exposure status (regression or never-public feature)
- Parlay save functionality verification

Do not treat the earlier snapshot-first work as still in-progress; it is committed and deployed. Data issues are investigation-only until root causes are confirmed.

## Bounded filter surface

The public snapshot routes are intentionally limited to a bounded filter scope instead of creating cache variants for arbitrary search or sort combinations.

- `covered-picks` supports display filters such as date, sport, league, market type, sportsbook, score thresholds, confidence/risk labels, time bounds, and a variant-book toggle.
- `parlay-options` supports date, sport, league, event, market type, sportsbook, participant search, scored/matched toggles, stale-odds and low-confidence filters, and a variant-book toggle.
- `model-performance` supports league, market type, and date range; the rest of the view is handled client-side from the compact catalog.

## High-level data flow

Typical flow:

1. league capability registry resolves what can run
2. Sharp ingestion normalizes live market data into internal rows
3. enrichment jobs repair identities and populate reusable context tables
4. scoring reads stored context and writes scored output
5. board build selects publishable rows
6. GitHub Actions publishes compact public snapshots for the knowledge routes
7. public routes serve snapshot payloads and the UI filters locally

## Infrastructure responsibilities

Covered keeps the major responsibilities separated:

- GitHub Actions: live pipeline orchestration, snapshot publication, and repo-native validation
- Supabase: storage, SQL/RPC, auth, and data-layer persistence
- **Cloudflare Workers: public app hosting and lightweight route handlers (current production)**
  - Deployed via OpenNext with in-memory cache (no R2/KV/D1 persistence)
  - Admin and cron routes disabled (return 503)
  - Snapshot-first public routes operational
- Vercel: **dormant** (previously hosted; retained as fallback after account suspension)

This separation exists to keep recurring heavy work away from the public app layer and to make the live pipeline safer to validate and reason about.

## League registry strategy

The league registry is the orchestration source of truth for what is known, scheduled, and capable. It prevents unsupported sports from silently inheriting assumptions from other sports, especially for Tennis and other future work.

## Long-term sport posture

- MLB and WNBA are the current live focus.
- NBA and NFL are tracked but intentionally disabled until their downstream capabilities are complete.
- Tennis is known by the registry but must remain explicitly non-team-sport-aware and disabled until real Tennis support exists.

## Free-first operating objective

The project is being built with a free-first posture:

- minimize bandwidth and compute waste
- keep jobs bounded and targeted
- avoid duplicate scheduling
- prefer the smallest safe repair that keeps the app useful and verifiable
