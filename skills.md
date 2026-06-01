# Picklebook Chat Agent — project skills

Short reference for humans and agents working in this repo.

## Stack

- **Frontend**: Next.js 16 App Router in `src/app/*`. Chat at `/chat` proxies to the court-sync Worker.
- **Court data (source of truth)**: Supabase Postgres (`public.courts`, `public.slots`). Schema in `supabase/migrations/`.
- **Scraper**: External `court-booking-scraper` service — `POST /api/scrape` with `{ all: true, maxDays: 30 }`.
- **Search index**: Cloudflare Worker `picklebook-court-sync` — Vectorize + Workers AI for `POST /query`.
- **Sync**: Supabase Edge Function `supabase/functions/sync-courts`, scheduled every 10 min via pg_cron.

## Data pipeline (sync → search)

```
court-booking-scraper  POST /api/scrape
        ↓
sync-courts (Edge Fn)  truncate + reload Supabase courts/slots
        ↓
picklebook-court-sync  POST /sync/index/workflow  →  SupabaseIndexWorkflow  →  Vectorize
        ↓
picklebook-chat-agent  POST /api/query  →  court-sync POST /query  →  semantic answers
```

### Stable ids for Vectorize (important)

Vectorize document ids use **`courts.external_id`** and **`external_id:datetime`**, not `slots.id` / `courts.id` (those reset every truncate via `RESTART IDENTITY`).

## Sync + cron

- **`supabase/functions/sync-courts`**:
  1. `POST {SCRAPER_SERVICE_URL}/api/scrape` with `{ all: true, maxDays: 30 }`
  2. `rpc truncate_courts_and_slots()` — `TRUNCATE slots` + `TRUNCATE courts RESTART IDENTITY`
  3. Batch insert courts (`external_id` = scraper court id)
  4. Batch insert slots (FK to new bigint `court_id`; only `available: true`)
  5. **Google Sheets** (optional): `_shared/google-sheets-sync.ts` — one tab per court, readable slot grid; `_Index` tab
  6. **`POST {COURT_SYNC_WORKER_URL}/sync/index/workflow`** with `{ "namespace": "courts" }` (10s timeout; errors logged, sync still returns `ok: true`)

- **Edge Function secrets** (`supabase secrets set` or `supabase/functions/.env` locally):
  - `SCRAPER_SERVICE_URL` — scraper base URL (no path)
  - `SCRAPER_SERVICE_TOKEN` (optional)
  - `COURT_SYNC_WORKER_URL` — e.g. `https://picklebook-court-sync.estremosjoshua.workers.dev`
  - `INDEX_SYNC_SECRET` (optional) — must match court-sync Worker secret if set
  - `GOOGLE_SHEETS_SPREADSHEET_ID` + `GOOGLE_SERVICE_ACCOUNT_JSON` (optional) — share spreadsheet with service account email

- **Cron**: migration `20260527073230_schedule_sync_courts.sql`. Vault secrets `project_url` + `service_role_key` in Postgres (see `supabase/scripts/setup-vault-secrets.sql`).

- **court-sync backup cron**: Worker cron at `:02,:12,:22,...` re-indexes if the Edge trigger is skipped.

## Chat agent (`src/app`)

- **`POST /api/query`**: Proxies `{ message }` → `{ question }` to `${COURT_SCRAPER_URL}/query`. Requires `CHAT_ACCESS_KEY` header.
- **`CHAT_ACCESS_KEY`**: Shared secret; browser dialog stores cookie, server validates on every request.
- Conversation history is not sent (`/query` is stateless RAG).

## Deployments

- **Supabase**: `.github/workflows/supabase-deploy.yml` — `supabase db push` + `supabase functions deploy` on push to `main`.
  - Repo secrets: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`.
  - Edge secrets: see Sync section above.

- **Chat frontend**: Cloudflare Workers via OpenNext — see `README.md` (`COURT_SCRAPER_URL`, `CHAT_ACCESS_KEY`).
