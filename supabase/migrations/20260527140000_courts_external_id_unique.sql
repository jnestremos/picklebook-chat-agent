-- PostgREST upsert(onConflict: 'external_id') needs a UNIQUE constraint.
-- Prior migration created a partial unique *index* with the same name — replace it.

alter table public.courts
  add column if not exists external_id text;

drop index if exists public.courts_external_id_key;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'courts_external_id_unique'
      and conrelid = 'public.courts'::regclass
  ) then
    alter table public.courts
      add constraint courts_external_id_unique unique (external_id);
  end if;
end
$$;
