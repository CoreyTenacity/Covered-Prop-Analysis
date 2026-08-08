# Cloudflare → GitHub production dispatcher — activation package

Status: repository-complete candidate only. No Worker, D1 database, secret, public workflow patch, private pin, or Cron Trigger has been activated by this package.

## Why this exists

GitHub created no workflow record for confirmed WNBA-only cron points (`23:20Z`, `23:40Z`, `00:00Z`) despite creating intervening MLB records. The first replacement heartbeat also produced no record at two consecutive confirmed points (`2026-08-03T02:27Z` and `02:47Z`). Covered cannot run before GitHub creates a record, so GitHub cron is unsuitable for the required WNBA freshness path. Do not test more GitHub cron expressions.

The candidate replaces GitHub as the *clock only*: one route-less Cloudflare scheduled Worker creates one authenticated `repository_dispatch` request. GitHub Actions remains the only place the private checkout and production pipeline execute.

## Components and trust boundaries

`workers/covered-github-dispatcher/` contains a standalone Worker with only a `scheduled()` handler. `workers_dev` is `false`; it has no `fetch()` handler, public route, Supabase binding, provider integration, scoring code, browser traffic, or OpenNext dependency.

The dispatcher creates `covered-production-heartbeat` with the fixed, non-sensitive payload:

```json
{
  "event_type": "covered-production-heartbeat",
  "client_payload": {
    "schema": "covered-production-heartbeat/v1",
    "source": "cloudflare-cron",
    "slot": "2026-08-03T02:47Z",
    "delivery_key": "covered:2026-08-03T02:47Z"
  }
}
```

It makes exactly one physical GitHub dispatch attempt per claimed slot, uses a 4-second abort timeout, and keeps the JSON body below 512 bytes. A timeout, rate limit, 4xx, 5xx, or lost response is terminal for that slot: no automatic replay is safe because GitHub might already have accepted it. The next bounded slot is the recovery path.

## Idempotency and telemetry

Cloudflare KV is not suitable because it cannot provide an atomic conditional claim. A dedicated free D1 database is required for one SQL `INSERT ... ON CONFLICT DO NOTHING` claim per slot. The 35-day retention field is telemetry retention only; it never reopens a claimed key. This prevents duplicate delivery across retries, delayed invocation, worker restarts, and midnight rollover. `schema.sql` is owner-applied only at activation; it is not a Supabase migration and this repository change did not provision it.

The Worker calls `controller.noRetry()` and logs only `{ component, state, slot, httpStatus? }`. It never logs the token, headers, payload body, provider output, or private checkout data. The D1 ledger records `claimed`, `accepted`, `rejected`, or `ambiguous` plus the safe GitHub request ID/status when available. A `204` confirms GitHub accepted the event, not that a workflow record was created; GitHub Actions history is the second required observation point.

The public candidate patch emits one safe Actions notice containing the accepted slot. This gives a bounded free observability chain:

```text
Cloudflare scheduled log / D1 slot → GitHub 204 → Actions run event=repository_dispatch → workflow notice → verified private checkout
```

## Credential

Use a **fine-grained GitHub PAT**, restricted to `CoreyTenacity/Covered-Prop-Analysis` only, with the minimum API-required permission: **Contents: write**. GitHub documents that this permission is required for `POST /repos/{owner}/{repo}/dispatches`; no private-repository access, Actions administration, environment, workflow-write, or organization scope is required. Store it only as the Cloudflare Worker secret named:

```text
COVERED_GITHUB_REPOSITORY_DISPATCH_TOKEN
```

Set a 30-day expiration and rotate before expiry. A GitHub App could also constrain installation scope, but would require an App private key, app ID, token minting request, and a second secret/API path; it is not the smallest bounded dispatcher. A compromised PAT can write contents in the one public repository because GitHub requires that permission for repository dispatch; the one-repo restriction, short expiry, Cloudflare secret storage, absent public route, and no private credentials bound to this Worker limit the blast radius.

## Public workflow candidate

`docs/candidate-f/covered-production-pipeline-repository-dispatch.yml` is generated from public baseline `fe9fc4f3db97dbe3ab0ace083c9261143e820e09`. Its paired `.patch` is the exact transition.

It removes both `schedule` entries, adds only `repository_dispatch.types: [covered-production-heartbeat]`, validates the fixed event/schema/source/UTC-minute/delivery-key contract, and rejects every other event/payload. It cannot accept an arbitrary league, command, stage, timeout, or private SHA. Manual dispatch and bounded maintenance remain unchanged. It preserves the 25-minute timeout, shared concurrency group, scheduler kill switch, WNBA enable control, private V2 validation/checkout, secret handling, and one shared Sharp maximum of eight.

It forwards `--schedulerHeartbeat true --slot <validated UTC minute> --league auto --wnbaEnabled <control>`. The private CLI recognizes this only for `repository_dispatch`, uses the existing resolver for the supplied slot, runs WNBA before MLB during overlap, and still passes pipeline `triggerType: "manual"`. Therefore Policy C remains inactive and no scheduled-only behavior is accidentally enabled.

