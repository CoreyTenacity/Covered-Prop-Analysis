# GitHub Actions Budget Audit Findings — 2026-07-15

Investigation-only. No workflow YAML, cron schedule, or scheduling variable was modified. No live provider
calls were made. No Supabase queries were run — all numbers below come from `.github/workflows/*.yml` file
inspection and the GitHub Actions REST API (`gh run list` / `gh api .../jobs`) via `gh` CLI, which reads CI
run history, not app/production data.

---

## 1. Corrected budget baseline

`AGENTS.md` (lines 65–68) currently states:

> "The private GitHub repository has a 20,000-minute/month included budget for Actions. Treat the real,
> usable budget as **18,000 minutes/month**..."

This is **confirmed wrong**. `CoreyTenacity/Covered` is a **private** repository on GitHub's default Free
plan, which includes **2,000 Actions minutes/month** for private repos (Linux runners at a 1× multiplier;
this repo uses `ubuntu-latest` everywhere, so no Windows/macOS multiplier applies). There is no 20,000-minute
tier at this plan level — that number does not correspond to any real GitHub billing tier for this repo.

**All cost math in this report is against the real 2,000-minute/month ceiling.** Per the task instructions,
I have not edited `AGENTS.md` in this pass — see Section 7 for the recommended follow-up.

Billing mechanics that matter for every number below:
- GitHub Actions bills **per job**, not per workflow.
- Each job's billed time is its wall-clock runtime **rounded up to the next whole minute** — a 4-second job
  costs 1 full billed minute, same as a 59-second job.
- A job whose job-level `if:` evaluates to `false` **never provisions a runner** and bills **0 minutes**.

---

## 2. Current workflow inventory

Two workflows have a `schedule:` trigger. Everything else is `workflow_dispatch` and/or `push` only (zero
recurring cost by itself).

| Workflow | Job | Cadence | Currently gated off? | Real/estimated runtime | Billed min/run |
|---|---|---|---|---|---|
| `covered-live-pipeline.yml` | `schedule-refresh` | `*/30 * * * *` (48/day) | Yes — `COVERED_GITHUB_SCHEDULER_ENABLED != 'true'` | **Measured**: 37–70s (5 real samples) | 1 |
| `covered-live-pipeline.yml` | `gate` | same tick | Yes — same var, plus `needs.schedule-refresh.result == 'success'` | **Measured**: 4–7s (5 real samples) | 1 |
| `covered-live-pipeline.yml` | `pipeline` | same tick, only if `gate` says `should_run=true` (event inside 6h pregame window, outside 5min close buffer) | Yes (transitively — gate never says run while disabled) | **Measured**: 27–195s across 5 real dispatch runs (wide variance — depends on how much Sharp/score/board work is actually due) | 1–4 |
| `wnba-data-ingestion.yml` | `wnba-current-refresh` | `*/20 * * * *` (72/day) | Yes — needs both `COVERED_GITHUB_SCHEDULER_ENABLED == 'true'` **and** `WNBA_INGESTION_ENABLED == 'true'` (latter is unset entirely — double-gated) | No scheduled run has ever executed (all history shows `skipped`). One manual `workflow_dispatch` sample: 76s total workflow wall-clock. | ~2 (est., unmeasured at job level) |
| `wnba-data-ingestion.yml` | `wnba-history-refresh` | `0 9 * * *` (1/day) | Same double-gate | **Documented estimate only** (code comment, not measured this session): incremental ~4–5 min, full backfill up to ~18 min | 5–18 (est.) |
| `wnba-data-ingestion.yml` | `wnba-diagnostic` | n/a — `workflow_dispatch` only | not scheduled | n/a | n/a |

**Empirical confirmation that the job-level skip actually works (not just asserted in docs):** I pulled every
`schedule`-triggered run for both workflows — **100% of them (≈35 for covered-live-pipeline, ≈22 for
wnba-data-ingestion, all currently in the run history)** show workflow-level `conclusion: skipped` with total
wall-clock of **0–11 seconds**, and job-level records show `skipped` status, not a runner that started and
exited. This is real evidence, not just the code comment in `GITHUB_ACTIONS_PHASE2_MIGRATION.md` claiming it.
**Current real recurring cost from these two scheduled workflows is 0 minutes/month**, because both gates are
off.

**Non-scheduled workflows** (no recurring cost by definition, listed for completeness):

