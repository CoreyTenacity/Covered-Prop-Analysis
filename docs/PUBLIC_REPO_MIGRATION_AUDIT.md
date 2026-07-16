# Public-Repo Migration Audit — 2026-07-15

> ⚠️ **Historical audit. Read `docs/AGENT_HANDOFF.md` → "Public-repo readiness" first for the current
> verdict and exclusion table.** The findings below are retained for provenance and are superseded where
> explicitly marked. The current verdict is **NO-GO pending dependency closure**.
> - `adapters/base.ts` — **PUBLIC-SAFE in the current tree** (its label fns' inputs AND outputs are all published
>   on every board row, so the source reveals nothing observation doesn't). The private residue was split
>   into `adapters/scoring-internals.ts`, which has **zero importers outside the private boundary**.
> - `parlay-analysis.ts` — **resolved**; logic moved to `scoring-engine/`, file now has 0 runtime exports.
> - `lib/slips/analyzer.ts` — **no longer exists** (Slip Analyzer removed); the third-importer finding below
>   is obsolete.
> - **`covered-score.ts` is now PUBLIC-SAFE** — it contains only score contracts, generic edge math, and
>   the published label mapping. The tuned implementation is in `scoring-engine/src/score-opportunities.ts`.
> The handoff is the authoritative current verdict and exclusion list; the historical inventory below is
> retained for provenance. Do not use the older tables below as an independent current exclusion list.


This document records the original audit only. Subsequent controlled repair work is tracked in Git history;
this document does not authorize pushes, merges, deployments, scheduler changes, provider runs, production
writes, backfills, paid-service decisions, or history rewriting.

The historical `lib/providers/request-policy.ts` borderline finding is superseded by local repair commit
`c357ffe`: `lib/providers/provider-contracts.ts` now contains the public provider identifiers, statuses, and
display labels, while private budget, cadence, rate-limit, request-limit, cost, and operational policy remain in
`request-policy.ts`. The current classification and unresolved importer closure are defined by
`docs/AGENT_HANDOFF.md` and `docs/public-repo-boundary.json`.

**A note on this document's own handling:** per the task's instruction, no actual formula values, tuned
constants, prompt text, or threshold numbers are reproduced below — only file paths, descriptions, and
structural findings. If this document itself ends up somewhere less guarded than the repo, it should not by
itself leak the sensitive content it's cataloguing.

---

## 1. Secret-sauce inventory (Task 1)

Confirmed real paths by reading the files directly, not assumed from memory or prior sessions.

### Definitely secret

| File | What it is | Why it's sensitive |
|---|---|---|
| `lib/scoring/covered-score.ts` | **SUPERSEDED classification:** current tree contains public contracts, generic edge math, and published label mapping only | The tuned scorer now resides behind the private Worker. See the current handoff table. |
| `lib/knowledge/scoring-service.ts` | The production scoring orchestrator (`scoreCurrentProps`), invoked from the GitHub Actions pipeline | Contains the exact publishability gate — the specific match-confidence threshold and match-status set that decide whether a scored prop is allowed onto the public board — plus the rescoring/staleness decision logic. |
| `lib/knowledge/adapters/basketball.ts` | The real WNBA/NBA scoring adapter | Full projection model (recent-form/minutes/usage/pace blending) and the edge/matchup/market/confidence scoring formulas with their tuned coefficients. The most detailed and most "secret sauce" file in the repo. |
| `lib/knowledge/adapters/mlb.ts` | The real MLB scoring adapter | Same category as `basketball.ts`, MLB-specific projection and scoring formula. |
| `lib/knowledge/adapters/base.ts` | **SUPERSEDED classification:** public-safe contracts, generic helpers, and published label mappings | The private-only helper was moved to `adapters/scoring-internals.ts`. The current file is not an exclusion candidate. |

### Borderline

| File | What it is | Why it's borderline |
|---|---|---|
| `lib/knowledge/sharp-matching.ts` (largest single file touched by this audit) | Real-time identity-resolution engine matching incoming Sharp API odds data to internal player/team/event records | Substantial proprietary heuristics (name normalization, participant-type inference, match-quality flag construction, multi-field ID extraction) — this is real data-quality engineering effort, not a thin API wrapper, but it's about *cleaning messy input data* rather than *encoding scoring judgment*. |
| `lib/knowledge/matching.ts` | A second, parallel/earlier identity-matching module with similar heuristics to `sharp-matching.ts` | Same reasoning as above. Worth noting two matching modules exist side by side. |
| `lib/knowledge/parlay-analysis.ts` | Parlay leg/combination risk-warning logic (e.g., flags on a selected combination of legs) | Real analytical judgment about parlay risk, not pure plumbing. **Important: this file is different from the others — see the client-exposure finding below.** |
| `lib/scoring/explanations.ts` | Deterministic (non-AI) template logic that assembles "why it made the board" text from factor labels | Reveals the internal factor/label vocabulary and how it's stitched into prose, but not the underlying numeric formula. |
| `lib/ai/explanation-adapter.ts` | Contains a hardcoded LLM prompt template (persona, tone instructions, and score-band-conditional framing) used to generate AI board explanations, plus a deterministic fallback | The prompt engineering itself is differentiated product voice/IP, distinct from the scoring math — describing it here without quoting it, per the task's instruction. |
| `lib/providers/request-policy.ts` | Per-provider budget/rate/reserve constants (daily/monthly spend limits, request spacing) | Reveals operational cost strategy and how aggressively each data provider is used — lower sensitivity than scoring logic, but still non-generic competitive information. |

### Probably fine to expose

| File | What it is |
|---|---|
| `lib/knowledge/adapters/nfl.ts`, `lib/knowledge/adapters/tennis.ts` | Verified by reading in full: pure placeholder stubs that always return a zero score / "Avoid" recommendation. No real logic. |
| `lib/knowledge/adapters/index.ts` | Trivial adapter-registry routing (a lookup by league ID). No judgment logic. |
| `lib/knowledge/sharp-pull-config.ts` | Ingestion cadence/rate-limit configuration (which pull configs are due, request spacing) — operational plumbing, same category as `request-policy.ts` but even more mechanical. |

### Two findings that change the risk picture, not just the inventory

**1. `lib/scoring/covered-score.ts`'s constants are bundled for the browser — but the code that bundles them is dead.**
`components/opportunities/opportunity-card.tsx` is a `"use client"` component that imports both the tuned
weight constants and the scoring function directly from `covered-score.ts` — meaning if this component were
ever rendered, its full module (constants included) would ship in the client-side JS bundle, extractable by
anyone visiting the site, independent of repo visibility entirely. I traced its actual reachability: **zero
files anywhere in the repository import `OpportunityBoard` (the only renderer of this card) from any `app/`
route.** It is orphaned dead code, not part of the current build's route tree, so it is not actually present
in the live production bundle today. This is a **latent risk, not a confirmed current leak** — but it means
the file is one accidental re-wiring away from silently shipping the formula to every browser, regardless of
what happens with the repo. Worth removing or at least flagging independent of the public-repo decision.

**2. `lib/knowledge/parlay-analysis.ts` is genuinely, currently client-exposed — this is not dead code.**
Unlike the above, `parlay-analysis.ts` is imported directly into `components/knowledge/parlay-builder-shell.tsx`
(a `"use client"` component), which is rendered by the live `/slip-analyzer` route (confirmed the route file
exists and is reachable). So this file's logic is **already shipped in the current production JS bundle
today**, regardless of what the git repo's visibility is. Making the repo public would expose the *source* of
an already-exposed *compiled* logic — a smaller incremental risk than the other items in this table, since a
determined party could already reverse-engineer it from the deployed bundle.

### One unrelated hygiene finding surfaced during this audit

`lib/ops/github-actions-pipeline 2.ts` is a **tracked, committed** stray duplicate file (commit message
literally "Create github-actions-pipeline 2.ts" — a macOS/sync-tool duplicate-paste accident, not intentional).
It's a stale, 816-line-divergent snapshot of `github-actions-pipeline.ts` from an earlier point in that file's
history. I checked its imports — it does not contain any scoring/adapter internals, only earlier-version
pipeline orchestration code, so it's not a new item for the secret-sauce inventory. But it's dead clutter in
the current tree that would ship into a public repo as-is, and is confusing if anyone reads it thinking it's
current. Worth deleting regardless of the public/private decision.

---

## 2. Git history exposure findings (Task 2)

Checked every file in the Task 1 inventory with `git log --all --follow` — including files not currently
reachable from any route (the dead-code case above) to see if their *source* has ever been committed.

**Result: 100% of the Task 1 inventory has git history. Zero files are "clean" (never committed).**

| File | Commits touching it | First commit | Most recent commit |
|---|---|---|---|
| `lib/scoring/covered-score.ts` | 5 | `904c18f` (Initial commit) | most recent adapter-label fix |
| `lib/knowledge/scoring-service.ts` | 18 | `0109cf0` ("Complete Overhaul") | WNBA freshness hardening |
| `lib/knowledge/adapters/basketball.ts` | 2 | `0109cf0` | minor change |
| `lib/knowledge/adapters/mlb.ts` | 2 | `0109cf0` | minor change |
| `lib/knowledge/adapters/base.ts` | 1 | `0109cf0` | (same commit) |
| `lib/knowledge/adapters/nfl.ts`, `tennis.ts`, `index.ts` | 1 each | `0109cf0` | (same commit) |
| `lib/knowledge/sharp-matching.ts` | 13 | `0109cf0` | type-fix commit |
| `lib/knowledge/matching.ts` | 1 | `0109cf0` | (same commit) |
| `lib/knowledge/parlay-analysis.ts` | 2 | `0109cf0` | "score work" |
| `lib/scoring/explanations.ts` | 5 | `904c18f` (Initial commit) | provider update |
| `lib/ai/explanation-adapter.ts` | 9 | `f765e5c` ("Add controlled AI explanation adapter") | Slip Analyzer removal |
| `lib/providers/request-policy.ts` | 16 | `904c18f` (Initial commit) | enrichment-safety change |
| `lib/knowledge/sharp-pull-config.ts` | 6 | `0109cf0` | cache-namespace versioning |
| `components/opportunities/opportunity-card.tsx` | 16 | `904c18f` (Initial commit) | type-widening refactor |
| `components/opportunities/opportunity-board.tsx` | 24 | `904c18f` (Initial commit) | board-snapshot change |

Some files (e.g. `basketball.ts`, `sharp-matching.ts`) show their earliest history at `0109cf0` ("Complete
Overhaul") rather than the true initial commit — that commit message suggests a prior squash/history-flatten
event already happened once in this repo's life. That doesn't change the conclusion: **as of today, every one
of these files is present in git history and would need explicit exclusion, not scrubbing of something already
absent.**

**This determines the Task 4 recommendation directly: since nothing is clean, there is no "mostly clean, just
scrub a few commits" scenario available. A rewrite-in-place would need to touch every commit that ever
touched any of these ~15 files, across the entire commit graph.**

---

## 3. Hardcoded-secret findings (Task 3)

**Result: no hardcoded real credentials found, in the current working tree or anywhere in full git history,
across every pattern and location checked.** No urgent rotation action is needed based on this audit.

What was checked:

- **Current tracked `.env`-style files**: only `.env.example` and `.dev.vars.example` are tracked. Both
  read in full — every credential field is a bare `KEY=` with no value; only non-secret operational defaults
  (budget numbers, base URLs, model names) are populated, which is expected and correct for an example file.
- **`.dev.vars` itself** (the file that holds real local development credentials): confirmed **not tracked**
  by git (absent from `git ls-files`), and `.gitignore` correctly covers `.env*` and `.dev.vars` (with
  `.env.example` explicitly un-ignored, which is intentional and correct).
- **Supabase key patterns** (`sb_secret_...`, `sb_publishable_...`, JWT-shaped service-role tokens): zero
  matches in the current tree; zero matches across the full diff content of every commit in the repo's
  history.
- **Cloudflare API token pattern** and **GitHub personal-access-token patterns** (`ghp_`, `gho_`,
  `github_pat_`): zero matches, current tree and full history.
- **Test fixtures/mocks**: no fixture or mock directory currently exists in the repo at all (a prior mock
  data file was deleted in an earlier session, and was never committed to git history either way).
- **Hardcoded `Bearer <token>` strings in test files**: zero matches.
- **Generic sweep** for any `*_KEY`/`*_SECRET`/`*_TOKEN`/`*_PASSWORD` variable assigned a real-looking
  25+ character value in a non-example, non-lockfile tracked file: zero matches.
- **The ntfy.sh deploy-notification topic**: confirmed it's referenced only via `${{ vars.NTFY_TOPIC }}` in
  the workflow YAML — the actual topic string is not hardcoded anywhere in a tracked file.
- **`docs/*.md`**: scanned for any of the above key patterns pasted into documentation; zero matches.

**One honest limitation:** several third-party provider keys in this codebase (SharpAPI, TheOddsAPI,
SportsGameOdds, OpenRouter, Big Balls Sports, Highlightly) don't have a distinctive, pattern-matchable prefix
the way Supabase/Cloudflare/GitHub tokens do — my "generic 25+ character high-entropy string" sweep should
catch an accidentally-pasted key for any of these, but I can't rule out a shorter or lower-entropy key format
for one of these providers with the same confidence as the prefixed ones. If any of these providers use short
or predictable-looking keys, a manual spot-check of their specific format would be worth doing separately.

---

## 4. Recommended migration approach (Task 4)

### Recommendation: fresh public repo, clean history.

Not a history rewrite on the current repo. Two reasons, both confirmed by this audit rather than assumed:

1. **Task 2 found nothing clean.** Every file in the Task 1 inventory has git history going back to (in most
   cases) the repo's actual initial commit. There's no scenario where "just scrub the recent commits" would
   work — a rewrite would need to touch the entire commit graph.
2. **The current repo has many active branches** (confirmed via the branch list at the start of this session:
   at least `main` plus seven or more `codex/*`, `fix/*`, and `diagnostics/*` branches). Rewriting history in
   place means force-pushing and coordinating every one of those branches, or accepting that they become
   incompatible/orphaned. The task's own framing correctly flagged this as the higher-risk path, and this
   audit's findings don't give a reason to take that risk — a fresh repo avoids it entirely.

### Historical exclusion inventory — superseded by the current handoff table

The list below was the original audit proposal. It is retained for provenance only; current classification,
including conditional importer closure, is defined in `docs/AGENT_HANDOFF.md`.

Every file from the Task 1 "definitely secret" and "borderline" tables, plus their associated test files
(checked directly — most of these have **no** dedicated test file at all, which somewhat reduces the
input/output-revealing-oracle risk described in the task, except for one file that does):

```
scoring-engine/src/score-opportunities.ts
scoring-engine/src/score-opportunities.test.ts <- exact parity and boundary assertions for the tuned scorer
lib/scoring/scoring-service.test.ts      <- exists, but only tests a generic ordering helper, not scoring math
lib/scoring/explanations.ts
lib/knowledge/scoring-service.ts
lib/knowledge/adapters/basketball.ts
lib/knowledge/adapters/mlb.ts
lib/knowledge/adapters/base.ts           <- SUPERSEDED; current tree classifies it public-safe
lib/knowledge/adapters/nfl.ts            <- optional; verified harmless stub, could stay
lib/knowledge/adapters/tennis.ts         <- optional; verified harmless stub, could stay
lib/knowledge/adapters/index.ts          <- optional; trivial routing, could stay
lib/knowledge/sharp-matching.ts
lib/knowledge/matching.ts
lib/knowledge/parlay-analysis.ts         <- SUPERSEDED; current file contains type contracts only
lib/ai/explanation-adapter.ts
lib/ai/explanation-adapter.test.ts
lib/providers/request-policy.ts          <- borderline; team call
lib/providers/request-policy.test.ts
components/opportunities/opportunity-card.tsx   <- dead code; recommend deleting outright, not migrating
components/opportunities/opportunity-board.tsx  <- dead code; recommend deleting outright, not migrating
lib/ops/github-actions-pipeline 2.ts     <- unrelated hygiene issue; delete regardless, don't migrate
```

I verified two earlier candidate test files were **false positives** from an initial pattern search and do
**not** belong on this list: `lib/knowledge/enrichment/basketball.test.ts` (tests data-enrichment jobs, not
the scoring adapter — matched my search only because of the word "basketball") and
`lib/providers/highlightly-mlb.test.ts` (tests an unrelated MLB data provider integration — matched only
because of "mlb"). Precision matters here since an over-broad exclusion list is its own kind of mistake.

### Historical `base.ts` finding — superseded

This section described the pre-refactor tree. It is no longer a current blocker. The current
`lib/knowledge/adapters/base.ts` explicitly contains only public-safe contracts, generic helpers, and
published label mappings; the private helper is in `lib/knowledge/adapters/scoring-internals.ts`.

The historical finding was:

- `lib/knowledge/read-service.ts` — the module that powers the **public** snapshot/read API
  (`getCoveredPicksOfTheDay`, `getParlayOptions`) — directly imports two of `base.ts`'s tuned label functions
  (the confidence-label and risk-label threshold logic) to label its public API responses.
- `read-service.ts` is absolutely not excludable; it's core, unavoidably-public app plumbing.
- So `base.ts` cannot simply move to the excluded set wholesale — doing so would break the live public read
  path.

**Historical recommendation:** before the earlier clean split was possible, `base.ts` needed a small refactor — splitting
it into (a) the pure type contracts and the two label-threshold functions that `read-service.ts` depends on
(these would need to stay in or move to the public repo, meaning their specific thresholds become public
regardless of the migration approach), and (b) everything else (`recommendationForCoveredScore` and the
adapter contract types only consumed by the excluded scoring path), which can move to the excluded set
cleanly. I have not designed or implemented that refactor — flagging it as necessary groundwork, not doing it.

### Confirmed scope: this is a small, mostly-separable slice of the codebase

Measured directly rather than estimated: the full exclusion list above is **21 files, ~6,070 lines**, against
a total tracked codebase of **190 TypeScript/TSX files, ~40,380 lines** — **roughly 15% of lines, 11% of
files.** Excluding the one `base.ts` coupling point above, everything else on the list has zero importers
outside itself and the GitHub-Actions-only pipeline entry point (`scoring-service.ts` is only reached from
`lib/ops/github-actions-pipeline.ts`, which is not part of the live app's request path). **This confirms the
app/pipeline code that would stay in a public repo is not tightly coupled to the scoring internals**, with
the single `base.ts` exception documented above.

---

## 5. What's uncertain or needs a human decision

- **The `base.ts` split is a real, small piece of engineering work, not just a file-move.** Someone needs to
  decide where the extracted `confidenceLabelFor`/`riskLabelFor` functions live in the public repo, and
  confirm the private repo's version stays the source of truth if the thresholds are ever retuned.
- **`nfl.ts`, `tennis.ts`, and `adapters/index.ts` are marked optional-exclude.** They're verified harmless,
  but leaving them in a public repo alongside excluded `basketball.ts`/`mlb.ts` means the `SportAdapter`
  interface shape is visible even if the real implementations aren't — a minor, judgment-call decision, not a
  technical one.
- **`lib/providers/request-policy.ts` was a genuine borderline call in the original audit, but that finding is
  superseded by `c357ffe`.** The private policy remains excluded, and the public-safe provider contract now
  carries only generic identifiers, display names, and status values. Remaining conditional provider importers
  still require closure before any public export.
- **`covered-score.ts`'s dead-code status should probably be resolved before any migration, independent of
  it.** If it's truly unused, deleting `opportunity-card.tsx`/`opportunity-board.tsx` (and, if nothing else
  needs it, `covered-score.ts` itself) removes both the latent client-bundle risk and a chunk of the exclusion
  list's complexity in one move. I have not deleted anything — this needs an explicit decision, since I can't
  be certain there's no future plan to reconnect this component tree.
- **`parlay-analysis.ts`'s already-client-exposed status is worth weighing explicitly when deciding how much
  effort to spend hiding it.** Since its compiled logic is already downloadable from the live app today,
  keeping its *source* out of a public repo adds real but incremental protection, not first-line protection —
  a different risk/effort tradeoff than the server-only files on this list.
- **This audit did not attempt to assess GitHub Actions workflow files, environment variable *names* (as
  opposed to values), or Supabase schema/table names for competitive sensitivity** — the task scoped this
  audit to code-level secret-sauce and hardcoded credentials specifically; workflow/schema-level exposure
  (e.g., whether table names like `basketball_team_context` reveal anything meaningful) wasn't in scope and
  would need a separate pass if that's also a concern before going public.

At the time of the original audit, no files were modified, staged, or committed beyond this output document.
Later controlled repair commits are recorded in Git history and do not change the historical findings above.
