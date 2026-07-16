import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { getProviderCache, putProviderCache, supabaseServerHeaders, withProviderCacheMemoScope } from "./provider-cache.ts";

function makeCacheRow(value: number, cacheKey = "memo:test") {
  return {
    cache_key: cacheKey,
    provider: "sharpapi",
    payload: { value },
    fetched_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    source_updated_at: null,
    is_stale: false,
  };
}

function withSupabaseEnv(run: () => Promise<void>) {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJtest";
  return run().finally(() => {
    if (originalUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    }
    if (originalKey === undefined) {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    } else {
      process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
    }
    mock.restoreAll();
  });
}

test("uses modern Supabase secret keys only as API keys", () => {
  const headers = supabaseServerHeaders("sb_secret_example");
  assert.equal(headers.apikey, "sb_secret_example");
  assert.equal(headers.Authorization, undefined);
});

test("keeps bearer authorization for legacy service-role JWTs", () => {
  const headers = supabaseServerHeaders("eyJlegacy");
  assert.equal(headers.Authorization, "Bearer eyJlegacy");
});

test("fresh memo scopes are isolated across separate top-level jobs", async () => {
  let readCount = 0;
  mock.method(globalThis, "fetch", async () => {
    readCount += 1;
    return new Response(JSON.stringify([makeCacheRow(readCount)]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  await withSupabaseEnv(async () => {
    await withProviderCacheMemoScope(async () => {
      const first = await getProviderCache<{ value: number }>("memo:test");
      const second = await getProviderCache<{ value: number }>("memo:test");
      assert.equal(first?.payload.value, 1);
      assert.equal(second?.payload.value, 1);
    });

    await withProviderCacheMemoScope(async () => {
      const third = await getProviderCache<{ value: number }>("memo:test");
      assert.equal(third?.payload.value, 2);
    });
  });

  assert.equal(readCount, 2);
});

test("memo scopes clean up after a thrown error", async () => {
  let readCount = 0;
  mock.method(globalThis, "fetch", async () => {
    readCount += 1;
    return new Response(JSON.stringify([makeCacheRow(readCount)]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  await withSupabaseEnv(async () => {
    await assert.rejects(
      () => withProviderCacheMemoScope(async () => {
        const first = await getProviderCache<{ value: number }>("memo:test");
        assert.equal(first?.payload.value, 1);
        throw new Error("boom");
      }),
      /boom/,
    );

    await withProviderCacheMemoScope(async () => {
      const second = await getProviderCache<{ value: number }>("memo:test");
      assert.equal(second?.payload.value, 2);
    });
  });

  assert.equal(readCount, 2);
});

test("changed payloads remain writable within the same memo scope", async () => {
  const methods: string[] = [];
  mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    return new Response(null, { status: 204 });
  });

  await withSupabaseEnv(async () => {
    await withProviderCacheMemoScope(async () => {
      const wroteFirst = await putProviderCache({
        cacheKey: "memo:test",
        provider: "sharpapi",
        payload: { value: 1 },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const wroteSecond = await putProviderCache({
        cacheKey: "memo:test",
        provider: "sharpapi",
        payload: { value: 2 },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      assert.equal(wroteFirst, true);
      assert.equal(wroteSecond, true);
    });
  });

  assert.deepEqual(methods, ["POST", "POST"]);
});
