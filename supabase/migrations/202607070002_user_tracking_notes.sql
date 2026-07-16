alter table if exists public.user_picks
  add column if not exists notes text;

alter table if exists public.user_parlays
  add column if not exists notes text;
