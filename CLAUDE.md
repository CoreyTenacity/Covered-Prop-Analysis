# CLAUDE.md

Claude Code should:

1. Read `AGENTS.md`.
2. Read `docs/PROJECT_CONTEXT.md`.
3. Read `docs/AGENT_HANDOFF.md`.
4. Inspect the current Git branch and working tree before changing anything.
5. Follow the shared repository rules instead of restating them here.

Only add Claude-specific guidance if it is truly necessary for this repository.

>> ACTIVE HANDOFF (2026-08-06) — WNBA CLOSED: OPERATIONALLY CERTIFIED. REPOSITORY AND PRODUCTION CHAIN COMPLETE.
>> Read `docs/AGENT_HANDOFF.md`'s "WNBA CLOSED (2026-08-06)" entry for the full final record. The owner accepted
>> the natural production evidence as sufficient: 13 fully-complete WNBA `scored_props` rows across 5 players in
>> a 24h window, 2 reaching `covered_score >= 70` (74 and 88), with identity/injury-marker/ingestion/scoring/
>> persistence all directly confirmed. Those 2 rows don't show in a *current* read only because their game has
>> since started and correctly rolled off the board (existing, tested behavior, not a defect). Live controls
>> unchanged: `COVERED_PRIVATE_PIPELINE_SHA_V2=e32e81e59eb5d0bd3bdb716d880d81c081648457` (matches repair-branch
>> HEAD), `COVERED_PRIVATE_PIPELINE_SHA=RETIRED_STALE_RUN_GUARD`, `COVERED_GITHUB_SCHEDULER_ENABLED=true`,
>> Cloudflare dispatcher still disabled, no Cloudflare Cron. No production mutation was required to reach or
>> record this closure. Remaining WNBA gaps are calibration-only (insufficient graded-outcome sample), not
>> operational. Do not reopen WNBA architecture, scheduler, or dispatcher work absent a new, separate owner
>> request. MLB was not touched in this pass.

Current handoff anchor: branch `codex/public-repo-repair`. Before making any further changes, re-read the current
monitoring section in `docs/AGENT_HANDOFF.md` and preserve the non-main repair workflow.

The historical Session 42–45 notes below are retained as archive only.

---

## Standing project instructions

You are helping continue development of Covered, a sports prop analysis application.

Treat the repository and shared project documents as the source of truth. Before proposing or making changes, inspect the relevant code, configuration, migrations, workflows, and recent handoff documents.

### Core working rules

1. Distinguish verified facts from assumptions.
2. Trace actual code paths before recommending changes.
3. Never infer a provider or endpoint from a filename or internal label.
4. Use exact file paths, functions, environment variables, workflows, database tables, and error messages.
5. Do not invent API coverage, pricing, reliability, SLA, freshness, or runtime behavior.
6. When external facts are needed, use official documentation or primary repositories.
7. State clearly when something remains unverified.

### Scope control

Stay within the requested task.

Do not:
- expand a narrowly scoped fix into a broad refactor
- modify unrelated sports or pipelines
- add paid providers without demonstrating a current need
- rewrite scoring formulas unless explicitly asked
- delete compatibility code before replacement behavior is verified
- create large speculative documentation files instead of testing
- fix unrelated defects unless they block the requested work

When you discover an unrelated issue:
1. document the evidence
2. classify its severity
3. explain whether it blocks the current task
4. recommend a separate follow-up
5. do not silently expand scope

### Evidence requirements

For architecture or provider decisions, prefer evidence in this order:

1. actual production or staging behavior
2. repository code
3. database schema and bounded read-only queries
4. automated tests using production functions
5. official provider documentation
6. clearly labeled inference

Do not call something verified solely because a unit test passes when the behavior depends on:
- GitHub Actions
- Vercel
- Supabase
- external APIs
- environment variables
- provider freshness

When practical, validate the real runtime path.

### Safety

Before any action that may write to Supabase, trigger workflows, modify production configuration, or send external requests:

