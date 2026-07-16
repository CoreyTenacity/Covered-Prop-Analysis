"use client";

import type { KnowledgeFactor } from "@/lib/knowledge/read-types";

function tone(impact: string | null | undefined) {
  if (impact === "positive") return "positive";
  if (impact === "negative") return "negative";
  if (impact === "caution") return "caution";
  return "neutral";
}

export function FactorBreakdown({ factors }: { factors: KnowledgeFactor[] | null | undefined }) {
  if (!factors?.length) return null;

  return (
    <div className="knowledge-factors">
      {factors.slice(0, 5).map((factor, index) => (
        <div className="knowledge-factor" key={`${factor.name ?? "factor"}-${index}`}>
          <div className="knowledge-factor__head">
            <strong>{factor.name ?? "Factor"}</strong>
            {factor.label ? <span className={`knowledge-factor__pill knowledge-factor__pill--${tone(factor.impact)}`}>{factor.label}</span> : null}
          </div>
          {factor.description ? <p>{factor.description}</p> : null}
        </div>
      ))}
    </div>
  );
}
