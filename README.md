# Picklebook Chat Agent

Next.js chat frontend plus **Supabase court data** (source of truth) and sync tooling.
Semantic search runs on the separate [`picklebook-court-sync`](../picklebook-court-sync) Cloudflare Worker.

```
src/app/              Next.js chat UI + POST /api/query proxy
supabase/             Postgres schema, pg_cron, Edge Function sync-courts
```

## Data pipeline

```
court-booking-scraper  →  sync-courts (Edge Fn)  →  Supabase courts/slots
                              ↓
                    picklebook-court-sync POST /sync/index/workflow
                              ↓
                         Vectorize index
                              ↓
              chat POST /api/query  →  court-sync POST /query
```

After each successful `sync-courts` run:

1. **Google Sheets** (optional) — `sync-courts` calls scraper with `exportSheets: true` on **`POST /api/scrape`**. Google secrets live on **court-booking-scraper** (Render `.env`), not the Worker.
2. **Vectorize** — `POST {COURT_SYNC_WORKER_URL}/sync/index/workflow` with `{ "namespace": "courts" }`
   (10s timeout; rebuild is async). If either optional step fails, `sync-courts` still returns `ok: true`.

Vectorize ids use **`courts.external_id`** and slot composite keys — not bigint `courts.id` /
`slots.id` (those reset on every truncate).

## Chat frontend

## Access gate

The chat is protected by a shared secret, `CHAT_ACCESS_KEY`:

- The browser collects it in a dialog, stores it in a cookie, and sends it as
  the `x-chat-access-key` header.
- `/api/query` rejects any request whose header does not match `CHAT_ACCESS_KEY`
  (`401`). If the server has no `CHAT_ACCESS_KEY` configured, the chat is locked
  (`503`) — so the gate cannot be bypassed by calling the API directly.
- A wrong key clears the stored cookie and re-prompts.

Set it in `.env.local` for dev and as a **secret** in the Cloudflare dashboard
for production.

## Supabase setup

```bash
pnpm install
cp supabase/functions/.env.example supabase/functions/.env   # scraper + court-sync URLs
cp .env.local.example .env.local                           # chat frontend

supabase start          # optional local stack
supabase db reset       # apply migrations

pnpm functions:serve    # test sync-courts locally
pnpm dev                # chat UI
```

### Edge Function secrets (`supabase secrets set`)

| Secret | Required | Notes |
| --- | --- | --- |
| `SCRAPER_SERVICE_URL` | yes | court-booking-scraper base URL (no path) |
| `SCRAPER_SERVICE_TOKEN` | no | Bearer token for scraper |
| `COURT_SYNC_WORKER_URL` | yes (prod) | e.g. `https://picklebook-court-sync.estremosjoshua.workers.dev` |
| `INDEX_SYNC_SECRET` | no | Must match court-sync Worker if set |

Google Sheets secrets (`GOOGLE_SHEETS_*`, `GOOGLE_SERVICE_ACCOUNT_JSON`) are set on **picklebook-court-sync** via `wrangler secret put`, not on Supabase.

### Google Sheets setup

See [picklebook-court-sync](../picklebook-court-sync) README — create spreadsheet, service account, then:

```bash
cd ../picklebook-court-sync
npx wrangler secret put GOOGLE_SHEETS_SPREADSHEET_ID
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
```

Share the spreadsheet with the service account email (Editor). After each `sync-courts` run, the Worker writes one **`Availability`** tab with venue sections.

Also set Vault entries `project_url` and `service_role_key` in Postgres for pg_cron
(see `supabase/scripts/setup-vault-secrets.sql`).

Deploy: push to `main` → `.github/workflows/supabase-deploy.yml` runs `db push` + `functions deploy`.

## Setup (chat only)

```bash
# 1. Install deps (uses pnpm)
pnpm install

# 2. Copy env files
cp .env.local.example .env.local

# 3. Start the court service in the other repo (separate terminal)
#    cd ../picklebook-court-scraper && npm run dev   # serves http://localhost:8787

# 4. Run the frontend
pnpm dev
```

`COURT_SCRAPER_URL` defaults to `http://localhost:8787` for local dev.

## Useful commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Run Next.js dev server |
| `pnpm db:push` | Push migrations to linked Supabase |
| `pnpm db:reset` | Reset local Postgres + reapply migrations |
| `pnpm functions:serve` | Serve `sync-courts` locally |
| `pnpm functions:deploy` | Deploy Edge Functions |
| `pnpm typecheck` | `tsc --noEmit` |

## Cloudflare Workers (Workers Builds from Git)

This app uses [@opennextjs/cloudflare](https://opennext.js.org/cloudflare). **`.env.local` is only for local dev** — Git builds never see it. Set values in the Cloudflare dashboard instead.

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

### 3. Environment variables

**Settings → Variables and Secrets** (runtime — used by `/api/query` on each request):

| Variable | Secret? | Notes |
| --- | --- | --- |
| `COURT_SCRAPER_URL` | no | Public URL of the deployed court service (e.g. `https://picklebook-court-sync.estremosjoshua.workers.dev`). Also set in `wrangler.jsonc` `vars`. |
| `CHAT_ACCESS_KEY` | **yes** | Shared secret required to use the chat. Users enter it once in the dialog. |

After changing runtime vars, redeploy once (push to `main` or **Retry deployment**). The deploy command uses `--keep-vars` so dashboard runtime vars are not wiped.

### 4. Local deploy (optional)

```bash
pnpm deploy   # build + deploy from your machine
pnpm preview  # local Worker; copy .dev.vars.example → .dev.vars or use .env.local
```
