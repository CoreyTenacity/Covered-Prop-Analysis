import type { ActiveKnowledgeLeagueCode } from "@/lib/knowledge/types";

function firstExternalId(externalIds: Record<string, unknown> | null | undefined, keys: string[]) {
  for (const key of keys) {
    const value = externalIds?.[key];
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return null;
}

function normalizeMlbLogoAbbreviation(abbreviation: string | null | undefined) {
  const normalized = (abbreviation ?? "").trim().toLowerCase();
  if (!normalized) return null;

  const aliases: Record<string, string> = {
    ari: "ari",
    atl: "atl",
    bal: "bal",
    bos: "bos",
    chc: "chc",
    cws: "chw",
    chw: "chw",
    cin: "cin",
    cle: "cle",
    col: "col",
    det: "det",
    hou: "hou",
    kc: "kc",
    kcr: "kc",
    laa: "laa",
    lad: "lad",
    mia: "mia",
    mil: "mil",
    min: "min",
    nym: "nym",
    nyy: "nyy",
    oak: "oak",
    ath: "oak",
    phi: "phi",
    pit: "pit",
    sd: "sd",
    sdp: "sd",
    sea: "sea",
    sf: "sf",
    sfg: "sf",
    stl: "stl",
    tb: "tb",
    tbr: "tb",
    tex: "tex",
    tor: "tor",
    wsh: "wsh",
    was: "wsh",
  };

  return aliases[normalized] ?? normalized;
}

export function deriveBasketballHeadshotUrl(leagueId: ActiveKnowledgeLeagueCode, externalIds?: Record<string, unknown> | null) {
  const playerId = firstExternalId(externalIds, ["nba-com-stats", "wehoop-wnba"]);
  if (!playerId) return null;
  if (leagueId === "WNBA") return `https://cdn.wnba.com/headshots/wnba/latest/1040x760/${playerId}.png`;
  return `https://cdn.nba.com/headshots/nba/latest/1040x760/${playerId}.png`;
}

export function deriveBasketballTeamLogoUrl(leagueId: ActiveKnowledgeLeagueCode, externalIds?: Record<string, unknown> | null) {
  const teamId = firstExternalId(externalIds, ["nba-com-stats", "wehoop-wnba"]);
  if (!teamId) return null;
  if (leagueId === "WNBA") return `https://cdn.wnba.com/logos/wnba/${teamId}/primary/L/logo.svg`;
  return `https://cdn.nba.com/logos/nba/${teamId}/global/L/logo.svg`;
}

export function deriveMlbTeamLogoUrl(abbreviation?: string | null) {
  const code = normalizeMlbLogoAbbreviation(abbreviation);
  return code ? `https://a.espncdn.com/i/teamlogos/mlb/500/${code}.png` : null;
}

export function derivePlayerHeadshotUrl(input: {
  leagueId: ActiveKnowledgeLeagueCode;
  storedHeadshotUrl?: string | null;
  participantImageUrl?: string | null;
  externalIds?: Record<string, unknown> | null;
}) {
  if (input.participantImageUrl) return input.participantImageUrl;
  if (input.storedHeadshotUrl) return input.storedHeadshotUrl;
  if (input.leagueId === "NBA" || input.leagueId === "WNBA") {
    return deriveBasketballHeadshotUrl(input.leagueId, input.externalIds);
  }
  return null;
}

export function deriveTeamLogoUrl(input: {
  leagueId: ActiveKnowledgeLeagueCode;
  storedLogoUrl?: string | null;
  externalIds?: Record<string, unknown> | null;
  abbreviation?: string | null;
}) {
  if (input.storedLogoUrl) return input.storedLogoUrl;
  if (input.leagueId === "NBA" || input.leagueId === "WNBA") {
    return deriveBasketballTeamLogoUrl(input.leagueId, input.externalIds);
  }
  if (input.leagueId === "MLB") {
    return deriveMlbTeamLogoUrl(input.abbreviation);
  }
  return null;
}
