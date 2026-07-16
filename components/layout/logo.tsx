import Link from "next/link";

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/today" className={compact ? "logo logo--compact" : "logo"} aria-label="Covered — return to today's opportunities">
      <span className="logo__word">Covered</span>
      <span className="logo__target" aria-hidden="true">
        <span className="logo__target-ring logo__target-ring--outer" />
        <span className="logo__target-ring logo__target-ring--inner" />
        <span className="logo__target-core" />
      </span>
    </Link>
  );
}
