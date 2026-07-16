-- RLS bypass does not replace ordinary table privileges. These tables remain
-- inaccessible to anon/authenticated clients and are available only to the
-- server-side service role used by Covered.'s protected refresh jobs.
grant select, insert, update, delete on table public.provider_cache to service_role;
grant select, insert, update on table public.provider_usage_daily to service_role;
grant select, insert, update on table public.provider_usage_monthly to service_role;

revoke all on table public.provider_cache from anon, authenticated;
revoke all on table public.provider_usage_daily from anon, authenticated;
revoke all on table public.provider_usage_monthly from anon, authenticated;
