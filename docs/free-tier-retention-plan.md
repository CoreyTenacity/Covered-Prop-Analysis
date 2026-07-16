# Covered free-tier retention plan

This note documents the first recommended cleanup windows for high-growth tables.

It is intentionally documentation-only in this pass.
No destructive pruning is implemented here yet.

## Recommended future retention windows

- `odds_snapshots`
  - Keep raw/high-frequency history for roughly 7–14 days on the free tier.
  - This is the highest-growth table because Sharp-style market polling can create many historical rows.

- `provider_cache`
  - Prune stale rows by provider and cache purpose.
  - Short-lived provider responses should expire aggressively once they are no longer useful.

- `score_inputs`
  - Prefer a recent rolling window or a latest-per-prop strategy if storage pressure grows.
  - These rows are useful for debugging model behavior, but they are not all equally valuable forever.

- `score_explanations`
  - Prefer a recent rolling window or a latest-per-prop strategy if storage pressure grows.
  - This table can grow quickly if scoring is frequent.

- `grading_results`
  - Keep longer than the raw odds/debug tables.
  - If needed later, summarize older grading history into lower-granularity model-performance rollups instead of keeping every high-detail record forever.

## Operational note

Before adding automated pruning on the free tier, prefer:

1. documented retention windows
2. admin-only dry-run cleanup queries
3. row-count monitoring
4. explicit approval before destructive deletes
