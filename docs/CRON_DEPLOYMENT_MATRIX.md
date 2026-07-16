# Covered cron deployment matrix

This matrix now includes the GitHub Actions live pipeline foundation.

GitHub Actions is the primary live pipeline owner for MLB and WNBA. The orchestrator registry also knows about NBA, NFL, and Tennis, but those leagues remain disabled until explicitly turned on later.
Do not keep overlapping Render, cron-job.org, and GitHub Actions schedules active for the same work.

## GitHub Actions jobs

| Job | Command | Recommended cadence | Notes |
|---|---|---:|---|
| `covered-live-pipeline` | `pnpm run cron:run -- github-actions --trigger scheduled --league all --configLimit 1 --runScoring true --runBoard true --dryRun false --pregameWindowHours 6 --pregameCloseBufferMinutes 5 --enabled true` | Every 30 minutes | Primary live pipeline. `all` is registry-aware and only picks leagues that are enabled for the requested stages; NBA/NFL/Tennis remain known but disabled. Manual runs can target one league with `workflow_dispatch`. |

## League readiness

| League | Known to orchestrator | Scheduled enabled | Sharp ingestion | Scoring | Board | Grading | Event model | Participant model | Production status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MLB | yes | yes | yes | yes | yes | yes | game | mixed | production |
| WNBA | yes | yes | yes | yes | yes | yes | game | mixed | production |
| NBA | yes | no | no | no | no | no | game | mixed | orchestration-only |
| NFL | yes | no | no | no | no | no | game | mixed | orchestration-only |
| Tennis | yes | no | no | no | no | no | match | player | orchestration-only |


This is the quickest way to see the setup side by side.

Render is the direct-runner transition path for non-Sharp jobs.
cron-job.org HTTP execution is legacy and should be disabled manually; the supported execution path is GitHub Actions/manual dispatch plus direct runner jobs.

## Render jobs

| Job | Command | Recommended cadence | Notes |
|---|---|---:|---|
| `covered-refresh-core-mlb` | `bash -lc 'pnpm install --frozen-lockfile && pnpm run cron:run -- knowledge --job refresh_teams --league MLB && pnpm run cron:run -- knowledge --job refresh_players --league MLB && pnpm run cron:run -- knowledge --job refresh_schedules --league MLB && pnpm run cron:run -- knowledge --job refresh_completed_games && pnpm run cron:run -- knowledge --job refresh_rest_context'` | Every 2 hours | MLB baseline knowledge bundle. |
| `covered-refresh-core-wnba` | `bash -lc 'pnpm install --frozen-lockfile && pnpm run cron:run -- knowledge --job refresh_teams --league WNBA && pnpm run cron:run -- knowledge --job refresh_players --league WNBA && pnpm run cron:run -- knowledge --job refresh_schedules --league WNBA && pnpm run cron:run -- knowledge --job refresh_completed_games && pnpm run cron:run -- knowledge --job refresh_rest_context'` | Every 2 hours, offset by 30 minutes | WNBA baseline knowledge bundle. |
| `covered-refresh-live-mlb` | `bash -lc 'pnpm install --frozen-lockfile && pnpm run cron:run -- knowledge --job refresh_team_game_logs --league MLB && pnpm run cron:run -- knowledge --job refresh_player_game_logs --league MLB && pnpm run cron:run -- knowledge --job refresh_recent_features --league MLB && pnpm run cron:run -- knowledge --job refresh_lineups --league MLB && pnpm run cron:run -- knowledge --job refresh_injuries --league MLB && pnpm run cron:run -- knowledge --job refresh_mlb_starting_pitchers && pnpm run cron:run -- knowledge --job refresh_mlb_weather && pnpm run cron:run -- knowledge --job refresh_mlb_ballparks && pnpm run cron:run -- knowledge --job refresh_mlb_handedness_splits && pnpm run cron:run -- knowledge --job refresh_mlb_bullpen_context && pnpm run cron:run -- knowledge --job refresh_mlb_matchup_features'` | Every 30 minutes | MLB live-context bundle. |
| `covered-refresh-live-wnba` | `bash -lc 'pnpm install --frozen-lockfile && pnpm run cron:run -- knowledge --job refresh_team_game_logs --league WNBA && pnpm run cron:run -- knowledge --job refresh_player_game_logs --league WNBA && pnpm run cron:run -- knowledge --job refresh_recent_features --league WNBA && pnpm run cron:run -- knowledge --job refresh_injuries --league WNBA && pnpm run cron:run -- knowledge --job refresh_basketball_matchup_features --league WNBA'` | Every 30 minutes, offset by 15 minutes | WNBA live-context bundle. |
| `score-props` MLB | `pnpm run cron:run -- score --league MLB --limit 40 --minimumMatchConfidence 0.7 --matchStatuses strongly_resolved,matched,manual_attached,manual_selected,possible_match` | Every 6 minutes | Stagger from WNBA scoring. |
| `score-props` WNBA | `pnpm run cron:run -- score --league WNBA --limit 40 --minimumMatchConfidence 0.7 --matchStatuses strongly_resolved,matched,manual_attached,manual_selected,possible_match` | Every 6 minutes, offset by 3 minutes | Stagger from MLB scoring. |
| `build-board` | `pnpm run cron:run -- board --mode build` | Every 6 minutes, 1 minute after scoring | Build after both league scoring passes. |
| `prune-current-props` | `pnpm run cron:run -- cleanup --bufferHours 18 --limit 250` | Every 6 hours | Trims inactive props that are safely past usefulness so live tables stay lean. |
| `retire-started-current-props` | `pnpm run cron:run -- retire-started-current-props --limit 500` | Every 15 minutes | Marks started props inactive so Sharp ingest stays lean. |

## Legacy cron-job.org jobs to disable manually

| Job | Route | Recommended cadence | Notes |
|---|---|---:|---|
| `sharp-ingest` MLB | legacy `/api/cron/sharp-ingest?league=MLB&configLimit=1` | Disable | Replaced by direct runner / GitHub Actions Sharp ingestion. |
| `sharp-ingest` WNBA | legacy `/api/cron/sharp-ingest?league=WNBA&configLimit=1` | Disable | Replaced by direct runner / GitHub Actions Sharp ingestion. |
| `score-props` MLB | legacy `/api/cron/score-props?league=MLB` | Disable | Replaced by direct runner / GitHub Actions scoring. |
| `score-props` WNBA | legacy `/api/cron/score-props?league=WNBA` | Disable | Replaced by direct runner / GitHub Actions scoring. |
| `build-board` | legacy `/api/cron/build-board` | Disable | Replaced by direct runner / GitHub Actions board build. |
| `refresh-board` | legacy `/api/cron/refresh-board` | Disable | Old combined refresh route; removed from the deployed app. |

## Suggested split

If you want the safest setup:

- Render handles grouped knowledge refresh, scoring, and board build
- cron-job.org handles Sharp ingest and any remaining Vercel refresh routes you still want to keep

That keeps the highest-volume provider pulls separate from the scoring work and avoids double-running the same logic.
