# CLAUDE.md

Claude Code should:

1. Read `AGENTS.md`.
2. Read `docs/PROJECT_CONTEXT.md`.
3. Read `docs/AGENT_HANDOFF.md`.
4. Inspect the current Git branch and working tree before changing anything.
5. Follow the shared repository rules instead of restating them here.

Only add Claude-specific guidance if it is truly necessary for this repository.

Current handoff anchor: branch `codex/public-repo-repair`. Run `git rev-parse HEAD` and `git rev-parse origin/codex/public-repo-repair` to confirm the exact current tip (they should match). `origin/main` is unchanged at `23f665955b55a9e862f7f2efa8205538c5426013`. Before making changes, re-read `docs/AGENT_HANDOFF.md` and preserve the non-main repair workflow.

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

Vercel is dormant and retained only as a fallback. GitHub Actions schedulers remain disabled, and this
repair branch must not be pushed to or merged into `main` without explicit owner approval.

The application should read prepared Supabase data rather than repeatedly calling external providers during user requests.

Keep shared project documents updated when decisions, active architecture, known defects, workflow controls, or handoff state change (e.g. `docs/AGENT_HANDOFF.md`, `docs/PROJECT_CONTEXT.md`, and any of `docs/PROJECT_STATE.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/KNOWN_ISSUES.md` that exist). Do not preserve outdated conclusions as current truth.
