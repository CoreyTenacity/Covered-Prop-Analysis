#!/usr/bin/env node

/**
 * Safe diagnostic for WNBA scoreboard endpoint
 * Does NOT write to Supabase or invoke production jobs
 * Tests the exact request used by fetchScoreboardForDate()
 */

import { performance } from 'perf_hooks';

function headers() {
  return {
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://www.nba.com',
    Referer: 'https://www.nba.com/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'x-nba-stats-origin': 'stats',
    'x-nba-stats-token': 'true',
  };
}

function formatDate(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  }).format(date);
}

async function testScoreboardRequest(leagueId = '10', dateStr = null) {
  const date = dateStr ? new Date(`${dateStr}T12:00:00-04:00`) : new Date();
  const formatted = formatDate(date);
  const url = `https://stats.nba.com/stats/scoreboardv2?GameDate=${encodeURIComponent(formatted)}&LeagueID=${encodeURIComponent(leagueId)}&DayOffset=0`;

  const result = {
    environment: process.env.GITHUB_ACTIONS ? 'github-actions' : (process.env.VERCEL ? 'vercel' : 'local'),
    timestamp: new Date().toISOString(),
    testDate: formatted,
    leagueId,
    url,
    headersCount: Object.keys(headers()).length,
    timeoutMs: 12000,
    attempts: 0,
    results: [],
  };

  // Try up to 2 times
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptResult = {
      attempt,
      startTime: performance.now(),
      connectTime: null,
      firstByteTime: null,
      endTime: null,
      statusCode: null,
      statusText: null,
      contentType: null,
      contentLength: null,
      responseBytes: null,
      error: null,
      errorName: null,
      errorMessage: null,
      success: false,
    };

    try {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), 12000);

      const startFetch = performance.now();
      const response = await fetch(url, {
        headers: headers(),
        signal: controller.signal,
        cache: 'no-store',
      });

      clearTimeout(timeoutHandle);
      attemptResult.connectTime = performance.now() - startFetch;
      attemptResult.statusCode = response.status;
      attemptResult.statusText = response.statusText;
      attemptResult.contentType = response.headers.get('content-type');
      attemptResult.contentLength = response.headers.get('content-length');

      const text = await response.text();
      attemptResult.responseBytes = text.length;
      attemptResult.firstByteTime = attemptResult.connectTime; // Approximation

      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }

      if (!response.ok) {
        attemptResult.error = `HTTP ${response.status}: ${response.statusText}`;
        attemptResult.errorName = 'HttpError';
      } else if (!payload || typeof payload !== 'object') {
        attemptResult.error = 'Invalid JSON response';
        attemptResult.errorName = 'ParseError';
      } else if (!Array.isArray(payload.resultSets)) {
        attemptResult.error = 'Missing resultSets in response';
        attemptResult.errorName = 'ResponseStructureError';
      } else {
        attemptResult.success = true;
        attemptResult.resultSetCount = payload.resultSets.length;
      }

      attemptResult.endTime = performance.now();
      attemptResult.totalTimeMs = attemptResult.endTime - startFetch;
    } catch (error) {
      attemptResult.endTime = performance.now();
      attemptResult.totalTimeMs = attemptResult.endTime - attemptResult.startTime;
      attemptResult.error = error instanceof Error ? error.message : String(error);
      attemptResult.errorName = error instanceof Error ? error.name : 'UnknownError';
      attemptResult.errorMessage = error instanceof Error ? error.message : String(error);
    }

    result.results.push(attemptResult);
    result.attempts = attempt;

    if (attemptResult.success) {
      break;
    }

    // Brief backoff before retry
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  return result;
}

async function main() {
  const leagueId = process.argv[2] || '10';
  const testDate = process.argv[3] || null;

  console.log('');
  console.log('='.repeat(60));
  console.log('WNBA Scoreboard Endpoint Diagnostic');
  console.log('='.repeat(60));
  console.log('');

  const result = await testScoreboardRequest(leagueId, testDate);

  console.log(`Environment: ${result.environment}`);
  console.log(`Timestamp: ${result.timestamp}`);
  console.log(`Test Date: ${result.testDate}`);
  console.log(`League ID: ${result.leagueId}`);
  console.log(`Timeout: ${result.timeoutMs}ms`);
  console.log(`Attempts: ${result.attempts}`);
  console.log('');
  console.log('URL:', result.url);
  console.log('Headers:', result.headersCount, 'fields');
  console.log('');

  for (const attempt of result.results) {
    console.log(`--- Attempt ${attempt.attempt} ---`);
    console.log(`Status: ${attempt.statusCode || 'N/A'} ${attempt.statusText || ''}`);
    console.log(`Connect Time: ${attempt.connectTime?.toFixed(0) || 'N/A'}ms`);
    console.log(`Total Time: ${attempt.totalTimeMs?.toFixed(0) || 'N/A'}ms`);
    console.log(`Content-Type: ${attempt.contentType || 'N/A'}`);
    console.log(`Response Size: ${attempt.responseBytes || 0} bytes`);

    if (attempt.success) {
      console.log(`✓ Success (${attempt.resultSetCount} result sets)`);
    } else {
      console.log(`✗ Failed`);
      console.log(`Error Name: ${attempt.errorName}`);
      console.log(`Error: ${attempt.error}`);
    }
    console.log('');
  }

  const lastResult = result.results[result.results.length - 1];
  console.log('='.repeat(60));
  console.log(`Final Status: ${lastResult.success ? '✓ SUCCESS' : '✗ FAILED'}`);
  console.log(`Total Time: ${lastResult.totalTimeMs?.toFixed(0) || 'N/A'}ms`);
  if (lastResult.errorName && !lastResult.success) {
    console.log(`Failure Class: ${lastResult.errorName}`);
  }
  console.log('='.repeat(60));
  console.log('');

  // Exit with appropriate code
  process.exit(lastResult.success ? 0 : 1);
}

main().catch((error) => {
  console.error('Diagnostic error:', error);
  process.exit(1);
});