| Workflow | Trigger | Note |
|---|---|---|
| `deploy-cloudflare.yml` | `push` → `codex/cloudflare-opennext-proof` | Not cron, but real recurring cost in practice: 9 runs across the last 2 days (7 on 7/14, 2 on 7/15), each measured 62–114s → 1–2 billed min/run. No `paths-ignore`, so a docs-only commit triggers a full rebuild+deploy. |
| `validate-targeted-repair.yml` | `push` → `codex/github-actions-league-registry` only | No runs on the current branch; last activity 2026-07-11. |
| `mlb-enrichment-backfill.yml`, `mlb-targeted-repair.yml`, `diagnostic-mlb-providers.yml`, `diagnostic-wnba-scoreboard.yml`, `TEMP-diagnostic-wnba-multi-provider.yml` | `workflow_dispatch` only | Zero recurring cost. The `TEMP-*` one is self-labeled "SCHEDULED FOR REMOVAL." |

---

## 3. Reconciled root-cause finding: `schedule-refresh` + `gate` job split

**Confirmed still accurate, with a correction to the precision of the savings estimate.**

`schedule-refresh` and `gate` are still two separate jobs today (verified by reading the current
`covered-live-pipeline.yml`, not assumed from a prior session). Real per-job durations from 5 successful
dispatch-triggered runs:

| Run | schedule-refresh | gate | combined | billed if separate (1+1, always) | billed if merged (ceil of combined) |
|---|---|---|---|---|---|
| 29331366578 | 37s | 7s | 44s | 2 min | 1 min |
| 29331538295 | 42s | 7s | 49s | 2 min | 1 min |
| 29331931032 | 40s | 4s | 44s | 2 min | 1 min |
| 29213011813 | 54s | 4s | 58s | 2 min | 1 min |
| 29211490990 | 70s | 4s | 74s | 2 min | **2 min** (only case that spills over) |

Average combined real work: **53.8s**. As **separate** jobs, billing is always exactly 2 min/tick regardless
of actual duration (a 4-second job still costs a full minute). As a **merged single job**, billing would be
1 min/tick in 4 of 5 samples and 2 min/tick in 1 of 5 (when combined work exceeds 60s).

**Correction to the prior "flat 1,440 min/month savings" framing:** that assumed merging always costs exactly
1 min/tick. Real data shows it's usually 1 min but occasionally 2 min when combined work runs long. A more
precise estimate: merging saves **~0.8 min/tick on average**, not a flat 1 min/tick.

- At 48 ticks/day (if scheduler were re-enabled): unmerged = 48 × 2 = 96 min/day = **2,880 min/month**.
  Merged ≈ 48 × 1.2 = 57.6 min/day ≈ **1,728 min/month**.
- **Corrected estimated savings from merging: ~1,150 min/month**, not the previously stated flat 1,440.
  Still the single highest-leverage structural fix available, just slightly less than originally claimed.

**Mechanics, confirmed:** GitHub's Actions billing charges each **job** independently, rounding each job's
own wall-clock time up to the next whole minute, before summing across jobs in a run. Two sequential jobs in
the same workflow are billed as two separate rounded charges; the same sequential steps inside **one** job
are billed as a single rounded charge for their combined time. This is exactly why the split costs extra —
it is not merely a "code style" choice, it is a real per-tick billing multiplier.

---

## 4. Reconciled 2,880–7,100 min/month estimate

Broken down precisely, this range (produced in an earlier session) is built from:

- **Low end, 2,880 min/month** = `covered-live-pipeline.yml`'s `schedule-refresh` + `gate` floor cost ONLY:
  48 ticks/day × 2 billed min × 30 days. This assumes **zero** `pipeline` job executions (i.e., a
  hypothetical stretch where no MLB/WNBA event is ever inside the 6h pregame window) — the pure overhead of
  repeatedly checking "should we do anything?" **It does not include `wnba-data-ingestion.yml` at all.**
- **High end, ~7,100 min/month** = the 2,880 floor **plus**:
  - An assumed ~16 `pipeline` job executions/day (estimated from an assumed ~8h/day of pregame-window
    coverage at the 30-min cadence) at an assumed flat 4 min/run = ~1,920 min/month. **Correction from real
    data**: the 5 measured `pipeline` runs actually ranged 1–4 billed min (average ≈2.6 min), so 4 min/run
    was a worst-case, not a typical-case, number. Using the real average, this component is closer to
    ~1,250 min/month, not ~1,920.
  - `wnba-data-ingestion.yml`'s `wnba-current-refresh` at `*/20` (72/day × ~1–2 min) ≈ 2,160 min/month,
    **only if `WNBA_INGESTION_ENABLED` were also set to `true`** — this is a second, independent kill switch
    from `COVERED_GITHUB_SCHEDULER_ENABLED`, and it is currently unset (not just `false` — undefined).
  - `wnba-history-refresh` at once/day, documented estimate 5–18 min ≈ ~150–540 min/month.

