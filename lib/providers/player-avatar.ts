import type { Sport } from "@/lib/types";

function initials(playerName: string) {
  return playerName
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .slice(0, 2)
    .join("") || "P";
}

function sportTint(sport: Sport) {
  if (sport === "MLB") return { start: "#7c3aed", end: "#1f1534" };
  if (sport === "WNBA") return { start: "#d946ef", end: "#2b1734" };
  if (sport === "NBA") return { start: "#60a5fa", end: "#152236" };
  if (sport === "NFL") return { start: "#22c55e", end: "#13271d" };
  return { start: "#8b5cf6", end: "#171127" };
}

export function generatedAvatarUrl(playerName: string, sport: Sport) {
  const { start, end } = sportTint(sport);
  const letters = initials(playerName);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" fill="none">
      <defs>
        <radialGradient id="g" cx="0.35" cy="0.2" r="0.85">
          <stop offset="0%" stop-color="${start}" />
          <stop offset="100%" stop-color="${end}" />
        </radialGradient>
      </defs>
      <rect width="128" height="128" rx="64" fill="url(#g)" />
      <circle cx="64" cy="52" r="22" fill="rgba(255,255,255,0.08)" />
      <path d="M29 106c8-18 22-27 35-27s27 9 35 27" fill="rgba(255,255,255,0.08)" />
      <text x="64" y="72" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="28" font-weight="800" fill="#f5f3ff">${letters}</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}
