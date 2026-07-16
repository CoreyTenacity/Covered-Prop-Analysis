import { getProviderCache, getProviderUsageSnapshot } from "@/lib/db/provider-cache";
import type { Sport } from "@/lib/types";
import { SportsGameOddsEventBrowser } from "@/components/providers/sports-game-odds-event-browser";
import { getSportsGameOddsAuditLog } from "@/lib/providers/sports-game-odds-audit";

type SportsGameOddsStatus = {
  sport: Sport;
  sportKey: string;
  status: string;
  cost?: number;
  remaining?: number | null;
  normalized?: number;
  rejected?: number;
  usage?: { allowed?: boolean; daily_used?: number; monthly_used?: number | null };
  reason?: string;
  error?: string;
};

type SportsGameOddsRefreshSummary = {
  mode: string;
  propCallsEnabled: boolean;
  propCallsAttempted: number;
  sgoResults: Array<Record<string, unknown>>;
  injuryResults: Array<Record<string, unknown>>;
  refreshedAt: string;
};

function sportFromSportsGameOddsKey(sportKey: string): Sport | null {
  const normalized = sportKey.toLowerCase();
  if (normalized.includes("baseball_mlb") || normalized === "mlb") return "MLB";
  if (normalized.includes("basketball_wnba") || normalized === "wnba") return "WNBA";
  if (normalized.includes("basketball_nba") || normalized === "nba") return "NBA";
  if (normalized.includes("americanfootball_nfl") || normalized === "nfl") return "NFL";
  if (normalized.startsWith("tennis")) return "Tennis";
  return null;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" }).format(new Date(value));
}

