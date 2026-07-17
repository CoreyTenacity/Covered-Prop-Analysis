"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { KnowledgeAvatar } from "@/components/knowledge/knowledge-avatar";
import { LegWarningList } from "@/components/knowledge/leg-warning-list";
import { ParlayLegSelector } from "@/components/knowledge/parlay-leg-selector";
import { ParlaySummary } from "@/components/knowledge/parlay-summary";
import { ParlayWarningList } from "@/components/knowledge/parlay-warning-list";
import { RiskBadge } from "@/components/knowledge/risk-badge";
import { ScoreBadge } from "@/components/knowledge/score-badge";
import { fetchParlayOptions } from "@/components/knowledge/parlay-options-fetch";
import type { AnalyzedParlay } from "@/lib/knowledge/parlay-analysis";
import { filterParlayOptionsSnapshotRows } from "@/lib/knowledge/public-snapshots";
import type { ParlayOptionRow, ParlayOptionsResponse } from "@/lib/knowledge/read-types";

const leagues = [
  { label: "All leagues", value: "" },
  { label: "MLB", value: "mlb" },
  { label: "WNBA", value: "wnba" },
  { label: "NBA", value: "nba" },
] as const;

const manualSortOptions = [
  { label: "Best score", value: "score" },
  { label: "Earliest start", value: "start" },
  { label: "Highest match confidence", value: "match" },
  { label: "Player A–Z", value: "player" },
] as const;

type ManualSortValue = (typeof manualSortOptions)[number]["value"];

function easternToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function manualCatalogGroupingKey(option: ParlayOptionRow) {
  const dateKey = option.start_time
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(option.start_time))
    : "date:unknown";
  return [
    option.league,
    option.event_id ?? option.event_display_name ?? "event:unknown",
    option.participant_id ?? option.participant_display_name,
    option.market_type,
    dateKey,
  ].join("|");
}

function collapseManualCatalog(rows: ParlayOptionRow[]) {
  const grouped = new Map<string, ParlayOptionRow[]>();
  for (const row of rows) {
    const key = manualCatalogGroupingKey(row);
    const bucket = grouped.get(key) ?? [];
    bucket.push(row);
    grouped.set(key, bucket);
  }

  return [...grouped.values()].map((bucket) => {
    const representative = [...bucket].sort((left, right) =>
      Number(right.covered_score ?? -Infinity) - Number(left.covered_score ?? -Infinity)
      || Number(right.match_confidence ?? 0) - Number(left.match_confidence ?? 0)
      || new Date(left.start_time ?? 0).getTime() - new Date(right.start_time ?? 0).getTime()
    )[0];

    const sportsbookMap = new Map(
      bucket
        .flatMap((row) => row.sportsbooks?.length ? row.sportsbooks : row.sportsbook ? [row.sportsbook] : [])
        .map((book) => [book.id, book]),
    );

    return {
      ...representative,
      sportsbooks: [...sportsbookMap.values()],
      sportsbook_count: sportsbookMap.size,
      grouped_variant_count: bucket.length,
    };
  }).sort((left, right) =>
    Number(right.covered_score ?? -Infinity) - Number(left.covered_score ?? -Infinity)
    || Number(right.match_confidence ?? 0) - Number(left.match_confidence ?? 0)
    || new Date(left.start_time ?? 0).getTime() - new Date(right.start_time ?? 0).getTime()
    || left.participant_display_name.localeCompare(right.participant_display_name)
  );
}

function sportsbookSummary(option: ParlayOptionRow) {
  const books = option.sportsbooks ?? (option.sportsbook ? [option.sportsbook] : []);
  if (!books.length) return "Sportsbook unavailable";
  if (books.length === 1) return books[0].display_name;
  if (books.length === 2) return `${books[0].display_name} + ${books[1].display_name}`;
  return `${books[0].display_name} + ${books.length - 1} more books`;
}

function oddsTakenForOption(option: ParlayOptionRow) {
  const side = (option.side ?? "").toLowerCase();
  if (side === "more" || side === "over") return option.over_price ?? option.under_price ?? null;
  if (side === "less" || side === "under") return option.under_price ?? option.over_price ?? null;
  return option.over_price ?? option.under_price ?? null;
}

