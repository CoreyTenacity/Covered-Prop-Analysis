# Render cron setup for Covered

This setup lets Render run Covered's real job code directly.

It does **not** call Vercel endpoints.
It does **not** need `CRON_SECRET` for the Render jobs themselves.
It talks straight to Supabase and SharpAPI using the same environment values the app already uses.

For the combined Render + legacy cron-job.org view, see [CRON_DEPLOYMENT_MATRIX.md](./CRON_DEPLOYMENT_MATRIX.md).

## What this uses

Covered now has a direct command runner:

- package script: `pnpm run cron:run`
- runner file: `scripts/run-covered-job.mjs`
- TS alias loader: `scripts/ts-path-loader.mjs`

Render cron jobs should call that script with different arguments.

## Required environment variables on Render

At minimum, copy these into the Render service or cron-job environment group:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SECRET_KEY`

Recommended if you want the full board/scoring text to behave like production:

- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`

Optional, only if the specific knowledge job needs them:

- `HIGHLIGHTLY_MLB_API_KEY`
- `BBS_API_KEY`
- `STATCAST_SAVANT_BASE_URL`
- `STATCAST_SAVANT_SEARCH_PATH`
- `NBA_COM_WNBA_LEAGUE_IDS`

Sharp jobs still need `SHARPAPI_KEY` wherever they run, but the old cron-job.org HTTP routes are no longer part of the supported path.

## Render strategy

Use Render for:

- knowledge refresh jobs
- score-props jobs
- board build jobs
- cleanup jobs

cron-job.org is now legacy:

- disable any remaining cron-job.org jobs manually
- do not rely on removed Vercel-facing refresh routes

This blueprint keeps Sharp off Render so you avoid paying an extra $1/month per Sharp cron job.

## Create the jobs in Render

Create these grouped Render Cron Jobs instead of one job per source.

### Knowledge bundles

MLB core bundle:

```bash
pnpm install --frozen-lockfile && pnpm run cron:run -- knowledge --job refresh_teams --league MLB && pnpm run cron:run -- knowledge --job refresh_players --league MLB && pnpm run cron:run -- knowledge --job refresh_schedules --league MLB && pnpm run cron:run -- knowledge --job refresh_completed_games && pnpm run cron:run -- knowledge --job refresh_rest_context
```

WNBA core bundle:

```bash
pnpm install --frozen-lockfile && pnpm run cron:run -- knowledge --job refresh_teams --league WNBA && pnpm run cron:run -- knowledge --job refresh_players --league WNBA && pnpm run cron:run -- knowledge --job refresh_schedules --league WNBA && pnpm run cron:run -- knowledge --job refresh_completed_games && pnpm run cron:run -- knowledge --job refresh_rest_context
```

MLB live bundle:

```bash
pnpm install --frozen-lockfile && pnpm run cron:run -- knowledge --job refresh_team_game_logs --league MLB && pnpm run cron:run -- knowledge --job refresh_player_game_logs --league MLB && pnpm run cron:run -- knowledge --job refresh_recent_features --league MLB && pnpm run cron:run -- knowledge --job refresh_lineups --league MLB && pnpm run cron:run -- knowledge --job refresh_injuries --league MLB && pnpm run cron:run -- knowledge --job refresh_mlb_starting_pitchers && pnpm run cron:run -- knowledge --job refresh_mlb_weather && pnpm run cron:run -- knowledge --job refresh_mlb_ballparks && pnpm run cron:run -- knowledge --job refresh_mlb_handedness_splits && pnpm run cron:run -- knowledge --job refresh_mlb_bullpen_context && pnpm run cron:run -- knowledge --job refresh_mlb_matchup_features
```

WNBA live bundle:

```bash
pnpm install --frozen-lockfile && pnpm run cron:run -- knowledge --job refresh_team_game_logs --league WNBA && pnpm run cron:run -- knowledge --job refresh_player_game_logs --league WNBA && pnpm run cron:run -- knowledge --job refresh_recent_features --league WNBA && pnpm run cron:run -- knowledge --job refresh_injuries --league WNBA && pnpm run cron:run -- knowledge --job refresh_basketball_matchup_features --league WNBA
```

### One-off MLB lineup-confidence test run

Use this as a manual Render job or shell command when you want to test MLB lineup/matchup attachment without adding another permanent cron service:

```bash
pnpm install --frozen-lockfile && pnpm run cron:test:mlb-live-focus
```

This keeps the Render service count flat while letting you verify:

- MLB lineups
- starting pitchers
- weather
- ballparks
- handedness splits
- bullpen context
- matchup features
- a fresh MLB score pass
```

### Score props

MLB scoring:

```bash
pnpm install --frozen-lockfile && pnpm run cron:run -- score --league MLB --limit 40 --minimumMatchConfidence 0.7 --matchStatuses strongly_resolved,matched,manual_attached,manual_selected,possible_match
```

WNBA scoring:

```bash
pnpm install --frozen-lockfile && pnpm run cron:run -- score --league WNBA --limit 40 --minimumMatchConfidence 0.7 --matchStatuses strongly_resolved,matched,manual_attached,manual_selected,possible_match
```

### Board build

```bash
pnpm install --frozen-lockfile && pnpm run cron:run -- board --mode build
```

### Prune inactive current props

```bash
pnpm install --frozen-lockfile && pnpm run cron:run -- cleanup --bufferHours 18 --limit 250
```

### Retire started current props

```bash
pnpm install --frozen-lockfile && pnpm run cron:run -- retire-started-current-props --limit 500
```

## Recommended cadence

### Legacy cron-job.org

Disable the old cron-job.org jobs manually. The deployed app no longer exposes
the HTTP execution routes those jobs used.

### Move to Render

Suggested Render cadence:

- `covered-refresh-core-mlb`: every 2 hours
- `covered-refresh-core-wnba`: every 2 hours, offset by 30 minutes
- `covered-refresh-live-mlb`: every 30 minutes
- `covered-refresh-live-wnba`: every 30 minutes, offset by 15 minutes
- `covered-score-props-mlb`: every 6 minutes
- `covered-score-props-wnba`: every 6 minutes, offset by 3 minutes
- `covered-build-board`: every 6 minutes, 1 minute after the later scoring run
- `covered-prune-current-props`: every 6 hours
- `covered-retire-started-current-props`: every 15 minutes

## Best way to avoid overlap

Try to stagger jobs like this:

- minute 0: Sharp MLB
- minute 1: Sharp WNBA
- minute 2: score MLB
- minute 5: score WNBA
- minute 6: build board

Keep heavier knowledge jobs away from those minutes.

## What success looks like

A successful Render job prints JSON to the logs.

Examples:

- knowledge jobs return a `status`, `message`, and `details`
- scoring returns `summary.counts` and `summary.timings`
- board build returns board counts and enrichment counts
- sharp returns request counts, normalized counts, and upsert counts

## Why this is safer than calling Vercel

This path:

- avoids public HTTP cron routes for these jobs
- avoids cron auth/header issues for Render
- avoids Vercel request timeout ceilings for jobs that are better run as direct commands
- runs the exact job code against Supabase/SharpAPI directly

## One important note

If a job takes too long for your current Render plan, split by league as shown above.
That is already supported by the command runner.
