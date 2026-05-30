// Shared CORS headers for Supabase Edge Functions.
// The sync-courts function is invoked internally by pg_cron, so it does not
// strictly need CORS — but having a helper here keeps any future functions
// (e.g. a hosted agent endpoint) consistent.

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}
