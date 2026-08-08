# AGENTS.md

This is the shared rulebook for every coding agent that works in Covered.

Before making changes, every agent must read these three files in order:

1. `AGENTS.md`
2. `docs/PROJECT_CONTEXT.md`
3. `docs/AGENT_HANDOFF.md`

If any of them conflicts with a newer repo-specific instruction from the user, the user instruction wins.

Update this file only when durable rules, architecture, supported capabilities, or safety constraints change.

## Owner quality standard — completion, not patches

Covered is treated as a high-value production product, at a quality standard appropriate for a
$100,000 professional software engagement. The owner does not want incremental patch-by-patch
handoffs. The objective of an authorized task is not "make the requested code change" — it is
"deliver the complete requested product outcome at production quality."

**Default operating mode.** Once the owner authorizes a bounded phase or objective, keep working
within that scope until the phase is genuinely complete. Do not stop after finding the first
defect, implementing the first fix, passing one focused test, discovering a second related
defect, finding a responsive/mobile issue during validation, finding an adjacent regression
caused by the same feature, finding a missing UI state, finding an obvious read-path
inconsistency, finding an egress/performance problem introduced by the implementation, or finding
that something works locally but not through the actual user-facing path. Instead: investigate →
implement → test → inspect → validate → fix discovered in-scope defects → revalidate → complete.
The owner should not need a fresh prompt for every ordinary engineering iteration.

**Definition of done.** A task is complete only when the requested outcome works end-to-end —
repository implementation, data/read-path correctness, API correctness, UI correctness,
responsive/mobile/desktop behavior, loading/empty/error/interaction states, production-shaped
data, regression coverage, performance, Supabase egress, request efficiency, security/public-repo
boundaries, production build, and (when deployment is authorized) actual deployed behavior.
Passing tests alone, a successful build alone, or local verification alone is not completion. A
deployed feature that is visibly broken on mobile is not complete. A backend fix whose frontend
was never deployed is not complete. A feature that technically works but is confusing, cramped,
misleading, stale, or inconsistent is not complete.

**Internal iteration requirement.** When validation discovers an in-scope defect, fix it before
reporting completion rather than asking "want me to fix X?" when X is clearly part of the
authorized objective and can be fixed safely without crossing an approval boundary.

**Adjacent defect rule.** Use judgment rather than blindly expanding scope. If a defect is
directly encountered while exercising the feature being changed, and materially prevents that
feature from meeting the requested production-quality outcome, treat it as part of the task (e.g.
responsive clipping in the component being changed, stale data leaking through another rendering
path for the same feature, duplicate evidence in the same feature, N+1 queries introduced by the
implementation, a frontend deployment missing the newly implemented frontend). This is not
authorization for unrelated refactoring or broad cleanup — see "Scope control" conventions this
file and the project's Claude-specific instructions already establish.

**Hard-stop boundaries.** Stop and request owner authorization only when continuing requires an
action outside already-authorized scope or a standing governance boundary — this list is
additional detail on top of, not a replacement for, the "Production safety rules,"
"Provider-call restrictions," and "Database-write restrictions" sections below: production
deployment not already authorized; private-main push or merge; migration; destructive database
operation; duplicate deletion/reconciliation; broad/historical backfill; broad production
rescoring; scheduler changes; recurring scheduler creation; provider configuration changes;
additional provider usage outside the authorized budget; paid-service changes; credential
creation/rotation; scoring-weight changes; threshold reductions; weakening publishability;
manufacturing picks; unsupported sports; material infrastructure changes. When blocked, complete
everything possible before stopping and ask for one precise authorization. Do not manufacture
additional approval checkpoints beyond these.

**Validation standard.** Before declaring a feature complete, actively try to break it: normal,
empty, stale, incomplete, and boundary-value states; multiple-item state; mobile, tablet, and
desktop; interaction after selection and repeated interaction; production-shaped data; relevant
API/read paths. Inspect for clipping, wrapping, stale or contradictory or duplicated information,
hidden controls, misleading labels, missing context, unnecessary requests, N+1 behavior, payload
bloat, and regressions on related surfaces. Do not wait for the owner to discover obvious defects
manually.

**Live product standard.** When a task affects the user-facing application and production
deployment is authorized, the final validation target is the actual deployed application —
localhost is useful during implementation but is not sufficient evidence production is correct.
Distinguish explicitly between repository-verified, local-runtime-verified,
production-data-shadow-verified, and deployed-production-verified. Never call something "live
verified" unless the actual deployed product was checked.

