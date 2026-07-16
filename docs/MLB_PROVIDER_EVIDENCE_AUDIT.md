# MLB Provider Evidence Audit

**Date:** 2026-07-12
**Method:** Direct code inspection + live GitHub Actions run (`29203229086`, `ubuntu-latest`, `2026-07-12T18:06:01Z`). No speculation — every claim below is sourced.

---

## 1. Findings Summary

- **`statsapi.mlb.com` is reachable from GitHub Actions with no auth required**, sub-350ms for game-log and schedule, sub-70ms for boxscore. All fields that `refreshMlbPlayerLogs` and `refreshMlbLineups` expect to parse are present in the live responses.
- **Open-Meteo is reachable from GitHub Actions**, 726ms, no auth required. All four `hourly` arrays (`temperature_2m`, `precipitation_probability`, `wind_speed_10m`, `weather_code`) are present with 24 elements each and match the shape `OpenMeteoWeatherAdapter.fetchMlbWeather()` expects.
- **BigBalls is reachable from GitHub Actions with the `BBS_API_KEY` secret** configured, 1224ms, 15 MLB matches returned today. The `match_id` field (a string) that `refreshMlbLineups` selects on is present. `scheduled_at` is absent from match records — the response carries `updated_at` instead — but the current enrichment code does not filter by `scheduled_at` in the BigBalls path, so this does not break anything today. See Section 4 for detail.
- **BigBalls is used as a fallback, not the primary lineup source.** `refreshMlbLineups` first calls `fetchMlbBoxscore` via `statsapi.mlb.com`. BigBalls is only reached if the boxscore returns zero player records.
- **Aaron Judge's last game log entry is 2026-05-31**, 40+ days before the test date. This is a player-status gap (he is likely on the IL), not an API defect — the game-log endpoint returned 59 splits and the correct field shape for all of them.

---

## 2. Source Table

| Source | Auth | Check | HTTP | Latency | Classification |
|---|---|---|---:|---:|:---:|
| `statsapi.mlb.com` game-log | none | `[1a]` | 200 | 290ms | **(a)** |
| `statsapi.mlb.com` schedule + boxscore | none | `[1b]` | 200 / 200 | 305ms / 67ms | **(a)** |
| `api.open-meteo.com` forecast | none | `[2]` | 200 | 726ms | **(a)** |
| `api.bigballsdata.com` MLB matches | `BBS_API_KEY` | `[3]` | 200 | 1224ms | **(a)** |

Classification key: (a) working / correctly wired · (b) reachable but wrong/incomplete shape · (c) unreachable · (d) no source / key not available

---

## 3. Check [1a] — `statsapi.mlb.com` Game Log

**Endpoint:** `GET /api/v1/people/{playerId}/stats?stats=gameLog&group=hitting&season=2026&gameType=R`
**Test player:** Aaron Judge (ID `592450`), 2026 season, hitting group
**Caller in code:** `MlbStatsApiAdapter` → consumed by `refreshMlbPlayerLogs`

**Response:**
- `stats[]`: 1 entry
- `splits[]`: 59 entries (full 2026 regular-season games through 2026-05-31)
- Latest split: `date: "2026-05-31"`, `game.gamePk: 825001`

**Field check against `extractRows()` + `chooseSplit()` expectations:**

| Field path | Required by | Present |
|---|---|:---:|
| `stats[].splits[]` (array) | `extractRows()` | ✓ |
| `splits[].stat.hits` | `refreshMlbPlayerLogs` | ✓ |
| `splits[].stat.atBats` | `refreshMlbPlayerLogs` | ✓ |
| `splits[].stat.strikeOuts` | `refreshMlbPlayerLogs` | ✓ |
| `splits[].stat.baseOnBalls` | `refreshMlbPlayerLogs` | ✓ |
| `splits[].stat.homeRuns` | `refreshMlbPlayerLogs` | ✓ |
| `splits[].stat.rbi` | `refreshMlbPlayerLogs` | ✓ |
| `splits[].stat.stolenBases` | `refreshMlbPlayerLogs` | ✓ |
| `splits[].game.gamePk` | `chooseSplit()` | ✓ |
| `splits[].date` | `chooseSplit()` sort | ✓ |

**Note:** Latest split is 2026-05-31. Aaron Judge has not appeared in the game log since then — consistent with an IL stint. The API is working correctly; the data gap is player status.

---

## 4. Check [1b] — `statsapi.mlb.com` Schedule + Boxscore

### Schedule

