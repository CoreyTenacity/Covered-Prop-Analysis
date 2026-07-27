# Enrichment Field Contracts (MLB + WNBA)

The machine-readable source of truth is `lib/knowledge/pipeline/field-contracts.ts`
(`FIELD_CONTRACTS`). This document is the human-readable view. The Phase C
readiness gate consumes the contracts directly, so "which fields must a prop have
before it can be scored" lives in ONE place instead of being implicit in
`scoring-service.ts`.

## Readiness states (owner terminology)

Every active/current prop ends in exactly one state before scoring:

- **`score_ready`** — all hard-required applicable fields present and fresh → valid Covered Score.
- **`score_limited`** — only contract-approved fields are genuinely provider-absent (proven via the absence standard) → valid Covered Score, flagged limited.
- **`score_blocked`** — a hard-required field is missing/stale for a pipeline reason → **no normal valid Covered Score**, not on Covered Picks, flagged in Manual Analyzer, carries exact classified blockers.

## Cause taxonomy

`provider_absent` (proven) vs pipeline failures: `identity_failed`, `ingestion_missing`, `join_failed`, `enrichment_error`, `validation_rejected`, `feature_gen_failed`, `stale`. Only `provider_absent` means the provider truly had nothing.

## Provider-absent proof standard

A field is `provider_absent` **only** with recorded evidence that: (1) identity resolved; (2) every configured/approved source was attempted; (3) each request completed successfully; (4) the correct player/event/team/date was queried; (5) no source returned an applicable value; (6) the field's contract permits absence. A request/parse/stale/join/mapping/format problem is the corresponding pipeline failure, never provider absence. Enforced by `classifyAbsence()` in `boundary-validation.ts`.

## Hard-required fields (block a valid score — same for both sports)

Grounded in the actual publishability blockers in `scoring-service.ts:publishabilityAssessment`:

| Field | Sources (priority → fallback) | Freshness | Absence permitted | Reconciliation |
|---|---|---|---|---|
| player_identity | players → aliases/mappings | — | no | identity |
| participant | participants | — | no | identity |
| team | teams → aliases | — | no | identity |
| opponent | events → teams | — | no | identity |
| event | events → mappings | — | no | identity |
| event_start_time | events → espn/mlb-stats | — | no | ingestion |
| market_stat_type | current_props | — | no | ingestion |
| line | current_props → sharpapi | 12h | no | ingestion |
| direction | current_props | — | no | ingestion |
| recent_game_logs | player_game_logs → SDV/mlb-stats | 3d | yes (proven first-game) | ingestion |
| recent_form_features | player_recent/basketball_player features | 12h | no | features |
| team_context | team_context/team_game_logs | 24h | no | matchup |
| opponent_context | opponent_context/mlb_opponent | 24h | no | matchup |
| matchup_context | matchup_features/opponent_context | 24h | no | matchup |

## Soft inputs (penalize, never block)

| Field | Sport | Applies to | Freshness | Absence permitted (why) |
|---|---|---|---|---|
| sportsbook | both | * | — | yes |
| hit_rate_inputs | both | * | 12h | yes |
| projection_inputs | both | * | 12h | no (penalize) |
| score_explanation_inputs | both | * | — | no (penalize) |
| injury_availability | both | * | 12h | yes (no record ≈ healthy) |
| role_context | both | * | 24h | yes |
| expected_minutes | WNBA | player markets | 24h | yes (role proxy fallback) |
| pace | WNBA | player markets | 24h | no (penalize) |
| basketball_player_features | WNBA | player markets | 12h | no (penalize) |
| wnba_lineup_context | WNBA | player markets | 12h | yes (until lineups posted) |
| opponent_pitcher | MLB | batter markets | 24h | yes (until announced) |
| handedness | MLB | batter+pitcher markets | — | yes |
| handedness_splits | MLB | batter markets | 24h | yes (until pitcher set) |
| weather | MLB | * | 3h | yes (dome venues); a request/parse/write failure is `enrichment_error`, NOT absence |
| ballpark_context | MLB | * | — | yes |
| bullpen_context | MLB | batter markets | 24h | yes |
| mlb_player_features | MLB | batter+pitcher markets | 12h | no (penalize) |

Applicability is explicit: unlisted markets receive only the `*` (all-market) fields. `weather` applies to every MLB market but is MLB-only; `handedness_splits` applies to batter markets only.

## Stored scoring provenance

Each valid score persists (`ScoringProvenance` in `provenance.ts`): runId, scoring model version, contract version, feature timestamp, per-source freshness timestamps, completeness state, allowed provider-absent fields, blockers, scoring timestamp. Historical grading stays bound to the model + contract + feature versions that existed when the pick was published — new features never silently reinterpret old picks.

## Boundary validation

Before data enters the pipeline or hits the DB (`boundary-validation.ts`): required-column checks (missing → `ingestion_missing`), id-type validation (INT32 number / INT64 bigint / non-empty string), date-format validation, and write-shape validation against NOT NULL columns (catches the `mlb_weather.game_id: null` / 23502 class before the DB does). Codec support is handled at parse time via `hyparquet-compressors`.
