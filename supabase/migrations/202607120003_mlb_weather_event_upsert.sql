-- Make MLB weather event-first so Sharp-only events no longer depend on a
-- legacy games row being present.
--
-- New rows should prefer event_id as the canonical contest key. game_id remains
-- as legacy compatibility for older rows, but it must no longer block writes
-- for events that only exist in the sport-agnostic events table.

alter table public.mlb_weather
  add column if not exists event_id uuid references public.events(id) on delete cascade;

alter table public.mlb_weather
  alter column game_id drop not null;

create unique index if not exists mlb_weather_event_idx
  on public.mlb_weather (event_id, weather_date);

comment on column public.mlb_weather.event_id is 'Canonical contest reference. New logic should prefer event_id over legacy game_id.';
comment on column public.mlb_weather.game_id is 'Legacy compatibility only. Safe to remove after downstream consumers finish migrating to event_id.';
