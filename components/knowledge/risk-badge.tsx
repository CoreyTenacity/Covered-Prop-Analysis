"use client";

export function RiskBadge({ label }: { label: string | null | undefined }) {
  if (!label) return null;
  const tone = /high|elevated/i.test(label) ? "risk-high" : /low/i.test(label) ? "risk-low" : "risk-mid";
  return <span className={`knowledge-badge knowledge-badge--${tone}`}>{label}</span>;
}
