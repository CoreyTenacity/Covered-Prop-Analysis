# Data Completeness Tracking

Trend log for the informational completeness checks added to the enrichment/scoring path
(`lib/knowledge/enrichment/validation.ts`).

## How entries get here

The checks run **inline** at the end of the relevant job (~1 bounded Supabase read each, negligible
GitHub Actions cost) and are **informational only — they never fail a job**.

Where the output lands:

- `refresh_players` → `details.completeness` in the job result (stdout JSON from `scripts/run-covered-job.mjs`).
- Scoring stage → `summary.score.completeness` in the pipeline report, and rendered into the
  **GitHub Actions step summary** by `formatGitHubActionsPipelineSummary()`.

Job code does **not** write to this file directly, and intentionally so: GitHub Actions runners have
ephemeral filesystems (a write inside a job is discarded when the runner exits), and the same job code is
reachable from Vercel/Inngest where the filesystem is read-only. `$GITHUB_STEP_SUMMARY` is the durable
per-run record; this file is the curated human-readable trend on top of it.

To add a row: copy the completeness lines from the run's Actions step summary (or from the
`cron:run` stdout JSON) under a new dated heading below.

Local check without running a job:

```bash
NODE_OPTIONS="--max-http-header-size=65536" pnpm run cron:run -- knowledge --job refresh_players --league WNBA
```

## Metric meanings

- **wehoop-wnba id** — gates WNBA player-log ingestion → recent features → projection. The single
  highest-leverage number here.
- **publishable** — props that clear `publishabilityAssessment()` (`lib/knowledge/scoring-service.ts:898`)
  and are therefore eligible for Covered Picks.
- **raw_current** — active props never scored.
- **headshot_url** — display only. **Not** a covered-score input; tracked for UI quality, not accuracy.

---

## 2026-07-15 — Baseline (verified read-only audit, pre-backfill)

Measured 2026-07-15 00:40 UTC. Scheduler was disabled (`COVERED_GITHUB_SCHEDULER_ENABLED=false`), so
these reflect state as of the last manual run on 2026-07-14 ~21:29.

- players · WNBA: wehoop-wnba id **10/227 (4.4%)** · current_team_id 226/227 (99.6%) · headshot_url 6/227 (2.6%)
- current_props · WNBA: publishable **69/430 (16.0%)** · raw_current 347/430 (80.7%) · future_start_time 4/430 (0.9%) · player_id 394/430 (91.6%) · team_and_opponent 317/430 (73.7%)
- current_props · MLB: publishable **0/396 (0%)** · raw_current 396/396 (100%) · future_start_time 0/396 (0%) · player_id 217/396 (54.8%) · team_and_opponent 0/396 (0%)

Notes: WNBA `basketball_team_context` was 100% populated (15 teams) for defensive_rating/pace/offensive_rating
but last updated 2026-07-12. MLB slate stale (0 future props).
