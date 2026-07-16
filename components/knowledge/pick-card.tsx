"use client";

import Link from "next/link";
import { useState } from "react";

import { FactorBreakdown } from "@/components/knowledge/factor-breakdown";
import { KnowledgeAvatar } from "@/components/knowledge/knowledge-avatar";
import { RiskBadge } from "@/components/knowledge/risk-badge";
import { ScoreBadge } from "@/components/knowledge/score-badge";
import type { CoveredPickRow } from "@/lib/knowledge/read-types";

function formatStartTime(value: string | null) {
  if (!value) return "TBD";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

function formatOdds(over: number | null, under: number | null) {
  const values = [];
  if (over !== null && Number.isFinite(over)) values.push(`Over ${over > 0 ? "+" : ""}${over}`);
  if (under !== null && Number.isFinite(under)) values.push(`Under ${under > 0 ? "+" : ""}${under}`);
  return values.join(" · ") || "Odds unavailable";
}

function sportsbookSummary(pick: CoveredPickRow) {
  const books = pick.sportsbooks ?? (pick.sportsbook ? [pick.sportsbook] : []);
  if (!books.length) return "Sportsbook unavailable";
  if (books.length === 1) return books[0].display_name;
  if (books.length === 2) return `${books[0].display_name} + ${books[1].display_name}`;
  return `${books[0].display_name} + ${books.length - 1} more books`;
}

function variantSummary(pick: CoveredPickRow) {
  if ((pick.grouped_variant_count ?? 1) <= 1) return sportsbookSummary(pick);
  const books = pick.sportsbook_count ?? pick.sportsbooks?.length ?? (pick.sportsbook ? 1 : 0);
  if (books > 1) return `Best current line from ${books} books · ${pick.grouped_variant_count} stored variants`;
  return `${pick.grouped_variant_count} stored variants`;
}

function prettifyMarket(market: string) {
  return market.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function prettifyLeague(league: string) {
  return league.toUpperCase();
}

function prettifySport(sport: string) {
  if (sport === "baseball") return "MLB";
  if (sport === "basketball") return "Basketball";
  return sport;
}

function escapeForRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function plainSummary(summary: string | null, playerName: string) {
  if (!summary) return "Covered does not have a plain-language summary for this prop yet.";
  const cleaned = summary
    .replace(new RegExp(`^The board likes\\s+${escapeForRegExp(playerName)}\\s+because\\s*`, "i"), "")
    .replace(new RegExp(`^The board avoids\\s+${escapeForRegExp(playerName)}\\s+because\\s*`, "i"), "")
    .replace(/\bdeterministic\b/gi, "clear")
    .replace(/\bprojection edge\b/gi, "projection advantage")
    .replace(/\bmarket is pricing in\b/gi, "sportsbooks seem to be pricing in")
    .replace(/\bmatchup history\b/gi, "past matchup sample")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 220 ? `${cleaned.slice(0, 217).trimEnd()}…` : cleaned;
}

type PickCardProps = {
  pick: CoveredPickRow;
  rank: number;
  canSave: boolean;
  saveHref: string;
  saveState?: "idle" | "saving" | "saved";
  saveMessage?: string;
  onSave?: (pick: CoveredPickRow) => void;
};

export function PickCard({
  pick,
  rank,
  canSave,
  saveHref,
  saveState = "idle",
  saveMessage,
  onSave,
}: PickCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [detailPick, setDetailPick] = useState<CoveredPickRow | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  const resolvedPick = detailPick ?? pick;

  async function toggleExpanded() {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (
      nextExpanded
      && !detailPick
      && !loadingDetails
      && (!pick.factor_breakdown?.length && !pick.grading_result)
    ) {
      try {
        setLoadingDetails(true);
        const response = await fetch(`/api/knowledge/covered-picks/${pick.scored_prop_id}`, {
          cache: "no-store",
        });
        if (!response.ok) return;
        const payload = await response.json() as { row?: CoveredPickRow };
        if (payload.row) setDetailPick(payload.row);
      } finally {
        setLoadingDetails(false);
      }
    }
  }

  return (
    <article className="knowledge-card">
      <div className="knowledge-card__top">
        <div className="knowledge-card__rank">
          <span>#{rank}</span>
          <small>{prettifySport(pick.sport)} · {prettifyLeague(pick.league)}</small>
        </div>
        <div className="knowledge-card__score">
          <strong>{resolvedPick.covered_score ?? "—"}</strong>
          <span>Covered Score</span>
        </div>
      </div>

      <div className="knowledge-card__identity">
        <div className="knowledge-identity-row">
          <KnowledgeAvatar
            name={resolvedPick.player_display_name}
            imageUrl={resolvedPick.participant_image_url ?? resolvedPick.player_headshot_url}
            teamLogoUrl={resolvedPick.team_logo_url}
          />
          <div className="knowledge-identity-row__copy">
            <h2>{resolvedPick.player_display_name}</h2>
            <p>{resolvedPick.event_display_name ?? [resolvedPick.team_display_name, resolvedPick.opponent_display_name].filter(Boolean).join(" vs ")} · {formatStartTime(resolvedPick.start_time)}</p>
          </div>
        </div>
      </div>

      <div className="knowledge-card__market">
        <strong>{resolvedPick.side ?? "Side TBD"} {resolvedPick.line} {resolvedPick.market_display_label || prettifyMarket(resolvedPick.market_type)}</strong>
        <span>{variantSummary(resolvedPick)} · {formatOdds(resolvedPick.over_price, resolvedPick.under_price)}</span>
      </div>

      <div className="knowledge-card__badges">
        <ScoreBadge label={resolvedPick.score_label} tone="score" />
        <ScoreBadge label={resolvedPick.confidence_label} tone="confidence" />
        <RiskBadge label={resolvedPick.risk_label} />
      </div>

      <div className="knowledge-card__summary">
        <p>{plainSummary(resolvedPick.explanation_summary, resolvedPick.player_display_name)}</p>
      </div>

      {resolvedPick.risk_flags?.length ? (
        <div className="knowledge-card__flags">
          {resolvedPick.risk_flags.slice(0, 4).map((flag) => (
            <span key={flag}>{flag.replace(/_/g, " ")}</span>
          ))}
        </div>
      ) : null}

      <div className="knowledge-card__meta">
        <span>Edge score {resolvedPick.edge_score ?? "—"}</span>
        <span>Confidence {resolvedPick.confidence_score ?? "—"}</span>
        <span>Data quality {resolvedPick.data_quality_score ?? "—"}</span>
      </div>

      <div className="knowledge-card__actions">
        <button type="button" className="details-button" onClick={toggleExpanded} aria-expanded={expanded}>
          {expanded ? "Hide details" : "View details"}
          <span>{expanded ? "↑" : "↓"}</span>
        </button>
        {canSave ? (
          <button
            type="button"
            className={saveState === "saved" ? "save-button save-button--saved" : "save-button"}
            onClick={() => onSave?.(pick)}
            disabled={saveState === "saving" || saveState === "saved"}
          >
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : "Save pick"}
          </button>
        ) : (
          <Link href={saveHref} className="save-button save-button--link">
            Log in to save
          </Link>
        )}
      </div>
      {saveMessage ? <p className="knowledge-selection-warning">{saveMessage}</p> : null}

      {expanded ? (
        <div className="knowledge-card__expanded">
          {loadingDetails ? <div className="knowledge-inline-panel"><small>Loading details</small><strong>Pulling factor breakdown…</strong></div> : null}
          <FactorBreakdown factors={resolvedPick.factor_breakdown} />
          {resolvedPick.grading_result ? (
            <div className="knowledge-inline-panel">
              <small>Latest model grade</small>
              <strong>{resolvedPick.grading_result.result ?? "Pending"}</strong>
              {resolvedPick.grading_result.final_stat !== null && resolvedPick.grading_result.final_stat !== undefined ? (
                <span>Final stat {resolvedPick.grading_result.final_stat}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