export function ParlayBuilderShell() {
  const [data, setData] = useState<ParlayOptionsResponse | null>(null);
  const [authUser, setAuthUser] = useState<{ id: string; displayName: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [date, setDate] = useState(easternToday());
  const [league, setLeague] = useState("");
  const [marketType, setMarketType] = useState("");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<ManualSortValue>("score");
  const [optionsSelected, setOptionsSelected] = useState<ParlayOptionRow[]>([]);
  const [selectionWarning, setSelectionWarning] = useState("");
  const [savingSinglePickId, setSavingSinglePickId] = useState<string | null>(null);
  const [savedSinglePickIds, setSavedSinglePickIds] = useState<Record<string, string>>({});
  const [singlePickMessages, setSinglePickMessages] = useState<Record<string, string>>({});
  const [savingParlay, setSavingParlay] = useState(false);
  const [parlayMessage, setParlayMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");

    fetchParlayOptions().then((outcome) => {
      if (cancelled) return;
      if (outcome.kind === "success") {
        setData(outcome.data);
      } else {
        setError(outcome.message);
      }
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

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
    let cancelled = false;
    if (!authUser) {
      setSavedSinglePickIds({});
      return () => {
        cancelled = true;
      };
    }

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
        setSavedSinglePickIds(next);
      })
      .catch(() => {
        if (!cancelled) setSavedSinglePickIds({});
      });

    return () => {
      cancelled = true;
    };
  }, [authUser]);

  const marketOptions = useMemo(() => {
    const seen = new Set<string>();
    const values = [{ label: "All markets", value: "" }];
    for (const row of data?.rows ?? []) {
      if (seen.has(row.market_type)) continue;
      seen.add(row.market_type);
      values.push({ label: row.market_type.replace(/_/g, " "), value: row.market_type });
    }
    return values;
  }, [data]);

  const manualCatalogRows = useMemo(() => {
    const filtered = filterParlayOptionsSnapshotRows(data?.rows ?? [], {
      date,
      sport: null,
      league,
      eventId: null,
      marketType,
      sportsbook: null,
      participantSearch: search,
      onlyScored: true,
      onlyMatched: false,
      excludeStaleOdds: false,
      excludeLowConfidenceMatches: false,
      limit: 100,
      includeVariantBooks: false,
    });

    // `onlyScored` only guarantees a linked scored_props row exists; some props have a scored
    // row that never finished computing (null covered_score / candidate state). Those render with
    // no score and read as "incomplete scoring", so exclude them from the manual builder catalog.
    const scoredOnly = filtered.filter((row) => row.covered_score != null);

    const collapsed = collapseManualCatalog(scoredOnly);
    const sorted = [...collapsed];
    sorted.sort((left, right) => {
      if (sortBy === "start") {
        return new Date(left.start_time ?? 0).getTime() - new Date(right.start_time ?? 0).getTime()
          || Number(right.covered_score ?? -Infinity) - Number(left.covered_score ?? -Infinity);
      }
      if (sortBy === "match") {
        return Number(right.match_confidence ?? 0) - Number(left.match_confidence ?? 0)
          || Number(right.covered_score ?? -Infinity) - Number(left.covered_score ?? -Infinity);
      }
      if (sortBy === "player") {
        return left.participant_display_name.localeCompare(right.participant_display_name)
          || new Date(left.start_time ?? 0).getTime() - new Date(right.start_time ?? 0).getTime();
      }
      return Number(right.covered_score ?? -Infinity) - Number(left.covered_score ?? -Infinity)
        || Number(right.match_confidence ?? 0) - Number(left.match_confidence ?? 0)
        || new Date(left.start_time ?? 0).getTime() - new Date(right.start_time ?? 0).getTime();
    });
    return sorted.slice(0, 10);
  }, [data?.rows, date, league, marketType, search, sortBy]);

  const [analysis, setAnalysis] = useState<AnalyzedParlay | null>(null);
  const [analysisError, setAnalysisError] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (!optionsSelected.length) {
      setAnalysis(null);
      setAnalysisError("");
      return () => {
        cancelled = true;
      };
    }

    setAnalysisError("");
    fetch("/api/parlay-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selected: optionsSelected }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not analyze this parlay selection.");
        return response.json() as Promise<AnalyzedParlay>;
      })
      .then((payload) => {
        if (!cancelled) setAnalysis(payload);
      })
      .catch((reason) => {
        if (!cancelled) {
          setAnalysis(null);
          setAnalysisError(reason instanceof Error ? reason.message : "Could not analyze this parlay selection.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [optionsSelected]);

  function toggleOption(option: ParlayOptionRow) {
    setSelectionWarning("");
    setOptionsSelected((current) => {
      const exists = current.some((item) => item.current_prop_id === option.current_prop_id);
      if (exists) return current.filter((item) => item.current_prop_id !== option.current_prop_id);
      if (current.length >= 6) {
        setSelectionWarning("Manual Parlay Builder supports up to 6 legs right now.");
        return current;
      }
      return [...current, option];
    });
  }

  async function saveSinglePick(option: ParlayOptionRow) {
    setSavingSinglePickId(option.current_prop_id);
    setSinglePickMessages((current) => ({ ...current, [option.current_prop_id]: "" }));

    try {
      const response = await fetch("/api/me/picks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPropId: option.current_prop_id,
          scoredPropId: option.latest_scored_prop_id,
          oddsSnapshotId: option.latest_snapshot_id,
          eventId: option.event_id,
          participantId: option.participant_id,
          marketInstanceKey: option.market_instance_key,
          marketType: option.market_type,
          side: option.side,
          line: option.line,
          oddsTaken: oddsTakenForOption(option),
          sportsbookId: option.sportsbook?.id ?? null,
          stakeUnits: 1,
        }),
      });

      const payload = await response.json().catch(() => ({})) as { error?: string; row?: { id?: string } | null };
      if (response.status === 409) {
        setSavedSinglePickIds((current) => ({ ...current, [option.current_prop_id]: payload.row?.id ?? "duplicate" }));
        setSinglePickMessages((current) => ({ ...current, [option.current_prop_id]: payload.error ?? "Already saved." }));
        return;
      }
      if (!response.ok) throw new Error(payload.error ?? "Could not save this pick.");

      setSavedSinglePickIds((current) => ({ ...current, [option.current_prop_id]: payload.row?.id ?? "saved" }));
      setSinglePickMessages((current) => ({ ...current, [option.current_prop_id]: "Saved to My Picks." }));
    } catch (reason) {
      setSinglePickMessages((current) => ({
        ...current,
        [option.current_prop_id]: reason instanceof Error ? reason.message : "Could not save this pick.",
      }));
    } finally {
      setSavingSinglePickId(null);
    }
  }

  async function saveParlay(options: ParlayOptionRow[]) {
    const resolvedLegs = options.slice(0, 6);
    if (!resolvedLegs.length) {
      setParlayMessage("There are no selected legs to save yet.");
      return;
    }
    if (resolvedLegs.length < 2) {
      setParlayMessage("A saved parlay needs at least two legs. Save this as a single pick instead.");
      return;
    }

    setSavingParlay(true);
    setParlayMessage("");

    try {
      const response = await fetch("/api/me/parlays", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stakeUnits: 1,
          legs: resolvedLegs.map((option) => ({
            currentPropId: option.current_prop_id,
            scoredPropId: option.latest_scored_prop_id,
            oddsSnapshotId: option.latest_snapshot_id,
            eventId: option.event_id,
            participantId: option.participant_id,
            marketInstanceKey: option.market_instance_key,
            marketType: option.market_type,
            side: option.side,
            line: option.line,
            oddsTaken: oddsTakenForOption(option),
            sportsbookId: option.sportsbook?.id ?? null,
          })),
        }),
      });

      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not save this parlay.");
      setParlayMessage("Saved this parlay to My Picks.");
    } catch (reason) {
      setParlayMessage(reason instanceof Error ? reason.message : "Could not save this parlay.");
    } finally {
      setSavingParlay(false);
    }
  }

  const trackButtonTitle = authUser
    ? "Your account foundation is active. Parlay saving can plug into this next."
    : "Public analysis stays open. Login is only needed for future save and tracking features.";

  return (
    <div className="page-wrap slip-page">
      <header className="page-hero slip-hero">
        <div>
          <div className="eyebrow"><span /> Public parlay builder</div>
          <h1>Covered Parlay Builder</h1>
          <p>Build a parlay manually from Covered’s stored prop universe. Select up to six legs, review the summary, and save the result if you’re logged in.</p>
        </div>
      </header>

      <section className="knowledge-filter-bar">
        <input
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          aria-label="Parlay date"
          className="knowledge-search"
        />
        <select value={league} onChange={(event) => setLeague(event.target.value)}>
          {leagues.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select value={marketType} onChange={(event) => setMarketType(event.target.value)}>
          {marketOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select value={sortBy} onChange={(event) => setSortBy(event.target.value as ManualSortValue)}>
          {manualSortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <input className="knowledge-search" placeholder="Search player or participant" value={search} onChange={(event) => setSearch(event.target.value)} />
      </section>

      <section className="knowledge-builder-layout">
        <div className="knowledge-builder__catalog">
          {loading ? <div className="empty-state"><strong>Loading parlay options…</strong><span>Pulling selectable props from the current prop read layer.</span></div> : null}
          {!loading && error ? <div className="empty-state"><strong>Couldn’t load parlay options.</strong><span>{error}</span></div> : null}
          {!loading && !error && !manualCatalogRows.length ? <div className="empty-state"><strong>No scored props are available for the current filters.</strong><span>Try a different date, league, market, or player search. The manual builder now stays focused on scored props only.</span></div> : null}
          {!loading && !error && manualCatalogRows.length ? (
            <div className="knowledge-list">
              {manualCatalogRows.map((option) => (
                <ParlayLegSelector
                  key={option.current_prop_id}
                  option={option}
                  selected={optionsSelected.some((item) => item.current_prop_id === option.current_prop_id)}
                  onToggle={toggleOption}
                />
              ))}
            </div>
          ) : null}
        </div>

        <aside className="knowledge-builder__selection settings-card">
          <span>Selected legs</span>
          <strong>{optionsSelected.length}/6 chosen</strong>
          <p>Public browsing stays open for everyone. If you’re logged in, resolved legs and 2+ leg parlays can be saved to My Picks without changing the research flow.</p>
          {selectionWarning ? <p className="knowledge-selection-warning">{selectionWarning}</p> : null}

          {optionsSelected.length && analysis ? (
            <>
              <ParlaySummary summary={analysis.summary} />
              <ParlayWarningList warnings={analysis.parlayWarnings} />
              <ul className="knowledge-selection-list">
                {analysis.legs.map((leg) => (
                  <li key={leg.option.current_prop_id}>
                    <div className="knowledge-selection-list__identity">
                      <KnowledgeAvatar
                        name={leg.option.participant_display_name}
                        imageUrl={leg.option.participant_image_url ?? leg.option.player_headshot_url}
                        teamLogoUrl={leg.option.team_logo_url}
                        size="sm"
                      />
                      <div className="knowledge-selection-list__copy">
                        <strong>{leg.option.participant_display_name}</strong>
                        <small>{leg.option.event_display_name}</small>
                        <small>{leg.option.side ?? "Side TBD"} {leg.option.line} · {leg.option.market_type.replace(/_/g, " ")} · {sportsbookSummary(leg.option)}</small>
                        <small>Covered Score {leg.option.covered_score ?? "—"} · {leg.option.score_label ?? "No score label"} · {leg.option.confidence_label ?? "No confidence label"} · {leg.option.risk_label ?? "No risk label"}</small>
                        <small>Match status {leg.option.match_status} · match confidence {leg.option.match_confidence ?? "—"}</small>
                      </div>
                    </div>
                    <LegWarningList warnings={leg.warnings} />
                    <div className="knowledge-card__actions">
                      {authUser ? (
                        <button
                          type="button"
                          className={savedSinglePickIds[leg.option.current_prop_id] ? "save-button save-button--saved" : "save-button"}
                          disabled={savingSinglePickId === leg.option.current_prop_id || Boolean(savedSinglePickIds[leg.option.current_prop_id])}
                          onClick={() => saveSinglePick(leg.option)}
                        >
                          {savingSinglePickId === leg.option.current_prop_id ? "Saving…" : savedSinglePickIds[leg.option.current_prop_id] ? "Saved" : "Save leg"}
                        </button>
                      ) : (
                        <Link href="/login?next=%2Fslip-analyzer" className="save-button save-button--link">
                          Log in to save
                        </Link>
                      )}
                    </div>
                    {singlePickMessages[leg.option.current_prop_id] ? (
                      <p className="knowledge-selection-warning">{singlePickMessages[leg.option.current_prop_id]}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
              <div className="knowledge-builder-metrics">
                <div><span>Strongest leg</span><strong>{analysis.summary.strongest_leg?.participant_display_name ?? "—"}</strong></div>
                <div><span>Weakest leg</span><strong>{analysis.summary.weakest_leg?.participant_display_name ?? "—"}</strong></div>
              </div>
            </>
          ) : optionsSelected.length ? (
            <div className="mini-empty">{analysisError || "Analyzing this selection…"}</div>
          ) : (
            <div className="mini-empty">Choose props from the left to sketch a parlay.</div>
          )}

          {authUser ? (
            <button
              type="button"
              className="save-button"
              disabled={savingParlay}
              onClick={() => saveParlay(optionsSelected)}
              title={trackButtonTitle}
            >
              {savingParlay ? "Saving…" : "Save selected parlay"}
            </button>
          ) : (
            <Link href="/login?next=%2Fmy-picks" className="save-button save-button--link" title={trackButtonTitle}>
              Log in to save parlays
            </Link>
          )}
          {parlayMessage ? <p className="knowledge-selection-warning">{parlayMessage}</p> : null}
        </aside>
      </section>
    </div>
  );
}
