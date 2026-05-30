-- Schedule the `sync-courts` edge function to run every 10 minutes via pg_cron + pg_net.
--
-- This is the ONLY migration the project ships with. The `courts` + `slots` tables
-- already exist in the linked Supabase project; this migration adds realtime
-- publication for those tables and schedules the sync-courts edge function.
--
-- The cron job is idempotent: re-running the migration unschedules then re-creates it.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- ---------------------------------------------------------------------------
-- Realtime publication (used by src/app/chat/use-realtime-pulse.ts)
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'courts'
  ) then
    alter publication supabase_realtime add table public.courts;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'slots'
  ) then
    alter publication supabase_realtime add table public.slots;
  end if;
end
$$;

-- Unschedule any prior copy of the job before re-creating it.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'sync-courts-every-10-min') then
    perform cron.unschedule('sync-courts-every-10-min');
  end if;
end
$$;

-- NOTE: superseded by 20260527103000_fix_sync_courts_cron_vault.sql which adds Vault
-- seeding + null guards. Kept here for migration history on fresh db reset chains.
select cron.schedule(
  'sync-courts-every-10-min',
  '*/10 * * * *',
  $cron$
  do $body$
  declare
    base_url text;
    svc_key  text;
  begin
    select decrypted_secret into base_url
      from vault.decrypted_secrets where name = 'project_url' limit 1;
    select decrypted_secret into svc_key
      from vault.decrypted_secrets where name = 'service_role_key' limit 1;

    if base_url is null or btrim(base_url) = '' or base_url ilike '%REPLACE_ME%' then
      raise warning 'sync-courts cron skipped: set vault secret project_url';
      return;
    end if;
    if svc_key is null or btrim(svc_key) = '' or svc_key ilike '%REPLACE_ME%' then
      raise warning 'sync-courts cron skipped: set vault secret service_role_key';
      return;
    end if;

    perform net.http_post(
      url     := rtrim(base_url, '/') || '/functions/v1/sync-courts',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || svc_key
      ),
      body    := jsonb_build_object('triggered_at', now())
    );
  end
  $body$;
  $cron$
);
