-- Configure Vault secrets for the sync-courts pg_cron job.
--
-- Run this in the Supabase SQL Editor (Dashboard → SQL → New query).
-- Replace the two placeholder values below, then execute the whole script.
--
-- Where to find the values:
--   project_url       → https://<project-ref>.supabase.co  (Settings → API → Project URL)
--   service_role_key  → Settings → API → service_role key (secret — server-side only)
--
-- NOTE: This is separate from `supabase secrets set` (Edge Function env vars).
--       pg_cron + pg_net can only read Vault secrets in Postgres.

-- ---------------------------------------------------------------------------
-- 1. Inspect current Vault rows (optional)
-- ---------------------------------------------------------------------------
-- select name, description from vault.secrets where name in ('project_url', 'service_role_key');

-- ---------------------------------------------------------------------------
-- 2. Update secrets — edit the two strings below before running
-- ---------------------------------------------------------------------------

do $setup$
declare
  v_project_url text := 'https://dhtmmiynkzloptvxkxvb.supabase.co';
  v_service_key text := 'PASTE_SERVICE_ROLE_KEY_HERE';
  v_id uuid;
begin
  if v_service_key = 'PASTE_SERVICE_ROLE_KEY_HERE' then
    raise exception 'Replace PASTE_SERVICE_ROLE_KEY_HERE with your service_role key before running';
  end if;

  select id into v_id from vault.secrets where name = 'project_url' limit 1;
  if v_id is null then
    perform vault.create_secret(v_project_url, 'project_url', 'Supabase project URL for pg_cron → sync-courts');
  else
    perform vault.update_secret(v_id, v_project_url);
  end if;

  select id into v_id from vault.secrets where name = 'service_role_key' limit 1;
  if v_id is null then
    perform vault.create_secret(v_service_key, 'service_role_key', 'Service role JWT for pg_cron → sync-courts');
  else
    perform vault.update_secret(v_id, v_service_key);
  end if;
end
$setup$;

-- ---------------------------------------------------------------------------
-- 3. Verify (should show your project URL prefix, not REPLACE_ME)
-- ---------------------------------------------------------------------------
-- select name, left(decrypted_secret, 40) as secret_prefix
--   from vault.decrypted_secrets
--  where name in ('project_url', 'service_role_key');
