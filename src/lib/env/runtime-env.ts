import { getCloudflareContext } from '@opennextjs/cloudflare';

/**
 * Read a runtime env var on Cloudflare Workers or during local `next dev`.
 * Wrangler `vars` and dashboard variables may only be on `env`, not `process.env`.
 */
export function readRuntimeEnv(name: string): string | undefined {
  const fromProcess = process.env[name]?.trim();
  if (fromProcess) return fromProcess;

  try {
    const { env } = getCloudflareContext();
    const raw = (env as Record<string, unknown>)[name];
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed) return trimmed;
    }
  } catch {
    // Not running inside a Cloudflare Worker request (e.g. static analysis).
  }

  return undefined;
}
