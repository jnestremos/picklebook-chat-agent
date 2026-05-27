# LLM auth gateway (Express + Tailscale Funnel)

The chat agent uses the **OpenAI-compatible** API (`POST /v1/chat/completions`) with **tool calling**. User API keys from the `/chat` dialog are forwarded to your gateway as:

```http
Authorization: Bearer <user-api-key>
```

## Picklebook config

Set these on the server (`.env.local` locally, Cloudflare **runtime** vars in production):

```bash
# Public Tailscale Funnel URL for your Express app — not Ollama directly.
OPENAI_COMPAT_BASE_URL=https://your-machine.ts.net
OPENAI_COMPAT_MODEL=qwen2.5:7b-instruct
```

Do **not** set `OPENAI_COMPAT_API_KEY` in production when users supply keys via the chat dialog. The cookie key is sent on every `/api/agent` request as `x-llm-api-key`, then reused as the Bearer token to your gateway.

## Express route required for this app

Your sample `/chat` → Ollama `/api/chat` proxy uses Ollama’s native API. **This app needs the OpenAI-compatible path** so tool calls work:

```javascript
// Add alongside your existing routes — validate Authorization on your gateway.
app.post("/v1/chat/completions", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth /* || !isValidKey(auth) */) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const response = await fetch("http://localhost:11434/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req.body),
  });

  const data = await response.json();
  res.status(response.status).json(data);
});
```

Ollama exposes OpenAI-compatible chat at `http://localhost:11434/v1/chat/completions` (not `/api/chat`).

## Request flow

```
Browser (/chat)
  → cookie API key
  → POST /api/agent  (header: x-llm-api-key)
Cloudflare Worker
  → OpenAI SDK
  → POST https://your-machine.ts.net/v1/chat/completions  (Authorization: Bearer <key>)
Express (Tailscale Funnel)
  → validates key
  → POST http://localhost:11434/v1/chat/completions
Ollama
```

## Cloudflare runtime vars

| Variable | Example |
| --- | --- |
| `OPENAI_COMPAT_BASE_URL` | `https://your-machine.ts.net` |
| `OPENAI_COMPAT_MODEL` | `qwen2.5:7b-instruct` |

No LLM secret is required on Cloudflare when users bring their own gateway key.