**Efficiency standard.** High quality does not mean wasteful investigation. Avoid repeatedly
rediscovering already-certified architecture, rerunning expensive full suites after every tiny
edit, repeatedly polling external systems, broad audits without evidence they're needed,
rewriting working code unnecessarily, reopening settled architectural questions, and token-heavy
narration. Use focused tests while iterating; run comprehensive validation once the
implementation stabilizes. Prefer one substantial, well-verified implementation cycle over many
tiny patches.

**Reporting standard.** Do not narrate routine implementation progress unless interaction is
required — work quietly through ordinary engineering iterations. Return when the entire
authorized objective is complete and validated, or a genuine hard-stop boundary prevents further
progress. If blocked, report: what is already complete, the exact blocker, why it crosses an
authorization boundary, the exact action requiring approval, and what happens after approval.

**Completion language.** Do not use "READY," "COMPLETE," "CERTIFIED," "LIVE," or "FIXED" unless
the evidence supports the full meaning of that term. Use conservative status language when
verification is incomplete — the standard is not "probably works," it is verified, coherent,
efficient, production-quality behavior across the complete authorized scope.

## Project architecture

Covered separates responsibilities by layer:

- GitHub Actions owns the live pipeline orchestration and repo-native validation.
- Supabase owns storage, SQL/RPC, auth, and scheduled database-side work where used.
- Cloudflare Workers owns the public app and lightweight route handlers in current production.
- Vercel is dormant and retained only as a fallback from the earlier hosting arrangement.
- Background jobs should avoid duplicating work across schedulers.

The repo currently uses a league capability registry and a gated live pipeline. The live pipeline is intentionally disabled for scheduled execution until explicitly enabled.

## Supported sports

Current active focus:

- MLB
- WNBA

Known but not currently enabled for live production orchestration:

- NBA
- NFL
- Tennis

Do not claim a sport is supported unless the downstream code actually supports it.

Tennis must never inherit team-sport assumptions.

## Free-tier constraints

This project must stay entirely free to run. Every provider, service, and plan selection — hosting,
database, data providers, CI/CD, and anything added later — must be a free-tier or free option. Do not
introduce a paid service, paid tier, or paid API without the user's explicit approval first, even if it
would be simpler or more capable.

The project must also stay mindful of free-tier limits for compute, bandwidth, and database growth.

Rules:

- Prefer bounded, targeted, idempotent jobs.
- Avoid unnecessary repeated reads and writes.
- Avoid live provider calls unless the task explicitly requires them.
- Do not enable recurring scheduled execution without approval.
- Keep heavy work out of Vercel when another scheduler or a direct job runner is the better fit.
- Prefer the smallest safe change that proves the path.
- Do not select or recommend a paid tier, paid API, or paid add-on for any part of the stack without
  explicit user approval.

### GitHub Actions minutes budget

The private GitHub repository is on **GitHub Free**, which includes **2,000 Actions minutes/month** for
private repos — NOT 20,000. (An earlier version of this file claimed a 20,000 cap with an 18,000 planning
budget; that was wrong by ~9x and every schedule sized against it was wrong. Corrected 2026-07-15 after a
real audit — see `docs/GHA_BUDGET_AUDIT_FINDINGS.md`.)

- Size every scheduled workflow against **2,000 minutes/month**.
- GitHub bills **per job, rounded UP to the whole minute** — a 4-second job costs a full minute. Two
  sequential sub-minute jobs cost 2 minutes; the same steps in ONE job cost 1. Prefer fewer, longer jobs.
- Jobs skipped by a job-level `if:` cost **nothing** (verified: gated runs bill 0).
- Current scheduled spend is **0** (schedulers gated off). Re-enabling as-is would cost **~4,800 min/month
  ≈ 2.4x the cap** — do not enable without the cost fixes in `docs/GHA_BUDGET_PHASE2_DESIGN.md`.
- If a proposed schedule approaches or exceeds 2,000 minutes, flag it rather than enabling it.
- **Public-minutes cost strategy (session 15):** the intended direction is to run the bulk of recurring
  production Actions minutes in the PUBLIC repo (`Covered-Prop-Analysis`), where standard-runner minutes are free
  and unlimited, keeping private-repo production Actions usage near zero. Scoring stays a private Cloudflare
  Worker (zero GitHub minutes). This shift is Supabase- and Cloudflare-neutral (same work, same DB/Worker calls);
  run **frequency/per-run egress** — not minute cost — remains the lever that protects the Supabase (~5 GB/mo)
  and Cloudflare free tiers, so cadence stays bounded regardless of free minutes. Full detail + free-tier
  validation: `docs/GHA_PUBLIC_MINUTES_STRATEGY.md`.

### Supabase egress and Vercel Fluid Active CPU — hard rule