- confirm the scope is bounded
- identify whether it is read-only or write-capable
- confirm workflow/job gating
- prevent unrelated jobs from running
- avoid logging secrets
- use idempotent upserts
- explain cleanup behavior

Do not run integration tests against production merely because they are opt-in. Prefer an isolated test database, transaction rollback, test schema, or mocked persistence layer. If production is the only available environment, obtain explicit approval before executing a write-capable test.

### Database rules

Before proposing schema changes:

1. inspect existing migrations
2. inspect the live schema when access is available
3. search all readers and writers
4. identify current uniqueness keys
5. verify whether an existing table or column already solves the need

For ingestion:

- use stable canonical identifiers
- preserve source identifiers
- upsert rather than blindly insert
- avoid rewriting unchanged rows
- record source time and ingestion time separately
- check duplicates and orphans using full pagination
- distinguish newly introduced rows from legacy data debt

Do not rely only on table counts as proof of integrity.

### Git and merge discipline

Before saying a branch is ready to merge:

- fetch current `origin/main`
- determine the merge base
- check ahead/behind counts
- run a real three-way conflict check
- identify uncommitted changes
- run typecheck, tests, and build
- clearly distinguish pre-existing failures from new failures

Do not describe a branch as both fast-forwardable and requiring `--no-ff`.

Do not merge, push to main, change production variables, or enable schedules unless explicitly instructed.

### Testing discipline

Tests should exercise production functions rather than duplicate their logic.

All tests must be included in the actual CI test command.

A test that is skipped by default does not prove behavior unless it is deliberately run in an appropriate isolated environment.

For every test report, state:
- command run
- pass/fail count
- skipped count
- pre-existing failures
- whether external services were involved
- whether any writes occurred

### Response style

Be concise but complete.

For implementation work, provide:
1. findings
2. changes made
3. evidence
4. tests run
5. known limitations
6. remaining risks
7. exact next action

Do not produce long narrative status reports when a focused table or short evidence summary is sufficient.

Do not repeatedly ask for confirmation when the requested task is clear. Make the safest reasonable implementation within scope, but stop before merge, production enablement, destructive operations, or material spending unless explicitly authorized.

### Current project priorities

Covered uses:

- Cloudflare Workers via OpenNext for the current public application
- Supabase as the normalized source of truth
- GitHub Actions for external ingestion and recurring jobs
- SharpAPI and dedicated odds sources for markets and props
- ESPN for current WNBA schedule and game-state data
- SportsDataverse for durable historical WNBA data

Vercel is dormant and retained only as a fallback. **Correction (Session 91, verified live 2026-08-01):**
the claim that "GitHub Actions schedulers remain disabled" is WRONG for the actual live product and must not
be repeated as current truth. The PRIVATE repo's own `covered-live-pipeline.yml` scheduled trigger has not
run since 2026-07-15 (genuinely idle) -- but the deployed product runs from a SEPARATE PUBLIC repo
(`CoreyTenacity/Covered-Prop-Analysis`), whose `covered-production-pipeline.yml` checks out this private
repo at the pinned `COVERED_PRIVATE_PIPELINE_SHA_V2` and runs on a live 20-minute cron, gated by the
`production` Environment's `COVERED_GITHUB_SCHEDULER_ENABLED=true` and `WNBA_INGESTION_ENABLED=true` (both
confirmed true via `gh api .../environments/production/variables` on 2026-08-01). This scheduler is real,
live, and currently writing real `scored_props`/board/snapshot rows for both leagues. See
`docs/AGENT_HANDOFF.md` Session 91 for the full trace and the real defect this correction uncovered (most
WNBA scheduled runs time out during background enrichment before ever reaching scoring). This repair branch
must not be pushed to or merged into `main` without explicit owner approval.

The application should read prepared Supabase data rather than repeatedly calling external providers during user requests.

Keep shared project documents updated when decisions, active architecture, known defects, workflow controls, or handoff state change (e.g. `docs/AGENT_HANDOFF.md`, `docs/PROJECT_CONTEXT.md`, and any of `docs/PROJECT_STATE.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/KNOWN_ISSUES.md` that exist). Do not preserve outdated conclusions as current truth.
