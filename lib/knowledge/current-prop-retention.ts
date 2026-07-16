import { deleteRows, selectRows, updateRows } from "@/lib/db/supabase-server";

function chunk<T>(values: T[], size: number) {
  const safeSize = Math.max(1, Math.floor(size));
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += safeSize) {
    groups.push(values.slice(index, index + safeSize));
  }
  return groups;
}

type RetireStartedCurrentPropsOptions = {
  league?: string | null;
  limit?: number;
};

type PruneInactiveCurrentPropsOptions = {
  league?: string | null;
  limit?: number;
  bufferHours?: number;
};

type RetireableCurrentPropRow = {
  id: string;
  start_time: string | null;
};

export async function retireStartedCurrentProps(
  options: RetireStartedCurrentPropsOptions = {},
) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const rows = await selectRows<RetireableCurrentPropRow>("current_props", {
    select: "id,start_time",
    filters: [
      { column: "active", value: true },
      { raw: `start_time=lte.${encodeURIComponent(nowIso)}` },
      ...(options.league ? [{ column: "league_id", value: options.league }] : []),
    ],
    orderBy: "start_time.asc",
    limit: Math.min(Math.max(options.limit ?? 250, 1), 1000),
  });

  const expiredIds = rows.map((row) => row.id);

  if (!expiredIds.length) {
    return { retiredCount: 0 };
  }

  for (const batch of chunk(expiredIds, 50)) {
    await updateRows(
      "current_props",
      [{ raw: `id=in.(${batch.join(",")})` }],
      {
        active: false,
        prop_state: "expired",
        updated_at: nowIso,
      },
      { returning: "minimal" },
    );
  }

  return { retiredCount: expiredIds.length };
}

type PrunableCurrentPropRow = {
  id: string;
  start_time: string | null;
  updated_at?: string | null;
};

export async function pruneInactiveCurrentProps(
  options: PruneInactiveCurrentPropsOptions = {},
) {
  const bufferHours = Math.min(Math.max(options.bufferHours ?? 18, 1), 24 * 14);
  const cutoffMs = Date.now() - bufferHours * 60 * 60 * 1000;
  const rows = await selectRows<PrunableCurrentPropRow>("current_props", {
    select: "id,start_time,updated_at",
    filters: [
      { column: "active", value: false },
      ...(options.league ? [{ column: "league_id", value: options.league }] : []),
    ],
    orderBy: "updated_at.asc",
    limit: Math.min(Math.max(options.limit ?? 200, 1), 2000),
  });

  const pruneIds = rows
    .filter((row) => {
      const referenceTime = row.start_time ?? row.updated_at ?? null;
      if (!referenceTime) return false;
      const timeMs = new Date(referenceTime).getTime();
      return Number.isFinite(timeMs) && timeMs <= cutoffMs;
    })
    .map((row) => row.id);

  if (!pruneIds.length) {
    return {
      prunedCount: 0,
      bufferHours,
    };
  }

  for (const batch of chunk(pruneIds, 50)) {
    await deleteRows("current_props", [
      { column: "id", operator: "in", value: batch },
    ]);
  }

  return {
    prunedCount: pruneIds.length,
    bufferHours,
  };
}
