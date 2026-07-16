#!/usr/bin/env node

/**
 * Read-only diagnostic for MLB data providers.
 * Does NOT write to Supabase or invoke production ingestion jobs.
 *
 * Covers:
 *   1. statsapi.mlb.com  — game-log fetch + schedule+boxscore fetch
 *   2. Open-Meteo        — forecast fetch for a known MLB venue
 *   3. BigBalls          — MLB matches fetch (only if BBS_API_KEY is present)
 *
 * Classification per finding:
 *   (a) working / correctly wired
 *   (b) reachable but wrong/incomplete shape relative to what parsing code expects
 *   (c) unreachable
 *   (d) no source / needs something we don't have
 */

import { performance } from 'perf_hooks';

// ─── constants ────────────────────────────────────────────────────────────────

// Aaron Judge – active hitter with a reliable game-log history
const TEST_PLAYER_ID = 592450;
const TEST_PLAYER_NAME = 'Aaron Judge';

// Today's date in YYYY-MM-DD (UTC)
const TODAY = new Date().toISOString().slice(0, 10);
const SEASON = new Date().getFullYear();

// New York Yankees coordinates (from open-meteo-weather.ts MLB_TEAM_COORDINATES)
const YANKEES_LAT = 40.8296;
const YANKEES_LON = -73.9262;

const TIMEOUT_MS = 12_000;

// ─── helpers ─────────────────────────────────────────────────────────────────

function timedFetch(url, options = {}) {
  const start = performance.now();
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal, cache: 'no-store' })
    .then(async (res) => {
      clearTimeout(handle);
      const latencyMs = Math.round(performance.now() - start);
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* ignore */ }
      return { ok: res.ok, status: res.status, statusText: res.statusText, latencyMs, text, json };
    })
    .catch((err) => {
      clearTimeout(handle);
      const latencyMs = Math.round(performance.now() - start);
      return { ok: false, status: null, statusText: null, latencyMs, text: null, json: null, error: err };
    });
}

function checkFields(obj, fields) {
  if (!obj || typeof obj !== 'object') return fields.map((f) => ({ field: f, present: false }));
  return fields.map((f) => ({ field: f, present: f in obj }));
}

function allPresent(checks) {
  return checks.every((c) => c.present);
}

function summarizeChecks(checks) {
  const missing = checks.filter((c) => !c.present).map((c) => c.field);
  return missing.length === 0
    ? '  All required fields present'
    : `  Missing fields: ${missing.join(', ')}`;
}

function classify(reachable, shapeOk, keyPresent = true) {
  if (!keyPresent) return 'd';
  if (!reachable) return 'c';
  if (!shapeOk) return 'b';
  return 'a';
}

function classifyLabel(code) {
  return { a: '(a) working / correctly wired', b: '(b) reachable but wrong/incomplete shape', c: '(c) unreachable', d: '(d) no source / key not available' }[code] ?? code;
}

// ─── check 1: statsapi.mlb.com game log ──────────────────────────────────────

async function checkMlbGameLog() {
  const url = `https://statsapi.mlb.com/api/v1/people/${TEST_PLAYER_ID}/stats?stats=gameLog&group=hitting&season=${SEASON}&gameType=R`;
  console.log(`\n[1a] MLB Stats API – game log`);
  console.log(`     Player: ${TEST_PLAYER_NAME} (ID ${TEST_PLAYER_ID}), season ${SEASON}`);
  console.log(`     URL: ${url}`);

  const result = await timedFetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (result.error) {
    console.log(`     Status: ERROR – ${result.error.message ?? result.error}`);
    console.log(`     Latency: ${result.latencyMs}ms`);
    return classify(false, false);
  }

  console.log(`     Status: ${result.status} ${result.statusText}`);
  console.log(`     Latency: ${result.latencyMs}ms`);

  if (!result.ok || !result.json) {
    console.log(`     Result: unreachable (HTTP ${result.status})`);
    return classify(false, false);
  }

  // extractRows() expects: response.stats[].splits[].stat with hitting fields
  const payload = result.json;
  const stats = Array.isArray(payload.stats) ? payload.stats : [];
  const splits = stats.flatMap((s) => Array.isArray(s.splits) ? s.splits : []);

  console.log(`     stats[]: ${stats.length}`);
  console.log(`     splits[]: ${splits.length}`);

  if (!splits.length) {
    console.log(`     Result: reachable but no splits found (off-season or wrong group?)`);
    // Shape structure is valid but empty — classify as (b) since parsing would yield nothing
    return classify(true, false);
  }

  // Check most-recent split for required stat fields
  const latestSplit = splits[splits.length - 1];
  const stat = latestSplit?.stat;
  const game = latestSplit?.game;

  const statChecks = checkFields(stat, ['hits', 'atBats', 'strikeOuts', 'baseOnBalls', 'homeRuns', 'rbi', 'stolenBases']);
  const gameChecks = checkFields(game, ['gamePk']);
  const dateCheck = [{ field: 'date (on split)', present: 'date' in (latestSplit ?? {}) }];

  console.log(`     Latest split date: ${latestSplit?.date ?? 'N/A'}`);
  console.log(`     Latest split gamePk: ${game?.gamePk ?? 'N/A'}`);
  console.log(`     stat fields check:`);
  console.log(`       ${summarizeChecks(statChecks)}`);
  console.log(`     game fields check:`);
  console.log(`       ${summarizeChecks(gameChecks)}`);
  console.log(`     date field check:`);
  console.log(`       ${summarizeChecks(dateCheck)}`);

  const shapeOk = allPresent(statChecks) && allPresent(gameChecks) && allPresent(dateCheck);
  return classify(true, shapeOk);
}