Monthly Supabase egress and monthly Vercel Fluid Active CPU usage must both stay very low and should
barely move month to month. This is a hard rule, not a soft preference — every change must be evaluated
for cost-effectiveness and efficiency, not just correctness.

- Prefer stored/cached data over live re-fetching; never re-fetch or re-transfer data that is already
  durably stored and fresh enough to reuse.
- Avoid designs that return large payloads, unbounded row sets, or full-table reads/writes when a
  targeted, filtered, or paginated query would do.
- Avoid designs that keep Vercel functions doing heavy or long-running compute; push heavy or recurring
  compute to GitHub Actions/direct job runners instead (consistent with the existing "keep heavy work out
  of Vercel" rule above).
- Before adding a new recurring job, a new route that reads/writes meaningfully more data, or a new
  provider integration, estimate its egress and compute impact and flag anything that would visibly move
  either number month over month, rather than enabling it silently.
- If a task would trade a small amount of extra egress/compute for a meaningfully simpler implementation,
  do not make that trade unilaterally — flag it to the user and let them decide.

## Live-pipeline order

When the live pipeline is exercised, the safe high-level order is:

1. gate / preflight
2. Sharp ingestion
3. enrichment repairs and feature refreshes
4. scoring
5. board build

The pipeline should fail closed on missing prerequisites.

## Pregame window behavior

Live execution should respect the configured pregame window and close buffer.

Current default behavior in the workflow is:

- pregame window: 6 hours before event start
- close buffer: 5 minutes before event start

Do not change those defaults without an explicit request.

## Branch, commit, push, and merge rules

- Work on the existing branch the user specifies, or the current feature branch if none is specified.
- Commit only the files needed for the requested change.
- Push when the user asks for a push.
- Do not merge branches unless the user explicitly asks.
- Do not enable scheduled execution as a side effect of a docs or validation change.
- Do not stage unrelated files.

## Production safety rules

- Do not run live provider jobs unless the user explicitly approves a live test.
- Do not write to production databases during diagnosis-only tasks.
- Do not bypass safety gates to force output.
- Do not lower thresholds just to make data appear.
- Do not treat validation workflows as production pipeline tests.

## Provider-call restrictions

- Do not make provider calls as part of docs work.
- For orchestration or validation changes, prefer mocked or controlled tests unless the user approves a live run.
- Keep Sharp ingestion and enrichment calls bounded and explicit.
- MLB Baseball Savant/Statcast (`lib/providers/statcast-savant.ts`) is a real, working, owner-approved
  intended source (Session 106), wired into `runLivePreScoreRepair` as a preflight-gated `savant` stage
  but **disabled by default** behind `KNOWLEDGE_MLB_SAVANT_ENABLED` (must equal exactly `"true"`; any other
  value, including unset, stays disabled). It is not set in production as of Session 106. Do not enable it
  without re-reading `docs/AGENT_HANDOFF.md` Session 106's activation proof package and getting explicit
  fresh owner sign-off — this is a live-call-enabling change, not a code change.

## Database-write restrictions

- Do not change production data during read-only investigations.
- Keep writes idempotent whenever possible.
- Do not add or alter schema unless the task explicitly calls for migrations.
- Prefer durable repair in the correct stage rather than patching downstream outputs.

## Validation requirements

When code changes are made, validate in proportion to risk. Common validation includes:

- `pnpm exec tsc --noEmit`
- focused tests relevant to the change
- `pnpm test` when the change crosses shared paths
- `pnpm build` when shared runtime behavior changes
- workflow YAML parsing when GitHub Actions files change

Do not use the production live pipeline as a compilation test.

## Documentation update behavior

Keep these files current:

- `AGENTS.md` only for durable rule or architecture changes
- `docs/PROJECT_CONTEXT.md` only for stable project or technical context changes
- `docs/AGENT_HANDOFF.md` after a meaningful commit, validation result, blocker change, controlled live test, or change in next step

Do not update the handoff for trivial formatting or tiny local edits.

Git history remains the authoritative chronological record.
Do not create a separate `changes.log` unless a future need clearly appears.

## Important repository entry points

Useful files to inspect first when working in the live pipeline or job orchestration:

- `.github/workflows/covered-live-pipeline.yml`
- `.github/workflows/validate-targeted-repair.yml`
- `lib/ops/github-actions-pipeline.ts`
- `lib/ops/github-actions-pipeline.test.ts`
- `lib/ops/github-actions-league-registry.json`
- `lib/knowledge/enrichment/jobs.ts`
- `lib/knowledge/sharp-matching.ts`
- `docs/CRON_DEPLOYMENT_MATRIX.md`
- `docs/GITHUB_ACTIONS_PHASE2_MIGRATION.md`
- `docs/AGENT_HANDOFF.md`
