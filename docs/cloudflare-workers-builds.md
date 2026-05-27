# Cloudflare Workers Builds checklist

Use this when connecting the GitHub repo to the `picklebook-chat-agent` Worker.

## Build settings (Settings → Builds)

```
Production branch:  main
Root directory:     (empty)
Build command:      pnpm cf:build
Deploy command:     pnpm cf:deploy
```

Optional preview deploys on other branches:

```
Non-production branch deploy command:  pnpm cf:upload
```

## Build variables and secrets (Settings → Builds)

These are available only during the OpenNext build. Required so `NEXT_PUBLIC_*` values are inlined into the client bundle.

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_ANON_KEY` *(or `NEXT_PUBLIC_SUPABASE_ANON_KEY`)*

## Runtime variables and secrets (Settings → Variables and Secrets)

These are available when the Worker handles requests. Required for API routes and server-side Supabase/LLM calls.

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_ANON_KEY` *(or `NEXT_PUBLIC_SUPABASE_ANON_KEY`)*
- `SUPABASE_SERVICE_ROLE_KEY` — **Secret**
- `OPENAI_API_KEY` — **Secret** *(if not using compat endpoint)*
- `OPENAI_MODEL` *(optional)*
- `OPENAI_COMPAT_BASE_URL` *(public URL only)*
- `OPENAI_COMPAT_API_KEY` — **Secret** *(optional)*
- `OPENAI_COMPAT_MODEL`

## Verify

1. Push to `main` or click **Retry deployment** on the latest build.
2. Open the deployed URL → `/chat` should load without "NEXT_PUBLIC_SUPABASE_URL is not set".
3. Send a chat message → `/api/agent` should not return missing LLM or service-role errors.
