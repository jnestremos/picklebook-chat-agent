export function formatAgentError(err: unknown): string {
  if (!(err instanceof Error)) return 'Unknown error';

  const parts = [err.message];
  if (err.cause instanceof Error && err.cause.message !== err.message) {
    parts.push(err.cause.message);
  } else if (err.cause && typeof err.cause === 'string') {
    parts.push(err.cause);
  }

  const joined = parts.filter(Boolean).join(' — ');
  if (joined.toLowerCase().includes('connection error')) {
    return `${joined}. The Cloudflare Worker could not reach OPENAI_COMPAT_BASE_URL (check Tailscale Funnel is up and /v1/chat/completions is exposed).`;
  }
  return joined;
}
