"use client";

import { useState } from "react";

import { EvidencePanel } from "@/components/knowledge/evidence-panel";
import { KnowledgeAvatar } from "@/components/knowledge/knowledge-avatar";
import { RiskBadge } from "@/components/knowledge/risk-badge";
import { ScoreBadge } from "@/components/knowledge/score-badge";
import type { ParlayOptionRow } from "@/lib/knowledge/read-types";

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

function sportsbookSummary(option: ParlayOptionRow) {
  const books = option.sportsbooks ?? (option.sportsbook ? [option.sportsbook] : []);
  if (!books.length) return "Sportsbook unavailable";
  if (books.length === 1) return books[0].display_name;
  if (books.length === 2) return `${books[0].display_name} + ${books[1].display_name}`;
  return `${books[0].display_name} + ${books.length - 1} more books`;
}

function variantSummary(option: ParlayOptionRow) {
  if ((option.grouped_variant_count ?? 1) <= 1) return sportsbookSummary(option);
  const books = option.sportsbook_count ?? option.sportsbooks?.length ?? (option.sportsbook ? 1 : 0);
  if (books > 1) return `Best current line from ${books} books · ${option.grouped_variant_count} stored variants`;
  return `${option.grouped_variant_count} stored variants`;
}

export function ParlayLegSelector({
  option,
  selected,
  onToggle,
}: {
  option: ParlayOptionRow;
  selected: boolean;
  onToggle: (option: ParlayOptionRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const evidence = option.evidence ?? null;
  const commentary = option.commentary ?? null;

  return (
    <article className={`knowledge-card knowledge-card--compact ${selected ? "knowledge-card--selected" : ""}`}>
      <div className="knowledge-card__top">
        <div className="knowledge-card__rank">
          <small>{option.sport.toUpperCase()} · {option.league.toUpperCase()}</small>
        </div>
        {option.covered_score !== null ? (
          <div className="knowledge-card__score knowledge-card__score--small">
            <strong>{option.covered_score}</strong>
            <span>Covered</span>
          </div>
        ) : null}
      </div>
      <div className="knowledge-card__identity">
        <div className="knowledge-identity-row">
          <KnowledgeAvatar
            name={option.participant_display_name}
            imageUrl={option.participant_image_url ?? option.player_headshot_url}
            teamLogoUrl={option.team_logo_url}
          />
          <div className="knowledge-identity-row__copy">
            <h2>{option.participant_display_name}</h2>
            <p>{option.event_display_name ?? "Event TBD"} · {formatStartTime(option.start_time)}</p>
          </div>
        </div>
      </div>
      <div className="knowledge-card__market">
        <strong>{option.side ?? "Side TBD"} {option.line} {option.market_type.replace(/_/g, " ")}</strong>
        <span>{variantSummary(option)}</span>
      </div>
      <div className="knowledge-card__badges">
        <ScoreBadge label={option.score_label} tone="score" />
        <ScoreBadge label={option.confidence_label} tone="confidence" />
        <RiskBadge label={option.risk_label} />
      </div>
      {commentary?.summary ? (
        <div className="knowledge-card__summary">
          <p>{commentary.summary}</p>
        </div>
      ) : null}
      <div className="knowledge-card__actions">
        <button type="button" className="details-button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          {expanded ? "Hide why this score?" : "Why this score?"}
          <span>{expanded ? "↑" : "↓"}</span>
        </button>
        <button type="button" className={selected ? "save-button save-button--saved" : "save-button"} onClick={() => onToggle(option)}>
          {selected ? "✓ Selected" : "+ Add leg"}
        </button>
      </div>

      {expanded ? (
        <div className="knowledge-card__expanded">
          <p className="knowledge-evidence-disclaimer">
            Covered Score reflects the strength of the stored evidence below, not a win probability.
          </p>
          <EvidencePanel evidence={evidence} commentary={commentary} line={option.line} side={option.side} />
        </div>
      ) : null}
    </article>
  );
}
