alter table public.current_props
  add column if not exists start_time timestamptz;

alter table public.odds_snapshots
  add column if not exists market_instance_key text;

alter table public.current_props
  add column if not exists market_instance_key text;

update public.current_props
set start_time = coalesce(start_time, game_time)
where start_time is null
  and game_time is not null;

update public.odds_snapshots
set market_instance_key = case
  when provider = 'sharpapi' then regexp_replace(provider_prop_key, '\\|(more|less|unknown)$', '')
  else provider_prop_key
end
where market_instance_key is null
  and provider_prop_key is not null;

update public.current_props
set market_instance_key = case
  when provider = 'sharpapi' then regexp_replace(provider_prop_key, '\\|(more|less|unknown)$', '')
  else provider_prop_key
end
where market_instance_key is null
  and provider_prop_key is not null;

comment on column public.current_props.start_time is 'Canonical contest start time for future product reads. Legacy game_time remains for backward compatibility.';
comment on column public.odds_snapshots.market_instance_key is 'Shared prop-family key that groups the same market instance across sides and line updates.';
comment on column public.current_props.market_instance_key is 'Shared prop-family key that groups the same market instance across sides and line updates.';

create index if not exists odds_snapshots_market_instance_idx
  on public.odds_snapshots (provider, league_id, market_instance_key, pulled_at desc);

create index if not exists current_props_market_instance_idx
  on public.current_props (provider, league_id, market_instance_key);

create index if not exists current_props_start_time_idx
  on public.current_props (league_id, start_time);
