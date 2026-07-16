alter table public.score_explanations
  add column if not exists recent_values numeric[] not null default '{}';
