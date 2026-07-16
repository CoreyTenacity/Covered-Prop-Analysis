-- Add event_id to mlb_handedness_splits so the job can upsert by
-- (player_id, event_id) instead of inserting a duplicate row on every run.
--
-- The existing unique index (player_id, split_date, batter_side, pitcher_side,
-- stat_type) is retained for backwards compatibility with any existing rows that
-- pre-date this column. New rows written by refreshMlbHandednessSplits will
-- always carry event_id so the new index is the authoritative constraint going
-- forward.

begin;

alter table public.mlb_handedness_splits
  add column if not exists event_id uuid references public.events(id) on delete cascade;

drop index if exists public.mlb_handedness_splits_event_idx;
drop index if exists public.mlb_handedness_splits_unique_idx;

-- Unique constraint: one handedness context row per player per event.
-- stat_type is included because the table schema allows for future expansion
-- beyond the current single stat_type value ("handedness_context").
create unique index mlb_handedness_splits_event_idx
  on public.mlb_handedness_splits (player_id, event_id, stat_type);

commit;
