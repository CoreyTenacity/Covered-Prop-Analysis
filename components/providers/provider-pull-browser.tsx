"use client";

import { useMemo, useState } from "react";
import type { ProviderPullAuditEntry, ProviderPullAuditProp } from "@/lib/providers/provider-pull-audit";
import type { Sport } from "@/lib/types";

type ProviderPullBrowserProps = {
  providerLabel: string;
  auditEntries: ProviderPullAuditEntry[];
};

type BrowserEvent = {
  id: string;
  sport: Sport;
  sportKey: string;
  eventId: string;
  matchup: string;
  commenceTime: string;
  propCount: number;
  rawMarketTypes: string[];
  props: ProviderPullAuditProp[];
  source: ProviderPullAuditEntry;
};

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" }).format(new Date(value));
}

function sportLabel(sport: Sport) {
  return sport === "Tennis" ? "Tennis (coming soon)" : sport;
}

function keyForEvent(sportKey: string, eventId: string) {
  return `${sportKey}:${eventId}`;
}

function isUpcoming(commenceTime: string) {
  const start = new Date(commenceTime).getTime();
  return Number.isFinite(start) && start > Date.now();
}

function dedupeProps(props: ProviderPullAuditProp[]) {
  const grouped = new Map<string, ProviderPullAuditProp[]>();
  for (const prop of props) {
    const key = `${prop.playerName.toLowerCase()}|${prop.marketKey}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(prop);
    grouped.set(key, bucket);
  }
  const median = (values: number[]) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  };
  return [...grouped.values()].map((items) => {
    if (items.length === 1) return items[0];
    const medianLine = median(items.map((item) => item.line)) ?? items[0].line;
    return [...items].sort((left, right) => Math.abs(left.line - medianLine) - Math.abs(right.line - medianLine) || left.line - right.line)[0];
  });
}

function buildBrowserEvents(auditEntries: ProviderPullAuditEntry[]) {
  const map = new Map<string, BrowserEvent>();
  for (const entry of auditEntries) {
    for (const event of entry.events) {
      if (!isUpcoming(event.commenceTime)) continue;
      const key = keyForEvent(entry.sportKey, event.eventId);
      const existing = map.get(key) ?? {
        id: key,
        sport: entry.sport,
        sportKey: entry.sportKey,
        eventId: event.eventId,
        matchup: event.matchup,
        commenceTime: event.commenceTime,
        propCount: 0,
        rawMarketTypes: [],
        props: [],
        source: entry,
      };
      const dedupedProps = dedupeProps(event.playerProps);
      existing.props = dedupeProps([...existing.props, ...dedupedProps]);
      existing.propCount = existing.props.length;
      existing.rawMarketTypes = [...new Set([...existing.rawMarketTypes, ...event.rawMarketTypes])];
      existing.matchup = event.matchup || existing.matchup;
      existing.commenceTime = event.commenceTime || existing.commenceTime;
      existing.source = entry;
      map.set(key, existing);
    }
  }
  return [...map.values()].sort((left, right) => new Date(left.commenceTime).getTime() - new Date(right.commenceTime).getTime());
}

export function ProviderPullBrowser({ providerLabel, auditEntries }: ProviderPullBrowserProps) {
  const [selected, setSelected] = useState<string>("all");
  const events = useMemo(() => buildBrowserEvents(auditEntries), [auditEntries]);
  const tabs = useMemo(() => [
    { id: "all", label: "All events" },
    ...events.map((event) => ({
      id: event.id,
      label: event.matchup,
      event,
    })),
  ], [events]);
  const selectedEvent = selected === "all" ? undefined : events.find((event) => event.id === selected);

  return (
    <div className="sgo-event-browser">
      <div className="sgo-event-browser__summary">
        <div>
          <strong>{events.length} fetched event{events.length === 1 ? "" : "s"}</strong>
          <span>{events.reduce((sum, event) => sum + event.propCount, 0)} cached prop{events.reduce((sum, event) => sum + event.propCount, 0) === 1 ? "" : "s"}</span>
        </div>
        <div>
          <strong>{auditEntries.length} audit entr{auditEntries.length === 1 ? "y" : "ies"}</strong>
          <span>Each tab is built from the actual {providerLabel} pull history.</span>
        </div>
      </div>

      <div className="sgo-event-browser__tabs" role="tablist" aria-label={`${providerLabel} events`}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={selected === tab.id}
            className={selected === tab.id ? "active" : ""}
            onClick={() => setSelected(tab.id)}
          >
            <strong>{tab.id === "all" ? "All" : "event" in tab ? tab.event?.sport ?? "" : ""}</strong>
            <span>{tab.id === "all" ? `${events.length} events` : tab.label}</span>
          </button>
        ))}
      </div>

      {selected === "all" ? (
        <div className="sgo-event-browser__all">
          {events.length ? events.map((event) => (
            <article className="sgo-event-card" key={event.id}>
              <div className="sgo-event-card__head">
                <div>
                  <span>{sportLabel(event.sport)}</span>
                  <strong>{event.matchup}</strong>
                </div>
                <div className="sgo-event-card__meta">
                  <strong>{formatDateTime(event.commenceTime)}</strong>
                  <span>{event.propCount} prop{event.propCount === 1 ? "" : "s"}</span>
                </div>
              </div>
              <div className="sgo-event-card__chips">
                <span>Raw markets: {event.rawMarketTypes.length ? event.rawMarketTypes.join(" · ") : "none listed"}</span>
                <span>Source/budget: {event.source.status}{typeof event.source.cost === "number" ? ` · cost ${event.source.cost}` : ""}{typeof event.source.remaining === "number" ? ` · ${event.source.remaining} remaining` : ""}{typeof event.source.normalized === "number" ? ` · ${event.source.normalized} normalized` : ""}{typeof event.source.rejected === "number" ? ` · ${event.source.rejected} rejected` : ""}{event.source.error ? ` · ${event.source.error}` : ""}</span>
              </div>
              <div className="sgo-prop-grid">
                {event.props.map((prop) => (
                  <div className="sgo-prop-card" key={prop.id}>
                    <strong>{prop.playerName}</strong>
                    <span>{prop.direction} {prop.line} {prop.statType}</span>
                    <small>{prop.homeTeam} vs {prop.awayTeam}</small>
                    <small>Event {prop.eventId}</small>
                  </div>
                ))}
              </div>
            </article>
          )) : <p className="sgo-empty-state">No cached event pulls are available yet for this provider.</p>}
        </div>
      ) : (
        <article className="sgo-event-card">
          <div className="sgo-event-card__head">
            <div>
              <span>{sportLabel(selectedEvent?.sport ?? "MLB")}</span>
              <strong>{selectedEvent?.matchup ?? "Selected event"}</strong>
            </div>
            <div className="sgo-event-card__meta">
              <strong>{selectedEvent ? formatDateTime(selectedEvent.commenceTime) : "No time"}</strong>
              <span>{selectedEvent?.propCount ?? 0} prop{selectedEvent?.propCount === 1 ? "" : "s"}</span>
            </div>
          </div>
          <div className="sgo-event-card__chips">
            <span>Raw markets: {selectedEvent?.rawMarketTypes.length ? selectedEvent.rawMarketTypes.join(" · ") : "none listed"}</span>
            <span>Source/budget: {selectedEvent?.source.status ?? "not cached yet"}{typeof selectedEvent?.source.cost === "number" ? ` · cost ${selectedEvent.source.cost}` : ""}{typeof selectedEvent?.source.remaining === "number" ? ` · ${selectedEvent.source.remaining} remaining` : ""}{typeof selectedEvent?.source.normalized === "number" ? ` · ${selectedEvent.source.normalized} normalized` : ""}{typeof selectedEvent?.source.rejected === "number" ? ` · ${selectedEvent.source.rejected} rejected` : ""}{selectedEvent?.source.error ? ` · ${selectedEvent.source.error}` : ""}</span>
          </div>
          {selectedEvent?.props.length ? (
            <div className="sgo-prop-grid">
              {selectedEvent.props.map((prop) => (
                <div className="sgo-prop-card" key={prop.id}>
                  <strong>{prop.playerName}</strong>
                  <span>{prop.direction} {prop.line} {prop.statType}</span>
                  <small>{prop.homeTeam} vs {prop.awayTeam}</small>
                  <small>Event {prop.eventId}</small>
                </div>
              ))}
            </div>
          ) : (
            <p className="sgo-empty-state">No player props were cached for this event.</p>
          )}
        </article>
      )}
    </div>
  );
}
