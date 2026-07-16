"use client";

import type { ParlayLegWarning } from "@/lib/knowledge/parlay-analysis";

function groupsForWarnings(warnings: ParlayLegWarning[]) {
  return {
    critical: warnings.filter((warning) => warning.severity === "critical"),
    warning: warnings.filter((warning) => warning.severity === "warning"),
    info: warnings.filter((warning) => warning.severity === "info"),
  };
}

export function ParlayWarningList({ warnings }: { warnings: ParlayLegWarning[] }) {
  if (!warnings.length) return null;

  const groups = groupsForWarnings(warnings);

  return (
    <div className="knowledge-warning-list">
      <strong>Parlay-level warnings</strong>
      {groups.critical.length ? (
        <div className="knowledge-warning-group knowledge-warning-group--critical">
          <span>Critical conflicts</span>
          <ul>
            {groups.critical.map((warning, index) => (
              <li key={`${warning.code}-critical-${index}`}>{warning.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {groups.warning.length ? (
        <div className="knowledge-warning-group knowledge-warning-group--warning">
          <span>Caution warnings</span>
          <ul>
            {groups.warning.map((warning, index) => (
              <li key={`${warning.code}-warning-${index}`}>{warning.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {groups.info.length ? (
        <div className="knowledge-warning-group knowledge-warning-group--info">
          <span>Correlation / context notes</span>
          <ul>
            {groups.info.map((warning, index) => (
              <li key={`${warning.code}-info-${index}`}>{warning.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
