import assert from "node:assert/strict";
import test from "node:test";
import { EspnWnbaAdapter } from "./espn-wnba.ts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function withMockedFetch<T>(impl: (url: string) => Promise<Response>, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  // @ts-expect-error - test-only override
  globalThis.fetch = (url: string) => impl(String(url));
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("configured() is always true (no API key required)", () => {
  assert.equal(new EspnWnbaAdapter().configured(), true);
});

test("fetchScheduleForDate parses a scheduled and a final game", async () => {
  const fixture = {
    events: [
      {
        id: "401857057",
        date: "2026-07-11T17:00Z",
        competitions: [{
          status: { type: { name: "STATUS_FINAL", state: "post", detail: "Final", description: "Final" } },
          venue: { fullName: "Barclays Center", address: { city: "Brooklyn", state: "NY" } },
          competitors: [
            { homeAway: "home", score: "90", team: { id: "8", displayName: "Minnesota Lynx", abbreviation: "MIN" } },
            { homeAway: "away", score: "85", team: { id: "9", displayName: "New York Liberty", abbreviation: "NY" } },
          ],
        }],
      },
      {
        id: "401857060",
        date: "2026-07-12T19:00Z",
        competitions: [{
          status: { type: { name: "STATUS_SCHEDULED", state: "pre", detail: "7/12 - 3:00 PM EDT", description: "Scheduled" } },
          venue: { fullName: "Coca-Cola Coliseum", address: { city: "Toronto", state: "ON" } },
          competitors: [
            { homeAway: "home", score: "0", team: { id: "31", displayName: "Toronto Tempo", abbreviation: "TOR" } },
            { homeAway: "away", score: "0", team: { id: "9", displayName: "New York Liberty", abbreviation: "NY" } },
          ],
        }],
      },
    ],
  };

  const games = await withMockedFetch(
    async (url) => {
      assert.match(url, /scoreboard\?dates=20260712/);
      return jsonResponse(fixture);
    },
    () => new EspnWnbaAdapter().fetchScheduleForDate("2026-07-12"),
  );

  assert.equal(games.length, 2);
  assert.equal(games[0].status, "final");
  assert.equal(games[0].homeTeamName, "Minnesota Lynx");
  assert.equal(games[0].homeScore, 90);
  assert.equal(games[0].awayScore, 85);
  assert.equal(games[1].status, "scheduled");
  assert.equal(games[1].homeScore, 0);
});

test("fetchScheduleForDate maps postponed and canceled statuses", async () => {
  const fixture = {
    events: [
      {
        id: "1",
        date: "2026-07-12T19:00Z",
        competitions: [{
          status: { type: { name: "STATUS_POSTPONED", state: "pre" } },
          competitors: [
            { homeAway: "home", team: { id: "1", displayName: "Team A" } },
            { homeAway: "away", team: { id: "2", displayName: "Team B" } },
          ],
        }],
      },
      {
        id: "2",
        date: "2026-07-12T19:00Z",
        competitions: [{
          status: { type: { name: "STATUS_CANCELED", state: "post" } },
          competitors: [
            { homeAway: "home", team: { id: "3", displayName: "Team C" } },
            { homeAway: "away", team: { id: "4", displayName: "Team D" } },
          ],
        }],
      },
    ],
  };
  const games = await withMockedFetch(
    async () => jsonResponse(fixture),
    () => new EspnWnbaAdapter().fetchScheduleForDate("2026-07-12"),
  );
  assert.equal(games[0].status, "postponed");
  assert.equal(games[1].status, "canceled");
});

test("fetchBoxScore returns null when boxscore is not yet available", async () => {
  const result = await withMockedFetch(
    async () => jsonResponse({ header: { competitions: [{ status: { type: { name: "STATUS_SCHEDULED", state: "pre" } } }] }, boxscore: { players: [], teams: [] } }),
    () => new EspnWnbaAdapter().fetchBoxScore("401857060"),
  );
  assert.equal(result, null);
});

