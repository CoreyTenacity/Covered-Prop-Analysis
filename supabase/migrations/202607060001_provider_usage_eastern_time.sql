create or replace function reserve_provider_usage(
  p_provider text,
  p_units integer,
  p_daily_budget integer,
  p_monthly_budget integer default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now_et timestamp := timezone('America/New_York', now());
  v_day date := v_now_et::date;
  v_month date := date_trunc('month', v_now_et)::date;
  v_daily_used integer;
  v_monthly_used integer := 0;
begin
  if p_units <= 0 or p_daily_budget < 0 or (p_monthly_budget is not null and p_monthly_budget < 0) then
    raise exception 'Invalid provider usage reservation';
  end if;

  insert into provider_usage_daily(provider, usage_date, units_used, hard_budget)
  values (p_provider, v_day, 0, p_daily_budget)
  on conflict (provider, usage_date) do update set hard_budget = excluded.hard_budget;

  select units_used into v_daily_used from provider_usage_daily
  where provider = p_provider and usage_date = v_day for update;

  if v_daily_used + p_units > p_daily_budget then
    return jsonb_build_object('allowed', false, 'daily_used', v_daily_used, 'monthly_used', null);
  end if;

  if p_monthly_budget is not null then
    insert into provider_usage_monthly(provider, usage_month, units_used, hard_budget)
    values (p_provider, v_month, 0, p_monthly_budget)
    on conflict (provider, usage_month) do update set hard_budget = excluded.hard_budget;

    select units_used into v_monthly_used from provider_usage_monthly
    where provider = p_provider and usage_month = v_month for update;

    if v_monthly_used + p_units > p_monthly_budget then
      return jsonb_build_object('allowed', false, 'daily_used', v_daily_used, 'monthly_used', v_monthly_used);
    end if;
  end if;

  update provider_usage_daily set units_used = units_used + p_units, updated_at = now()
  where provider = p_provider and usage_date = v_day;

  if p_monthly_budget is not null then
    update provider_usage_monthly set units_used = units_used + p_units, updated_at = now()
    where provider = p_provider and usage_month = v_month;
    v_monthly_used := v_monthly_used + p_units;
  end if;

  return jsonb_build_object(
    'allowed', true,
    'daily_used', v_daily_used + p_units,
    'monthly_used', case when p_monthly_budget is null then null else v_monthly_used end
  );
end;
$$;

revoke all on function reserve_provider_usage(text, integer, integer, integer) from public, anon, authenticated;
grant execute on function reserve_provider_usage(text, integer, integer, integer) to service_role;
