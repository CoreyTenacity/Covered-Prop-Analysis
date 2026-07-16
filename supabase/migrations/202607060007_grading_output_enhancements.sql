alter table public.grading_results
  add column if not exists odds_snapshot_id uuid references public.odds_snapshots(id) on delete set null,
  add column if not exists participant_id uuid references public.participants(id) on delete set null,
  add column if not exists event_id uuid references public.events(id) on delete set null,
  add column if not exists side text,
  add column if not exists final_stat numeric,
  add column if not exists grade_status text,
  add column if not exists grade_reason text,
  add column if not exists grading_flags text[] not null default '{}'::text[],
  add column if not exists model_version_id uuid references public.model_versions(id) on delete set null,
  add column if not exists graded_at timestamptz;

update public.grading_results
set final_stat = coalesce(final_stat, actual_value),
    grade_status = coalesce(grade_status, case when result = 'no_grade' then 'no_grade' else 'graded' end),
    graded_at = coalesce(graded_at, created_at)
where final_stat is null
   or grade_status is null
   or graded_at is null;

comment on column public.grading_results.odds_snapshot_id is 'Latest odds snapshot tied to the graded scored prop when available.';
comment on column public.grading_results.side is 'Canonical prop side used during grading.';
comment on column public.grading_results.final_stat is 'Resolved final stat used to grade the prop. Mirrors actual_value for compatibility.';
comment on column public.grading_results.grade_status is 'Grading lifecycle state: graded, no_grade, skipped, or already_graded.';
comment on column public.grading_results.grade_reason is 'Short machine-readable reason for the grading outcome.';
comment on column public.grading_results.grading_flags is 'Quality or grading flags such as missing_final_stat or unsupported_market.';
comment on column public.grading_results.graded_at is 'Timestamp when model grading was completed.';

create index if not exists grading_results_event_status_idx
  on public.grading_results (event_id, grade_status, graded_at desc);

create index if not exists grading_results_scored_prop_idx
  on public.grading_results (scored_prop_id, graded_at desc);
