import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function resolveSupabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set');
  return url;
}

function resolveAnonKey(): string {
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_ANON_KEY;
  if (!key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_ANON_KEY (or NEXT_PUBLIC_ANON_KEY) is not set',
    );
  }
  return key;
}

/**
 * Server-side anon client — respects RLS (public read on courts/slots).
 * Use for read-only routes that should not require the service-role key.
 */
let anonCached: SupabaseClient | null = null;

export function getAnonSupabase(): SupabaseClient {
  if (anonCached) return anonCached;
  anonCached = createClient(resolveSupabaseUrl(), resolveAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return anonCached;
}

/**
 * Server-only Supabase client (Next.js route handlers, server components).
 *
 * Uses the service-role key so the agent route can read freely (RLS bypassed)
 * and write should it ever need to. NEVER import this from a `'use client'` file.
 */
let cached: SupabaseClient | null = null;

export function getServiceSupabase(): SupabaseClient {
  if (cached) return cached;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  cached = createClient(resolveSupabaseUrl(), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
