import { NbaComStatsAdapter, type NbaComGameFinderPayload, type NbaComPlayer, type NbaComStatsPayload, type NbaComTeamStatsPayload } from "./nba-com-stats";
import type { ProviderFetchResult } from "./provider-adapter";

/**
 * DEPRECATED - misleading name, kept as a fallback only.
 *
 * Despite the class name, this does NOT call the real SportsDataverse
 * wehoop project (https://wehoop.sportsdataverse.org/) or any ESPN
 * endpoint. It is a thin wrapper around NbaComStatsAdapter that calls
 * stats.nba.com with LeagueID=10. The name predates the discovery that
 * stats.nba.com is unreachable from GitHub Actions runners (confirmed in
 * docs/WNBA_PROVIDER_EVIDENCE_AUDIT.md: both scoreboardv2 and
 * commonallplayers time out completely - 18s, zero bytes - from GitHub
 * Actions, while ESPN and SportsDataverse succeed from the same runner).
 *
 * Replaced by lib/providers/espn-wnba.ts (current data) and
 * lib/knowledge/ingestion/sportsdataverse-wnba.ts (historical data), which
 * are now the DEFAULT WNBA path (see resolveWnbaDataProvider() in
 * lib/knowledge/enrichment/shared.ts - unset or empty WNBA_DATA_PROVIDER
 * resolves to "espn-sportsdataverse", not this adapter). This class now
 * only runs when WNBA_DATA_PROVIDER=legacy-stats-nba is explicitly set.
 * It is kept in the repository for now - do not remove it without
 * confirming the replacement is stable (see docs/WNBA_PROVIDER_EVIDENCE_AUDIT.md,
 * "Cleanup steps" in the rollout report).
 */
export class WeHoopWnbaAdapter {
  readonly id = "wehoop-wnba";
  private readonly nba = new NbaComStatsAdapter();

  configured() {
    return true;
  }

  async probeLeaguePath(leagueId = "10", season?: string) {
    return this.nba.probeLeaguePath(leagueId, season);
  }

  async searchPlayer(playerName: string, leagueId = "10", season?: string): Promise<NbaComPlayer | null> {
    return this.nba.searchPlayer(playerName, leagueId ?? "10", season);
  }

  async fetchCurrentPlayers(leagueId = "10", season?: string): Promise<NbaComPlayer[]> {
    return this.nba.fetchCurrentPlayers(leagueId ?? "10", season);
  }

  async fetchPlayerGameLog(input: { playerId: number; playerName: string; statType: string; season?: string; leagueId?: string; gameId?: string }): Promise<ProviderFetchResult<NbaComStatsPayload> | null> {
    return this.nba.fetchPlayerGameLog({ ...input, leagueId: input.leagueId ?? "10" });
  }

  async fetchLeagueTeamStats(leagueId = "10", season: string, measureType = "Advanced"): Promise<NbaComTeamStatsPayload> {
    return this.nba.fetchLeagueTeamStats(leagueId ?? "10", season, measureType);
  }

  async fetchLeagueGameFinder(leagueId = "10", season: string, seasonType = "Regular Season"): Promise<NbaComGameFinderPayload> {
    return this.nba.fetchLeagueGameFinder(leagueId ?? "10", season, seasonType);
  }

  extractBestGame(payload: NbaComStatsPayload, gameId?: string) {
    return this.nba.extractBestGame(payload, gameId);
  }

  statGroup(statType: string) {
    return this.nba.statGroup(statType);
  }
}