**So the range conflates two different questions** — "what does `covered-live-pipeline` alone cost if
re-enabled" (2,880 floor + realistic pipeline cost ≈ **~4,100–4,800 min/month**, corrected) vs. "what does
everything cost if both workflows and both kill switches are flipped on" (adds another ~2,300–2,700
min/month on top, reaching the ~7,100 figure). **Both scenarios exceed the real 2,000-minute cap even before
correction** — the corrected numbers don't change that conclusion, only its precision.

---

## 5. Proposed tiered schedule — modeled against real numbers, with one material gap flagged

Before the math: I checked whether the user's proposed "injuries, lineups" pregame-proximity tier maps to
anything that exists in the codebase today, since the task asked me to confirm or challenge the model rather
than take it as given. Per user follow-up, MLB weather was checked against the same question.

**Finding: none of injuries, lineups, or MLB weather exist as a scheduled path today — all three share the
identical gap.** `refresh_injuries` is defined in the job registry (`lib/knowledge/enrichment/jobs.ts`) but is
**not invoked from any workflow file** — grepping every `.yml` for it returns zero scheduled or gated call
sites. `refresh_lineups` is invoked from exactly one place: `mlb-enrichment-backfill.yml`, which is
`workflow_dispatch`-only (one-time backfill, not a recurring schedule). `refresh_mlb_weather` is invoked from
two places — `mlb-targeted-repair.yml` and `mlb-enrichment-backfill.yml` — both `workflow_dispatch`-only,
never scheduled.

The pregame-gated `pipeline` job's live-repair path (`runLivePreScoreRepair` → `inspectLiveRepairPreflight`)
does conditionally refresh player logs, recent features, and matchup/team context when stale — and for MLB,
its matchup freshness check does **read** `mlb_weather.updated_at`/`weather_date` as one of five support
signals (alongside lineups, starting pitchers, bullpen, ballpark) to decide whether matchup context overall
is fresh enough. But that check only *observes* weather staleness — it never calls `refreshMlbWeatherJob` to
actually refresh it, exactly the same pattern as lineups. So today, **injuries has no refresh path at all**,
and **lineups and MLB weather only get refreshed via one-time manual backfills**, never on any recurring or
event-triggered schedule. This is a real gap independent of the budget question — flagging it, not fixing it,
per scope. If a pregame-proximity tier is built, MLB weather belongs in it alongside injuries and lineups, and
all three would need new wiring into a scheduled/gated workflow — none of the existing schedule infrastructure
touches any of them today.

**Sharp odds/props tier — confirmed already correctly gated.** The `pipeline` job (which does Sharp
ingestion + scoring + board build) only runs when `gate`'s `should_run` output is `true`, and `gate`'s Python
script implements exactly the 6-hour-pregame-window / 5-minute-close-buffer logic described in the proposed
model, reading real event `start_time` values from Supabase before deciding. **This part of the existing
system is not running on a flat interval regardless of event proximity — it is correctly windowed already.**
The waste is entirely in the `schedule-refresh` + `gate` overhead needed to make that determination 48
times/day, not in `pipeline` firing when it shouldn't.

**wnba-current-refresh — confirmed running on a flat interval, NOT pregame-windowed.** Unlike
`covered-live-pipeline`, this job's `if:` condition checks only the two kill switches — there is no pregame
or event-proximity check anywhere in `wnba-data-ingestion.yml`. If both switches were flipped on, it would
run all 72 ticks/day unconditionally, including overnight hours with no games anywhere near start time.

**Tiered model, computed:**

| Tier | Jobs | Proposed cadence | Billed min/run (real or best estimate) | Runs/day | Monthly minutes | Running total |
|---|---|---|---|---|---|---|
| Sharp/scoring/board (existing, correctly gated) | merged `schedule-refresh`+`gate` (1 min avg, per §3) + `pipeline` only when window open | 30 min tick to *check*; `pipeline` fires only inside 6h pregame windows | 1 (check) + 1–4 (pipeline, when it fires) | 48 checks/day; pipeline-fire count depends on real game volume — **could not verify without production `events` data**, which this task explicitly excludes | Floor: 48×1×30 = **1,440**. Pipeline add-on: unverifiable precisely (see Open Questions) — using the corrected ~2.6 min/run average and the same ~16 fires/day assumption as §4: 16×2.6×30 ≈ **1,248** | **≈2,688** |
| Daily (player recent-features, team context) | `refresh_recent_features`, team-context refresh | once/day, after last game final | No direct measurement exists for these run standalone (only ever observed as part of the ~2.6 min average `pipeline` run, or unscheduled). **Estimate, labeled as such**: 2–4 min | 1/day | 60–120 | **≈2,748–2,808** |
| Pregame-proximity (injuries, lineups, MLB weather) | `refresh_injuries`, `refresh_lineups`, `refresh_mlb_weather` — **all three currently unreachable from any schedule, all would need new wiring** | every 30–60 min, only inside each event's 6h window | **No real runtime data exists** — none of these jobs are ever invoked from any scheduled or gated workflow today | Depends on same unverifiable game-window overlap as above | **Cannot be computed without either (a) real event-volume data or (b) a live timed run of these jobs, both excluded from this task's scope** | not added |

