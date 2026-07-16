import { getProviderCache, putProviderCache } from "@/lib/db/provider-cache";
import { NbaComStatsAdapter, type NbaComLeagueProbe } from "@/lib/providers/nba-com-stats";

type WnbaLeagueSelection = {
  leagueId: string;
  status: NbaComLeagueProbe["status"];
  probe: NbaComLeagueProbe | null;
  candidates: string[];
  refreshedAt: string;
};

function configuredLeagueIds() {
  const raw = process.env.NBA_COM_WNBA_LEAGUE_IDS?.trim() || "10,00";
  return [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
}

function shouldRequireProbe() {
  return process.env.NBA_COM_WNBA_REQUIRE_PROBE?.trim().toLowerCase() === "true";
}

function cacheKey() {
  return "nba-com:wnba-league-id:latest";
}

export async function resolveWnbaLeagueId(now = new Date()): Promise<WnbaLeagueSelection> {
  const candidates = configuredLeagueIds();
  const preferredLeagueId = candidates.includes("10") ? "10" : (candidates[0] ?? "10");
  const cached = await getProviderCache<WnbaLeagueSelection>(cacheKey()).catch(() => null);
  if (cached?.payload?.leagueId && candidates.includes(cached.payload.leagueId) && cached.payload.status === "supported") {
    return cached.payload;
  }

  if (!shouldRequireProbe()) {
    const selection: WnbaLeagueSelection = {
      leagueId: preferredLeagueId,
      status: "supported",
      probe: null,
      candidates,
      refreshedAt: new Date().toISOString(),
    };
    await putProviderCache({
      cacheKey: cacheKey(),
      provider: "nba-com-stats",
      payload: selection,
      expiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString(),
    }).catch(() => {});
    return selection;
  }

  const nba = new NbaComStatsAdapter();
  const probes: NbaComLeagueProbe[] = [];
  let chosen: WnbaLeagueSelection | null = null;

  for (const leagueId of candidates) {
    // Probe one league ID at a time so a timeout on one path does not
    // prematurely rule out the others.
    // eslint-disable-next-line no-await-in-loop
    const probe = await nba.probeLeaguePath(leagueId);
    probes.push(probe);
    if (probe.status === "supported") {
      chosen = {
        leagueId,
        status: probe.status,
        probe,
        candidates,
        refreshedAt: new Date().toISOString(),
      };
      break;
    }
  }

  const fallbackProbe = probes.at(-1) ?? null;
  const selection: WnbaLeagueSelection = chosen ?? {
    leagueId: preferredLeagueId,
    status: fallbackProbe?.status ?? "provider-error",
    probe: fallbackProbe,
    candidates,
    refreshedAt: new Date().toISOString(),
  };

  await putProviderCache({
    cacheKey: cacheKey(),
    provider: "nba-com-stats",
    payload: selection,
    expiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString(),
  }).catch(() => {});

  return selection;
}
