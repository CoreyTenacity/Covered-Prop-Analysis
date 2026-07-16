import type { ProviderId } from "@/lib/providers/provider-contracts";

export type CacheRecord<T> = {
  cache_key: string;
  provider: ProviderId;
  payload: T;
  fetched_at: string;
  expires_at: string;
  source_updated_at: string | null;
  is_stale: boolean;
};

type ProviderUsageDailyRecord = {
  provider: ProviderId;
  usage_date: string;
  units_used: number;
  hard_budget: number;
  updated_at: string;
};

type ProviderUsageMonthlyRecord = {
  provider: ProviderId;
  usage_month: string;
  units_used: number;
  hard_budget: number;
  updated_at: string;
};

type ProviderCacheMemoRecord<T> = CacheRecord<T> | null;
type ProviderCacheMemoFingerprint = string | null;

let providerCacheMemo: Map<string, ProviderCacheMemoRecord<unknown>> | null = null;
let providerCacheFingerprintMemo: Map<string, ProviderCacheMemoFingerprint> | null = null;

function memoStore() {
  return providerCacheMemo;
}

function isFreshMemoRecord(record: CacheRecord<unknown> | null) {
  if (!record) return false;
  if (record.is_stale) return false;
  const expiresAt = new Date(record.expires_at).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function memoizeRead<T>(cacheKey: string, record: ProviderCacheMemoRecord<T>) {
  memoStore()?.set(cacheKey, record as ProviderCacheMemoRecord<unknown>);
  memoFingerprintStore()?.set(cacheKey, cacheRecordFingerprint(record));
}

function memoizedRead<T>(cacheKey: string) {
  const store = memoStore();
  if (!store?.has(cacheKey)) return undefined;
  const record = store.get(cacheKey) as ProviderCacheMemoRecord<T>;
  if (record === null) return null;
  if (!isFreshMemoRecord(record)) {
    store.delete(cacheKey);
    return undefined;
  }
  return record;
}

function memoFingerprintStore() {
  return providerCacheFingerprintMemo;
}

function cacheRecordFingerprint(record: ProviderCacheMemoRecord<unknown>) {
  if (!record) return null;
  return JSON.stringify({
    cache_key: record.cache_key,
    provider: record.provider,
    payload: record.payload,
    source_updated_at: record.source_updated_at ?? null,
    is_stale: record.is_stale,
  });
}

export async function withProviderCacheMemoScope<T>(run: () => Promise<T>) {
  const previous = providerCacheMemo;
  const previousFingerprints = providerCacheFingerprintMemo;
  providerCacheMemo = new Map<string, ProviderCacheMemoRecord<unknown>>();
  providerCacheFingerprintMemo = new Map<string, ProviderCacheMemoFingerprint>();
  try {
    return await run();
  } finally {
    providerCacheMemo = previous;
    providerCacheFingerprintMemo = previousFingerprints;
  }
}

function easternDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function easternMonthStart(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value ?? String(value.getFullYear());
  const month = parts.find((part) => part.type === "month")?.value ?? String(value.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

function configuration() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Supabase server cache is not configured.");
  if (!key.startsWith("sb_secret_") && !key.startsWith("eyJ")) {
    throw new Error("Supabase server cache requires a secret or service-role key, not a publishable key.");
  }
  return { url, key };
}

export function supabaseServerHeaders(key: string) {
  const headers: Record<string, string> = { apikey: key, "Content-Type": "application/json" };
  // Modern sb_secret_ keys are opaque API keys, not JWTs. Legacy service-role
  // keys are JWTs and still require the Authorization header for PostgREST.
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function supabase(path: string, init: RequestInit = {}) {
  const { url, key } = configuration();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...supabaseServerHeaders(key),
      ...init.headers,
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const safeDetail = detail.replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[redacted-key]").slice(0, 300);
    throw new Error(`Supabase cache request failed with status ${response.status}${safeDetail ? `: ${safeDetail}` : "."}`);
  }
  return response;
}

async function deleteProviderCacheRows(cacheKeys: string[]) {
  if (!cacheKeys.length) return;
  await supabase(`provider_cache?cache_key=in.(${cacheKeys.map((key) => encodeURIComponent(key)).join(",")})`, {
    method: "DELETE",
    headers: {
      Prefer: "return=minimal",
    },
  });
  const store = memoStore();
  const fingerprints = memoFingerprintStore();
  if (store) {
    for (const cacheKey of cacheKeys) store.delete(cacheKey);
  }
  if (fingerprints) {
    for (const cacheKey of cacheKeys) fingerprints.delete(cacheKey);
  }
}

export type ProviderCacheReadStatus = "hit" | "missing" | "failed";

export async function getProviderCacheWithStatus<T>(cacheKey: string): Promise<{
  record: CacheRecord<T> | null;
  status: ProviderCacheReadStatus;
}> {
  try {
    const memoized = memoizedRead<T>(cacheKey);
    if (memoized !== undefined) {
      return { record: memoized, status: memoized ? "hit" : "missing" };
    }
    const key = encodeURIComponent(cacheKey);
    const response = await supabase(
      `provider_cache?cache_key=eq.${key}&select=cache_key,provider,payload,fetched_at,expires_at,source_updated_at,is_stale`,
    );
    const rows = await response.json() as CacheRecord<T>[];
    const record = rows[0] ?? null;
    memoizeRead(cacheKey, record);
    return { record, status: record ? "hit" : "missing" };
  } catch (error) {
    console.warn(`[provider-cache] read failed for ${cacheKey}:`, error instanceof Error ? error.message : error);
    return { record: null, status: "failed" };
  }
}

export async function getProviderCache<T>(cacheKey: string): Promise<CacheRecord<T> | null> {
  return (await getProviderCacheWithStatus<T>(cacheKey)).record;
}

export async function putProviderCache(input: {
  cacheKey: string;
  provider: ProviderId;
  payload: unknown;
  expiresAt: string;
  sourceUpdatedAt?: string | null;
}): Promise<boolean> {
  try {
    const now = new Date().toISOString();
    const nextRecord: CacheRecord<unknown> = {
      cache_key: input.cacheKey,
      provider: input.provider,
      payload: input.payload,
      fetched_at: now,
      expires_at: input.expiresAt,
      source_updated_at: input.sourceUpdatedAt ?? null,
      is_stale: false,
    };
    const fingerprint = cacheRecordFingerprint(nextRecord);
    const memoizedFingerprint = memoFingerprintStore()?.get(input.cacheKey);
    if (memoizedFingerprint && memoizedFingerprint === fingerprint) {
      return true;
    }
    await supabase("provider_cache?on_conflict=cache_key", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(nextRecord),
    });
    memoizeRead(input.cacheKey, nextRecord);
    return true;
  } catch (error) {
    console.warn(`[provider-cache] write failed for ${input.cacheKey}:`, error instanceof Error ? error.message : error);
    return false;
  }
}

export async function touchTodayBoardContext(source: string) {
  try {
    const cacheKey = "today-board:context-updated:latest";
    if (memoStore()?.has(cacheKey)) {
      return;
    }
    await putProviderCache({
      cacheKey,
      provider: "the-odds-api",
      payload: {
        source,
        refreshedAt: new Date().toISOString(),
      },
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    });
  } catch (error) {
    console.warn(`[provider-cache] context touch failed for ${source}:`, error instanceof Error ? error.message : error);
  }
}

export async function pruneExpiredProviderCache(options: {
  provider?: ProviderId | null;
  bufferHours?: number;
  limit?: number;
} = {}) {
  const bufferHours = Math.min(Math.max(options.bufferHours ?? 24, 1), 24 * 14);
  const cutoffMs = Date.now() - bufferHours * 60 * 60 * 1000;
  const rows = await supabase(
    `provider_cache?select=cache_key,provider,expires_at&order=expires_at.asc&limit=${Math.min(Math.max(options.limit ?? 200, 1), 1000)}${
      options.provider ? `&provider=eq.${encodeURIComponent(options.provider)}` : ""
    }`,
  ).then(async (response) => response.json() as Promise<Array<{ cache_key: string; provider: ProviderId; expires_at: string }>>);

  const cacheKeys = rows
    .filter((row) => {
      const expiresAt = new Date(row.expires_at).getTime();
      return Number.isFinite(expiresAt) && expiresAt <= cutoffMs;
    })
    .map((row) => row.cache_key);

  if (!cacheKeys.length) {
    return { prunedCount: 0, bufferHours };
  }

  await deleteProviderCacheRows(cacheKeys);
  return { prunedCount: cacheKeys.length, bufferHours };
}

export async function reserveProviderUsage(input: {
  provider: ProviderId;
  units: number;
  dailyBudget: number;
  monthlyBudget?: number | null;
}) {
  try {
    const response = await supabase("rpc/reserve_provider_usage", {
      method: "POST",
      body: JSON.stringify({
        p_provider: input.provider,
        p_units: input.units,
        p_daily_budget: input.dailyBudget,
        p_monthly_budget: input.monthlyBudget ?? null,
      }),
    });
    return await response.json() as { allowed: boolean; daily_used: number; monthly_used: number | null; error?: string };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Provider usage reservation failed.";
    console.warn(`[provider-cache] usage reservation failed for ${input.provider}:`, message);
    return { allowed: false, daily_used: 0, monthly_used: null, error: message };
  }
}

export async function getProviderUsageSnapshot(provider: ProviderId, now = new Date()) {
  const usageDate = easternDate(now);
  const usageMonth = easternMonthStart(now);
  try {
    const [dailyResponse, monthlyResponse] = await Promise.all([
      supabase(
        `provider_usage_daily?provider=eq.${encodeURIComponent(provider)}&usage_date=eq.${encodeURIComponent(usageDate)}&select=provider,usage_date,units_used,hard_budget,updated_at`,
      ),
      supabase(
        `provider_usage_monthly?provider=eq.${encodeURIComponent(provider)}&usage_month=eq.${encodeURIComponent(usageMonth)}&select=provider,usage_month,units_used,hard_budget,updated_at`,
      ),
    ]);
    const [dailyRows, monthlyRows] = await Promise.all([
      dailyResponse.json() as Promise<ProviderUsageDailyRecord[]>,
      monthlyResponse.json() as Promise<ProviderUsageMonthlyRecord[]>,
    ]);
    return {
      provider,
      usageDate,
      usageMonth,
      daily: dailyRows[0] ?? null,
      monthly: monthlyRows[0] ?? null,
    };
  } catch (error) {
    console.warn(`[provider-cache] usage snapshot failed for ${provider}:`, error instanceof Error ? error.message : error);
    return {
      provider,
      usageDate,
      usageMonth,
      daily: null,
      monthly: null,
    };
  }
}
