import assert from "node:assert/strict";
import test from "node:test";
import { resolveWnbaDataProvider } from "./shared.ts";

function withEnv(value: string | undefined, run: () => void) {
  const original = process.env.WNBA_DATA_PROVIDER;
  if (value === undefined) delete process.env.WNBA_DATA_PROVIDER;
  else process.env.WNBA_DATA_PROVIDER = value;
  try {
    run();
  } finally {
    if (original === undefined) delete process.env.WNBA_DATA_PROVIDER;
    else process.env.WNBA_DATA_PROVIDER = original;
  }
}

test("resolveWnbaDataProvider defaults to espn-sportsdataverse when unset", () => {
  withEnv(undefined, () => {
    assert.equal(resolveWnbaDataProvider(), "espn-sportsdataverse");
  });
});

test("resolveWnbaDataProvider defaults to espn-sportsdataverse when empty string", () => {
  withEnv("", () => {
    assert.equal(resolveWnbaDataProvider(), "espn-sportsdataverse");
  });
});

test("resolveWnbaDataProvider defaults to espn-sportsdataverse when whitespace-only", () => {
  withEnv("   ", () => {
    assert.equal(resolveWnbaDataProvider(), "espn-sportsdataverse");
  });
});

test("resolveWnbaDataProvider returns espn-sportsdataverse when explicitly set", () => {
  withEnv("espn-sportsdataverse", () => {
    assert.equal(resolveWnbaDataProvider(), "espn-sportsdataverse");
  });
});

test("resolveWnbaDataProvider returns legacy-stats-nba only when explicitly requested", () => {
  withEnv("legacy-stats-nba", () => {
    assert.equal(resolveWnbaDataProvider(), "legacy-stats-nba");
  });
});

test("resolveWnbaDataProvider throws on an unrecognized value instead of silently falling back to legacy", () => {
  withEnv("espn-sportdataverse", () => { // missing "s" - realistic typo
    assert.throws(() => resolveWnbaDataProvider(), /Invalid WNBA_DATA_PROVIDER value "espn-sportdataverse"/);
  });
});

test("resolveWnbaDataProvider throws on the old bare stats.nba.com-style value if someone guesses wrong", () => {
  withEnv("wehoop-wnba", () => {
    assert.throws(() => resolveWnbaDataProvider(), /Invalid WNBA_DATA_PROVIDER value "wehoop-wnba"/);
  });
});

test("resolveWnbaDataProvider error message lists the valid values and the safe-default escape hatch", () => {
  withEnv("bogus", () => {
    assert.throws(() => resolveWnbaDataProvider(), /espn-sportsdataverse.*legacy-stats-nba|legacy-stats-nba.*espn-sportsdataverse/);
    assert.throws(() => resolveWnbaDataProvider(), /Unset the variable entirely/);
  });
});