// ─── check 2: statsapi.mlb.com schedule + boxscore ───────────────────────────

async function checkMlbScheduleAndBoxscore() {
  const scheduleUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${TODAY}&endDate=${TODAY}&hydrate=probablePitcher,linescore,team`;
  console.log(`\n[1b] MLB Stats API – schedule + boxscore`);
  console.log(`     Date: ${TODAY}`);
  console.log(`     URL: ${scheduleUrl}`);

  const schedResult = await timedFetch(scheduleUrl, {
    headers: { Accept: 'application/json' },
  });

  if (schedResult.error) {
    console.log(`     Status: ERROR – ${schedResult.error.message ?? schedResult.error}`);
    console.log(`     Latency: ${schedResult.latencyMs}ms`);
    return classify(false, false);
  }

  console.log(`     Status: ${schedResult.status} ${schedResult.statusText}`);
  console.log(`     Latency: ${schedResult.latencyMs}ms`);

  if (!schedResult.ok || !schedResult.json) {
    console.log(`     Result: unreachable (HTTP ${schedResult.status})`);
    return classify(false, false);
  }

  const payload = schedResult.json;
  const dates = Array.isArray(payload.dates) ? payload.dates : [];
  const games = dates.flatMap((d) => Array.isArray(d.games) ? d.games : []);

  console.log(`     dates[]: ${dates.length}`);
  console.log(`     games[]: ${games.length}`);

  // Check schedule shape (SchedulePayload): dates[].games[].teams.home/away.team, gamePk
  const sampleGame = games[0];
  const schedChecks = [
    { field: 'gamePk', present: Boolean(sampleGame?.gamePk) },
    { field: 'teams.home.team.id', present: Boolean(sampleGame?.teams?.home?.team?.id) },
    { field: 'teams.away.team.id', present: Boolean(sampleGame?.teams?.away?.team?.id) },
  ];
  console.log(`     Schedule shape check (sample game):`);
  console.log(`       ${summarizeChecks(schedChecks)}`);

  if (!games.length || !sampleGame?.gamePk) {
    console.log(`     No games today – skipping boxscore check`);
    // Schedule reachable and valid shape — just no games
    return classify(true, true);
  }

  // Boxscore check
  const gamePk = sampleGame.gamePk;
  const boxscoreUrl = `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`;
  console.log(`\n     Boxscore URL: ${boxscoreUrl} (gamePk ${gamePk})`);

  const bsResult = await timedFetch(boxscoreUrl, {
    headers: { Accept: 'application/json' },
  });

  if (bsResult.error) {
    console.log(`     Boxscore Status: ERROR – ${bsResult.error.message ?? bsResult.error}`);
    console.log(`     Boxscore Latency: ${bsResult.latencyMs}ms`);
    return classify(true, false);
  }

  console.log(`     Boxscore Status: ${bsResult.status} ${bsResult.statusText}`);
  console.log(`     Boxscore Latency: ${bsResult.latencyMs}ms`);

  if (!bsResult.ok || !bsResult.json) {
    console.log(`     Result: schedule ok, boxscore unreachable (HTTP ${bsResult.status})`);
    return classify(true, false);
  }

  // MlbBoxscorePayload: teams.home.players (Record), teams.home.team.id/name
  const bs = bsResult.json;
  const bsChecks = [
    { field: 'teams.home.players (object)', present: Boolean(bs?.teams?.home?.players && typeof bs.teams.home.players === 'object') },
    { field: 'teams.away.players (object)', present: Boolean(bs?.teams?.away?.players && typeof bs.teams.away.players === 'object') },
    { field: 'teams.home.team.id', present: Boolean(bs?.teams?.home?.team?.id) },
    { field: 'teams.away.team.id', present: Boolean(bs?.teams?.away?.team?.id) },
  ];

  const homePlayers = bs?.teams?.home?.players ?? {};
  const playerCount = Object.keys(homePlayers).length;

  console.log(`     Boxscore shape check:`);
  console.log(`       ${summarizeChecks(bsChecks)}`);
  console.log(`     home.players count: ${playerCount}`);

  const shapeOk = allPresent(schedChecks) && allPresent(bsChecks);
  return classify(true, shapeOk);
}

// ─── check 3: Open-Meteo weather ─────────────────────────────────────────────

async function checkOpenMeteo() {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(YANKEES_LAT));
  url.searchParams.set('longitude', String(YANKEES_LON));
  url.searchParams.set('hourly', 'temperature_2m,precipitation_probability,wind_speed_10m,weather_code');
  url.searchParams.set('forecast_hours', '24');
  url.searchParams.set('timezone', 'America/New_York');
  url.searchParams.set('timeformat', 'unixtime');

  console.log(`\n[2] Open-Meteo – forecast`);
  console.log(`     Venue: New York Yankees (${YANKEES_LAT}, ${YANKEES_LON})`);
  console.log(`     URL: ${url}`);

  const result = await timedFetch(url.toString());

  if (result.error) {
    console.log(`     Status: ERROR – ${result.error.message ?? result.error}`);
    console.log(`     Latency: ${result.latencyMs}ms`);
    return classify(false, false);
  }

  console.log(`     Status: ${result.status} ${result.statusText}`);
  console.log(`     Latency: ${result.latencyMs}ms`);

  if (!result.ok || !result.json) {
    console.log(`     Result: unreachable (HTTP ${result.status})`);
    return classify(false, false);
  }

  // OpenMeteoHourlyPayload: hourly.time[], temperature_2m[], precipitation_probability[], wind_speed_10m[], weather_code[]
  const hourly = result.json?.hourly;
  const hourlyChecks = checkFields(hourly, ['time', 'temperature_2m', 'precipitation_probability', 'wind_speed_10m', 'weather_code']);
  const arrayLengths = hourlyChecks.map((c) => c.present ? `${c.field}[${Array.isArray(hourly[c.field]) ? hourly[c.field].length : 'N/A'}]` : null).filter(Boolean);

  console.log(`     hourly fields check:`);
  console.log(`       ${summarizeChecks(hourlyChecks)}`);
  console.log(`     array lengths: ${arrayLengths.join(', ')}`);

  if (hourlyChecks.every((c) => c.present)) {
    const sample = hourly.time?.[0];
    const tempSample = hourly.temperature_2m?.[0];
    const precipSample = hourly.precipitation_probability?.[0];
    const windSample = hourly.wind_speed_10m?.[0];
    const codeSample = hourly.weather_code?.[0];
    console.log(`     Sample hour [0]: time=${sample}, temp_2m=${tempSample}°C, precip_prob=${precipSample}%, wind=${windSample}km/h, code=${codeSample}`);
  }

  const shapeOk = allPresent(hourlyChecks);
  return classify(true, shapeOk);
}

// ─── check 4: BigBalls Data ───────────────────────────────────────────────────

async function checkBigBalls() {
  console.log(`\n[3] BigBalls (api.bigballsdata.com) – MLB matches`);

  const apiKey = process.env.BBS_API_KEY?.trim();
  if (!apiKey) {
    console.log(`     BBS_API_KEY: NOT PRESENT in environment`);
    console.log(`     Cannot test BigBalls from this environment.`);
    return classify(false, false, false);
  }

  console.log(`     BBS_API_KEY: present (length ${apiKey.length})`);

  const url = new URL('https://api.bigballsdata.com/v1/matches');
  url.searchParams.set('sport', 'baseball');
  url.searchParams.set('league', 'mlb');
  url.searchParams.set('date', TODAY);
  console.log(`     URL: ${url}`);

  const headers = { Accept: 'application/json', 'x-api-key': apiKey };
  const result = await timedFetch(url.toString(), { headers });

  // Try bearer if api-key fails with 401/403
  let finalResult = result;
  if (result.status && [401, 403].includes(result.status)) {
    console.log(`     x-api-key returned ${result.status}, retrying with Bearer auth...`);
    finalResult = await timedFetch(url.toString(), {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
    });
  }

  if (finalResult.error) {
    console.log(`     Status: ERROR – ${finalResult.error.message ?? finalResult.error}`);
    console.log(`     Latency: ${finalResult.latencyMs}ms`);
    return classify(false, false);
  }

  console.log(`     Status: ${finalResult.status} ${finalResult.statusText}`);
  console.log(`     Latency: ${finalResult.latencyMs}ms`);

  if (!finalResult.ok || !finalResult.json) {
    console.log(`     Result: unreachable (HTTP ${finalResult.status})`);
    return classify(false, false);
  }

  // extractBigBallsMatches(): payload.data (array) OR payload.data.scores.value (array)
  const payload = finalResult.json;
  const topLevelKeys = Object.keys(payload).slice(0, 15);
  console.log(`     Top-level keys: ${topLevelKeys.join(', ')}`);

  let matches = [];
  if (Array.isArray(payload.data)) {
    matches = payload.data;
  } else if (payload.data && typeof payload.data === 'object') {
    const scores = payload.data.scores;
    const value = scores && typeof scores === 'object' ? scores.value : null;
    if (Array.isArray(value)) matches = value;
  }

  console.log(`     Extracted matches: ${matches.length}`);

  if (matches.length > 0) {
    const sampleMatch = matches[0];
    const matchChecks = checkFields(sampleMatch, ['match_id', 'scheduled_at']);
    console.log(`     Sample match fields:`);
    console.log(`       ${summarizeChecks(matchChecks)}`);
    // selectLineupEligibleMatch needs match_id (string) + scheduled_at/starts_at/updated_at
    const hasIdField = typeof sampleMatch?.match_id === 'string';
    const hasTimeField = 'scheduled_at' in sampleMatch || 'starts_at' in sampleMatch || 'updated_at' in sampleMatch;
    const allMatchFields = Object.keys(sampleMatch).slice(0, 20);
    console.log(`     Sample match keys: ${allMatchFields.join(', ')}`);
    const shapeOk = hasIdField && hasTimeField;
    return classify(true, shapeOk);
  } else {
    console.log(`     No matches found for ${TODAY} (may be off-day or empty response)`);
    // Reachable with valid structure, just no matches today
    const hasDataKey = 'data' in payload;
    return classify(true, hasDataKey);
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('='.repeat(70));
  console.log('MLB Provider Diagnostic');
  console.log('='.repeat(70));
  console.log(`Environment: ${process.env.GITHUB_ACTIONS ? 'github-actions' : (process.env.VERCEL ? 'vercel' : 'local')}`);
  console.log(`Timestamp:   ${new Date().toISOString()}`);
  console.log(`Test date:   ${TODAY}`);
  console.log(`Season:      ${SEASON}`);
  console.log('');

  const [codeGameLog, codeSchedule, codeWeather, codeBigBalls] = await Promise.all([
    checkMlbGameLog(),
    checkMlbScheduleAndBoxscore(),
    checkOpenMeteo(),
    checkBigBalls(),
  ]);

  console.log('');
  console.log('='.repeat(70));
  console.log('Summary');
  console.log('='.repeat(70));
  console.log(`[1a] statsapi.mlb.com / game-log   → ${classifyLabel(codeGameLog)}`);
  console.log(`[1b] statsapi.mlb.com / sched+bxsc → ${classifyLabel(codeSchedule)}`);
  console.log(`[2]  Open-Meteo / forecast          → ${classifyLabel(codeWeather)}`);
  console.log(`[3]  BigBalls / MLB matches          → ${classifyLabel(codeBigBalls)}`);
  console.log('');

  const allOk = [codeGameLog, codeSchedule, codeWeather].every((c) => c === 'a');
  if (allOk) {
    console.log('All required sources: PASS');
  } else {
    const issues = [
      codeGameLog !== 'a' && `game-log (${codeGameLog})`,
      codeSchedule !== 'a' && `schedule+boxscore (${codeSchedule})`,
      codeWeather !== 'a' && `open-meteo (${codeWeather})`,
    ].filter(Boolean);
    console.log(`Issues: ${issues.join(', ')}`);
  }
  console.log('='.repeat(70));
  console.log('');

  // Non-zero exit only if a required (non-BigBalls) source fails hard
  const requiredFailed = [codeGameLog, codeSchedule, codeWeather].some((c) => c === 'c');
  process.exit(requiredFailed ? 1 : 0);
}

main().catch((err) => {
  console.error('Diagnostic error:', err);
  process.exit(1);
});