test("fetchBoxScore parses player minutes, points, starter status and team stats", async () => {
  const fixture = {
    header: {
      competitions: [{
        status: { type: { name: "STATUS_FINAL", state: "post", detail: "Final" } },
        competitors: [
          { homeAway: "home", score: "90", team: { id: "8" } },
          { homeAway: "away", score: "85", team: { id: "9" } },
        ],
      }],
    },
    boxscore: {
      teams: [
        {
          team: { id: "9", displayName: "New York Liberty" },
          statistics: [
            { name: "fieldGoalsMade-fieldGoalsAttempted", displayValue: "32-75" },
            { name: "threePointFieldGoalsMade-threePointFieldGoalsAttempted", displayValue: "13-38" },
            { name: "freeThrowsMade-freeThrowsAttempted", displayValue: "8-9" },
            { name: "totalRebounds", displayValue: "34" },
            { name: "offensiveRebounds", displayValue: "11" },
            { name: "defensiveRebounds", displayValue: "23" },
            { name: "assists", displayValue: "20" },
            { name: "steals", displayValue: "8" },
            { name: "blocks", displayValue: "2" },
            { name: "totalTurnovers", displayValue: "14" },
          ],
        },
      ],
      players: [
        {
          team: { id: "9" },
          statistics: [{
            labels: ["MIN", "PTS", "FG", "3PT", "FT", "REB", "AST", "TO", "STL", "BLK", "OREB", "DREB", "PF", "+/-"],
            athletes: [
              { athlete: { id: "101", displayName: "Breanna Stewart" }, starter: true, stats: ["37", "17", "7-16", "2-3", "1-1", "7", "3", "4", "2", "1", "3", "4", "1", "-4"] },
              { athlete: { id: "102", displayName: "Bench Player" }, starter: false, didNotPlay: true, stats: [] },
            ],
          }],
        },
      ],
    },
  };

  const box = await withMockedFetch(
    async () => jsonResponse(fixture),
    () => new EspnWnbaAdapter().fetchBoxScore("401857057"),
  );

  assert.ok(box);
  assert.equal(box!.status, "final");
  assert.equal(box!.players.length, 2);
  const stewart = box!.players.find((p) => p.athleteId === "101")!;
  assert.equal(stewart.minutes, 37);
  assert.equal(stewart.points, 17);
  assert.equal(stewart.starter, true);
  assert.equal(stewart.rebounds, 7);
  assert.equal(stewart.fieldGoalsMade, 7);
  assert.equal(stewart.fieldGoalsAttempted, 16);
  const bench = box!.players.find((p) => p.athleteId === "102")!;
  assert.equal(bench.didNotPlay, true);
  assert.equal(bench.minutes, null);

  assert.equal(box!.teams.length, 1);
  const team = box!.teams[0];
  assert.equal(team.score, 85);
  assert.equal(team.rebounds, 34);
  assert.equal(team.assists, 20);
  assert.equal(team.turnovers, 14);
  assert.equal(team.fieldGoalsMade, 32);
  assert.equal(team.fieldGoalsAttempted, 75);
});

test("fetchScheduleForDate retries on transient failure then succeeds", async () => {
  let calls = 0;
  const fixture = { events: [] };
  const games = await withMockedFetch(
    async () => {
      calls += 1;
      if (calls < 2) return new Response("Service Unavailable", { status: 503 });
      return jsonResponse(fixture);
    },
    () => new EspnWnbaAdapter().fetchScheduleForDate("2026-07-12"),
  );
  assert.equal(calls, 2);
  assert.deepEqual(games, []);
});

test("fetchScheduleForDate throws after exhausting retries", async () => {
  await assert.rejects(
    withMockedFetch(
      async () => new Response("Service Unavailable", { status: 503 }),
      () => new EspnWnbaAdapter().fetchScheduleForDate("2026-07-12"),
    ),
  );
});
