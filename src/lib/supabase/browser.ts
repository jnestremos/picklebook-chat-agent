'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Browser-side Supabase client (anon key). Used by the chat page to subscribe to
 * realtime changes on the `courts` / `slots` tables so the directory + last search
 * preview can refresh without re-querying the agent.
 *
 * The legacy env var was `NEXT_PUBLIC_ANON_KEY`. We also accept the conventional
 * `NEXT_PUBLIC_SUPABASE_ANON_KEY` so both names work.
 */
let cached: SupabaseClient | null = null;

export function getBrowserSupabase(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_ANON_KEY;
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set');
  if (!key) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY (or NEXT_PUBLIC_ANON_KEY) is not set');
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 4 } },
  });
  return cached;
}
