# Picklebook Chat Agent

A thin Next.js 16 chat frontend for pickleball / badminton court availability.
The LLM, scraper, and database all live in the separate
[`picklebook-court-scraper`](../picklebook-court-scraper) Cloudflare worker. This
app just forwards each chat message to that worker's `/query` endpoint and
renders the answer.

```
src/                 Next.js App Router (FE + a single /api proxy route)
  app/
    api/query/   POST: proxies { message } to ${COURT_SCRAPER_URL}/query
    chat/        Chat page (text in, answer out)
  lib/
    env/runtime-env.ts   reads COURT_SCRAPER_URL on Workers or local dev
```

## Data flow

```
/chat page  --POST { message }-->  /api/query  --POST { question }-->  scraper /query
                                                <--   { answer }   --
```

The scraper worker owns embedding, the Vectorize lookup, and Workers AI answer
generation. It is stateless RAG, so only the latest message is sent (no
conversation history) and no LLM API key is required from the user.

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

## Setup

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

| Command          | What it does            |
| ---------------- | ----------------------- |
| `pnpm dev`       | Run Next.js dev server  |
| `pnpm typecheck` | `tsc --noEmit`          |
| `pnpm lint`      | `next lint`             |

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
| `COURT_SCRAPER_URL` | no | Public URL of the deployed scraper worker (e.g. `https://picklebook-court-scraper.<account>.workers.dev`). Also set in `wrangler.jsonc` `vars`. |
| `CHAT_ACCESS_KEY` | **yes** | Shared secret required to use the chat. Users enter it once in the dialog. |

After changing runtime vars, redeploy once (push to `main` or **Retry deployment**). The deploy command uses `--keep-vars` so dashboard runtime vars are not wiped.

### 4. Local deploy (optional)

```bash
pnpm deploy   # build + deploy from your machine
pnpm preview  # local Worker; copy .dev.vars.example → .dev.vars or use .env.local
```