## Scheduler and resource model

Activation cron: `7,27,47 16-23,0-4 * * *` (UTC), the union operating window only.

| Item | Old separate GitHub cron | Failed GitHub heartbeat | Cloudflare dispatcher candidate |
| --- | ---: | ---: | ---: |
| Opportunities/day | 60 | 39 | 39 |
| Opportunities/30-day month | ~1,800 | ~1,170 | ~1,170 |
| GitHub dispatch API requests/day | 0 | 0 | 39 normal; never >1/slot |
| D1 writes/day | 0 | 0 | ~78 normal (claim + terminal status) |
| Supabase/provider/browser/Vercel work in dispatcher | 0 | 0 | 0 |

Cloudflare's current published Workers Free limits include 100,000 requests/day, 10 ms CPU/invocation, 50 subrequests/invocation, and five Cron Triggers/account. Current D1 Free included limits are 5 million rows read/day, 100,000 rows written/day, and 5 GB stored data. This dispatcher needs at most three subrequests per active slot (claim, dispatch, status), about 78 writes/day normally, and negligible storage (~14,235 slot rows/year before owner-managed retention). GitHub Actions still receives up to 39 runs/day and retains its existing 25-minute hard timeout; worst case is 1,170 runs/month × 25 minutes, while actual billed runtime must be observed during proof. The dispatcher itself adds no Supabase egress, Vercel CPU, browser egress, or provider calls.

Account-specific Cloudflare resources could not be read in this repository session because Wrangler is unauthenticated and no `CLOUDFLARE_API_TOKEN` is configured locally. Repository evidence shows the existing `covered-opennext-proof` app Worker is deployed through Cloudflare Workers Builds and has no cron handler. Activation must verify the account remains on a free plan and has an available Worker/Cron/D1 allocation before provisioning.

## Owner-only activation and rollback

### Activation — no overlap

1. Re-verify public baseline, live rollback controls, zero executable production runs, and D1/Workers Free allocation.
2. Push the verified private candidate; change only V2 to that candidate while the old public explicit-league workflow remains active. Verify an explicit-league invocation remains compatible.
3. Merge the public repository-dispatch candidate. This **removes GitHub cron first**, creating a safe zero-scheduler interval; Cloudflare remains undeployed/inactive.
4. Create the dedicated free D1 database, apply `schema.sql`, set only `COVERED_GITHUB_REPOSITORY_DISPATCH_TOKEN`, deploy the Worker with default `crons: []`/`enabled=false`, and verify no public route exists.
5. Deploy only `wrangler.activation.jsonc` after replacing its owner placeholder with the real D1 ID. This creates the single Cloudflare Cron Trigger and sets the exact kill switch true. Allow Cloudflare's documented trigger propagation window before proof.
6. Observe no more than three qualifying natural WNBA slots. Never use `workflow_dispatch`.

### Rollback — public/private ordering preserved

1. Disable the Cloudflare Worker with `crons: []` and `COVERED_GITHUB_DISPATCHER_ENABLED=false`; verify trigger removal has propagated. Do not delete D1 rows or logs.
2. Restore public workflow baseline `fe9fc4f3db97dbe3ab0ace083c9261143e820e09` and verify its explicit-league cron workflow is active.
3. Restore V2 to `933ae62fabc2f8d50adf0e084d422c7d7db47181` and verify read-back.

At no point may Cloudflare Cron and public GitHub `schedule` both be active.

## Natural WNBA proof

Maximum proof: three qualifying WNBA heartbeat cycles (normally 40 minutes across `:07/:27/:47`, plus bounded GitHub/Cloudflare propagation allowance; stop after 90 minutes). Roll back immediately if two consecutive Cloudflare-triggered slots lack a GitHub workflow record, a wrong private SHA executes, payload resolution is wrong, Policy C activates, shared Sharp requests exceed eight, WNBA injury/marker integrity fails, incomplete/unversioned scores reach a public surface, bounds are exceeded, or no complete strict-v1 WNBA prop exists after cycle three.

The existing WNBA criteria remain unchanged: valid both-team injury markers, logs → features/minutes/matchup convergence, strict-v1 scoring/snapshot provenance, one complete natural WNBA prop by cycle three, Manual Analyzer/API/UI behavior, and MLB incomplete-score containment. A sub-70 WNBA prop is sufficient; never manufacture or lower a Covered Pick.

### Monitoring commands after activation

```bash
gh run list -R CoreyTenacity/Covered-Prop-Analysis --workflow "Covered Production Pipeline" --limit 20
gh run view <run-id> -R CoreyTenacity/Covered-Prop-Analysis --log
wrangler d1 execute covered-dispatch-ledger --remote --command "SELECT slot_key,status,http_status,github_request_id,updated_at FROM covered_dispatch_slots ORDER BY slot_key DESC LIMIT 20"
```

The first command proves GitHub created a `repository_dispatch` run. The second proves validated slot, WNBA-first resolution, private SHA, caps, and pipeline stages. The third proves Cloudflare ran and whether GitHub accepted the dispatch. None should expose a token or private data.
