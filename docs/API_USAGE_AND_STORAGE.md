# Covered. API usage and storage map

## The rule that protects every quota

Third-party sports APIs are called only by scheduled server jobs. Browser visits, refreshes, filters, manual selections, and deterministic analysis read one shared cache. Ten users and 10,000 users therefore do not multiply sports-provider usage.

The provider adapters are optional at runtime. When a provider is connected, the server refreshes it into shared cache; when it is missing or unavailable, the board and manual analyzer continue to use mock/local data and consume no sports-provider quota.

## What each product action consumes

| User action | Sports API calls | AI calls | Storage or database activity |
| --- | ---: | ---: | --- |
| Open or refresh Today's Best Opportunities | 0 | 0 | One shared-cache read once Supabase is connected |
| Change the sport filter | 0 | 0 | None; filtering happens in the browser |
| Reveal the next seven props | 0 | 0 | None; those records arrived with the cached top ten |
| Choose sport, player, prop, line, or direction manually | 0 | 0 | None; choices come from a cached catalog |
| Analyze a manually selected slip | 0 | 0 | Deterministic scoring uses cached inputs |
| Build and analyze a manual parlay | 0 sports calls | 0 by default; optional text explanations only when requested | No uploaded file is retained |
| Save a pick or update its result | 0 | 0 | Currently local browser storage; later one small Supabase write |
| View history or performance | 0 | 0 | Local read now; later cached Supabase reads |
| Scheduled board refresh | Yes | 0 | Server writes one shared normalized snapshot |
| Scheduled result grading | Only the selected result provider, plus a safe local fallback when actual values are already stored | 0 | Reads persisted picks and writes final results once |

The production Vercel deployment currently uses one daily cron job that refreshes the board and then grades any saved picks that can be finalized from verified provider data or already stored actual values.

**Manual betting-odds selection does not spend any API quota.** It also does not cause a background refresh. The future dropdown catalog will be refreshed centrally on a schedule and shared by everyone.

## Provider access plan

| Provider | What Covered. uses it for | Access and trigger | Initial safety limit |
| --- | --- | --- | --- |
| The Odds API | Consensus/DFS lines for MLB, WNBA, NBA, and NFL | Server-side scheduled calls only | 500 monthly credits. Basic featured-market odds can cost per sport/market/region, but player props are event-specific and cost per event × market × region. Covered. must preflight that true cost and stay within the daily/monthly ledger. |
| SportsGameOdds | Secondary odds/event coverage for MLB, WNBA, NBA, NFL, plus primary tennis props when configured | Server-side v2 requests; usage is charged by events/objects returned | Disabled at `0` objects/day until the account's actual allowance is entered; then batch narrowly and check its account-usage endpoint |
| SharpAPI sports API | Secondary pre-match odds coverage | Server sends `X-API-Key`; scheduled and cached | No app-side daily cap by default; the free-plan 12 requests/minute is a burst ceiling, not a refresh target |
| Highlightly | MLB injury/stat data available to the subscribed endpoints | Server-only scheduled refresh | Hard stop at 80 of the published 100 daily requests |
| MLB Stats API | Official MLB game logs and deeper stat context | Server-side on-demand lookups plus shared cache | No API key; cache aggressively |
| nba_api / NBA.com | Official NBA player logs and stats | Server-side on-demand lookups plus shared cache | No API key; WNBA support remains unverified |
| Official NBA/NFL injury pages | Best-effort injury context for NBA/WNBA/NFL when machine-readable URLs are configured | Server-only scheduled refresh | Zero-cost optional enrichment; cache and skip if the source is unavailable |
| API-Sports | Supported schedules, injuries, and stats | Server-only scheduled refresh | Hard stop at 80 of the published 100 daily requests |
| Big Balls Data | Supported NBA and other available data | Server-only scheduled refresh | Hard stop at 800 of the published 1,000 daily requests |
| Open-Meteo | MLB/NFL weather context | Scheduled by venue/time and cached | No key; call only when a forecast window changes, not per visitor |
| OpenRouter | Optional wording for explanations | User-triggered explanation requests only | Free-model availability can vary; use only when the user explicitly asks for AI wording |
| Supabase | Shared provider cache, saved picks, results, and calibration | Database reads/writes, not a sports-data call | Free plan currently provides 500 MB database and 1 GB file storage; alert and prune well before those limits |

SportsGameOdds and SharpAPI overlap with The Odds API. Connecting their keys will not automatically make all three run. The refresh job should query the minimum provider set needed for coverage, deduplicate matching markets, and use fallbacks only when primary data is missing or stale. Manual slip selection never triggers a sports-provider request; it only reads already-cached catalogs and deterministic scoring inputs. Official injury pages and official stat lookups are optional enrichment only; if they fail, the board keeps running with lower context confidence instead of stopping the refresh.

## Storage and retention

- Store normalized prop records, not entire repeated provider responses.
- Replace current-board snapshots as odds change; retain only useful line movement, source, and retrieval timestamps.
- Delete raw cache payloads after 30 days. Keep compact saved-pick outcomes and calibration records longer because they are small and useful.
- Do not retain uploaded files by default. Persist only the manually saved parlay or pick records.
- Cache final game results for long periods and recheck only during a short correction window.
- Track daily and monthly provider usage centrally. Stop at each hard budget and serve the last snapshot with a stale-data timestamp.
- Add warnings at 70%, 85%, and 95% of quota or storage. At 100%, never make the call.

## Board-size rule

Every filter returns at most ten opportunities: the top three featured props followed by no more than seven additional props, all ordered by Covered Score. Selecting a league changes which cached records are ranked; it does not fetch more records from a provider.

## Odds API cost correction

The initial three-refresh estimate assumed one basic market request for each of five sports. That is not a safe estimate for player props: the provider documents props through its event-specific odds endpoint, with quota cost determined by requested markets and regions for every event. The adapter therefore discovers events first (the documented events endpoint is zero-credit), estimates the prop cost, and must reserve that cost before requesting any prop payload. No live prop refresh is enabled until this reservation flow is connected to the monthly ledger.

Last Deployment Connection Check: July 4, 2026
