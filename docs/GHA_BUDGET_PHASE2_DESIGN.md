# GitHub Actions Budget — Phase 2 Design — 2026-07-15

Design only. No workflow YAML was edited, no scheduling variable was changed, no live provider calls were
made. `docs/GHA_BUDGET_AUDIT_FINDINGS.md` (Phase 1) is treated as verified ground truth and not re-derived
here except where Phase 1 explicitly flagged a number as an unverified placeholder — those are replaced below
with real data.

**One change from Phase 1's rules, per this task's instructions:** read-only aggregate queries against
Supabase were permitted this pass, scoped narrowly to the `events` table's `start_time` column. Every query
fetched only `start_time` (no `id`, no team/venue/status columns), bounded to a 60-day window, and **only
aggregate statistics were computed and printed** — no row-level event data appears anywhere in this document
or was logged during the investigation. Nothing was written.

---

## 1. Real game-volume findings (Task 1)

**Method:** `selectRows('events', { select: 'start_time', filters: [league_id, start_time range] })`, bounded
to a 60-day trailing window (+3-day forward buffer for near-term scheduled games), aggregated client-side into
per-date counts, an hour-of-day histogram (Eastern time), and pregame-window (6h) overlap statistics. Full
query code and console output were scratch-only; only the aggregate numbers below were kept.

### WNBA — real, live data (verified below to be current, not stale)

- **183 total events** in the WNBA `events` table spanning **2026-05-08 to 2026-07-16** — reaches to
  essentially today, confirming this is a live, actively-populated schedule, not a stale import.
- In the 60-day trailing window: **57 of 60 days had at least one game (95% of days)**, 159 total events.
- **Avg games/day, game-days only: 2.79.** Avg games/day averaged across all 60 days (incl. the 3 off-days):
  2.65.
- **Start-time distribution is clustered into bands, not spread evenly across the day**: 19:00 ET (47 games)
  and 22:00 ET (43 games) are the two dominant bands, with secondary clusters at 15:00 ET (12) and 20:00 ET
  (26). Combined, 19:00+22:00 alone account for ~57% of all WNBA starts in the window.
- **Avg concurrent open pregame windows, sampled at each game's own start: 1.87.** (i.e., when a typical WNBA
  game starts, on average ~0.87 *other* games' 6h windows are also still open — real but modest overlap, not
  heavy stacking.) Max observed concurrency: 6.
