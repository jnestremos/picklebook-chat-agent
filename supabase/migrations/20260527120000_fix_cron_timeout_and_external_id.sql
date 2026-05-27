-- Fix sync-courts cron: pg_net defaults to ~2–5s timeout but sync takes 20s+ (scrape + DB).
-- Also add courts.external_id so the edge function can upsert by stable scraper id.

alter table public.courts
  add column if not exists external_id text;

create unique index if not exists courts_external_id_key
  on public.courts (external_id)
  where external_id is not null;

-- Reschedule cron with a 3-minute HTTP timeout and apikey header (required by some gateways).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'sync-courts-every-10-min') then
    perform cron.unschedule('sync-courts-every-10-min');
  end if;
end
$$;

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
      raise warning 'sync-courts cron skipped: set vault secret project_url (see supabase/scripts/setup-vault-secrets.sql)';
      return;
    end if;
    if svc_key is null or btrim(svc_key) = '' or svc_key ilike '%REPLACE_ME%' then
      raise warning 'sync-courts cron skipped: set vault secret service_role_key (see supabase/scripts/setup-vault-secrets.sql)';
      return;
    end if;

    perform net.http_post(
      url     := rtrim(base_url, '/') || '/functions/v1/sync-courts',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || svc_key,
        'apikey', svc_key
      ),
      body    := jsonb_build_object('triggered_at', now()),
      timeout_milliseconds := 180000
    );
  end
  $body$;
  $cron$
);
