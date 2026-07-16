# Covered

Covered is a sports prop analysis application. It ingests betting-market prop data, resolves it
against durable player/team/event knowledge, scores it, and serves a curated board of props
through a small set of read-oriented API routes and pages.

This repository is a **deterministically-generated public export** of the private working
repository. It is intended to let the owner and interested readers inspect the application's
architecture, public-facing API surface, and general approach. It is **not** the full private
codebase — see "What is intentionally excluded" below.

## What's here

- **Sports currently supported**: MLB and WNBA. NBA, NFL, and Tennis are registry-known in the
  code but are not currently enabled for live production orchestration.
- **Public reads**: `covered-picks`, `parlay-options`, and `model-performance` are served from a
  pre-computed, versioned snapshot (`app/api/knowledge/*`) rather than by querying live data on
  every request.

## High-level architecture

- **Next.js** (App Router) is the frontend and API route layer.
- **Supabase** (Postgres + PostgREST) is the persistence layer — the normalized source of truth
  for players, teams, events, props, scores, and cached snapshots.
- **GitHub Actions** runs the bounded ingestion/enrichment/scoring jobs and repo-native
  validation. Recurring scheduling is disabled by default and requires explicit, deliberate
  configuration to enable (see "Safety" below).
- **Snapshot-first public reads**: the public API routes read a versioned snapshot from
  `provider_cache` rather than recomputing results per request, keeping read-path egress and
  compute low.
- **Cloudflare Workers via OpenNext** is the current deployment target for the application
  itself (`pnpm run cf:build`).

## What is intentionally excluded from this export

This export deliberately omits the proprietary scoring engine, the tuned per-sport scoring
adapters, the Sharp-odds identity-matching/ingestion pipeline, the GitHub Actions pipeline
orchestrator, and a small number of other private-only modules and their paired tests. Generic
plumbing, provider-adapter shape, UI, and the public read API are included. The exact, current
exclusion list is produced deterministically by this repository's own export tooling
(`scripts/public-export.mjs`) from `docs/public-repo-boundary.json` — nothing here should be
assumed complete or authoritative from the private repository's perspective.

**No production credentials, `.env`/`.dev.vars` files, or private operational tooling
(the private job-orchestration CLI, the scoring engine, the Sharp-matching pipeline) are
included in this export.**

## Local development

### Prerequisites

- Node.js 22
- [pnpm](https://pnpm.io/) (see `packageManager` in `package.json` for the exact pinned version)
- A Supabase project (for any command that touches persistence)

### Install

```bash
pnpm install
```

### Environment configuration

Copy `.env.public.example` to `.env.local` and fill in the values you need. At minimum, the
Supabase variables are required for anything that reads or writes persisted data. Every other
variable is optional and only matters if you're exercising the corresponding provider adapter.
See the comments in `.env.public.example` for which is which.

### Development server

```bash
pnpm run dev
```

### Typecheck

```bash
pnpm exec tsc --noEmit
```

### Tests

```bash
pnpm test
```

### Next.js build

```bash
pnpm run build
```

### Cloudflare / OpenNext build

```bash
pnpm run cf:build
```

## Safety: live jobs, scheduling, and publication

This export includes the GitHub Actions workflow definitions used by the private repository, for
transparency. If you fork or adapt this repository:

- **Recurring scheduling is disabled by default** and gated behind an explicit repository
  variable. Do not enable it without understanding the provider-call and hosting-cost
  implications.
- **Public snapshot publication requires an explicit, separate opt-in at two levels** (a
  lower-level `publish: true` and a pipeline-level `publishPublicSnapshots: true`) — omitting
  either means no write occurs. Do not wire these to `true` casually.
- **Live provider calls, ingestion, enrichment, scoring, and board-generation jobs** all require
  their own explicit configuration and credentials, and are not something to run casually against
  a real database without understanding their write scope first.

## Repository status

This is a working application under active, iterative development, not a finished or
production-hardened product. Some documentation in `docs/` reflects historical decisions,
audits, and session-by-session engineering notes rather than a single polished specification —
`docs/AGENT_HANDOFF.md` is the most current operational record if you want the latest state.

## License

No license is currently granted. This code is publicly viewable for transparency, but you do not
have permission to copy, modify, or redistribute it beyond what applicable law (e.g. reading
public source for personal reference) already allows. If you're interested in a specific use,
reach out to the repository owner.

## Contributions

External contributions are not currently being accepted. Issues and pull requests may not be
reviewed or merged.
