import { NextResponse } from "next/server";

type RouteCacheProfile = "public-live" | "public-analytics" | "public-snapshot-latest" | "public-snapshot-versioned" | "public-snapshot-fallback" | "public-snapshot-unavailable" | "private-debug" | "no-store";

function cacheControl(profile: RouteCacheProfile) {
  switch (profile) {
    case "public-live":
      return "public, s-maxage=30, stale-while-revalidate=90";
    case "public-analytics":
      return "public, s-maxage=60, stale-while-revalidate=180";
    case "public-snapshot-latest":
      return "public, s-maxage=120, stale-while-revalidate=900";
    case "public-snapshot-versioned":
      return "public, s-maxage=31536000, stale-while-revalidate=31536000, immutable";
    case "public-snapshot-fallback":
      return "public, s-maxage=15, stale-while-revalidate=60";
    case "public-snapshot-unavailable":
      return "public, s-maxage=15, stale-while-revalidate=60";
    case "private-debug":
      return "private, max-age=15, stale-while-revalidate=30";
    case "no-store":
    default:
      return "no-store";
  }
}

export function jsonRouteResponse(
  routeName: string,
  payload: unknown,
  options: {
    status?: number;
    cacheProfile?: RouteCacheProfile;
    rowsReturned?: number;
    cacheStatus?: string | null;
    snapshotSource?: "published" | "relational-fallback" | "unavailable" | null;
    headers?: HeadersInit;
  } = {},
) {
  const body = JSON.stringify(payload);
  const responseSizeBytes = Buffer.byteLength(body, "utf8");
  const responseSizeKb = Number((responseSizeBytes / 1024).toFixed(2));
  const rowsReturned = options.rowsReturned
    ?? (payload && typeof payload === "object" && Array.isArray((payload as { rows?: unknown[] }).rows)
      ? (payload as { rows: unknown[] }).rows.length
      : null);

  const logPayload = {
    route_name: routeName,
    response_size_kb: responseSizeKb,
    rows_returned: rowsReturned,
    cache_status: options.cacheStatus ?? null,
    snapshot_source: options.snapshotSource ?? null,
    timestamp: new Date().toISOString(),
  };

  if (responseSizeKb > 1024) {
    console.warn("[route-egress][critical]", logPayload);
  } else if (responseSizeKb > 500) {
    console.warn("[route-egress][warning]", logPayload);
  } else {
    console.info("[route-egress]", logPayload);
  }

  return new NextResponse(body, {
    status: options.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheControl(options.cacheProfile ?? "public-live"),
      ...options.headers,
    },
  });
}
