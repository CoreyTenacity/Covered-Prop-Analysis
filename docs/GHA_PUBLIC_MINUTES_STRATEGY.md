# GitHub Actions Public-Minutes Cost Strategy (2026-07-16, session 15)

## Goal
Shift the bulk of recurring **production** GitHub Actions minutes to the PUBLIC repo
(`CoreyTenacity/Covered-Prop-Analysis`), where GitHub-hosted standard-runner minutes are **free and
unlimited**, keeping the PRIVATE repo (`CoreyTenacity/Covered`) production Actions usage near zero and far under
its GitHub Free **2,000 min/month** cap. "Some private minutes are fine" as long as they stay nowhere near that cap.

## Why it works
- **Public repos:** unlimited free standard-runner Actions minutes.
- **Private repos (GitHub Free):** 2,000 min/month.
- The scheduler is currently DISABLED (`COVERED_GITHUB_SCHEDULER_ENABLED=false`) precisely because re-enabling it
  as-is would cost **~4,800 min/mo ≈ 2.4× the private cap** (per `AGENTS.md` / `docs/GHA_BUDGET_AUDIT_FINDINGS.md`).
  Running those same minutes in the PUBLIC repo makes that cost **$0** — this is the insight that dissolves the
  cost blocker.
- The one deliberately-private stage, **scoring**, already runs as a **Cloudflare Worker** (`scoring-engine`,
  `SCORING_ENGINE_SECRET`-authenticated), invoked over HTTPS — so it consumes **zero GitHub Actions minutes**,
  public or private.

## Target split
| Stage | Where it runs | GitHub minutes |
|---|---|---|
| Gate / event discovery | Public repo | Free (public) |
| Sharp ingestion (paced 6.5s/req — the main time sink) | Public repo | Free (public) |
| Enrichment / feature refresh | Public repo | Free (public) |
| **Scoring (tuned secret sauce)** | **Private Cloudflare Worker (HTTP)** | **Zero** |
| Board build + snapshot publish | Public repo | Free (public) |
| Private repo | production: ~none; only occasional CI on push | Far under 2,000/mo |

## Free-tier impact of the SHIFT — validation
The shift is about **where compute minutes are billed, not about doing more work.** The pipeline reads/writes the
same rows and makes the same Worker calls regardless of which repo's runner executes it. Therefore:

- **Supabase — NEUTRAL.** Ingestion/enrichment/publish touch identical rows whether the runner is public or
  private. The public/private location does not change Supabase egress, storage, or request counts by one byte.
- **Cloudflare app Worker (`covered-opennext-proof`) + Workers Builds — NEUTRAL.** End-user/app traffic is
  unchanged. Workers Builds runs on **code push**, not on the recurring schedule, so cadence doesn't touch it.
- **Cloudflare `scoring-engine` Worker — small NEW load, trivial.** Invoked once/a few times per scheduled run.
  At a ~20-min game-window cadence (~tens of runs/day) that is on the order of a few hundred requests/day —
  negligible against the Workers free tier of **100,000 requests/day**. (Per-invocation CPU must be confirmed
  within the free-tier CPU limit, but the Worker already exists and is sized for batch scoring.)

**Verdict:** the location shift does **not** negatively impact Supabase or Cloudflare free limits.

## The real lever to keep disciplined (independent of the shift)
Free GitHub minutes remove the *minute-cost* brake, but **not** the need to respect Supabase egress
(free tier ~5 GB/mo) and Cloudflare limits. Those are driven by run **frequency** and **per-run data volume**,
which are unchanged by the location shift and are a separate decision. So:
- Cadence stays governed by freshness need + Supabase egress budget (~20-min during game windows, game-window
  gated, no overnight work) — **NOT** by "minutes are now free."
- Keep `KNOWLEDGE_LOW_EGRESS_MODE=TRUE` and the snapshot-first architecture (public routes read one compact
  cached snapshot, not raw tables).
- Shared SharpAPI concurrency across public + private so the shared key is never double-pulled.

## Security tradeoff (accepted, must be configured correctly)
Running ingestion/enrichment from the public repo requires the Supabase **service-role key** and **SharpAPI key**
in the PUBLIC repo's Actions secrets. Safe only with: scheduled/dispatch-only triggers, no `pull_request_target`,
manual dispatch restricted to trusted actors, least-privilege `permissions`, standard GitHub-hosted runners.

## Still to validate (deferred read-only scoping pass)
1. Which pipeline stages (esp. `lib/knowledge/sharp-matching.ts`, `lib/knowledge/matching.ts`) are public-safe
   vs. private-coupled — determines how close to 100% public minutes is achievable, and whether matching must
   move behind the Worker boundary or stay as a small private job.
2. Quantitative per-run Supabase egress and `scoring-engine` Worker CPU/request volume against current baselines,
   to confirm the enabled cadence stays inside the Supabase 5 GB/mo and Cloudflare Workers free tiers.

## Update (session 17): Candidate F resolves the split without reclassification
Verified that **Candidate F** — a public-repo workflow that checks out the private repo at runtime (read-only
credential) and runs the existing pipeline on a public-billed runner — is **VIABLE WITH REQUIRED SECURITY
GATES**. GitHub bills Actions to the repo owning the run, so 100% of production minutes bill to the PUBLIC repo
(free) with **zero private-repo minutes**; private SOURCE never enters the public repo/export/artifacts/caches
(only ephemeral runner disk). This makes reclassifying ingestion/matching/enrichment **unnecessary** and reuses
the current pipeline unchanged. Trade-off: public-repo Actions logs are world-readable and the production
service-role key would live in the public repo's (main-restricted) Environment secrets. Full gate list +
implementation scope: `docs/AGENT_HANDOFF.md` "Session 17".

## Update (session 37): bounded pre-score enrichment added to the recurring pipeline
The recurring pipeline now runs a bounded background-enrichment stage before scoring (Session 37 in
`docs/AGENT_HANDOFF.md`). Recurring-cost impact, measured/verified:
- **WNBA** downloads three whole-season SportsDataverse parquet files (~343 KB total, from GitHub's raw CDN —
  free inbound to Actions, not Supabase egress) ONLY on runs where a referenced team has a completed game newer
  than the newest already-logged game. Steady-state runs skip the download (and the matchup recompute) entirely,
  so the added per-run cost is ~3 bounded read queries (<1 s) except on the ~once-daily catch-up.
- **MLB** external calls stay bounded: only lineups + weather hit providers, both freshness-skipped and per-run
  capped; the other four substages are Supabase-only compute with rotating-window write caps. No historical work.
This keeps the enabled cadence inside the SharpAPI rate limit, Supabase 5 GB/mo egress, and Cloudflare/Actions
free tiers. `COVERED_PRIVATE_PIPELINE_SHA` is NOT yet advanced to the new commits; promotion is owner-gated
(see the Session 37 promotion/rollback plan).

## Update (session 39): ZSTD decode makes the WNBA SDV path actually usable
The session-37 stale-only download bounds are unchanged, but session 38's live proof showed the WNBA
SportsDataverse ingestion could not parse the ZSTD-compressed parquet files in the GitHub Actions runtime
(hyparquet supports only UNCOMPRESSED/SNAPPY). Candidate `c4e8e47` adds `hyparquet-compressors` (pure-JS, no
native binary) so the ~343 KB stale-only download now actually decodes and advances the watermark, instead of
re-downloading and re-failing every run. Recurring-cost profile is otherwise unchanged (stale-only download +
freshness-gated matchup recompute). Production remains pinned to the known-good rollback SHA `3087979d…`;
promotion of `c4e8e47` is owner-gated.
