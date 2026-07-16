alter table public.odds_snapshots add column if not exists provider_market_type text;
alter table public.odds_snapshots add column if not exists side text;
alter table public.odds_snapshots add column if not exists over_price integer;
alter table public.odds_snapshots add column if not exists under_price integer;
alter table public.odds_snapshots add column if not exists start_time timestamptz;

alter table public.current_props add column if not exists provider_market_type text;
alter table public.current_props add column if not exists side text;
alter table public.current_props add column if not exists over_price integer;
alter table public.current_props add column if not exists under_price integer;

comment on column public.odds_snapshots.provider_market_type is 'Original provider market key before Covered canonical normalization.';
comment on column public.current_props.provider_market_type is 'Original provider market key before Covered canonical normalization.';
comment on column public.odds_snapshots.side is 'Canonical prop side for this stored row. Direction remains for backward compatibility.';
comment on column public.current_props.side is 'Canonical prop side for this stored row. Direction remains for backward compatibility.';
comment on column public.odds_snapshots.over_price is 'Current over price captured for the selected main line, even when the row represents the under side.';
comment on column public.odds_snapshots.under_price is 'Current under price captured for the selected main line, even when the row represents the over side.';
comment on column public.current_props.over_price is 'Current over price for this prop market.';
comment on column public.current_props.under_price is 'Current under price for this prop market.';
comment on column public.odds_snapshots.start_time is 'Provider-supplied contest start time stored with the historical odds snapshot.';
