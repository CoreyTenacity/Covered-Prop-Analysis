import type { ParlayOptionsResponse } from "@/lib/knowledge/read-types";

export type ParlayOptionsFetchOutcome =
  | { kind: "success"; data: ParlayOptionsResponse }
  | { kind: "error"; message: string };

/**
 * `cache: "no-store"` on purpose, not `force-cache`: the Fetch spec's `force-cache` mode reuses
 * any matching browser cache entry "no matter how old it is", so once a browser cached an empty
 * pre-publication response it would never observe a newer published snapshot at all. The public
 * snapshot route's own `Cache-Control: public, s-maxage=120, stale-while-revalidate=900` header
 * still bounds the actual backend/Supabase read to roughly once every two minutes at Cloudflare's
 * shared edge cache regardless of this client-side mode -- `no-store` only stops the browser from
 * holding an indefinitely-stale private copy on top of that.
 */
export async function fetchParlayOptions(fetchImpl: typeof fetch = fetch): Promise<ParlayOptionsFetchOutcome> {
  try {
    const response = await fetchImpl("/api/knowledge/parlay-options", {
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok) throw new Error("Could not load manual parlay options.");
    const data = (await response.json()) as ParlayOptionsResponse;
    return { kind: "success", data };
  } catch (reason) {
    return { kind: "error", message: reason instanceof Error ? reason.message : "Could not load manual parlay options." };
  }
}