**Bottom line, stated plainly:** even the partial, verifiable portion of this tiered model (Sharp/scoring/board
+ a once-daily features refresh) lands at **~2,700–2,800 min/month — still ~35–40% over the real 2,000-minute
cap**, before adding the pregame-proximity tier at all. The `schedule-refresh`/`gate` merge (§3) is necessary
but **not sufficient** on its own to fit the budget; the 30-minute check cadence itself (1,440 min/month just
for merged floor checks) is the next-largest lever, independent of anything else in this model.

---

## 6. Open questions / could not verify without a live run or excluded data

- **Real MLB/WNBA game volume and pregame-window overlap.** The task instructed me not to use production
  data or query Supabase, so every "runs/day the pipeline job would actually fire" and "how many
  hours/day is at least one event inside its 6h window" number in Section 5 is **unverified** — I reused the
  same ~8h/day, ~16-fires/day assumption from the prior session's estimate rather than re-deriving it, and
  flagged it as such rather than presenting it as measured. Getting a real number would require either a
  bounded read-only query against the `events` table (which this task excludes) or reasoning from public
  MLB/WNBA schedule facts, which I also avoided since the task's data restriction reads as covering both.
- **`wnba-current-refresh` and `wnba-history-refresh` job-level billed minutes.** No scheduled run of either
  has ever executed (100% `skipped` in history), so there is no real per-job timing to draw on. The one
  `wnba-history-refresh` estimate that exists (4–5 min incremental / up to 18 min full backfill) is a code
  comment in the workflow file itself, not something I measured this session — I've labeled it as such.
- **`refresh_injuries`, `refresh_lineups`, and `refresh_mlb_weather` standalone runtime.** None of these have
  ever run on any schedule, so there's no history to measure. I did not trigger a live run to find out, per
  the task's restriction on live provider calls — refreshing injuries/lineups/weather calls external
  providers.
- **Whether `pnpm install --frozen-lockfile`'s `cache: pnpm` step is actually hitting cache reliably.** The
  tight 37–70s range for `schedule-refresh` across 5 samples is consistent with a warm cache, but I did not
  pull the raw step-level logs to confirm a cache-hit line explicitly — flagging as inferred, not confirmed.

---

## 7. Recommended next steps

1. **Correct `AGENTS.md`'s stated Actions budget** from "20,000-minute/month included budget... usable budget
   18,000 minutes/month" to the real 2,000 minutes/month for a private repo. This was explicitly out of scope
   to edit in this pass, but every future scheduling decision made against the wrong number in AGENTS.md will
   be wrong by roughly 9×, so this correction should happen before any scheduler is re-enabled.
2. Merge `schedule-refresh` and `gate` into a single job (Section 3) — the only structural fix in this report
   with a fully real, measured savings basis (~1,150 min/month, corrected from the earlier ~1,440 estimate).
3. Before modeling further, get a real read on actual MLB/WNBA event volume and pregame-window overlap (the
   biggest open question in Section 6) — everything in Section 5's "pipeline fires 16×/day" and the entire
   pregame-proximity tier is unverifiable without it, and this audit intentionally did not query that data.
4. Decide whether `refresh_injuries`, `refresh_lineups`, and `refresh_mlb_weather` (all three currently
   unreachable from any schedule) should be wired into the pregame-proximity tier described in the task,
   since none of them exist as a scheduled job today. Per user follow-up during this audit, MLB weather is
   confirmed to belong in this tier alongside injuries and lineups — same gap, same fix needed.
5. Re-run this cost model with the real numbers from steps 2–3 before enabling `COVERED_GITHUB_SCHEDULER_ENABLED`
   or `WNBA_INGESTION_ENABLED` — even the partial, verified math in Section 5 already exceeds the 2,000-minute
   cap by ~35–40%, so the tiered model as proposed needs further tightening (e.g., a check cadence longer
   than 30 minutes) before it fits, not just the merge fix.

No files were modified, staged, or committed as part of this task.
