"use client";

import type { ParlayLegWarning } from "@/lib/knowledge/parlay-analysis";

function labelForSeverity(severity: ParlayLegWarning["severity"]) {
  if (severity === "critical") return "Critical";
  if (severity === "warning") return "Caution";
  return "Info";
}

export function LegWarningList({ warnings }: { warnings: ParlayLegWarning[] }) {
  if (!warnings.length) return null;

  return (
    <div className="knowledge-warning-stack">
      <strong>Leg warnings</strong>
      <ul className="knowledge-warning-pills">
        {warnings.map((warning, index) => (
          <li key={`${warning.code}-${index}`} className={`knowledge-warning-pill knowledge-warning-pill--${warning.severity}`}>
            <b>{labelForSeverity(warning.severity)}:</b> {warning.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
