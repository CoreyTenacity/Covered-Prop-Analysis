# Inngest Sharp shape for Covered

This is the cheapest practical Inngest setup for Sharp when you want:

- low egress
- no Render Sharp crons
- fresh-ish odds during live slate windows
- one place to test and reason about the schedule

The goal is to keep the Inngest side simple:

- 1 scheduled function for MLB
- 1 scheduled function for WNBA
- no market fan-out in the scheduler
- no extra `step.run()` calls unless you truly need them

Inngest Hobby currently includes 50k executions and defines an execution as a single durable function run plus each step inside it. Hobby is $0/mo. Source: [Inngest pricing](https://www.inngest.com/pricing).

## What’s wired in this repo now

- Inngest client: [`lib/inngest/client.ts`](../lib/inngest/client.ts)
- Scheduled Sharp functions: [`lib/inngest/sharp.ts`](../lib/inngest/sharp.ts)
- Serve route: [`app/api/inngest/route.ts`](../app/api/inngest/route.ts)

The code is intentionally small:

- 1 scheduled function for MLB
- 1 scheduled function for WNBA
- one guard check per run to see if the next slate is close enough
- one Sharp call per run when the window is active
- no fan-out by market

## Recommended shape

| League | Inngest schedule | What it does | Why this is the cheapest useful shape |
|---|---|---|---|
| MLB | Every 5 minutes | Check the next MLB start time. Only call Sharp when the slate is close enough to matter. | Fresh enough for pregame movement without running a bunch of market jobs. |
| WNBA | Every 5 minutes | Check the next WNBA start time. Only call Sharp when the slate is close enough to matter. | Same idea as MLB, with low egress and no extra fan-out. |

## Dynamic gate inside each function

Each run should do this before calling Sharp:

1. Load the next upcoming event for that league.
2. If there is no game within the active window, exit without calling Sharp.
3. If there is a game approaching, call `runSharpApiIngestion()` once with a narrow slice.

Suggested window:

- more than 6 hours before the first start: do nothing
- 6 hours to 2 hours before start: pull one config
- 2 hours to 60 minutes before start: pull one config, still narrow
- last 60 minutes before start: keep it on, still one config at a time
- after the slate starts: stop calling Sharp for that event and let the retirement job clean up

## Suggested parameters for the Sharp call

Keep the call narrow so it stays cheap:

- `configLimit: 1`
- `limit: 10`
- `strictCronMode: true`
- `force: false` unless you are manually testing

## What you need to do in Inngest

Once the app is deployed, the setup is basically:

1. Create the Inngest app in your dashboard and connect it to this repo.
2. Add the production signing key (`INNGEST_SIGNING_KEY`) to your app environment if Inngest asks for it.
3. Deploy Covered so the `/api/inngest` route exists in production.
4. Confirm the two scheduled functions show up:
   - `sharp-refresh-mlb`
   - `sharp-refresh-wnba`
5. Let Inngest own the 5-minute schedule for those two functions.

If you later want Covered to send events into Inngest from app code, add `INNGEST_EVENT_KEY` too. You do not need that just to run these scheduled Sharp jobs.

That’s the set-it-and-forget-it version. You do not need separate cron services for Sharp if Inngest is handling these schedules.

## Lowest-cost version

If you want the absolute cheapest safe setup:

- MLB schedule: every 5 minutes
- WNBA schedule: every 5 minutes
- one plain function run per tick
- no steps unless needed

That keeps the execution count predictable and usually stays well inside Hobby if the function stays simple.

## What to avoid

- don’t fan out by market in the scheduler
- don’t create separate schedules per sportsbook
- don’t add extra steps unless you need retries or branching
- don’t keep a second Sharp scheduler somewhere else

## Good test URL behavior

If you still want to sanity-check the existing Vercel route before fully moving:

- MLB: `pnpm run cron:run -- sharp --league MLB --configLimit 1 --limit 10 --strictCronMode true`
- WNBA: `pnpm run cron:run -- sharp --league WNBA --configLimit 1 --limit 10 --strictCronMode true`

But for the Inngest version, the function should call the underlying Sharp job directly instead of bouncing through Vercel.

## My recommendation

For your current goals, this is the best balance:

- 2 Inngest jobs total
- 5-minute cadence
- internal active-window gating
- one Sharp config per run

That’s the most “set it and forget it” version that still keeps egress low.