- **Avg pregame-window "open" coverage per game-day (union of all that day's windows): 9.11 hours out of 24.**

### MLB — data-quality caveat: the table is stale, not a live schedule

**This needs to be stated plainly before any number is used:** the entire MLB `events` table currently
contains only **45 rows total, all clustered in a single 4-day span (2026-07-09 through 2026-07-12)**, with
**zero rows** for 7/13, 7/14, 7/15 (today), or any future date. This is consistent with — and further
confirms — the MLB gating/staleness finding from an earlier session's data-completeness audit
(`docs/PROJECT_STATE.md`): MLB ingestion has not run since the scheduler was disabled, and the table reflects
a one-time partial import, not an ongoing live season feed.

**Consequence: I cannot report a trustworthy MLB "days/month active" or "avg games/day across a normal
season" number from this dataset — doing so would present staleness as if it were real cadence.** What I *can*
report, cautiously, is the **per-active-day shape** on the 4 days that do have data, since that shape is a
function of how MLB schedules games (many East Coast day/afternoon starts, West Coast night starts), not of
how stale the table is:

- On the 4 days with data: 13, 14, 1, and 17 games respectively (avg **11.25 games/day** on active days).
- Start-time histogram on those days: clustered at 13:00 ET (11 games) and 14:00 ET (6), with a secondary
  evening band at 18:00–20:00 ET (14 combined) — consistent with real MLB's mix of day and night games.
- Avg concurrent open pregame windows, sampled at each start: **6.73**. Max observed: **17**.
- Avg pregame-window open coverage per active day: **10.15 hours out of 24.**

**I am treating this per-active-day shape as a labeled, low-confidence proxy for "what an MLB gameday would
look like once the schedule is live," not as a verified ongoing frequency.** The "how many days per month is
MLB actually live" question remains genuinely unanswered by this dataset — see Section 5.

### Replacing the Phase 1 ~8h/day placeholder

Phase 1's Section 5 used an unlabeled ~8h/day pregame-window-coverage assumption to estimate how often the
`pipeline` job would fire. The real, verified replacement:

- **WNBA (trustworthy): 9.11h/day on the 95% of days that have games** — the placeholder was in the right
  ballpark but **understated** real coverage by ~14% (9.11 vs. 8).
- **MLB (low-confidence, stale-data proxy only): 10.15h/day on days with data** — similarly close to the
  placeholder in shape, but the *frequency* (how many days/month) cannot be verified from current data at all,
  which the original placeholder implicitly assumed was "most days."
- **Combined dataset (MLB+WNBA together, but skewed by MLB's clustering into just 4 days): 9.30h/day** — I am
  **not** using this blended figure going forward, since it's weighted by a stale MLB sample; Section 2 and
  Section 4 below use the WNBA-only real number as the primary basis and flag MLB's contribution as an
  unquantified addition on top.

---

## 2. `wnba-current-refresh` before/after design (Task 2)

### Current state (re-read from the live file, not memory)

```yaml
wnba-current-refresh:
  if: >-
    github.event.inputs.diagnostic_only != 'true' &&
    (
      (github.event_name == 'schedule' && github.event.schedule == '*/20 * * * *' && vars.COVERED_GITHUB_SCHEDULER_ENABLED == 'true' && vars.WNBA_INGESTION_ENABLED == 'true')
      || (github.event_name == 'workflow_dispatch' && github.event.inputs.run_current_refresh == 'true')
    )
  runs-on: ubuntu-latest
  timeout-minutes: 5
  steps:
    - actions/checkout@v4
    - pnpm/action-setup@v4
    - actions/setup-node@v4 (cache: pnpm)
    - pnpm install --frozen-lockfile
    - pnpm run cron:run -- knowledge --job refresh_schedules_live_gate --league WNBA
```

Confirmed from the current file: this job's `if:` checks only the two kill switches
(`COVERED_GITHUB_SCHEDULER_ENABLED` and `WNBA_INGESTION_ENABLED`) — **there is no pregame-window or
event-proximity check anywhere in this workflow.** On the `*/20 * * * *` cron (72 ticks/day), if both
switches were ever set to `true`, this job would run unconditionally on every tick, 24/7, including hours
with zero games anywhere near start.

**Real billed-minutes/run, corrected from Phase 1's estimate:** Phase 1 only had a *workflow-level* wall-clock
sample (76s) and estimated the job cost as "~2 (est., unmeasured at job level)." I pulled the actual per-job
breakdown for that same run: **`wnba-current-refresh` itself measured 72s → rounds up to 2 billed minutes.**
This is a single real sample (n=1) — flagged as such — but it confirms Phase 1's estimate was directionally
right and gives a real number to build on instead of a guess.

**Naive unconditional cost, corrected:** 72 ticks/day × 2 billed min × 30 days = **4,320 min/month** if left
exactly as-is and both switches were flipped on. (Phase 1's Section 4 had used a blended ~1–2 min/run
assumption yielding ~2,160/month — the real 2-min measurement pushes this materially higher than that
estimate.)

### Proposed fix — with a structural correction to how it should be built

The task asks to mirror "the pattern already working correctly in the sharp/odds gate." I looked at that
pattern closely (`covered-live-pipeline.yml`'s `schedule-refresh` → `gate` → `pipeline` three-job chain) and
there's an important nuance: **Phase 1 Section 3 identified that exact multi-job split as the #1 source of
wasted minutes**, because each separate job pays its own rounded-up-to-a-minute charge even when the real
work is a few seconds. Copying that pattern verbatim into a *second* workflow would reproduce the same
inefficiency Phase 1 flagged, not fix anything.

**Recommended design instead: one job, with the pregame check as an early *step*, gating later steps via
step-level `if:` — not a second job.**

```yaml
wnba-current-refresh:
  if: >-
    github.event.inputs.diagnostic_only != 'true' &&
    (
      (github.event_name == 'schedule' && ... && vars.COVERED_GITHUB_SCHEDULER_ENABLED == 'true' && vars.WNBA_INGESTION_ENABLED == 'true')
      || (github.event_name == 'workflow_dispatch' && github.event.inputs.run_current_refresh == 'true')
    )
  steps:
    - actions/checkout@v4                          # still needed to read repo scripts either way
    - id: pregame_check                             # NEW: lightweight, no pnpm/install yet
      run: <inline check reusing the same classify-by-window logic as gate's Python script,
            scoped to WNBA only, outputs should_run>
    - pnpm/action-setup@v4                          # gated: if: steps.pregame_check.outputs.should_run == 'true'
    - actions/setup-node@v4 (cache: pnpm)            # same gate
    - pnpm install --frozen-lockfile                 # same gate
    - pnpm run cron:run -- knowledge --job ...       # same gate
```

This borrows the *exact same windowing logic* already proven correct in `gate`'s Python script (event
`start_time` inside 6h before now, outside the 5-minute close buffer) — just scoped to a single league and
placed as a step, not a second job. The reason this matters for cost: on a "skip" tick, only `checkout` +
the lightweight check step run (no `pnpm install`), so the job still bills the unavoidable 1-minute minimum,
but never pays a *second* job's independent rounding charge on top, and never pays for the expensive
`pnpm install` step when nothing needs to run.

### Recomputed monthly minutes using Task 1's real WNBA data

Using WNBA's real 9.11h/day open-coverage on 57/60 (95%) of days, at the **current unchanged `*/20` cadence**
(72 ticks/day): probability any given tick lands inside an open window ≈ (9.11/24) × 0.95 ≈ **0.361**.

- Expected "run" ticks/day ≈ 72 × 0.361 ≈ **26.0**
- Expected "skip" ticks/day ≈ 72 − 26.0 ≈ **46.0**
- Monthly minutes = 30 × [26.0 × 2 (run, measured) + 46.0 × 1 (skip, checkout+check only)]
  = 30 × [52.0 + 46.0] = 30 × 98.0 ≈ **2,940 min/month**

**This is the headline finding of this task: gating alone, at the current `*/20` cadence, is nowhere near
enough.** Even with a correctly-designed step-level gate, the job still costs **~2,940 min/month** — because
72 ticks/day means 46 "skip" ticks/day still each cost a full billed minute just for checkout + a quick check.
That alone (46 × 30 = 1,380 min/month) is more than half the *entire* 2,000-minute budget.

**The cadence itself is the larger lever here, not just the missing gate.** Recomputing at coarser cadences
(same gating design, same real WNBA data):

| Cadence | Ticks/day | Run ticks/day | Skip ticks/day | Monthly minutes |
|---|---|---|---|---|
| `*/20` (current, gated) | 72 | 26.0 | 46.0 | **2,940** |
| `*/30` (match covered-live-pipeline's cadence) | 48 | 17.3 | 30.7 | **1,959** |
| `*/60` (hourly) | 24 | 8.7 | 15.3 | **980** |

**Recommendation: pair the gate with a move to hourly (`0 * * * *`).** Gating alone still leaves this single
job consuming ~147% of the entire budget by itself; gating + hourly brings it to **980 min/month**, a real,
material fix rather than a partial one.

### Corrected baseline statement

Phase 1's Section 5 total was **~2,700–2,800 min/month**, built from the merged `schedule-refresh`+`gate`
floor (1,728, using Phase 1 Section 3's more precise figure) plus a *placeholder*-derived pipeline-fire
estimate (~1,250, using an assumed ~8h/day, ~16 fires/day). Replacing the placeholder with Task 1's real WNBA
data (Section 4 below) changes this; the `wnba-current-refresh` fix is a *separate, additional* line item that
Phase 1's total never included at all (Phase 1 explicitly excluded `wnba-data-ingestion.yml` from that number).
See Section 4 for the fully reassembled total.

---

## 3. Injuries/lineups/weather wiring recommendation (Task 3)

### Option A — fold into the existing pregame-gated live-repair path

The `pipeline` job (gated correctly, per Phase 1) already runs `runLivePreScoreRepair`, which already reads
`updated_at`/staleness for player logs, recent features, and matchup context — and for MLB, specifically
already reads `mlb_weather.updated_at` as one of its freshness signals (Phase 1 finding). The missing piece
in all three cases (injuries, lineups, MLB weather) is purely that the freshness check never triggers the
matching `refresh_*` call. Option A closes that loop: add conditional `refreshInjuriesJob` /
`refreshLineupsJob` / `refreshMlbWeatherJob` calls inside the same already-gated, already-running function,
following the exact same `shouldRefresh` conditional pattern already used there for player logs and recent
features.

**Cost:** since this adds work *inside a job that's already running and already billed*, there is no new
per-tick floor cost at all — the only marginal cost is whatever extra seconds these three refresh calls add
to a `pipeline` run that would have fired anyway. Given the real measured `pipeline` range (27–195s, i.e.
1–4 billed minutes), roughly half of those samples had 20–40s of headroom before crossing into the next
billed-minute bracket; a few (e.g., the 195s sample, already at the top of its 4-minute bracket with room to
spare before 240s) had more. **Realistic estimate: an average of +0.3–0.5 billed minutes per pipeline run
that already fires**, i.e., some ticks absorb the extra work for free, others get pushed one bracket higher.
Using the ~26.0 real (WNBA-derived) pipeline-fire rate from Section 2: 26.0 × 0.4 avg × 30 ≈ **~310
min/month**, labeled as an estimate (no way to measure this without actually adding the calls and observing
real durations).

### Option B — new dedicated proximity-tier workflow

A separate workflow with its own schedule and its own gate check, running only inside the 6h pregame window
at a 30–60 min cadence. **This reproduces exactly the same per-tick floor-cost problem diagnosed for
`wnba-current-refresh` in Section 2** — a new, independent job/workflow pays its own rounded-minute charge on
every tick it's asked to check, even on skip ticks. Using the same real WNBA data and the same design
discipline (step-level gate, not job-level), a 60-min cadence version of this tier would cost roughly the
same order of magnitude as the fixed `wnba-current-refresh` at hourly cadence (~980 min/month, Section 2) —
**~3× more than Option A**, for work that could instead ride along inside an already-paid-for job.

### Recommendation: **Option A.**

It is strictly cheaper (an estimated ~310 min/month marginal cost vs. Option B's ~980+ min/month for a new
standalone tier at the coarsest reasonable cadence), requires no new workflow file, no new gate logic to
maintain in parallel with the existing one, and directly "closes the loop" on freshness checks that already
exist. The only reason to prefer Option B would be if injuries/lineups/weather needed a *different* cadence
than the sharp/scoring/board pipeline (e.g., refreshed more or less often than scoring runs) — nothing in the
task or the codebase suggests that's the case; they're consumed by the same scoring pass that already reads
their freshness.

---

## 4. Consolidated projected budget (Task 4)

All real-data-based, assembled from the corrected figures above. WNBA-only real event data is used
throughout; MLB's contribution is flagged as unquantified (its own events table cannot be trusted for
cadence — see Section 1), so **every total below is a floor, not a ceiling** — real combined MLB+WNBA cost
would be higher once MLB's schedule is actually live and ingesting.

| Line item | Design | Monthly minutes | Basis |
|---|---|---|---|
| Sharp/scoring/board floor (`schedule-refresh`+`gate`, merged per Phase 1 §3) | merged single job, 30-min cadence, unchanged | **1,728** | Phase 1 §3 real measurement, unchanged by Task 1 |
| Sharp/scoring/board `pipeline` fires | unchanged 30-min cadence, real WNBA fire-rate (not the Phase 1 placeholder) | **1,349** | 17.3 fires/day (Task 1 real data) × 2.6 min avg (Phase 1 real avg) × 30 |
| `wnba-current-refresh`, fixed (gate + hourly cadence, Section 2 recommendation) | step-level gate, `0 * * * *` | **980** | Task 1 real WNBA data + Section 2 design |
| `wnba-history-refresh` (unchanged from Phase 1 — not in scope for this pass) | once/day, no change proposed | **150–540** (midpoint ~345) | Phase 1 code-comment estimate, not re-verified this pass |
| Injuries/lineups/weather, Option A (recommended) | folded into existing `pipeline` job | **~310** | Section 3 estimate |
| Daily tier (recent-features, team context — unchanged from Phase 1) | once/day | **60–120** (midpoint ~90) | Phase 1 estimate, not re-verified this pass |
| **TOTAL (using midpoints)** | | **≈4,802 min/month** | |

**This does not fit inside the real 2,000-minute cap — it lands at roughly 2.4× the budget, even after
applying both fixes designed in this pass (the `wnba-current-refresh` gate+cadence fix and the Option A
injuries/lineups/weather wiring).** This is a meaningfully different, more pessimistic picture than Phase 1's
placeholder-based ~2,700–2,800 figure — the corrected total is higher primarily because (a) real WNBA game
density (9.11h/day open-window coverage on 95% of days) is denser than the ~8h/day placeholder assumed, and
(b) `wnba-current-refresh`, which Phase 1's total excluded entirely, now adds a real ~980 min/month even after
its fix.

**Single next-highest-leverage cut, if one more change is needed beyond what's already designed here:**
**loosen `covered-live-pipeline.yml`'s own base cadence from `*/30` to hourly.** It's now the largest single
line item (1,728 + 1,349 = 3,077 min/month combined, ~64% of the total). Applying the same cadence-halving
logic already validated for `wnba-current-refresh` in Section 2 (merged-job floor scales roughly linearly
with tick count; pipeline-fire count scales similarly) would roughly halve both components — merged floor
~864, pipeline fires ~675 — bringing sharp/scoring/board down to **≈1,539 min/month**, and the grand total to
**≈3,264 min/month**. That still doesn't clear 2,000 on its own; a second cut (e.g., dropping the daily and
injuries/lineups/weather tiers to every-other-day, or accepting `wnba-history-refresh`'s incremental-only mode
and disabling full-backfill entirely) would likely be needed to close the remaining gap. I have not designed
that second cut in this pass — flagging it as the next open question rather than picking one unilaterally.

---

## 5. What's still unverified or needs a human decision

- **MLB's real cadence cannot be determined from current data**, full stop (Section 1). Every number in this
  report that touches MLB is either WNBA-only (and therefore an undercount of the true combined cost once MLB
  is live) or a low-confidence per-active-day proxy. **Getting MLB's `events` table current again (re-running
  MLB schedule ingestion, even manually/once) would be the single highest-value action to sharpen every
  number in this document** — right now this entire cost model is provably a floor, not the real number.
- **The Option A marginal-cost estimate (~310 min/month) is unmeasured** — it's derived from headroom
  observed in 5 historical `pipeline` run samples, not from actually adding the three refresh calls and timing
  them. Real cost could be somewhat higher or lower.
- **The step-level gate design for `wnba-current-refresh` (Section 2) has not been implemented or timed.**
  The "checkout + lightweight check only, ~1 billed min" skip-tick cost is a reasoned estimate based on how
  fast `gate`'s existing Python check runs (4–7s measured) — a WNBA-only, no-pnpm-install version should be at
  least that fast, likely faster, but this is inference, not measurement.
- **Whether hourly cadence (proposed for both `wnba-current-refresh` and, as the Section 4 next-cut
  suggestion, `covered-live-pipeline`) is an acceptable freshness trade-off is a product decision, not a
  technical one.** Moving from 20–30 min to 60 min increases the worst-case staleness window for schedule
  refreshes and Sharp odds/scoring by roughly 2–3×. I have not evaluated whether that's acceptable for the
  product — flagging it for an explicit human decision before implementation.
- **The "second cut" needed to close the remaining ~1,264 min/month gap after the covered-live-pipeline
  cadence change (Section 4) was not designed in this pass** — Task 4 only asked me to identify the
  single next-highest-leverage cut, not fully close the gap, so I've stopped there deliberately rather than
  picking a second cut unilaterally.
- **None of the designs in this document have been implemented, tested, or timed against a real deployed
  workflow.** Everything here is a projection built from real historical data plus reasoned design; actual
  post-implementation numbers should be re-measured the same way Phase 1 and this pass did, before trusting
  them as final.

No workflow files were modified. No scheduling variables were changed. No commits were made beyond this one
output file, which itself has not been staged or committed.
