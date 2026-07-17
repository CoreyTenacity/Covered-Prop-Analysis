"use client";

import { useEffect, useMemo, useState } from "react";

import { PickCard } from "@/components/knowledge/pick-card";
import { filterCoveredPicksSnapshotRows } from "@/lib/knowledge/public-snapshots";
import type { CoveredPickRow, CoveredPicksResponse } from "@/lib/knowledge/read-types";

const leagues = [
  { label: "All leagues", value: "" },
  { label: "MLB", value: "mlb" },
  { label: "WNBA", value: "wnba" },
  { label: "NBA", value: "nba" },
];

const sports = [
  { label: "All sports", value: "" },
  { label: "Baseball", value: "baseball" },
  { label: "Basketball", value: "basketball" },
];

// Must match the labels produced by confidenceLabelFor() in lib/knowledge/adapters/base.ts
// (High/Medium/Low Confidence + Data Limited). The prior "Solid"/"Limited" options never
// matched any scored row, and "Medium Confidence" — the most common real label — was missing.
const confidenceOptions = ["", "High Confidence", "Medium Confidence", "Low Confidence", "Data Limited"];
const riskOptions = ["", "Low Risk", "Moderate Risk", "Elevated Risk", "High Risk"];

function easternToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function queryString(filters: Record<string, string | number | boolean | null | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return params.toString();
}