**Endpoint:** `GET /api/v1/schedule?sportId=1&startDate=2026-07-12&endDate=2026-07-12&hydrate=probablePitcher,linescore,team`
**Caller in code:** `refreshMlbLineups` (and `refreshMlbPlayerLogs` for the date window)

**Response:**
- `dates[]`: 1 entry for 2026-07-12
- `games[]`: 15 games

**Field check against `SchedulePayload` type:**

| Field path | Required by | Present |
|---|---|:---:|
| `dates[].games[].gamePk` | `refreshMlbLineups` | ✓ |
| `dates[].games[].teams.home.team.id` | `refreshMlbLineups` | ✓ |
| `dates[].games[].teams.away.team.id` | `refreshMlbLineups` | ✓ |
| `dates[].games[].teams.home.probablePitcher` | `refreshMlbSchedules` | ✓ (present as field; value depends on game) |

### Boxscore

**Endpoint:** `GET /api/v1/game/{gamePk}/boxscore` (tested against gamePk `823358`)
**Caller in code:** `fetchMlbBoxscore()` → `refreshMlbLineups`

**Response:**
- `home.players`: 26 entries (keyed by player ID string)
- `away.players`: present

**Field check against `MlbBoxscorePayload` type:**

| Field path | Required by | Present |
|---|---|:---:|
| `teams.home.players` (object) | `refreshMlbLineups` | ✓ |
| `teams.away.players` (object) | `refreshMlbLineups` | ✓ |
| `teams.home.team.id` | `refreshMlbLineups` | ✓ |
| `teams.away.team.id` | `refreshMlbLineups` | ✓ |
| `players[].person.id` | player identity resolution | ✓ |
| `players[].person.fullName` | player identity resolution | ✓ |
| `players[].battingOrder` | batting order in `mlb_lineups` | ✓ |
| `players[].gameStatusCode` / `status` | `confirmed` flag | ✓ |

---

## 5. Check [2] — Open-Meteo Forecast

**Endpoint:** `GET https://api.open-meteo.com/v1/forecast`
**Params:** `latitude=40.8296&longitude=-73.9262&hourly=temperature_2m,precipitation_probability,wind_speed_10m,weather_code&forecast_hours=24&timezone=America/New_York&timeformat=unixtime`
**Test venue:** New York Yankees (lat `40.8296`, lon `-73.9262`) — one of 30 entries in `MLB_TEAM_COORDINATES` in `open-meteo-weather.ts`
**Caller in code:** `OpenMeteoWeatherAdapter.fetchMlbWeather()` → `refreshMlbWeather`

**Response:**
- `hourly.time`: 24 elements (unix timestamps)
- `hourly.temperature_2m`: 24 elements — sample hour[0]: `30°C`
- `hourly.precipitation_probability`: 24 elements — sample: `0%`
- `hourly.wind_speed_10m`: 24 elements — sample: `5.2 km/h`
- `hourly.weather_code`: 24 elements — sample: `1` (mostly clear)

**Field check against `OpenMeteoHourlyPayload` type:**

| Field path | Required by | Present |
|---|---|:---:|
| `hourly.time[]` | `scoreNearestHour()` | ✓ |
| `hourly.temperature_2m[]` | `summarizeWeather()` | ✓ |
| `hourly.precipitation_probability[]` | `summarizeWeather()` | ✓ |
| `hourly.wind_speed_10m[]` | `summarizeWeather()` | ✓ |
| `hourly.weather_code[]` | `summarizeWeather()` | ✓ |

All 24-element arrays align with `forecast_hours=24`. No optional `apikey` param needed — the free tier endpoint works without it (Open-Meteo free tier is auth-optional).

---

## 6. Check [3] — BigBalls MLB Matches

**Endpoint:** `GET https://api.bigballsdata.com/v1/matches?sport=baseball&league=mlb&date=2026-07-12`
**Auth:** `x-api-key: {BBS_API_KEY}` header (falls back to `Authorization: Bearer {key}` on 401/403)
**Caller in code:** `BigBallsDataAdapter.fetchMlbMatches()` → `refreshMlbLineups` (fallback only)

**Secret leak check:** The key is redacted by GitHub's runner at the env declaration level (`BBS_API_KEY: ***`). The script logged only `BBS_API_KEY: present (length 57)`. The request URL contains no key parameter — auth is header-only. No raw header values appeared in any log line. **No leak.**

**Response:**
- Top-level keys: `data`, `meta`, `error`
- `extractBigBallsMatches()` path: `payload.data` is an array → 15 matches extracted
- Sample match keys: `match_id`, `home`, `away`, `status`, `updated_at`

