const MAX_RUNNER_SERVER_SKEW_MS = 30_000;
const MAX_FUTURE_IAT_SKEW_MS = 5_000;

function jwtTimes(apiKey) {
  const parts = apiKey.split(".");
  if (parts.length !== 3) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const iat = Number(payload.iat);
    const exp = Number(payload.exp);
    if (!Number.isFinite(iat) || !Number.isFinite(exp)) return null;
    return { iat, exp };
  } catch {
    return null;
  }
}

function toIso(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString();
}

export class SupabaseTimeProbeError extends Error {
  constructor(code, diagnostics) {
    super(code);
    this.name = "SupabaseTimeProbeError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

/**
 * Performs the exact bounded, read-only `sports?id=eq.football` prerequisite
 * read and returns only safe clock metadata plus the at-most-two result rows.
 * The key is used in memory and is never included in a return value or error.
 */
export async function fetchFootballSportsWithTimeProbe({
  supabaseUrl,
  apiKey,
  fetchImpl = fetch,
  now = Date.now,
}) {
  if (!supabaseUrl || !apiKey) throw new Error("supabase_time_probe_not_configured");
  const startedAtMs = now();
  const jwt = jwtTimes(apiKey);
  const headers = {
    apikey: apiKey,
    "Content-Type": "application/json",
  };
  if (apiKey.startsWith("eyJ")) headers.Authorization = `Bearer ${apiKey}`;

  let response;
  try {
    response = await fetchImpl(
      `${supabaseUrl.replace(/\/$/, "")}/rest/v1/sports?select=id,code&id=eq.football&limit=2`,
      { method: "GET", headers, cache: "no-store", signal: AbortSignal.timeout(10_000) },
    );
  } catch {
    const endedAtMs = now();
    const diagnostics = makeDiagnostics({ startedAtMs, endedAtMs, jwt, serverDate: null, status: null, errorCode: null });
    throw new SupabaseTimeProbeError("supabase_time_probe_transport_failed", diagnostics);
  }

  const endedAtMs = now();
  const serverDate = response.headers.get("date");
  const errorCode = await readErrorCode(response);
  const diagnostics = makeDiagnostics({ startedAtMs, endedAtMs, jwt, serverDate, status: response.status, errorCode });

  if (diagnostics.supabaseDateUtc === null) {
    throw new SupabaseTimeProbeError("supabase_date_header_unavailable", diagnostics);
  }
  if (Math.abs(diagnostics.runnerMinusSupabaseSeconds) > MAX_RUNNER_SERVER_SKEW_MS / 1000) {
    throw new SupabaseTimeProbeError("runner_supabase_clock_skew_exceeds_30_seconds", diagnostics);
  }
  if (diagnostics.jwtIatUtc && diagnostics.jwtIatAfterSupabaseDateSeconds > MAX_FUTURE_IAT_SKEW_MS / 1000) {
    throw new SupabaseTimeProbeError("jwt_iat_is_after_supabase_response_time", diagnostics);
  }
  if (!response.ok) throw new SupabaseTimeProbeError(`supabase_read_http_${response.status}_${errorCode ?? "unknown"}`, diagnostics);

  let rows;
  try {
    rows = await response.json();
  } catch {
    throw new SupabaseTimeProbeError("supabase_read_invalid_json", diagnostics);
  }
  if (!Array.isArray(rows) || rows.length > 2) {
    throw new SupabaseTimeProbeError("supabase_read_result_out_of_bounds", diagnostics);
  }

  return {
    rows,
    diagnostics: { ...diagnostics, status: "read_only_probe_passed" },
  };
}

function makeDiagnostics({ startedAtMs, endedAtMs, jwt, serverDate, status, errorCode }) {
  const serverMs = serverDate ? Date.parse(serverDate) : Number.NaN;
  const midpointMs = Math.round((startedAtMs + endedAtMs) / 2);
  const validServerTime = Number.isFinite(serverMs);
  return {
    appDateNowStartMs: startedAtMs,
    appUtcStart: new Date(startedAtMs).toISOString(),
    appDateNowEndMs: endedAtMs,
    appUtcEnd: new Date(endedAtMs).toISOString(),
    supabaseDateHeader: serverDate,
    supabaseDateUtc: validServerTime ? new Date(serverMs).toISOString() : null,
    runnerMinusSupabaseSeconds: validServerTime ? Number(((midpointMs - serverMs) / 1000).toFixed(3)) : null,
    jwtClaimsAvailable: jwt !== null,
    jwtIatUtc: jwt ? toIso(jwt.iat) : null,
    jwtExpUtc: jwt ? toIso(jwt.exp) : null,
    jwtIatAfterSupabaseDateSeconds: jwt && validServerTime ? Number(((jwt.iat * 1000 - serverMs) / 1000).toFixed(3)) : null,
    httpStatus: status,
    postgrestErrorCode: errorCode,
  };
}

async function readErrorCode(response) {
  if (response.ok) return null;
  try {
    const body = await response.clone().json();
    return typeof body?.code === "string" && /^[A-Z0-9]{3,16}$/.test(body.code) ? body.code : null;
  } catch {
    return null;
  }
}
