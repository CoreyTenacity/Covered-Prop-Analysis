import type { ActiveKnowledgeLeagueCode, MatchResolution } from "@/lib/knowledge/types";
import type { NormalizedSharpMarketCandidate } from "@/lib/knowledge/sharp-normalize";

function normalize(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "");
}

function slug(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function safePart(value: string | null | undefined, fallback: string) {
  const trimmed = (value ?? "").trim();
  return trimmed.length ? trimmed : fallback;
}

export function buildSharpProviderPropKey(input: {
  league: ActiveKnowledgeLeagueCode;
  sportsbook: string;
  eventId: string;
  playerName: string;
  marketType: string;
  side: "more" | "less" | "unknown";
}) {
  return [
    "sharpapi",
    input.league.toLowerCase(),
    slug(input.sportsbook),
    input.eventId,
    normalize(input.playerName),
    input.marketType,
    input.side,
  ].join("|");
}

export function buildSharpMarketInstanceKey(candidate: NormalizedSharpMarketCandidate, league: ActiveKnowledgeLeagueCode, match: MatchResolution) {
  const eventRef = safePart(match.eventId, safePart(candidate.eventId, "unknown_event"));
  const participantRef = safePart(
    match.participantId,
    match.playerId ? `player:${match.playerId}` : normalize(candidate.playerName) || "unknown_participant",
  );
  const teamRef = safePart(match.teamId, slug(candidate.team) || "no_team");
  const opponentRef = safePart(
    match.opponentId,
    safePart(match.opponentTeamId, slug(candidate.homeTeam === candidate.team ? candidate.awayTeam : candidate.homeTeam) || "no_opponent"),
  );

  return [
    "sharpapi",
    league.toLowerCase(),
    eventRef,
    match.participantType ?? "player",
    participantRef,
    candidate.marketType,
    String(candidate.line),
    teamRef,
    opponentRef,
  ].join("|");
}