export function CoveredPicksShell() {
  const [data, setData] = useState<CoveredPicksResponse | null>(null);
  const [authUser, setAuthUser] = useState<{ id: string; displayName: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sport, setSport] = useState("");
  const [league, setLeague] = useState("");
  const [date, setDate] = useState(easternToday());
  const [marketType, setMarketType] = useState("");
  const [sportsbook, setSportsbook] = useState("");
  const [minimumCoveredScore, setMinimumCoveredScore] = useState("70");
  const [confidenceLabel, setConfidenceLabel] = useState("");
  const [riskLabel, setRiskLabel] = useState("");
  const [savingPickId, setSavingPickId] = useState<string | null>(null);
  const [savedPickIds, setSavedPickIds] = useState<Record<string, string>>({});
  const [saveMessages, setSaveMessages] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((response) => response.json() as Promise<{ user: { id: string; displayName: string } | null }>)
      .then((payload) => {
        if (!cancelled) setAuthUser(payload.user);
      })
      .catch(() => {
        if (!cancelled) setAuthUser(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!authUser) return;
    let cancelled = false;
    fetch("/api/me/picks", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return { rows: [] as Array<{ id: string; current_prop_id?: string | null }> };
        return response.json() as Promise<{ rows: Array<{ id: string; current_prop_id?: string | null }> }>;
      })
      .then((payload) => {
        if (cancelled) return;
        const next: Record<string, string> = {};
        for (const row of payload.rows ?? []) {
          if (row.current_prop_id) next[row.current_prop_id] = row.id;
        }
        setSavedPickIds(next);
      })
      .catch(() => {
        if (!cancelled) setSavedPickIds({});
      });
    return () => {
      cancelled = true;
    };
  }, [authUser]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");

    fetch("/api/knowledge/covered-picks", {
      cache: "force-cache",
      credentials: "omit",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load Covered Picks of the Day.");
        return response.json() as Promise<CoveredPicksResponse>;
      })
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load Covered Picks of the Day.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const displayedRows = useMemo(() => filterCoveredPicksSnapshotRows(data?.rows ?? [], {
    date,
    sport,
    league,
    marketType,
    sportsbook,
    minimumCoveredScore: Number(minimumCoveredScore) || undefined,
    minimumConfidenceScore: undefined,
    scoreLabel: null,
    confidenceLabel: confidenceLabel || null,
    riskLabel: riskLabel || null,
    excludeHighRisk: false,
    excludeUnsupportedMarkets: false,
    startTimeFrom: null,
    startTimeTo: null,
    limit: 6,
    includeVariantBooks: false,
  }), [data, date, sport, league, marketType, sportsbook, minimumCoveredScore, confidenceLabel, riskLabel]);

  const marketOptions = useMemo(() => {
    const seen = new Set<string>();
    const options = [{ label: "All markets", value: "" }];
    for (const row of data?.rows ?? []) {
      if (!row.market_type || seen.has(row.market_type)) continue;
      seen.add(row.market_type);
      options.push({ label: row.market_display_label ?? row.market_type, value: row.market_type });
    }
    return options;
  }, [data]);

  const sportsbookOptions = useMemo(() => {
    const seen = new Set<string>();
    const options = [{ label: "All sportsbooks", value: "" }];
    for (const row of data?.rows ?? []) {
      if (!row.sportsbook?.code || seen.has(row.sportsbook.code)) continue;
      seen.add(row.sportsbook.code);
      options.push({ label: row.sportsbook.display_name, value: row.sportsbook.code });
    }
    return options;
  }, [data]);

  async function savePick(pick: CoveredPickRow) {
    setSavingPickId(pick.current_prop_id);
    setSaveMessages((current) => ({ ...current, [pick.current_prop_id]: "" }));

    const oddsTaken = (() => {
      const normalizedSide = (pick.side ?? "").toLowerCase();
      if (normalizedSide === "more" || normalizedSide === "over") return pick.over_price ?? pick.under_price ?? null;
      if (normalizedSide === "less" || normalizedSide === "under") return pick.under_price ?? pick.over_price ?? null;
      return pick.over_price ?? pick.under_price ?? null;
    })();

    try {
      const response = await fetch("/api/me/picks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scoredPropId: pick.scored_prop_id,
          currentPropId: pick.current_prop_id,
          oddsSnapshotId: pick.odds_snapshot_id,
          eventId: pick.event_id,
          participantId: pick.participant_id,
          marketInstanceKey: pick.market_instance_key,
          marketType: pick.market_type,
          side: pick.side,
          line: pick.line,
          oddsTaken,
          sportsbookId: pick.sportsbook_id,
          stakeUnits: 1,
        }),
      });

      const payload = await response.json().catch(() => ({})) as { error?: string; row?: { id?: string } | null };
      if (response.status === 409) {
        setSavedPickIds((current) => ({ ...current, [pick.current_prop_id]: payload.row?.id ?? "duplicate" }));
        setSaveMessages((current) => ({ ...current, [pick.current_prop_id]: payload.error ?? "Already saved." }));
        return;
      }
      if (!response.ok) throw new Error(payload.error ?? "Could not save this pick.");

      setSavedPickIds((current) => ({ ...current, [pick.current_prop_id]: payload.row?.id ?? "saved" }));
      setSaveMessages((current) => ({ ...current, [pick.current_prop_id]: "Saved to My Picks." }));
    } catch (reason) {
      setSaveMessages((current) => ({
        ...current,
        [pick.current_prop_id]: reason instanceof Error ? reason.message : "Could not save this pick.",
      }));
    } finally {
      setSavingPickId(null);
    }
  }

  return (
    <div className="page-wrap">
      <header className="page-hero">
        <div>
          <div className="eyebrow"><span /> Public research board</div>
          <h1>Covered Picks of the Day</h1>
          <p>Public, read-only ranked props from the scored knowledge layer. No account is needed to browse or compare the board.</p>
        </div>
      </header>

      <section className="knowledge-filter-bar">
        <input
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          aria-label="Pick date"
          className="knowledge-search"
        />
        <select value={sport} onChange={(event) => setSport(event.target.value)}>{sports.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <select value={league} onChange={(event) => setLeague(event.target.value)}>{leagues.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <select value={marketType} onChange={(event) => setMarketType(event.target.value)}>{marketOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <select value={sportsbook} onChange={(event) => setSportsbook(event.target.value)}>{sportsbookOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <select value={minimumCoveredScore} onChange={(event) => setMinimumCoveredScore(event.target.value)}>
          <option value="50">50+ Covered Score</option>
          <option value="60">60+ Covered Score</option>
          <option value="70">70+ Covered Score</option>
        </select>
        <select value={confidenceLabel} onChange={(event) => setConfidenceLabel(event.target.value)}>{confidenceOptions.map((option) => <option key={option} value={option}>{option || "Any confidence"}</option>)}</select>
        <select value={riskLabel} onChange={(event) => setRiskLabel(event.target.value)}>{riskOptions.map((option) => <option key={option} value={option}>{option || "Any risk"}</option>)}</select>
      </section>

      {loading ? <div className="empty-state"><strong>Loading Covered Picks of the Day…</strong><span>Pulling the latest ranked scored props from the backend read layer.</span></div> : null}
      {!loading && error ? <div className="empty-state"><strong>Couldn’t load Covered Picks of the Day.</strong><span>{error}</span></div> : null}
      {!loading && !error && !displayedRows.length ? <div className="empty-state"><strong>No Covered Picks are available right now.</strong><span>Scored props may already exist, but nothing has cleared the current public board floor yet. Try widening the filters or lowering the minimum Covered Score.</span></div> : null}

      {!loading && !error && displayedRows.length ? (
        <section className="opportunity-grid" aria-live="polite">
          {displayedRows.map((pick, index) => (
            <PickCard
              key={pick.scored_prop_id}
              pick={pick}
              rank={index + 1}
              canSave={Boolean(authUser)}
              saveHref="/login?next=%2Ftoday"
              saveState={savedPickIds[pick.current_prop_id] ? "saved" : savingPickId === pick.current_prop_id ? "saving" : "idle"}
              saveMessage={saveMessages[pick.current_prop_id]}
              onSave={savePick}
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}