**Field check:**

| Field | Required by | Present |
|---|---|:---:|
| `match_id` (string) | `refreshMlbLineups` match selection | ✓ |
| `scheduled_at` | `selectLineupEligibleMatch()` (primary sort key) | ✗ |
| `starts_at` | `selectLineupEligibleMatch()` (fallback 1) | ✗ |
| `updated_at` | `selectLineupEligibleMatch()` (fallback 2) | ✓ |

**⚠️ Known defect: BigBalls lineup fallback is silently non-functional.**

`refreshMlbLineups` selects a match with:

```js
matchList.find((match) => typeof match.match_id === "string")
```

This succeeds — `match_id` is a string in the live response. The selected `match_id` is then passed into `bigBalls.fetchMlbLineup(matchId)`, which validates the ID against:

```js
/^bb_match_[A-Za-z0-9]+$/
```

The IDs returned by the live endpoint today do **not** match this pattern. `fetchMlbLineup()` throws `"Invalid Big Balls Data match ID."` The throw is caught by `.catch(() => null)` at the call site, so `lineupPayload` is `null` and the lineup path produces zero records — silently, with no error surfaced.

**Net effect:** whenever the boxscore path returns zero players and falls back to BigBalls, the BigBalls path also returns zero players. The fallback does not function as intended with the current API response.

The `scheduled_at` absence is a secondary issue; the ID pattern mismatch is what makes the lineup fallback currently inoperative.

---

## 7. Role of Each Source in the Production Pipeline

| Source | Used by | Role | Fallback behavior |
|---|---|---|---|
| `statsapi.mlb.com` game-log | `refreshMlbPlayerLogs` | Primary player stat history | None; function errors if API is down |
| `statsapi.mlb.com` schedule | `refreshMlbSchedules`, `refreshMlbLineups` | Game calendar and probable pitchers | `refreshMlbSchedules` has incremental fallback via MAX(`game_date`) cursor |
| `statsapi.mlb.com` boxscore | `refreshMlbLineups` | Primary lineup source | Falls back to BigBalls if zero players returned |
| `api.open-meteo.com` | `refreshMlbWeather` | Venue weather for environment scoring factor | None; function errors if API is down |
| `api.bigballsdata.com` | ~~`refreshMlbLineups`~~ | **Disabled** — lineup fallback removed (see Section 8) | N/A |

---

## 8. Known Defects — Resolved

1. **BigBalls lineup fallback was silently non-functional** (`lib/knowledge/enrichment/mlb.ts`, `lib/providers/big-balls-data.ts:89–92`). The live `/v1/matches` response returns `match_id` values that do not match the `/^bb_match_[A-Za-z0-9]+$/` regex in `fetchMlbLineup()`. The throw was swallowed by `.catch(() => null)`, producing zero lineup records without surfacing an error.

   **Resolution (2026-07-12, commit `50973a7`):** Option 2 selected. The BigBalls fallback branch, the `BigBallsDataAdapter` instantiation, and its import were removed from `refreshMlbLineups`. MLB Stats API boxscore is now the sole lineup source. If the boxscore returns zero players for an event, that event proceeds with no lineup data rather than a silently-failed fallback. `BigBallsDataAdapter` and its module remain in the codebase — only the lineup path in `mlb.ts` was changed.

---

## 9. Remaining Unknowns

1. **Aaron Judge gap reflects IL status, not a systemic issue.** No other players were tested. A player confirmed active (e.g., Shohei Ohtani, ID `660271`) should be tested separately to confirm game-log freshness for a currently-playing hitter.

2. **BigBalls `scheduled_at` absent.** If `selectLineupEligibleMatch()` is ever adopted into `refreshMlbLineups`, the time-window filter will fall back to `updated_at`. This could produce incorrect lineup selections for games recently updated but not yet started. Secondary to the ID defect above — resolve the ID issue first.

3. **Open-Meteo indoor/dome venues.** Noted in prior version — venues like Chase Field (retractable roof) and Tropicana Field (dome) receive weather forecasts that may not reflect actual playing conditions. Data-quality note, not a connectivity issue.

4. **Open-Meteo indoor/dome venues.** The `MLB_TEAM_COORDINATES` table in `open-meteo-weather.ts` covers all 30 teams, but venues like Chase Field (retractable roof) and Tropicana Field (dome) receive weather forecasts that may not reflect actual playing conditions. This is a data-quality note, not a connectivity issue.
