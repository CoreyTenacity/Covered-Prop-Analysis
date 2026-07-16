-- Make the SharpAPI current-props upsert target real in Supabase.
-- The app writes current_props with on_conflict(provider, provider_prop_key).
-- If older rows were duplicated before the constraint existed, remove the
-- duplicates first so the unique index can be created safely.

with ranked as (
  select
    ctid,
    row_number() over (
      partition by provider, provider_prop_key
      order by updated_at desc nulls last, created_at desc nulls last, id desc
    ) as row_num
  from public.current_props
)
delete from public.current_props
where ctid in (
  select ctid
  from ranked
  where row_num > 1
);

create unique index if not exists current_props_provider_key_unique_idx
  on public.current_props (provider, provider_prop_key);
