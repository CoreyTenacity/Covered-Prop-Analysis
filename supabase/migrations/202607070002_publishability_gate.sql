alter table public.current_props
  add column if not exists prop_state text not null default 'raw_current';

alter table public.scored_props
  add column if not exists prop_state text not null default 'candidate',
  add column if not exists publishable boolean not null default false,
  add column if not exists publishability_reasons text[] not null default '{}'::text[];

comment on column public.current_props.prop_state is 'Lifecycle stage for stored current props. raw_current rows are ingested odds records before final scoring/publishing decisions.';
comment on column public.scored_props.prop_state is 'Lifecycle stage for scored props. candidate rows are scored internally; publishable rows are eligible for Covered Picks of the Day.';
comment on column public.scored_props.publishable is 'Whether this scored prop passed identity, context, and freshness gates for final product surfaces.';
comment on column public.scored_props.publishability_reasons is 'Debug and admin-visible reasons why a scored prop is still candidate-only or why it was publishable.';

create index if not exists current_props_prop_state_idx
  on public.current_props (prop_state, league_id, updated_at desc);

create index if not exists scored_props_publishable_idx
  on public.scored_props (publishable, league_id, covered_score desc, created_at desc);

create index if not exists scored_props_prop_state_idx
  on public.scored_props (prop_state, league_id, created_at desc);
