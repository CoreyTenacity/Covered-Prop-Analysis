# WNBA scheduler reliability package

Status: repository-only; **not approved for production activation**.

## Root cause boundary

On 2026-08-02/03 UTC, GitHub created no public `Covered Production Pipeline`
workflow records at the valid WNBA-only cron times 23:20, 23:40, and 00:00.
It created the intervening MLB records at 23:30 and 23:50. The public workflow
was active, on default branch `main`, and its shared concurrency group had no
queued or cancelled WNBA record. This is GitHub scheduled-run creation loss,
before Covered job, environment, gate, or provider code can execute.

## Proposed owner-gated architecture

Replace the two schedule entries with one `7,27,47 16-23,0-4 * * *` heartbeat in the
public workflow. It calls the pinned private tree with `--league auto`, one
config per due league, and the existing `WNBA_INGESTION_ENABLED` value.

`resolveScheduledLeagues` is pure and UTC-based:

- MLB window: 16:00–04:59 UTC.
- WNBA window: 22:00–04:59 UTC when enabled.
- Overlap order: WNBA, then MLB.
- Outside either window: safe no-op; existing event/pregame gates remain the
  authority for off days and no eligible event.

One private pipeline process preserves the existing single shared Sharp hard
budget of eight outbound requests. One config per due league prevents MLB from
claiming all requested config slots before WNBA receives an attempted turn.
Policy C remains inactive: GitHub's literal `schedule` event is deliberately
not remapped to the pipeline's `scheduled` trigger type.

The exact public-only candidate fixture and reviewable patch are:

- `docs/candidate-f/covered-production-pipeline.yml`
- `docs/candidate-f/covered-production-pipeline-heartbeat.patch`

## Resource model

The current two-cron design schedules up to 60 invocation opportunities/day
(39 MLB + 21 WNBA), but GitHub omitted WNBA-only records. A 24-hour heartbeat
would create 72 opportunities/day (about 2,160/month). The approved candidate
instead has 13 UTC hours × 3 offsets = **39 opportunities/day** (about
1,170/month): 18 MLB-only and 21 overlapping WNBA+MLB opportunities. It has
no time-window no-op runs; off-day/no-event skips remain the existing cheap
pregame gate. One process attempts WNBA then MLB in overlap and never exceeds
the existing eight-request Sharp budget. It adds no scheduler, provider,
browser, Cloudflare, Vercel, migration, or paid service.

The offsets deliberately avoid `:00/:20/:40`, the three confirmed omitted
WNBA slots. Creation-minute history is not proof that a new offset will be
delivered—GitHub's API does not label the originating cron, and delayed runs
can be misclassified—but `:07/:27/:47` avoids the observed failure pattern
and the beginning of the hour without adding cadence.

## Next proof, owner approval required

1. Review and merge the public workflow patch through the public repository.
2. Pin the approved private candidate; keep the existing rollback pin available.
3. Enable only under the existing scheduler control.
4. Observe at most three natural heartbeat cycles, requiring GitHub creation,
   exact private checkout, WNBA injury markers, fresh features/minutes/context,
   strict-v1 scoring and snapshots, and API/UI verification.
5. Roll back the public workflow and private pin if a heartbeat is not created,
   WNBA is not attempted during its UTC window, shared requests exceed eight,
   or any strict public-surface invariant fails.