export async function SportsGameOddsSlate() {
  const [dedicatedRefreshCache, usageSnapshot, auditLog] = await Promise.all([
    getProviderCache<SportsGameOddsRefreshSummary>("sports-game-odds-refresh:latest"),
    getProviderUsageSnapshot("sports-game-odds"),
    getSportsGameOddsAuditLog(),
  ]);
  const latestSportsGameOddsRefresh = dedicatedRefreshCache?.payload ?? null;

  const statusBySport = new Map<Sport, SportsGameOddsStatus>();
  for (const item of latestSportsGameOddsRefresh?.sgoResults ?? []) {
    const sportKey = typeof item.sportKey === "string" ? item.sportKey : "";
    const sport = typeof item.sport === "string" ? item.sport as Sport : sportFromSportsGameOddsKey(sportKey);
    if (!sport) continue;
    statusBySport.set(sport, {
      sport,
      sportKey,
      status: typeof item.status === "string" ? item.status : "unknown",
      cost: typeof item.cost === "number" ? item.cost : undefined,
      remaining: typeof item.remaining === "number" || item.remaining === null ? item.remaining : undefined,
      normalized: typeof item.normalized === "number" ? item.normalized : undefined,
      rejected: typeof item.rejected === "number" ? item.rejected : undefined,
      usage: typeof item.usage === "object" && item.usage ? item.usage as SportsGameOddsStatus["usage"] : undefined,
      reason: typeof item.reason === "string" ? item.reason : undefined,
      error: typeof item.error === "string" ? item.error : undefined,
    });
  }

  const auditEntries = auditLog?.payload?.entries ?? [];
  const totalProps = auditEntries.flatMap((entry) => entry.events).reduce((sum, event) => sum + event.propCount, 0);
  const discoveredEvents = auditEntries.flatMap((entry) => entry.events).length;
  const successfulPulls = (latestSportsGameOddsRefresh?.sgoResults ?? []).filter((item) => item.status === "fetched" || item.status === "cached").length;
  const blockedPulls = (latestSportsGameOddsRefresh?.sgoResults ?? []).filter((item) => item.status === "budget-blocked").length;
  const providerErrors = (latestSportsGameOddsRefresh?.sgoResults ?? []).filter((item) => item.status === "provider-error").length;
  const dailyBudgetUsed = usageSnapshot.daily?.units_used ?? 0;
  const dailyBudgetLimit = usageSnapshot.daily?.hard_budget ?? null;
  const monthlyBudgetUsed = usageSnapshot.monthly?.units_used ?? 0;
  const monthlyBudgetLimit = usageSnapshot.monthly?.hard_budget ?? null;

  return (
    <div className="page-wrap settings-page">
      <header className="page-hero">
        <div>
          <div className="eyebrow"><span /> Provider audit</div>
          <h1>SportsGameOdds</h1>
          <p>Inspect what SportsGameOdds actually stored, where it was blocked, and how many usable player-prop rows made it into cache.</p>
        </div>
      </header>

      <section className="settings-section">
        <div className="settings-section__head">
          <div>
            <span>Latest cache</span>
            <h2>What SportsGameOdds stored most recently</h2>
          </div>
          <p>The page starts with the latest refresh summary, then opens into the event-by-event pull history underneath it.</p>
        </div>

        <article className="settings-card settings-card--wide">
          <span>Latest refresh snapshot</span>
          <strong>{latestSportsGameOddsRefresh ? `${latestSportsGameOddsRefresh.mode ?? "refresh"} · ${formatDateTime(latestSportsGameOddsRefresh.refreshedAt)}` : "No refresh audit cached yet"}</strong>
          <p>SportsGameOdds is billed per event object, so this page tracks event-level fetches first and the stored player props inside those events second.</p>
          <div className="refresh-timing-grid" style={{ marginTop: 14 }}>
            <div className="refresh-timing-card">
              <span>Event discovery</span>
              <strong>{discoveredEvents} events</strong>
              <small>SportsGameOdds returns event objects directly, so this is the unique future-event count inside today’s ET audit log.</small>
            </div>
            <div className="refresh-timing-card">
              <span>Successful prop pulls</span>
              <strong>{successfulPulls}</strong>
              <small>{(["MLB", "WNBA"] as const).map((sport) => {
                const status = statusBySport.get(sport);
                return status?.normalized ? `${sport} ${status.normalized}` : null;
              }).filter(Boolean).join(" · ") || "No normalized props stored yet"}</small>
            </div>
            <div className="refresh-timing-card">
              <span>Blocked pulls</span>
              <strong>{blockedPulls}</strong>
              <small>{providerErrors ? `${providerErrors} provider error${providerErrors === 1 ? "" : "s"}` : "No provider errors in the latest snapshot"}</small>
            </div>
            <div className="refresh-timing-card">
              <span>Stored prop rows</span>
              <strong>{totalProps}</strong>
              <small>{auditEntries.length} audit entr{auditEntries.length === 1 ? "y" : "ies"} cached for the ET day</small>
            </div>
            <div className="refresh-timing-card">
              <span>Budget usage</span>
              <strong>{dailyBudgetLimit !== null ? `${dailyBudgetUsed} / ${dailyBudgetLimit}` : String(dailyBudgetUsed)}</strong>
              <small>ET day {usageSnapshot.usageDate}{monthlyBudgetLimit !== null ? ` · month ${monthlyBudgetUsed} / ${monthlyBudgetLimit}` : ""}</small>
            </div>
          </div>

          {latestSportsGameOddsRefresh && (
            <div className="coverage-grid" style={{ marginTop: 12 }}>
              <div className="coverage-card">
                <div className="coverage-card__head">
                  <strong>Per-sport status</strong>
                  <span>{latestSportsGameOddsRefresh.propCallsAttempted} attempted</span>
                </div>
                <ul>
                  {(["MLB", "WNBA"] as const).map((sport) => {
                    const status = statusBySport.get(sport);
                    return (
                      <li key={sport}>
                        <strong>{sport}</strong>
                        <span>{status?.status ?? "no refresh audit yet"}{typeof status?.cost === "number" ? ` · cost ${status.cost}` : ""}{typeof status?.remaining === "number" ? ` · ${status.remaining} remaining` : ""}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div className="coverage-card">
                <div className="coverage-card__head">
                  <strong>Stored rows by sport</strong>
                  <span>latest cache</span>
                </div>
                <ul>
                  {(["MLB", "WNBA"] as const).map((sport) => {
                    const status = statusBySport.get(sport);
                    return (
                      <li key={`${sport}-rows`}>
                        <strong>{sport}</strong>
                        <span>{status?.normalized ?? 0} normalized · {status?.rejected ?? 0} rejected</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          )}
        </article>

        <article className="settings-card settings-card--wide">
          <span>SportsGameOdds audit</span>
          <strong>{auditEntries.length} audit entr{auditEntries.length === 1 ? "y" : "ies"} · {totalProps} stored prop rows</strong>
          <p>Each event opens to the raw market types, the stored player props, and the latest source/budget status for that event.</p>
          <SportsGameOddsEventBrowser auditEntries={auditEntries} />
        </article>
      </section>
    </div>
  );
}
