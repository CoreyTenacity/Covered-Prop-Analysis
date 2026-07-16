"use client";

import { useEffect, useMemo, useState } from "react";

import { KnowledgeAvatar } from "@/components/knowledge/knowledge-avatar";
import { RiskBadge } from "@/components/knowledge/risk-badge";
import { ScoreBadge } from "@/components/knowledge/score-badge";

type SavedSportsbook = {
  id: string;
  code: string;
  display_name: string;
} | null;

type SavedPickRow = {
  id: string;
  current_prop_id?: string | null;
  market_type: string | null;
  side: string | null;
  line: number | null;
  status: string;
  result: string;
  stake_units: number | null;
  notes?: string | null;
  profit_units: number | null;
  odds_taken: number | null;
  created_at: string;
  settled_at?: string | null;
  participant_display_name: string | null;
  participant_image_url: string | null;
  player_headshot_url: string | null;
  team_display_name: string | null;
  team_logo_url: string | null;
  opponent_display_name: string | null;
  opponent_logo_url: string | null;
  event_display_name: string | null;
  start_time: string | null;
  sport: string | null;
  league: string | null;
  sportsbook: SavedSportsbook;
  covered_score: number | null;
  score_label: string | null;
  confidence_label: string | null;
  risk_label: string | null;
  summary: string | null;
};

type SavedParlayLegRow = SavedPickRow & {
  current_prop_id: string | null;
  leg_result?: string | null;
};

type SavedParlayRow = {
  id: string;
  total_legs: number;
  status: string;
  result: string;
  stake_units: number | null;
  notes?: string | null;
  combined_odds: number | null;
  profit_units: number | null;
  created_at: string;
  settled_at?: string | null;
  legs: SavedParlayLegRow[];
};

type FilterValue = "all" | "singles" | "parlays" | "pending" | "completed" | "wins" | "losses" | "pushes";
type SortValue = "newest" | "oldest" | "start_time";

type EditDraft = {
  stakeUnits: string;
  notes: string;
};

type SettlementSummary = {
  processedPicks: number;
  settledPicks: number;
  processedParlays: number;
  settledParlays: number;
  skippedOrPending: number;
  durationMs: number;
};

type PerformanceTotals = {
  total: number;
  pending: number;
  settled: number;
  wins: number;
  losses: number;
  pushes: number;
  noGrades: number;
  hitRate: number | null;
  stakeUnits: number | null;
  profitUnits: number | null;
  roi: number | null;
};

