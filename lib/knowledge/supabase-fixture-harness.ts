import { mock } from "node:test";

export type FixtureRow = Record<string, unknown>;

/**
 * A generic in-memory PostgREST-shaped mock keyed by table name, for offline
 * end-to-end tests. Every scoring-service, read-service, public-snapshots, and
 * enrichment call goes through lib/db/supabase-server.ts or lib/db/provider-cache.ts,
 * both of which hit `${url}/rest/v1/${table}?...` with the same eq./in./gte./lte.
 * filter query-string convention -- so one generic handler covers every table an
 * offline integration test touches instead of a bespoke branch per table.
 *
 * Only intercepts requests whose host matches `restHost` (default: any `/rest/v1/`
 * path), so callers that also mock a second, non-Supabase host (e.g. a public
 * provider API) can layer their own handler around this one.
 */
export function createSupabaseFixture(
  seed: Record<string, FixtureRow[]>,
  options: { onOtherRequest?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } = {},
) {
  const tables = new Map<string, FixtureRow[]>(Object.entries(seed).map(([table, rows]) => [table, [...rows]]));
  const calls: Array<{ method: string; table: string }> = [];

  function matches(row: FixtureRow, key: string, rawValue: string): boolean {
    if (rawValue.startsWith("in.(") && rawValue.endsWith(")")) {
      const expected = rawValue.slice(4, -1).split(",").filter(Boolean);
      return expected.includes(String(row[key] ?? ""));
    }
    if (rawValue.startsWith("eq.")) return String(row[key] ?? "") === rawValue.slice(3);
    if (rawValue.startsWith("gte.") || rawValue.startsWith("lte.")) {
      const operator = rawValue.slice(0, 3);
      const raw = rawValue.slice(4);
      const rowValue = row[key];
      const numericRow = Number(rowValue);
      const numericTarget = Number(raw);
      const comparable = Number.isFinite(numericRow) && Number.isFinite(numericTarget)
        ? [numericRow, numericTarget] as const
        : [String(rowValue ?? ""), raw] as const;
      return operator === "gte" ? comparable[0] >= comparable[1] : comparable[0] <= comparable[1];
    }
    if (rawValue === "is.null") return rowValue_isNull(row[key]);
    return true;
  }

  function rowValue_isNull(value: unknown) {
    return value === null || value === undefined;
  }

  function respondToRest(method: string, table: string, url: URL, init?: RequestInit) {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (method === "GET") {
      const rows = (tables.get(table) ?? []).filter((row) => {
        for (const [key, value] of url.searchParams.entries()) {
          if (["select", "order", "limit", "on_conflict"].includes(key)) continue;
          if (!matches(row, key, value)) return false;
        }
        return true;
      });
      return json(rows);
    }

    if (method === "POST") {
      const body = JSON.parse(String(init?.body ?? "[]")) as FixtureRow | FixtureRow[];
      const incoming = Array.isArray(body) ? body : [body];
      const onConflict = url.searchParams.get("on_conflict")?.split(",").filter(Boolean) ?? null;
      const existing = tables.get(table) ?? [];
      const written: FixtureRow[] = [];
      for (const row of incoming) {
        const withId: FixtureRow = { id: row.id ?? `${table}-${existing.length + written.length + 1}`, ...row };
        const conflictIndex = onConflict
          ? existing.findIndex((candidate) => onConflict.every((column) => String(candidate[column] ?? "") === String(withId[column] ?? "")))
          : -1;
        if (conflictIndex >= 0) existing[conflictIndex] = { ...existing[conflictIndex], ...withId };
        else existing.push(withId);
        written.push(withId);
      }
      tables.set(table, existing);
      return json(written, 201);
    }

    if (method === "PATCH") {
      const patch = JSON.parse(String(init?.body ?? "{}")) as FixtureRow;
      const rows = tables.get(table) ?? [];
      const matched = rows.filter((row) => {
        for (const [key, value] of url.searchParams.entries()) {
          if (["select", "order", "limit"].includes(key)) continue;
          if (!matches(row, key, value)) return false;
        }
        return true;
      });
      for (const row of matched) Object.assign(row, patch);
      return json(matched);
    }

    if (method === "DELETE") {
      const rows = tables.get(table) ?? [];
      const kept = rows.filter((row) => {
        for (const [key, value] of url.searchParams.entries()) {
          if (key === "select") continue;
          if (matches(row, key, value)) return false;
        }
        return true;
      });
      tables.set(table, kept);
      return new Response(null, { status: 204 });
    }

    return json([]);
  }

  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = new URL(String(input));
    if (!url.pathname.includes("/rest/v1/")) {
      if (options.onOtherRequest) return options.onOtherRequest(input, init);
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const table = url.pathname.split("/rest/v1/").pop()!.split("?")[0];
    calls.push({ method, table });
    return respondToRest(method, table, url, init);
  });

  return { tables, calls };
}
