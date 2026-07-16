alter table if exists saved_picks
  add column if not exists grading_note text;

