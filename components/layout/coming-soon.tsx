import Link from "next/link";

export function ComingSoon({ title, description, step }: { title: string; description: string; step: string }) {
  return (
    <div className="coming-page">
      <div className="eyebrow"><span /> Planned workspace</div>
      <div className="coming-card">
        <span className="coming-card__step">{step}</span>
        <h1>{title}</h1>
        <p>{description}</p>
        <Link href="/today">← Return to today’s board</Link>
      </div>
    </div>
  );
}
