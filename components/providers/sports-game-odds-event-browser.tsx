"use client";

import { useMemo, useState } from "react";
import type { NormalizedSportsGameOddsProp } from "@/lib/providers/sports-game-odds";
import type { SportsGameOddsAuditEntry } from "@/lib/providers/sports-game-odds-audit";
import type { Sport } from "@/lib/types";

type SportsGameOddsEventBrowserProps = {
  auditEntries: SportsGameOddsAuditEntry[];
};

type BrowserEvent = {
  id: string;
  sport: Sport;
  sportKey: string;
  eventId: string;
  matchup: string;
  commenceTime: string;
  propCount: number;
  marketTypes: string[];
  props: NormalizedSportsGameOddsProp[];
  source: SportsGameOddsAuditEntry;
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

function inferSportFromSportKey(sportKey: string): Sport {
  const normalized = sportKey.toLowerCase();
  if (normalized.includes("baseball_mlb") || normalized === "mlb") return "MLB";
  if (normalized.includes("basketball_wnba") || normalized === "wnba") return "WNBA";
  if (normalized.includes("basketball_nba") || normalized === "nba") return "NBA";
  if (normalized.includes("americanfootball_nfl") || normalized === "nfl") return "NFL";
  return "MLB";
}

function buildBrowserEvents(auditEntries: SportsGameOddsAuditEntry[]) {
  const map = new Map<string, BrowserEvent>();
  for (const entry of auditEntries) {
    for (const event of entry.events) {
      const firstProp = event.playerProps[0];
      const sportKey = firstProp?.sportKey ?? entry.sportKey;
      const sport = firstProp ? inferSportFromSportKey(firstProp.sportKey) : entry.sport;
      const key = keyForEvent(sportKey, event.eventId);
      const existing = map.get(key) ?? {
        id: key,
        sport,
        sportKey,
        eventId: event.eventId,
        matchup: event.matchup,
        commenceTime: event.commenceTime,
        propCount: 0,
        marketTypes: [],
        props: [],
        source: entry,
      };
      existing.propCount += event.propCount;
      existing.marketTypes = [...new Set([...existing.marketTypes, ...event.marketTypes])];
      existing.props.push(...event.playerProps);
      existing.matchup = event.matchup || existing.matchup;
      existing.commenceTime = event.commenceTime || existing.commenceTime;
      existing.source = entry;
      map.set(key, existing);
    }
  }
  return [...map.values()].sort((left, right) => new Date(left.commenceTime).getTime() - new Date(right.commenceTime).getTime());
}

export function SportsGameOddsEventBrowser({ auditEntries }: SportsGameOddsEventBrowserProps) {
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
          <span>Each tab is built from the actual SportsGameOdds pull history.</span>
        </div>
      </div>

      <div className="sgo-event-browser__tabs" role="tablist" aria-label="SportsGameOdds events">
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
                <span>Raw markets: {event.marketTypes.length ? event.marketTypes.join(" · ") : "none listed"}</span>
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
          )) : <p className="sgo-empty-state">No SportsGameOdds event pulls are cached yet for today.</p>}
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
            <span>Raw markets: {selectedEvent?.marketTypes.length ? selectedEvent.marketTypes.join(" · ") : "none listed"}</span>
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
