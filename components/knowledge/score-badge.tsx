"use client";

export function ScoreBadge({
  label,
  tone = "default",
}: {
  label: string | null | undefined;
  tone?: "default" | "score" | "confidence" | "risk";
}) {
  if (!label) return null;
  return <span className={`knowledge-badge knowledge-badge--${tone}`}>{label}</span>;
}
