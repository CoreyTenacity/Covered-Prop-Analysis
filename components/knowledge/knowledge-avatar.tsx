"use client";

import { useState } from "react";

function initialsForName(name: string) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase())
    .slice(0, 2)
    .join("");

  return initials || "CV";
}

export function KnowledgeAvatar({
  name,
  imageUrl,
  teamLogoUrl,
  size = "md",
}: {
  name: string;
  imageUrl?: string | null;
  teamLogoUrl?: string | null;
  size?: "sm" | "md";
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const [teamLogoFailed, setTeamLogoFailed] = useState(false);

  return (
    <div className={`knowledge-avatar knowledge-avatar--${size}`} aria-hidden="true">
      {imageUrl && !imageFailed ? (
        <img
          className="knowledge-avatar__image"
          src={imageUrl}
          alt=""
          loading="lazy"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span className="knowledge-avatar__fallback">{initialsForName(name)}</span>
      )}
      {teamLogoUrl && !teamLogoFailed ? (
        <span className="knowledge-avatar__team-mark">
          <img
            className="knowledge-avatar__team-logo"
            src={teamLogoUrl}
            alt=""
            loading="lazy"
            onError={() => setTeamLogoFailed(true)}
          />
        </span>
      ) : null}
    </div>
  );
}
