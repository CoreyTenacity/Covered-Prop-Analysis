# Covered legacy cron-job.org schedule

This file now serves as the retirement checklist for the old HTTP cron layer.
The supported execution path is GitHub Actions / manual workflow dispatch plus the direct runner.

For the side-by-side Render + legacy cron-job.org matrix, see [CRON_DEPLOYMENT_MATRIX.md](./CRON_DEPLOYMENT_MATRIX.md).

All times should use:

- `America/New_York`
- `POST`
- header: `Authorization: Bearer YOUR_CRON_SECRET`

Keep the heavy knowledge refresh jobs away from the scoring windows so Sharp ingest, scoring, and board builds do not pile up on each other.

## Legacy cron-job.org timing reference

These were the old jobs that previously kept the live prop pipeline moving.
They are retained here only so Corey can disable the old cron-job.org entries in
the right order while the supported execution path has moved to GitHub Actions
and the direct runner.

### Sharp ingest

Sharp runs narrow by league and should stay offset so MLB and WNBA are not competing every minute.

- `sharp-ingest MLB`
  - route: `/api/cron/sharp-ingest?league=MLB&configLimit=1`
  - cadence: every 2 minutes
  - minute pattern: `0,2,4,6,8,10,12,14,16,18,20,22,24,26,28,30,32,34,36,38,40,42,44,46,48,50,52,54,56,58`

- `sharp-ingest WNBA`
  - route: `/api/cron/sharp-ingest?league=WNBA&configLimit=1`
  - cadence: every 2 minutes, offset by 1 minute
  - minute pattern: `1,3,5,7,9,11,13,15,17,19,21,23,25,27,29,31,33,35,37,39,41,43,45,47,49,51,53,55,57,59`

### Score props

Scoring should run slower than ingest and should stay staggered by league.

- `score-props MLB`
  - route: `/api/cron/score-props?league=MLB`
  - cadence: every 6 minutes
  - minute pattern: `2,8,14,20,26,32,38,44,50,56`

- `score-props WNBA`
  - route: `/api/cron/score-props?league=WNBA`
  - cadence: every 6 minutes, offset by 3 minutes
  - minute pattern: `5,11,17,23,29,35,41,47,53,59`

### Build board

Build only after scoring has had a chance to finish.

- `build-board`
  - route: `/api/cron/build-board`
  - cadence: every 6 minutes
  - minute pattern: `6,12,18,24,30,36,42,48,54`

## Heavy knowledge refresh jobs

These should be hourly or every 2 hours unless there is a real reason to run them more often.

Recommended cadence:

- every 2 hours for:
  - `refresh_players`
  - `refresh_teams`
  - `refresh_schedules`
  - `refresh_player_game_logs`
  - `refresh_recent_features`
  - `refresh_injuries`
  - `refresh_lineups`
  - `refresh_rest_context`
  - `refresh_basketball_matchup_features`

Recommended minute windows:

- MLB knowledge jobs: around minute `21`
- WNBA knowledge jobs: around minute `39`

That keeps them away from the main score/build windows.

Examples:

- `/api/cron/knowledge-refresh?job=refresh_teams&league=MLB`
- `/api/cron/knowledge-refresh?job=refresh_players&league=MLB`
- `/api/cron/knowledge-refresh?job=refresh_schedules&league=MLB`
- `/api/cron/knowledge-refresh?job=refresh_player_game_logs&league=MLB`
- `/api/cron/knowledge-refresh?job=refresh_recent_features&league=MLB`

- `/api/cron/knowledge-refresh?job=refresh_teams&league=WNBA`
- `/api/cron/knowledge-refresh?job=refresh_players&league=WNBA`
- `/api/cron/knowledge-refresh?job=refresh_schedules&league=WNBA`
- `/api/cron/knowledge-refresh?job=refresh_player_game_logs&league=WNBA`
- `/api/cron/knowledge-refresh?job=refresh_recent_features&league=WNBA`

## Legacy cron-job.org jobs to disable manually

These routes were removed from the deployed app and should be turned off in cron-job.org.

- `/api/cron/sharp-ingest?league=MLB&configLimit=1`
- `/api/cron/sharp-ingest?league=WNBA&configLimit=1`
- `/api/cron/score-props?league=MLB`
- `/api/cron/score-props?league=WNBA`
- `/api/cron/build-board`
- `/api/cron/refresh-board`
- `/api/cron/knowledge-refresh?job=refresh_teams&league=MLB`
- `/api/cron/knowledge-refresh?job=refresh_players&league=MLB`
- `/api/cron/knowledge-refresh?job=refresh_schedules&league=MLB`
- `/api/cron/knowledge-refresh?job=refresh_player_game_logs&league=MLB`
- `/api/cron/knowledge-refresh?job=refresh_recent_features&league=MLB`
- `/api/cron/knowledge-refresh?job=refresh_teams&league=WNBA`
- `/api/cron/knowledge-refresh?job=refresh_players&league=WNBA`
- `/api/cron/knowledge-refresh?job=refresh_schedules&league=WNBA`
- `/api/cron/knowledge-refresh?job=refresh_player_game_logs&league=WNBA`
- `/api/cron/knowledge-refresh?job=refresh_recent_features&league=WNBA`

## What the score-props response should show

When you hit:

- `/api/cron/score-props?league=MLB`
- `/api/cron/score-props?league=WNBA`

the JSON response should include a `summary` block with:

- `poolCount`
- `eligibleCount`
- `processedCount`
- `publishableCount`
- `candidateCount`
- `skippedCount`
- `skippedReasons`
- `propsWritten`
- `supabaseCalls`
- `timings`

The `timings` block should include:

- `propsLoadedMs`
- `latestScoredLookupMs`
- `contextTouchLookupMs`
- `featureBatchReadsMs`
- `scoringLoopMs`
- `scoreInputWritesMs`
- `scoredPropWritesMs`
- `currentPropUpdatesMs`
- `explanationWritesMs`
- `totalRuntimeMs`

## What the sharp-ingest response should show

When you hit:

- `/api/cron/sharp-ingest?league=MLB&configLimit=1`
- `/api/cron/sharp-ingest?league=WNBA&configLimit=1`

the JSON response should include:

- request limit
- request spacing
- config limit applied
- requests attempted
- outbound SharpAPI requests
- requests skipped by cadence
- requests succeeded / failed
- per-config result rows with:
  - requested league
  - sportsbook
  - internal market type
  - provider market type
  - runtime
  - returned prop count
  - normalized prop count
  - inserted/upserted prop count
  - duplicate or unchanged count
  - matched / ambiguous / unmatched count
  - error details when a config fails

## Important free-tier note

Keep Sharp ingest narrow.

The recommended cron pattern above assumes:

- one league per Sharp cron
- `configLimit=1`
- strict cron mode

That keeps each run bounded so it can stay inside the cron-job.org 30-second ceiling.
