"use client";

import { useEffect, useMemo, useState } from "react";
import type { PickRecord, PickResult, Sport } from "@/lib/types";
import { getPicks, removePick, subscribeToPicks, updatePick, updatePickActualValue } from "@/lib/db/picks";

const resultOptions: { value: PickResult; label: string }[] = [
  { value: "pending", label: "Pending" }, { value: "hit", label: "Hit" },
  { value: "miss", label: "Miss" }, { value: "push", label: "Push" },
  { value: "void", label: "Void / DNP" },
];

function sportLabel(sport: Sport) {
  return sport === "Tennis" ? "Tennis (coming soon)" : sport;
}

export function PickHistory() {
  const [picks, setPicks] = useState<PickRecord[]>([]);
  const [sport, setSport] = useState<Sport | "All">("All");
  const [result, setResult] = useState<PickResult | "All">("All");

  useEffect(() => {
    const sync = () => setPicks(getPicks());
    sync();
    return subscribeToPicks(sync);
  }, []);

  const visible = useMemo(() => picks.filter((pick) =>
    (sport === "All" || pick.sport === sport) && (result === "All" || pick.result === result)
  ), [picks, result, sport]);

  function changeResult(id: string, nextResult: PickResult) {
    updatePick(id, { result: nextResult, gradingStatus: "manual", gradedAt: undefined });
  }

  return (
    <div className="page-wrap history-page">
      <header className="page-hero history-hero">
        <div>
          <div className="eyebrow"><span /> Research log</div>
          <h1>Pick History</h1>
          <p>Save the thesis, record the result, and learn which signals hold up over time.</p>
        </div>
        <div className="history-count"><strong>{picks.length}</strong><span>saved picks</span></div>
      </header>

      <section className="history-controls" aria-label="History filters">
        <label>Sport<select value={sport} onChange={(event) => setSport(event.target.value as Sport | "All")}><option>All</option><option>MLB</option><option>WNBA</option><option>NFL</option><option>NBA</option><option value="Tennis">{sportLabel("Tennis")}</option></select></label>
        <label>Result<select value={result} onChange={(event) => setResult(event.target.value as PickResult | "All")}><option>All</option>{resultOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
        <span>{visible.length} shown</span>
      </section>

      {visible.length === 0 ? (
        <div className="history-empty">
          <div>♡</div><h2>{picks.length ? "No picks match these filters" : "Your research log is empty"}</h2>
          <p>{picks.length ? "Change a filter to see more of your history." : "Save an opportunity from today’s board and it will appear here."}</p>
          <a href="/today">Browse today’s opportunities →</a>
        </div>
      ) : (
        <div className="history-table-wrap">
          <table className="history-table">
            <thead><tr><th>Date</th><th>Sport</th><th>Player & pick</th><th>Score</th><th>Actual</th><th>Result</th><th>Notes</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{visible.map((pick) => (
              <tr key={pick.id}>
                <td data-label="Date"><span className="date-primary">{new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }).format(new Date(pick.savedAt))}</span><small>{new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(new Date(pick.savedAt))}</small></td>
                <td data-label="Sport"><span className="sport-badge">{pick.sport}</span></td>
                <td data-label="Pick"><strong>{pick.playerName}</strong><span>{pick.direction} {pick.line} {pick.statType}</span><small>{pick.team} vs {pick.opponent}</small></td>
                <td data-label="Score"><span className="history-score">{pick.coveredScore}</span><small>{pick.recommendationLabel}</small></td>
                <td data-label="Actual"><input inputMode="decimal" aria-label={`Actual result for ${pick.playerName}`} defaultValue={pick.actualValue ?? ""} placeholder="Final…" maxLength={8} onBlur={(event) => updatePickActualValue(pick.id, event.target.value.trim())} /></td>
                <td data-label="Result"><select className={`result-select result-${pick.result}`} value={pick.result} onChange={(event) => changeResult(pick.id, event.target.value as PickResult)}>{resultOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select><small>{pick.gradingStatus === "graded-auto" ? "Auto-graded" : pick.gradingStatus === "pending-auto" ? "Pending auto-grade" : "Manual"}</small></td>
                <td data-label="Notes"><input aria-label={`Notes for ${pick.playerName}`} defaultValue={pick.notes} placeholder="Add context…" maxLength={240} onBlur={(event) => updatePick(pick.id, { notes: event.target.value.trim() })} /><small>{pick.gradingNote ?? "No final result note yet"}</small></td>
                <td><button className="remove-pick" onClick={() => removePick(pick.id)} aria-label={`Remove ${pick.playerName}`}>×</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <p className="local-storage-note"><span /> Manual grading is always available. When you enter an actual result, the pick can auto-grade to hit, miss, or push; provider-based post-game grading is still being expanded for live feeds.</p>
    </div>
  );
}
