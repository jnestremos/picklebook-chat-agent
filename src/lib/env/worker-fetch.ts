/**
 * OpenAI SDK must use the Workers global `fetch` in production.
 * With nodejs_compat it may pick Node http and fail with "Connection error."
 */
export const workerFetch: typeof fetch = (input, init) => fetch(input, init);

/** Ollama on local hardware can be slow; Workers subrequests allow up to ~90s on paid plans. */
export const LLM_REQUEST_TIMEOUT_MS = 120_000;
