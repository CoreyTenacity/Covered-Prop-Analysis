import assert from "node:assert/strict";
import test from "node:test";
import { fetchFootballSportsWithTimeProbe, SupabaseTimeProbeError } from "./supabase-time-probe.mjs";

const serverTime = Date.parse("2026-10-07T02:56:30.000Z");
const makeJwt = ({ iat = serverTime / 1000 - 10, exp = serverTime / 1000 + 3600 } = {}) =>
  `eyJfake.${Buffer.from(JSON.stringify({ iat, exp, sub: "must-not-be-returned" })).toString("base64url")}.signature`;
const response = ({ status = 200, body = [{ id: "football", code: "football" }], date = "Wed, 07 Oct 2026 02:56:30 GMT" } = {}) =>
  new Response(JSON.stringify(status >= 400 ? body : body), {
    status,
    headers: { "content-type": "application/json", date },
  });

test("records runner/app and Supabase time plus JWT iat/exp without returning token claims", async () => {
  const nowValues = [serverTime, serverTime + 200];
  const key = makeJwt();
  let request;
  const result = await fetchFootballSportsWithTimeProbe({
    supabaseUrl: "https://example.supabase.co/",
    apiKey: key,
    now: () => nowValues.shift(),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response();
    },
  });

  assert.equal(request.url, "https://example.supabase.co/rest/v1/sports?select=id,code&id=eq.football&limit=2");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.Authorization.startsWith("Bearer "), true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.diagnostics.appDateNowStartMs, serverTime);
  assert.equal(result.diagnostics.supabaseDateUtc, "2026-10-07T02:56:30.000Z");
  assert.equal(result.diagnostics.jwtIatUtc, "2026-10-07T02:56:20.000Z");
  assert.equal(result.diagnostics.jwtExpUtc, "2026-10-07T03:56:30.000Z");
  assert.equal(JSON.stringify(result).includes("must-not-be-returned"), false);
  assert.equal(JSON.stringify(result).includes("signature"), false);
  assert.equal(JSON.stringify(result).includes(key), false);
});

test("fails closed when JWT iat is ahead of the Supabase response clock", async () => {
  const iat = serverTime / 1000 + 20;
  await assert.rejects(
    () => fetchFootballSportsWithTimeProbe({
      supabaseUrl: "https://example.supabase.co",
      apiKey: makeJwt({ iat }),
      now: () => serverTime,
      fetchImpl: async () => response({ status: 401, body: { code: "PGRST303", message: "redacted" } }),
    }),
    (error) => {
      assert.ok(error instanceof SupabaseTimeProbeError);
      assert.equal(error.code, "jwt_iat_is_after_supabase_response_time");
      assert.equal(error.diagnostics.postgrestErrorCode, "PGRST303");
      assert.equal(error.diagnostics.jwtIatAfterSupabaseDateSeconds, 20);
      assert.equal(JSON.stringify(error).includes("signature"), false);
      return true;
    },
  );
});

test("fails closed when runner clock differs from Supabase Date by more than 30 seconds", async () => {
  await assert.rejects(
    () => fetchFootballSportsWithTimeProbe({
      supabaseUrl: "https://example.supabase.co",
      apiKey: makeJwt(),
      now: () => serverTime + 45_000,
      fetchImpl: async () => response(),
    }),
    (error) => error.code === "runner_supabase_clock_skew_exceeds_30_seconds",
  );
});

test("supports opaque Supabase secret keys without attempting to treat them as JWTs", async () => {
  let authorizationHeader;
  const result = await fetchFootballSportsWithTimeProbe({
    supabaseUrl: "https://example.supabase.co",
    apiKey: "sb_secret_nonproduction_fixture",
    now: () => serverTime,
    fetchImpl: async (_url, options) => {
      authorizationHeader = options.headers.Authorization;
      return response();
    },
  });
  assert.equal(authorizationHeader, undefined);
  assert.equal(result.diagnostics.jwtClaimsAvailable, false);
  assert.equal(result.diagnostics.jwtIatUtc, null);
});

test("does not expose response body or credential material on an HTTP error", async () => {
  await assert.rejects(
    () => fetchFootballSportsWithTimeProbe({
      supabaseUrl: "https://example.supabase.co",
      apiKey: makeJwt(),
      now: () => serverTime,
      fetchImpl: async () => response({ status: 401, body: { code: "PGRST303", message: "sensitive detail" } }),
    }),
    (error) => {
      assert.equal(error.code, "supabase_read_http_401_PGRST303");
      assert.equal(JSON.stringify(error).includes("sensitive detail"), false);
      return true;
    },
  );
});
