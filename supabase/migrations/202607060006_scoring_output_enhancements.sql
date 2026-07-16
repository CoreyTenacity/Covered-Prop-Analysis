alter table public.scored_props
  add column if not exists covered_score numeric;

alter table public.score_explanations
  add column if not exists score_label text,
  add column if not exists confidence_label text,
  add column if not exists risk_label text,
  add column if not exists factors jsonb not null default '[]'::jsonb;

comment on column public.scored_props.covered_score is 'Final Covered Score used for ranking future Covered Picks of the Day and analyzer outputs.';
comment on column public.score_explanations.score_label is 'User-facing overall score label such as Elite, Strong, Playable, Lean, Pass, or Avoid.';
comment on column public.score_explanations.confidence_label is 'User-facing confidence label such as High Confidence or Data Limited.';
comment on column public.score_explanations.risk_label is 'User-facing risk label such as Low Risk or Elevated Risk.';
comment on column public.score_explanations.factors is 'Structured factor-by-factor explanation payload for product reads.';

create index if not exists scored_props_covered_score_idx
  on public.scored_props (league_id, covered_score desc, created_at desc);