function formatWhen(value: string | null) {
  if (!value) return "TBD";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

function formatSavedAt(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

function formatProfitUnits(value: number | null) {
  if (value === null || value === undefined) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}u`;
}

function formatPercent(value: number | null) {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function prettifyMarket(marketType: string | null) {
  return marketType ? marketType.replace(/_/g, " ") : "Market pending";
}

function prettifyStatus(value: string | null) {
  return (value ?? "pending").replace(/_/g, " ");
}

function sortRows<T extends { created_at: string; start_time?: string | null }>(rows: T[], sort: SortValue) {
  const copy = [...rows];
  if (sort === "oldest") return copy.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  if (sort === "start_time") {
    return copy.sort((a, b) => {
      const left = a.start_time ? new Date(a.start_time).getTime() : Number.MAX_SAFE_INTEGER;
      const right = b.start_time ? new Date(b.start_time).getTime() : Number.MAX_SAFE_INTEGER;
      return left - right || new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }
  return copy.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

function pickMatchesFilter(pick: SavedPickRow, filter: FilterValue) {
  switch (filter) {
    case "singles":
      return true;
    case "parlays":
      return false;
    case "pending":
      return pick.result === "pending";
    case "completed":
      return pick.result !== "pending";
    case "wins":
      return pick.result === "win";
    case "losses":
      return pick.result === "loss";
    case "pushes":
      return pick.result === "push";
    default:
      return true;
  }
}

function parlayMatchesFilter(parlay: SavedParlayRow, filter: FilterValue) {
  switch (filter) {
    case "singles":
      return false;
    case "parlays":
      return true;
    case "pending":
      return parlay.result === "pending";
    case "completed":
      return parlay.result !== "pending";
    case "wins":
      return parlay.result === "win";
    case "losses":
      return parlay.result === "loss";
    case "pushes":
      return parlay.result === "push";
    default:
      return true;
  }
}

function makeDraft(stakeUnits: number | null | undefined, notes: string | null | undefined): EditDraft {
  return {
    stakeUnits: stakeUnits === null || stakeUnits === undefined ? "" : String(stakeUnits),
    notes: notes ?? "",
  };
}

function parseStakeUnits(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Stake units must be a non-negative number.");
  }
  return parsed;
}

function computePerformanceTotals<T extends {
  result: string;
  stake_units: number | null;
  profit_units: number | null;
}>(rows: T[]): PerformanceTotals {
  const totals = {
    total: rows.length,
    pending: 0,
    settled: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    noGrades: 0,
    gradedForHitRate: 0,
    stakeRows: 0,
    profitRows: 0,
    stakeUnits: 0,
    profitUnits: 0,
  };

  for (const row of rows) {
    const result = row.result ?? "pending";
    if (result === "pending") {
      totals.pending += 1;
    } else {
      totals.settled += 1;
    }
    if (result === "win") {
      totals.wins += 1;
      totals.gradedForHitRate += 1;
    } else if (result === "loss") {
      totals.losses += 1;
      totals.gradedForHitRate += 1;
    } else if (result === "push") {
      totals.pushes += 1;
    } else if (result === "no_grade") {
      totals.noGrades += 1;
    }

    if (typeof row.stake_units === "number") {
      totals.stakeUnits += row.stake_units;
      totals.stakeRows += 1;
    }
    if (typeof row.profit_units === "number") {
      totals.profitUnits += row.profit_units;
      totals.profitRows += 1;
    }
  }

  const hitRate = totals.gradedForHitRate > 0 ? totals.wins / totals.gradedForHitRate : null;
  const stakeUnits = totals.stakeRows > 0 ? totals.stakeUnits : null;
  const profitUnits = totals.profitRows > 0 ? totals.profitUnits : null;
  const roi = stakeUnits && profitUnits !== null && stakeUnits > 0 ? profitUnits / stakeUnits : null;

  return {
    total: totals.total,
    pending: totals.pending,
    settled: totals.settled,
    wins: totals.wins,
    losses: totals.losses,
    pushes: totals.pushes,
    noGrades: totals.noGrades,
    hitRate,
    stakeUnits,
    profitUnits,
    roi,
  };
}

export function MyPicksShell() {
  const [picks, setPicks] = useState<SavedPickRow[]>([]);
  const [parlays, setParlays] = useState<SavedParlayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<FilterValue>("all");
  const [sort, setSort] = useState<SortValue>("newest");
  const [removingType, setRemovingType] = useState<{ kind: "pick" | "parlay"; id: string } | null>(null);
  const [editingType, setEditingType] = useState<{ kind: "pick" | "parlay"; id: string } | null>(null);
  const [savingType, setSavingType] = useState<{ kind: "pick" | "parlay"; id: string } | null>(null);
  const [settling, setSettling] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, EditDraft>>({});
  const [feedback, setFeedback] = useState("");

  async function reloadTracking() {
    const [pickPayload, parlayPayload] = await Promise.all([
      fetch("/api/me/picks", { cache: "no-store" }).then(async (response) => {
        if (!response.ok) throw new Error("Could not load your picks.");
        return response.json() as Promise<{ rows: SavedPickRow[] }>;
      }),
      fetch("/api/me/parlays", { cache: "no-store" }).then(async (response) => {
        if (!response.ok) throw new Error("Could not load your parlays.");
        return response.json() as Promise<{ rows: SavedParlayRow[] }>;
      }),
    ]);

    setPicks(pickPayload.rows ?? []);
    setParlays(parlayPayload.rows ?? []);
  }

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    reloadTracking().catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load your account tracking.");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const visiblePicks = useMemo(
    () => sortRows(picks.filter((pick) => pickMatchesFilter(pick, filter)).map((pick) => ({ ...pick, start_time: pick.start_time })), sort),
    [picks, filter, sort],
  );

  const visibleParlays = useMemo(
    () => sortRows(parlays.filter((parlay) => parlayMatchesFilter(parlay, filter)).map((parlay) => ({
      ...parlay,
      start_time: parlay.legs.map((leg) => leg.start_time).filter(Boolean).sort()[0] ?? null,
    })), sort),
    [parlays, filter, sort],
  );

  const singleSummary = useMemo(() => computePerformanceTotals(picks), [picks]);
  const parlaySummary = useMemo(() => computePerformanceTotals(parlays), [parlays]);
  const combinedSummary = useMemo(() => computePerformanceTotals([...picks, ...parlays]), [picks, parlays]);

  function startEditingPick(pick: SavedPickRow) {
    setEditingType({ kind: "pick", id: pick.id });
    setDrafts((current) => ({ ...current, [`pick:${pick.id}`]: makeDraft(pick.stake_units, pick.notes) }));
    setFeedback("");
  }

  function startEditingParlay(parlay: SavedParlayRow) {
    setEditingType({ kind: "parlay", id: parlay.id });
    setDrafts((current) => ({ ...current, [`parlay:${parlay.id}`]: makeDraft(parlay.stake_units, parlay.notes) }));
    setFeedback("");
  }

  function cancelEditing() {
    setEditingType(null);
  }

  function setDraftValue(key: string, patch: Partial<EditDraft>) {
    setDrafts((current) => ({
      ...current,
      [key]: { ...current[key], ...patch },
    }));
  }

  async function removePick(pickId: string) {
    if (!window.confirm("Remove this saved pick from My Picks?")) return;
    setRemovingType({ kind: "pick", id: pickId });
    setFeedback("");
    try {
      const response = await fetch(`/api/me/picks/${pickId}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not remove this pick.");
      setPicks((current) => current.filter((pick) => pick.id !== pickId));
      setFeedback("Saved pick removed.");
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : "Could not remove this pick.");
    } finally {
      setRemovingType(null);
    }
  }

  async function removeParlay(parlayId: string) {
    if (!window.confirm("Remove this saved parlay from My Picks?")) return;
    setRemovingType({ kind: "parlay", id: parlayId });
    setFeedback("");
    try {
      const response = await fetch(`/api/me/parlays/${parlayId}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not remove this parlay.");
      setParlays((current) => current.filter((parlay) => parlay.id !== parlayId));
      setFeedback("Saved parlay removed.");
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : "Could not remove this parlay.");
    } finally {
      setRemovingType(null);
    }
  }

  async function savePickTracking(pickId: string) {
    const draftKey = `pick:${pickId}`;
    const draft = drafts[draftKey];
    if (!draft) return;

    setSavingType({ kind: "pick", id: pickId });
    setFeedback("");

    try {
      const response = await fetch(`/api/me/picks/${pickId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stakeUnits: parseStakeUnits(draft.stakeUnits),
          notes: draft.notes.trim() ? draft.notes : null,
        }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; row?: SavedPickRow };
      if (!response.ok) throw new Error(payload.error ?? "Could not update this pick.");
      if (payload.row) {
        setPicks((current) => current.map((pick) => pick.id === pickId ? payload.row! : pick));
      }
      setEditingType(null);
      setFeedback("Saved pick details updated.");
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : "Could not update this pick.");
    } finally {
      setSavingType(null);
    }
  }

  async function saveParlayTracking(parlayId: string) {
    const draftKey = `parlay:${parlayId}`;
    const draft = drafts[draftKey];
    if (!draft) return;

    setSavingType({ kind: "parlay", id: parlayId });
    setFeedback("");

    try {
      const response = await fetch(`/api/me/parlays/${parlayId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stakeUnits: parseStakeUnits(draft.stakeUnits),
          notes: draft.notes.trim() ? draft.notes : null,
        }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; row?: SavedParlayRow };
      if (!response.ok) throw new Error(payload.error ?? "Could not update this parlay.");
      if (payload.row) {
        setParlays((current) => current.map((parlay) => parlay.id === parlayId ? payload.row! : parlay));
      }
      setEditingType(null);
      setFeedback("Saved parlay details updated.");
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : "Could not update this parlay.");
    } finally {
      setSavingType(null);
    }
  }

  async function refreshResults() {
    setSettling(true);
    setFeedback("");
    setError("");

    try {
      const response = await fetch("/api/me/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const payload = await response.json().catch(() => ({})) as { error?: string } & Partial<SettlementSummary>;
      if (!response.ok) throw new Error(payload.error ?? "Could not refresh your saved results.");

      await reloadTracking();

      setFeedback(
        `Results refreshed: ${payload.settledPicks ?? 0} picks and ${payload.settledParlays ?? 0} parlays settled. ${payload.skippedOrPending ?? 0} still pending.`,
      );
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : "Could not refresh your saved results.");
    } finally {
      setSettling(false);
    }
  }

  return (
    <div className="page-wrap">
      <header className="page-hero">
        <div>
          <div className="eyebrow"><span /> Protected account area</div>
          <h1>My Picks</h1>
          <p>Your saved single picks and parlays live here. Browsing stays public, but this page is where your tracked decisions start to collect.</p>
        </div>
      </header>

      {loading ? <div className="empty-state"><strong>Loading your tracking space…</strong><span>Checking your saved picks and parlays.</span></div> : null}
      {!loading && error ? <div className="empty-state"><strong>Couldn’t load My Picks.</strong><span>{error}</span></div> : null}

      {!loading && !error ? (
        <>
          <section className="knowledge-filter-bar my-picks-toolbar">
            <select value={filter} onChange={(event) => setFilter(event.target.value as FilterValue)}>
              <option value="all">All</option>
              <option value="singles">Singles</option>
              <option value="parlays">Parlays</option>
              <option value="pending">Pending</option>
              <option value="completed">Completed</option>
              <option value="wins">Wins</option>
              <option value="losses">Losses</option>
              <option value="pushes">Pushes</option>
            </select>
            <select value={sort} onChange={(event) => setSort(event.target.value as SortValue)}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="start_time">Event/start time</option>
            </select>
            <div className="my-picks-toolbar__counts">
              <span>{visiblePicks.length} singles</span>
              <span>{visibleParlays.length} parlays</span>
            </div>
            <button type="button" className="save-button" onClick={refreshResults} disabled={settling || loading}>
              {settling ? "Refreshing…" : "Refresh Results"}
            </button>
          </section>

          <section className="performance-kpis my-picks-summary">
            <article className="kpi-card kpi-card--primary">
              <span>Tracked singles</span>
              <strong>{singleSummary.total}</strong>
              <small>
                {singleSummary.wins}W · {singleSummary.losses}L · {singleSummary.pushes}P · {singleSummary.noGrades} no-grade
              </small>
            </article>
            <article className="kpi-card">
              <span>Single hit rate</span>
              <strong>{formatPercent(singleSummary.hitRate)}</strong>
              <small>
                {singleSummary.hitRate === null
                  ? "Needs at least one settled win/loss."
                  : `${singleSummary.wins} wins across ${singleSummary.wins + singleSummary.losses} graded decisions`}
              </small>
            </article>
            <article className="kpi-card">
              <span>Singles stake / profit</span>
              <strong>{formatProfitUnits(singleSummary.profitUnits)}</strong>
              <small>
                {singleSummary.stakeUnits !== null
                  ? `${singleSummary.stakeUnits.toFixed(2)}u staked · ROI ${formatPercent(singleSummary.roi)}`
                  : "Not enough settled stake data yet"}
              </small>
            </article>
            <article className="kpi-card">
              <span>Tracked parlays</span>
              <strong>{parlaySummary.total}</strong>
              <small>
                {parlaySummary.pending} pending · {parlaySummary.wins}W · {parlaySummary.losses}L · {parlaySummary.pushes}P
              </small>
            </article>
          </section>

          <section className="my-picks-summary-grid">
            <article className="knowledge-card knowledge-card--compact">
              <div className="my-picks-card__head">
                <div>
                  <small>Singles summary</small>
                  <h2>Your saved picks</h2>
                </div>
              </div>
              <div className="my-picks-summary-metrics">
                <span>Total saved singles <strong>{singleSummary.total}</strong></span>
                <span>Pending singles <strong>{singleSummary.pending}</strong></span>
                <span>Settled singles <strong>{singleSummary.settled}</strong></span>
                <span>Wins / losses <strong>{singleSummary.wins} / {singleSummary.losses}</strong></span>
                <span>Pushes / no-grades <strong>{singleSummary.pushes} / {singleSummary.noGrades}</strong></span>
                <span>Units staked <strong>{singleSummary.stakeUnits !== null ? `${singleSummary.stakeUnits.toFixed(2)}u` : "—"}</strong></span>
                <span>Profit units <strong>{formatProfitUnits(singleSummary.profitUnits)}</strong></span>
                <span>ROI <strong>{formatPercent(singleSummary.roi)}</strong></span>
              </div>
            </article>

            <article className="knowledge-card knowledge-card--compact">
              <div className="my-picks-card__head">
                <div>
                  <small>Parlay summary</small>
                  <h2>Your saved parlays</h2>
                </div>
              </div>
              <div className="my-picks-summary-metrics">
                <span>Total saved parlays <strong>{parlaySummary.total}</strong></span>
                <span>Pending parlays <strong>{parlaySummary.pending}</strong></span>
                <span>Settled parlays <strong>{parlaySummary.settled}</strong></span>
                <span>Parlay wins / losses <strong>{parlaySummary.wins} / {parlaySummary.losses}</strong></span>
                <span>Pushes / no-grades <strong>{parlaySummary.pushes} / {parlaySummary.noGrades}</strong></span>
                <span>Units staked <strong>{parlaySummary.stakeUnits !== null ? `${parlaySummary.stakeUnits.toFixed(2)}u` : "—"}</strong></span>
                <span>Profit units <strong>{formatProfitUnits(parlaySummary.profitUnits)}</strong></span>
                <span>ROI <strong>{formatPercent(parlaySummary.roi)}</strong></span>
              </div>
            </article>

            <article className="knowledge-card knowledge-card--compact">
              <div className="my-picks-card__head">
                <div>
                  <small>Combined snapshot</small>
                  <h2>All tracked items</h2>
                </div>
              </div>
              <div className="my-picks-summary-metrics">
                <span>Total tracked items <strong>{combinedSummary.total}</strong></span>
                <span>Total pending <strong>{combinedSummary.pending}</strong></span>
                <span>Total settled <strong>{combinedSummary.settled}</strong></span>
                <span>Total units staked <strong>{combinedSummary.stakeUnits !== null ? `${combinedSummary.stakeUnits.toFixed(2)}u` : "—"}</strong></span>
                <span>Total profit units <strong>{formatProfitUnits(combinedSummary.profitUnits)}</strong></span>
                <span>Combined ROI <strong>{formatPercent(combinedSummary.roi)}</strong></span>
              </div>
              <div className="my-picks-note">
                <strong>How this works</strong>
                <span>
                  This summary uses all saved items, not the active filter. Hit rate excludes pushes, no-grades, and pending rows.
                  {combinedSummary.roi === null ? " Not enough settled stake data yet." : ""}
                </span>
              </div>
            </article>
          </section>

          {feedback ? <p className="knowledge-selection-warning">{feedback}</p> : null}

          <div className="my-picks-grid">
            <section className="knowledge-card">
              <div className="my-picks-card__head">
                <div>
                  <small>Tracked singles</small>
                  <h2>Saved picks</h2>
                </div>
                <strong>{visiblePicks.length}</strong>
              </div>

              {visiblePicks.length ? (
                <ul className="my-picks-list">
                  {visiblePicks.map((pick) => {
                    const isEditing = editingType?.kind === "pick" && editingType.id === pick.id;
                    const isSaving = savingType?.kind === "pick" && savingType.id === pick.id;
                    const draftKey = `pick:${pick.id}`;
                    const draft = drafts[draftKey] ?? makeDraft(pick.stake_units, pick.notes);

                    return (
                      <li key={pick.id}>
                        <div className="my-picks-row">
                          <KnowledgeAvatar
                            name={pick.participant_display_name ?? "Pick"}
                            imageUrl={pick.participant_image_url ?? pick.player_headshot_url}
                            teamLogoUrl={pick.team_logo_url}
                            size="sm"
                          />
                          <div className="my-picks-copy">
                            <strong>{pick.participant_display_name ?? "Participant pending"}</strong>
                            <span>{pick.event_display_name ?? "Event pending"} · {formatWhen(pick.start_time)}</span>
                            <span>{pick.side ?? "Side TBD"} {pick.line ?? "—"} · {prettifyMarket(pick.market_type)} · {pick.sportsbook?.display_name ?? "Sportsbook unavailable"}</span>
                            <span>Saved {formatSavedAt(pick.created_at)} · {prettifyStatus(pick.status)} · result {prettifyStatus(pick.result)}</span>
                            <span>Odds {pick.odds_taken ?? "—"} · stake {pick.stake_units ?? 1}u · profit {formatProfitUnits(pick.profit_units)}</span>
                            {pick.settled_at ? <span>Settled {formatWhen(pick.settled_at)}</span> : null}
                          </div>
                        </div>
                        <div className="knowledge-card__badges knowledge-card__badges--compact">
                          {pick.covered_score !== null ? <span className="knowledge-badge">Covered {pick.covered_score}</span> : null}
                          <ScoreBadge label={pick.score_label} tone="score" />
                          <ScoreBadge label={pick.confidence_label} tone="confidence" />
                          <RiskBadge label={pick.risk_label} />
                        </div>
                        {pick.summary ? <span>{pick.summary}</span> : null}

                        {isEditing ? (
                          <div className="my-picks-edit-panel">
                            <label>
                              <span>Stake units</span>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={draft.stakeUnits}
                                onChange={(event) => setDraftValue(draftKey, { stakeUnits: event.target.value })}
                                placeholder="1"
                              />
                            </label>
                            <label>
                              <span>Notes</span>
                              <textarea
                                value={draft.notes}
                                onChange={(event) => setDraftValue(draftKey, { notes: event.target.value })}
                                placeholder="Add your own tracking note"
                              />
                            </label>
                            <div className="knowledge-card__actions">
                              <button
                                type="button"
                                className="save-button"
                                onClick={() => savePickTracking(pick.id)}
                                disabled={isSaving}
                              >
                                {isSaving ? "Saving…" : "Save changes"}
                              </button>
                              <button type="button" className="details-button details-button--inline" onClick={cancelEditing}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="my-picks-note">
                              <strong>Notes</strong>
                              <span>{pick.notes?.trim() ? pick.notes : "No personal notes yet."}</span>
                            </div>
                            <div className="knowledge-card__actions">
                              <button type="button" className="save-button" onClick={() => startEditingPick(pick)}>
                                Edit tracking
                              </button>
                              <button
                                type="button"
                                className="details-button details-button--inline details-button--danger"
                                onClick={() => removePick(pick.id)}
                                disabled={removingType?.kind === "pick" && removingType.id === pick.id}
                              >
                                {removingType?.kind === "pick" && removingType.id === pick.id ? "Removing…" : "Remove pick"}
                              </button>
                            </div>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="my-picks-empty">
                  {filter === "all" || filter === "singles"
                    ? "No saved picks yet. Use the save action on Covered Picks of the Day or on a resolved analyzer leg to start building your board."
                    : "No saved single picks match this filter right now."}
                </p>
              )}
            </section>

            <section className="knowledge-card">
              <div className="my-picks-card__head">
                <div>
                  <small>Tracked slips</small>
                  <h2>Saved parlays</h2>
                </div>
                <strong>{visibleParlays.length}</strong>
              </div>

              {visibleParlays.length ? (
                <ul className="my-picks-list">
                  {visibleParlays.map((parlay) => {
                    const isEditing = editingType?.kind === "parlay" && editingType.id === parlay.id;
                    const isSaving = savingType?.kind === "parlay" && savingType.id === parlay.id;
                    const draftKey = `parlay:${parlay.id}`;
                    const draft = drafts[draftKey] ?? makeDraft(parlay.stake_units, parlay.notes);

                    return (
                      <li key={parlay.id}>
                        <strong>{parlay.total_legs} legs · {parlay.combined_odds ?? "odds TBD"} · {prettifyStatus(parlay.status)}</strong>
                        <span>Saved {formatSavedAt(parlay.created_at)} · result {prettifyStatus(parlay.result)} · stake {parlay.stake_units ?? 1}u · profit {formatProfitUnits(parlay.profit_units)}</span>
                        {parlay.settled_at ? <span>Settled {formatWhen(parlay.settled_at)}</span> : null}
                        <div className="my-picks-parlay-legs">
                          {parlay.legs.map((leg) => (
                            <div key={leg.id} className="my-picks-parlay-leg">
                              <KnowledgeAvatar
                                name={leg.participant_display_name ?? "Leg"}
                                imageUrl={leg.participant_image_url ?? leg.player_headshot_url}
                                teamLogoUrl={leg.team_logo_url}
                                size="sm"
                              />
                              <div className="my-picks-copy">
                                <strong>{leg.participant_display_name ?? "Participant pending"}</strong>
                                <span>{leg.side ?? "Side TBD"} {leg.line ?? "—"} · {prettifyMarket(leg.market_type)}</span>
                                <span>{leg.event_display_name ?? "Event pending"} · {leg.sportsbook?.display_name ?? "Sportsbook unavailable"}</span>
                                <span>Leg result {prettifyStatus(leg.leg_result ?? "pending")}</span>
                              </div>
                            </div>
                          ))}
                        </div>

                        {isEditing ? (
                          <div className="my-picks-edit-panel">
                            <label>
                              <span>Stake units</span>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={draft.stakeUnits}
                                onChange={(event) => setDraftValue(draftKey, { stakeUnits: event.target.value })}
                                placeholder="1"
                              />
                            </label>
                            <label>
                              <span>Notes</span>
                              <textarea
                                value={draft.notes}
                                onChange={(event) => setDraftValue(draftKey, { notes: event.target.value })}
                                placeholder="Add your own tracking note"
                              />
                            </label>
                            <div className="knowledge-card__actions">
                              <button
                                type="button"
                                className="save-button"
                                onClick={() => saveParlayTracking(parlay.id)}
                                disabled={isSaving}
                              >
                                {isSaving ? "Saving…" : "Save changes"}
                              </button>
                              <button type="button" className="details-button details-button--inline" onClick={cancelEditing}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="my-picks-note">
                              <strong>Notes</strong>
                              <span>{parlay.notes?.trim() ? parlay.notes : "No personal notes yet."}</span>
                            </div>
                            <div className="knowledge-card__actions">
                              <button type="button" className="save-button" onClick={() => startEditingParlay(parlay)}>
                                Edit tracking
                              </button>
                              <button
                                type="button"
                                className="details-button details-button--inline details-button--danger"
                                onClick={() => removeParlay(parlay.id)}
                                disabled={removingType?.kind === "parlay" && removingType.id === parlay.id}
                              >
                                {removingType?.kind === "parlay" && removingType.id === parlay.id ? "Removing…" : "Remove parlay"}
                              </button>
                            </div>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="my-picks-empty">
                  {filter === "all" || filter === "parlays"
                    ? "No saved parlays yet. Once you save a resolved two-leg-or-more slip from the analyzer, it will show up here."
                    : "No saved parlays match this filter right now."}
                </p>
              )}
            </section>
          </div>

          {!visiblePicks.length && !visibleParlays.length ? (
            <div className="empty-state">
              <strong>No saved items match this filter.</strong>
              <span>Try another filter or sort option, or save a pick from Today or the analyzer first.</span>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
