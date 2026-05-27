'use client';

import { useEffect, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase/browser';

/**
 * Subscribes to postgres_changes on the `courts` + `slots` tables (publication
 * `supabase_realtime`, added in the initial migration) and returns a counter
 * that ticks on every change. Components can `useEffect(…, [pulse])` to refetch
 * derived data — e.g. the locations panel — when the scraper writes new rows.
 *
 * The agent itself doesn't need this hook: every POST /api/agent already reads
 * Supabase server-side on each turn, so the LLM always sees latest data.
 */
export function useCourtsRealtimePulse(): number {
  const [pulse, setPulse] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    try {
      const supabase = getBrowserSupabase();
      const channel = supabase
        .channel('picklebook-chat-agent:db')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'courts' }, () => {
          if (!cancelled) setPulse((n) => n + 1);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'slots' }, () => {
          if (!cancelled) setPulse((n) => n + 1);
        })
        .subscribe();

      cleanup = () => {
        void supabase.removeChannel(channel);
      };
    } catch (err) {
      // Missing env vars or browser-side issue: silently skip realtime; agent still works.
      console.warn('[realtime] disabled:', err instanceof Error ? err.message : err);
    }

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return pulse;
}
