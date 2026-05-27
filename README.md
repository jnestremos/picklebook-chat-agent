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
4. Deploy the Next.js app — see [Cloudflare Workers](#cloudflare-workers) below or any other host with the same env vars set.

## Cloudflare Workers (Workers Builds from Git)

This app uses [@opennextjs/cloudflare](https://opennext.js.org/cloudflare). **`.env.local` is only for local dev** — Git builds never see it. Copy values from `.env.local` into the Cloudflare dashboard instead.

### 1. Connect the repo

Dashboard → **Workers & Pages** → **picklebook-chat-agent** → **Settings** → **Builds** → **Connect**

The Worker name in the dashboard must match `name` in `wrangler.jsonc` (`picklebook-chat-agent`).

### 2. Build settings

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | *(leave empty — repo root)* |
| Build command | `pnpm cf:build` |
| Deploy command | `pnpm cf:deploy` |
| Non-production branch deploy command | `pnpm cf:upload` *(optional; preview URLs)* |

Cloudflare auto-detects **pnpm** from `pnpm-lock.yaml` and runs install before the build command.

### 3. Environment variables (two separate sections)

Build variables are **not** available at runtime. You must set both sections in the dashboard.

**Settings → Builds → Build variables and secrets** (used during `pnpm cf:build`):

| Variable | Secret? |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | no |
| `NEXT_PUBLIC_ANON_KEY` or `NEXT_PUBLIC_SUPABASE_ANON_KEY` | no |

**Settings → Variables and Secrets** (runtime — used by `/api/*` on each request):

| Variable | Secret? |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | no |
| `NEXT_PUBLIC_ANON_KEY` or `NEXT_PUBLIC_SUPABASE_ANON_KEY` | no |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** |
| `OPENAI_API_KEY` | **yes** *(or use compat vars below)* |
| `OPENAI_MODEL` | no |
| `OPENAI_COMPAT_BASE_URL` | no *(must be public internet — not Tailscale/localhost)* |
| `OPENAI_COMPAT_API_KEY` | **yes** |
| `OPENAI_COMPAT_MODEL` | no |

After adding runtime vars, redeploy once (push to `main` or **Retry deployment**). The deploy command uses `--keep-vars` so dashboard runtime vars are not wiped.

### 4. Local deploy (optional)

```bash
pnpm deploy   # build + deploy from your machine (reads .env.local at build time)
pnpm preview  # local Worker; copy .dev.vars.example → .dev.vars or use .env.local
```
