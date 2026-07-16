# GitHub Actions Phase 2 migration plan

This phase adds GitHub Actions as the primary live pipeline owner for:

- Sharp ingestion
- scoring
- board building

It does not remove the legacy cron routes yet.

## Ownership

- GitHub Actions: primary live pipeline for MLB and WNBA
- GitHub Actions registry: knows about MLB, WNBA, NBA, NFL, and Tennis, but NBA/NFL/Tennis remain orchestration-only until they are explicitly enabled later
- cron-job.org: Sharp-only fallback or manual narrow pulls while we transition
- Render: legacy transition only; do not keep active overlaps with the GitHub workflow
- Vercel: keep public product pages and read routes, but stop recurring heavy jobs there

## Required repository variable

- `COVERED_GITHUB_SCHEDULER_ENABLED`
  - set to `true` when you want scheduled GitHub Actions runs to execute
  - leave unset or `false` to keep scheduled runs disabled while you test manually

## Required GitHub Actions inputs

Set these in the repository secrets/variables before turning on the workflow:

| Name | Scope | Required | Notes |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Repository variable | Yes | Needed for direct database reads during sharp, score, and board phases. |
| `SUPABASE_SERVICE_ROLE_KEY` | Repository secret | Yes | Primary service-role key for direct Supabase writes. |
| `SUPABASE_SECRET_KEY` | Repository secret | Optional fallback | Kept for compatibility if your deployment still uses the older secret name. |
| `SHARPAPI_KEY` | Repository secret | Yes | Required for Sharp ingestion. |
| `COVERED_GITHUB_SCHEDULER_ENABLED` | Repository variable | Yes for scheduled runs | Enables the scheduled workflow path. |
| `SHARPAPI_MAX_REQUESTS_PER_MINUTE` | Repository variable | Optional | Lets you cap Sharp pacing more tightly. |
| `SHARPAPI_REQUEST_SPACING_MS` | Repository variable | Optional | Lets you slow down Sharp calls if needed. |
| `SHARPAPI_CONFIGS_PER_RUN` | Repository variable | Optional | Lowers per-run Sharp work to reduce minutes. |
| `SHARPAPI_DAILY_REQUEST_BUDGET` | Repository variable | Optional | Adds a hard daily request ceiling if you want one. |
| `KNOWLEDGE_LOW_EGRESS_MODE` | Repository variable | Optional | Keeps read paths leaner when turned on. |

## Workflow behavior

The GitHub Actions workflow runs the bundled direct job runner with:

- league selection: `all`, `MLB`, or `WNBA`
- league selection also accepts `NBA`, `NFL`, and `TENNIS` for safe manual fail-closed checks
- configurable Sharp config limit
- optional scoring toggle
- optional board toggle
- pregame gating that opens 6 hours before event start and closes 5 minutes before event start

Manual runs use the same pregame gate by default so they do not bypass the event window.
Scheduled runs now skip at the job level before checkout/install when the scheduler is disabled, so GitHub does not spend minutes on a disabled cron.
The live pipeline now uses `pregameWindowHours` and `pregameCloseBufferMinutes` instead of a symmetric live window.

## League readiness

| League | Known to orchestrator | Scheduled enabled | Sharp ingestion | Scoring | Board | Grading | Event model | Participant model | Production status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MLB | yes | yes | yes | yes | yes | yes | game | mixed | production |
| WNBA | yes | yes | yes | yes | yes | yes | game | mixed | production |
| NBA | yes | no | no | no | no | no | game | mixed | orchestration-only |
| NFL | yes | no | no | no | no | no | game | mixed | orchestration-only |
| Tennis | yes | no | no | no | no | no | match | player | orchestration-only |

NBA, NFL, and Tennis stay in the registry so the workflow can reject them clearly instead of treating them as unknown values.

## Activation sequence

1. Set `COVERED_GITHUB_SCHEDULER_ENABLED=true` in repository variables.
2. Run the workflow manually once with `dry_run=true`.
3. Run it manually with real inputs for MLB and WNBA.
4. If you want to validate disabled leagues, run manual dispatches for NBA, NFL, or Tennis and confirm they fail closed with a clear registry message.
5. Disable the overlapping Render and cron-job.org schedules that would duplicate sharp/score/board work.
6. Enable the scheduled GitHub Actions workflow.

## Tennis enablement checklist

Before Tennis can be scheduled-enabled, make sure all of the following are in place:

- tournament and match schedule ingestion
- event and participant identity mapping
- provider-market support
- player normalization
- surface and tournament context where applicable
- scoring validation
- board validation
- grading support

## Rollback sequence

1. Set `COVERED_GITHUB_SCHEDULER_ENABLED=false`.
2. Disable the scheduled GitHub Actions workflow in GitHub Actions.
3. Re-enable the legacy scheduler you want to fall back to.
4. Confirm only one owner is running each job.

## Overlap warnings

Never run both of these at the same time:

- GitHub Actions live pipeline and Render live pipeline
- GitHub Actions live pipeline and cron-job.org score/build routes
- multiple schedulers for the same league/window

## Why no Edge Functions yet

This phase does not need Supabase Edge Functions. The direct runner already lives in the repository and can call the same job code the existing routes call.
