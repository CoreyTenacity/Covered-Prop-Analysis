alter table if exists public.teams
  add column if not exists logo_url text;

alter table if exists public.participants
  add column if not exists image_url text;

comment on column public.players.headshot_url is 'Optional player headshot URL from free provider-supported sources.';
comment on column public.teams.logo_url is 'Optional team logo URL from free provider-supported sources.';
comment on column public.participants.image_url is 'Optional participant image URL for player/team display without requiring a join.';
