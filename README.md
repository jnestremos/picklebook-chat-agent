# Picklebook Chat Agent

A Next.js 16 frontend backed by Supabase. The chat agent searches scraped
pickleball / badminton court availability via OpenAI-compatible tool calls.

```
src/                 Next.js App Router (FE + /api route handlers = the only backend)
  app/
    api/agent/             POST: LLM tool loop, reads Supabase via service role
    api/courts/locations/  GET:  directory of venues
    chat/                  Chat page + realtime subscriptions
  lib/
    supabase/              server.ts (service role) + browser.ts (anon, realtime)
    agent/                 system-prompt, tools, OpenAI loop, Manila helpers

supabase/            Pulled from the linked Supabase project
  migrations/        Schema + cron schedule for sync-courts
  functions/
    sync-courts/     Edge function: GET scraper → upsert courts → replace slots
    _shared/         CORS / JSON helper

.github/workflows/   db push + functions deploy on main
```

## Setup

```bash
# 1. Install deps (uses pnpm)
pnpm install

# 2. Copy env files
cp .env.local.example .env.local
cp supabase/functions/.env.example supabase/functions/.env

# 3. Start Supabase locally (requires Docker)
supabase start

# 4. Apply migrations to the local stack
supabase db reset

# 5. Run the frontend
pnpm dev
```

## Useful commands

| Command                       | What it does                                        |
| ----------------------------- | --------------------------------------------------- |
| `pnpm dev`                    | Run Next.js dev server                              |
| `pnpm db:diff`                | Diff local vs. linked Supabase                      |
| `pnpm db:push`                | Push pending migrations to the linked project       |
| `pnpm db:reset`               | Reset the local Postgres + reapply all migrations   |
| `pnpm functions:serve`        | Serve `sync-courts` locally with `supabase/functions/.env` |
| `pnpm functions:deploy`       | Deploy all edge functions to the linked project     |

## Production deploys

1. Push to `main` — `.github/workflows/supabase-deploy.yml` runs `supabase db push` and `supabase functions deploy`.
2. Once per project, set the runtime secrets:
   ```bash
   supabase secrets set --env-file supabase/functions/.env
   ```
3. In SQL editor / psql, replace the placeholder vault secrets seeded by the cron migration:
   ```sql
   update vault.secrets set secret = 'https://<ref>.supabase.co' where name = 'project_url';
   update vault.secrets set secret = '<service-role-key>'        where name = 'service_role_key';
   ```
4. Deploy the Next.js app to your host of choice (Vercel, Fly, etc.) with `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and the `OPENAI_*` / `OPENAI_COMPAT_*` keys set.
