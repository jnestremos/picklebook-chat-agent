# Picklebook Chat Agent — project skills

Short reference for humans and agents working in this repo. Updated after the
D1 + Hono → Supabase migration.

## Stack

- **Frontend**: Next.js 16 App Router in `src/app/*`. No more Nx — `next dev` is the only dev command for the FE.
- **Backend**: Next.js route handlers in `src/app/api/*` use the **service-role** Supabase client to talk to Postgres.
- **Database**: Supabase (project ref `dhtmmiynkzloptvxkxvb`). Schema in `supabase/migrations/`.
- **Scraper sync**: Supabase Edge Function `supabase/functions/sync-courts`, called every 10 min by pg_cron (migration `20260527073230_schedule_sync_courts.sql`).

## API → web contract

- **`POST /api/agent`** returns `{ message, data?, meta? }`. `data` is an array of slot rows from the `court_slot_rows` view; `meta.search` carries the `{ location?, manilaDate?, datetime? }` arguments the LLM passed to `search_courts`.
- **`GET /api/courts/locations`** returns `{ locations: { location, court_count, court_names }[] }` from the `court_locations` view.
- **`meta.search.location`** drives the **narrow calendar view**: only venue columns that pass `venueHeaderMatchesSearchHint` show by default; unrelated courts are behind **"Show other venues"**.

## Venue relevance (web)

- Implemented in `src/app/chat/search-data-preview.tsx`.
- **Problem solved:** generic tokens like `pickle`, `indoor`, `court`, `sports` matched many venues; we **do not** score on those alone.
- **Match rules:** (1) normalized **full phrase** substring for a segment (split on `and` / `,` / `&` / `+`), **or** (2) overlap on **discriminative** words after stripping the generic set (`GENERIC_VENUE_TOKENS`).
- Columns need **`venueSearchHintScores >= MIN_VENUE_HINT_SCORE` (260)** to count as "searched" for the narrow table.

## Backend search

- **`src/lib/agent/tools.ts`** exposes `searchCourts` + `listLocations`. The search uses `ilike` on `name`/`location` plus a Manila-day timestamp range.
- The agent reads Supabase server-side on **every** turn (the system prompt enforces it), so realtime is only a UX nicety for the FE — the LLM never depends on the browser's view.

## Realtime

- `supabase/migrations/20260527073229_initial_schema.sql` adds `public.courts` + `public.slots` to the `supabase_realtime` publication.
- Browser hook: `src/app/chat/use-realtime-pulse.ts` returns a counter that ticks on any change, used to refresh the locations directory.

## Sync + Cron

- `supabase/functions/sync-courts` GETs `{SCRAPER_SERVICE_URL}/api/scrape` (optional bearer `SCRAPER_SERVICE_TOKEN`), expects a JSON array of flat slot rows `{ name, location?, source?, price?, datetime, datetime_end?, time_slot?, booking_url?, court_booking_url?, skedda_space_id?, available? }`, reconciles courts by `skedda_space_id` or `(name, location)`, then deletes+inserts all slots.
- Schedule lives in the cron migration; **Vault** secrets `project_url` + `service_role_key` must be set in Postgres (see `supabase/scripts/setup-vault-secrets.sql`). This is **not** the same as `supabase secrets set` (Edge Function env vars).

## Tools / LLM

- OpenAI tool-calling loop: `src/lib/agent/openai-tool-agent.ts`. Prefers `OPENAI_COMPAT_*` env vars (any OpenAI-compatible endpoint), falls back to `OPENAI_API_KEY` + `OPENAI_MODEL`.
- **Responses:** Assistant text is **English-only** (`src/lib/agent/system-prompt.ts`; each user turn also carries a short `[Reply language: English]` note in `openai-tool-agent.ts`). Venue names etc. stay verbatim from DB.

## Deployments

- GitHub workflow `.github/workflows/supabase-deploy.yml` runs `supabase db push` + `supabase functions deploy` on push to `main`.
- Required repo secrets: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`.
- Edge function runtime secrets (set once via `supabase secrets set …` or in the workflow): `SCRAPER_SERVICE_URL` (scraper **base** URL, no path), optional `SCRAPER_SERVICE_TOKEN`.
- Vault entries (DB-side) `project_url` and `service_role_key` must be replaced in the dashboard or via psql.
