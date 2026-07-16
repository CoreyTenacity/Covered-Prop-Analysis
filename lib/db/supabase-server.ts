export type SupabaseFilter =
  | { column: string; operator?: "eq" | "gte" | "lte" | "gt" | "lt" | "neq" | "in" | "is"; value: string | number | boolean | null | Array<string | number> }
  | { raw: string };

function configuration() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Supabase server access is not configured.");
  if (!key.startsWith("sb_secret_") && !key.startsWith("eyJ")) {
    throw new Error("Supabase server access requires a secret or service-role key, not a publishable key.");
  }
  return { url, key };
}

export function supabaseServerHeaders(key: string) {
  const headers: Record<string, string> = {
    apikey: key,
    "Content-Type": "application/json",
  };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

function encodeFilter(filter: Exclude<SupabaseFilter, { raw: string }>) {
  const operator = filter.operator ?? "eq";
  if (operator === "in" && Array.isArray(filter.value)) {
    return `${encodeURIComponent(filter.column)}=in.(${filter.value.map((value) => encodeURIComponent(String(value))).join(",")})`;
  }
  if (operator === "is" && filter.value === null) {
    return `${encodeURIComponent(filter.column)}=is.null`;
  }
  return `${encodeURIComponent(filter.column)}=${operator}.${encodeURIComponent(String(filter.value))}`;
}

export async function supabaseServerRequest(path: string, init: RequestInit = {}) {
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
    const safeDetail = detail.replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[redacted-key]").slice(0, 400);
    throw new Error(`Supabase request failed with status ${response.status}${safeDetail ? `: ${safeDetail}` : "."}`);
  }
  return response;
}

export async function selectRows<T>(table: string, options: {
  select?: string;
  filters?: SupabaseFilter[];
  orderBy?: string;
  limit?: number;
} = {}) {
  const params = [
    `select=${encodeURIComponent(options.select ?? "*")}`,
    ...(options.filters ?? []).map((filter) => "raw" in filter ? filter.raw : encodeFilter(filter)),
    ...(options.orderBy ? [`order=${encodeURIComponent(options.orderBy)}`] : []),
    ...(typeof options.limit === "number" ? [`limit=${options.limit}`] : []),
  ];
  const response = await supabaseServerRequest(`${table}?${params.join("&")}`);
  return response.json() as Promise<T[]>;
}

export async function insertRows<T extends Record<string, unknown>>(table: string, rows: T[], options: { returning?: "minimal" | "representation" } = {}) {
  if (!rows.length) return [] as T[];
  const response = await supabaseServerRequest(table, {
    method: "POST",
    headers: {
      Prefer: `return=${options.returning ?? "representation"}`,
    },
    body: JSON.stringify(rows),
  });
  if (options.returning === "minimal") return [] as T[];
  return response.json() as Promise<T[]>;
}

export async function upsertRows<T extends Record<string, unknown>>(table: string, rows: T[], conflictColumns: string[], options: { returning?: "minimal" | "representation" } = {}) {
  if (!rows.length) return [] as T[];
  const response = await supabaseServerRequest(`${table}?on_conflict=${encodeURIComponent(conflictColumns.join(","))}`, {
    method: "POST",
    headers: {
      Prefer: `resolution=merge-duplicates,return=${options.returning ?? "representation"}`,
    },
    body: JSON.stringify(rows),
  });
  if (options.returning === "minimal") return [] as T[];
  return response.json() as Promise<T[]>;
}

export async function updateRows<T extends Record<string, unknown>>(table: string, filters: SupabaseFilter[], patch: T, options: { returning?: "minimal" | "representation" } = {}) {
  const params = (filters ?? []).map((filter) => "raw" in filter ? filter.raw : encodeFilter(filter));
  const response = await supabaseServerRequest(`${table}?${params.join("&")}`, {
    method: "PATCH",
    headers: {
      Prefer: `return=${options.returning ?? "representation"}`,
    },
    body: JSON.stringify(patch),
  });
  if (options.returning === "minimal") return [] as T[];
  return response.json() as Promise<T[]>;
}

export async function deleteRows(table: string, filters: SupabaseFilter[]) {
  const params = (filters ?? []).map((filter) => "raw" in filter ? filter.raw : encodeFilter(filter));
  await supabaseServerRequest(`${table}?${params.join("&")}`, {
    method: "DELETE",
    headers: {
      Prefer: "return=minimal",
    },
  });
}
