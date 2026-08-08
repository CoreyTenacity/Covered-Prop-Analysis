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
  // Session 117: market freshness now reads odds_snapshots.pulled_at via
  // current_props.latest_snapshot_id (loadOddsSnapshotPulledAt in
  // read-service.ts), NEVER current_props.updated_at -- see market-freshness.ts's
  // doc comment for the production defect (run 31129018935) this closes. Every
  // fixture across this codebase that seeds current_props but not odds_snapshots
  // was written assuming updated_at alone controlled freshness. Rather than
  // hand-edit every call site, auto-derive a matching odds_snapshots row
  // (pulled_at = that prop's own updated_at) for any current_props row whose
  // latest_snapshot_id has no EXPLICIT odds_snapshots entry in this seed --
  // reproducing the pre-fix behavior automatically. A test proving the fix
  // itself supplies its own explicit odds_snapshots entry (a genuinely stale
  // pulled_at alongside a fresh updated_at, e.g. an identity-repair shape),
  // which always wins over this derivation.
  // An explicit `odds_snapshots` key (even an empty array) means the test wants full,
  // deliberate control over which snapshots exist -- e.g. proving the "no matching
  // odds_snapshots row at all" (never_observed) case -- so it opts OUT of derivation
  // entirely. Only a seed that never mentions odds_snapshots gets the auto-derived,
  // backward-compatible-with-updated_at rows.
  const currentPropsSeed = ("odds_snapshots" in seed ? [] : (seed.current_props ?? [])) as Array<FixtureRow & { latest_snapshot_id?: unknown; updated_at?: unknown }>;
  if (currentPropsSeed.length) {
    const oddsSnapshots = tables.get("odds_snapshots") ?? [];
    const explicitSnapshotIds = new Set(oddsSnapshots.map((row) => String((row as FixtureRow & { id?: unknown }).id)));
    const seenIds = new Set<string>();
    for (const prop of currentPropsSeed) {
      const snapshotId = typeof prop.latest_snapshot_id === "string" ? prop.latest_snapshot_id : null;
      if (!snapshotId || explicitSnapshotIds.has(snapshotId) || seenIds.has(snapshotId)) continue;
      seenIds.add(snapshotId);
      oddsSnapshots.push({ id: snapshotId, pulled_at: (prop.updated_at as string | null) ?? null });
    }
    tables.set("odds_snapshots", oddsSnapshots);
  }
  const calls: Array<{ method: string; table: string }> = [];

  function matches(row: FixtureRow, key: string, rawValue: string): boolean {
    // Session 92: `or`/`and` are PostgREST combinators, not real columns -- a bare
    // `row["or"]` lookup would never match any comparison operator and silently fell
    // through to the default `return true` below, meaning every `{ raw: "or=(...)" }`
    // filter used anywhere in this codebase (e.g. the bounded delete-batch filters in
    // sportsdataverse-wnba.ts, the future-or-null start_time filters in read-service.ts)
    // was being treated as an unconditional match rather than actually evaluated -- a
    // real gap that could have hidden a real filtering bug behind a passing test. Now
    // parsed and evaluated for real, including arbitrary and()/or() nesting.
    if (key === "or" || key === "and") {
      // The top-level combinator is the key itself (or=/and=), not inferable from the
      // bare "(...)" wrapper alone -- pass it through explicitly rather than guessing.
      const inner = rawValue.trim().replace(/^\(|\)$/g, "");
      const conditions = splitTopLevel(inner).map((cond) => evalPostgrestExpr(cond, row));
      return key === "or" ? conditions.some(Boolean) : conditions.every(Boolean);
    }
    if (rawValue.startsWith("in.(") && rawValue.endsWith(")")) {
      const expected = rawValue.slice(4, -1).split(",").filter(Boolean);
      return expected.includes(String(row[key] ?? ""));
    }
    if (rawValue.startsWith("eq.")) return String(row[key] ?? "") === rawValue.slice(3);
    const comparisonMatch = /^(gte|lte|gt|lt)\.(.*)$/.exec(rawValue);
    if (comparisonMatch) {
      const [, operator, raw] = comparisonMatch;
      const rowValue = row[key];
      const numericRow = Number(rowValue);
      const numericTarget = Number(raw);
      const comparable = Number.isFinite(numericRow) && Number.isFinite(numericTarget)
        ? [numericRow, numericTarget] as const
        : [String(rowValue ?? ""), raw] as const;
      if (operator === "gte") return comparable[0] >= comparable[1];
      if (operator === "lte") return comparable[0] <= comparable[1];
      if (operator === "gt") return comparable[0] > comparable[1];
      return comparable[0] < comparable[1];
    }
    if (rawValue === "is.null") return rowValue_isNull(row[key]);
    return true;
  }

  function rowValue_isNull(value: unknown) {
    return value === null || value === undefined;
  }

  // Splits a PostgREST combinator's inner content on top-level commas only -- a comma
  // inside a nested and(...)/or(...) group must not be treated as a separator between
  // sibling conditions.
  function splitTopLevel(inner: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      else if (ch === "," && depth === 0) {
        parts.push(inner.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(inner.slice(start));
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  // Recursively evaluates a PostgREST filter expression -- a leaf `column.op.value`, or
  // a nested `and(...)`/`or(...)` combinator -- against one row. The bare top-level
  // "(cond1,cond2)" wrapper (from `or=`/`and=`) is unwrapped by `matches()` above, which
  // already knows the correct top-level combinator from the query key itself; this
  // function only ever sees leaves or explicitly-named nested groups.
  function evalPostgrestExpr(expr: string, row: FixtureRow): boolean {
    const trimmed = expr.trim();
    if (trimmed.startsWith("and(") && trimmed.endsWith(")")) {
      return splitTopLevel(trimmed.slice(4, -1)).every((cond) => evalPostgrestExpr(cond, row));
    }
    if (trimmed.startsWith("or(") && trimmed.endsWith(")")) {
      return splitTopLevel(trimmed.slice(3, -1)).some((cond) => evalPostgrestExpr(cond, row));
    }
    // Leaf condition: "column.operator.value" (operator/value may itself contain dots,
    // e.g. an ISO timestamp -- only the FIRST dot separates column from the rest).
    const dotIndex = trimmed.indexOf(".");
    if (dotIndex === -1) return true; // malformed leaf -- fail open exactly like the pre-existing default, not a new behavior
    const column = trimmed.slice(0, dotIndex);
    const rest = trimmed.slice(dotIndex + 1);
    return matches(row, column, rest);
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
      // A row is deleted only if it matches EVERY filter (AND, mirroring
      // PostgREST's real semantics and this harness's own GET/PATCH matching
      // below) -- not if it matches ANY single filter. The prior OR-shaped
      // check meant a delete scoped narrowly by e.g. team_id would still wipe
      // out every row sharing only the broader, non-distinguishing filters
      // (league_id, report_source, injury_date) -- exactly the shape of a
      // per-team delete-then-insert loop sharing those filters across teams.
      const kept = rows.filter((row) => {
        for (const [key, value] of url.searchParams.entries()) {
          if (key === "select") continue;
          if (!matches(row, key, value)) return true;
        }
        return false;
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
