import type { SupabaseClient } from '@supabase/supabase-js';
import { manilaDateRangeUtc } from './manila';
import type { SearchToolArgs, SlotRow } from './types';

/**
 * Both tools talk to the raw `public.courts` and `public.slots` tables — there
 * are no views in the linked Supabase project (per the user's DDL).
 *
 * Strategy for `search_courts`:
 *   1. If a `location` keyword is provided, first resolve matching court ids via
 *      ilike on `name` OR `location`. Skipping this round trip when no keyword
 *      is given keeps the common "any venue" case to a single query.
 *   2. Pull `slots` filtered by `available = true`, the resolved court ids
 *      (when present), and the requested Manila-day / datetime window.
 *   3. Embed the parent court via PostgREST so we can flatten the response.
 */

type CourtRow = {
  id: number;
  name: string | null;
  location: string | null;
  source: string | null;
  price: number | null;
  booking_url: string | null;
  skedda_space_id: string | null;
};

type RawSlotJoinRow = {
  id: number;
  datetime: string | null;
  datetime_end: string | null;
  time_slot: string | null;
  booking_url: string | null;
  available: boolean | null;
  skedda_space_id: string | null;
  court: CourtRow | null;
};

function escapeIlike(s: string): string {
  return s.replace(/[%_]/g, (m) => `\\${m}`);
}

async function resolveCourtIdsByLocation(
  supabase: SupabaseClient,
  location: string,
): Promise<number[]> {
  const term = `%${escapeIlike(location.trim())}%`;
  const { data, error } = await supabase
    .from('courts')
    .select('id')
    .or(`name.ilike.${term},location.ilike.${term}`);
  if (error) throw new Error(`court id resolution failed: ${error.message}`);
  return (data ?? []).map((r) => (r as { id: number }).id);
}

export async function searchCourts(
  supabase: SupabaseClient,
  args: SearchToolArgs,
): Promise<SlotRow[]> {
  // Optional location pre-filter
  let courtIds: number[] | null = null;
  if (args.location && args.location.trim()) {
    courtIds = await resolveCourtIdsByLocation(supabase, args.location);
    if (courtIds.length === 0) return [];
  }

  let q = supabase
    .from('slots')
    .select(
      `
        id,
        datetime,
        datetime_end,
        time_slot,
        booking_url,
        available,
        skedda_space_id,
        court:courts!inner (
          id,
          name,
          location,
          source,
          price,
          booking_url,
          skedda_space_id
        )
      `,
    )
    .eq('available', true)
    .order('datetime', { ascending: true })
    .limit(500);

  if (courtIds) q = q.in('court_id', courtIds);

  if (args.manilaDate) {
    const range = manilaDateRangeUtc(args.manilaDate);
    if (range) q = q.gte('datetime', range.start).lt('datetime', range.end);
  } else if (args.datetime) {
    const t = Date.parse(args.datetime);
    if (!Number.isNaN(t)) {
      const start = new Date(t - 30 * 60 * 1000).toISOString();
      const end = new Date(t + 90 * 60 * 1000).toISOString();
      q = q.gte('datetime', start).lt('datetime', end);
    }
  }

  const { data, error } = await q;
  if (error) throw new Error(`search_courts failed: ${error.message}`);

  const raw = (data ?? []) as unknown as RawSlotJoinRow[];
  return raw
    .filter((r) => r.court !== null)
    .map((r): SlotRow => {
      const c = r.court as CourtRow;
      return {
        id: c.id,
        name: c.name,
        location: c.location,
        source: c.source,
        price: c.price,
        slot_id: r.id,
        datetime: r.datetime,
        datetime_end: r.datetime_end,
        time_slot: r.time_slot,
        booking_url: r.booking_url ?? c.booking_url ?? null,
        court_booking_url: c.booking_url ?? null,
        slot_booking_url: r.booking_url ?? null,
        skedda_space_id: r.skedda_space_id ?? c.skedda_space_id ?? null,
        available: r.available,
      };
    });
}

export type LocationGroup = {
  location: string;
  court_count: number;
  court_names: string | null;
};

const NO_LOCATION = '(No location)';

/**
 * `list_locations` — groups `public.courts` by location in JS. The directory
 * sidebar uses this; the agent may call it to enumerate venues.
 */
export async function listLocations(supabase: SupabaseClient): Promise<LocationGroup[]> {
  const { data, error } = await supabase
    .from('courts')
    .select('name, location')
    .order('location', { ascending: true, nullsFirst: false });
  if (error) throw new Error(`list_locations failed: ${error.message}`);

  type Acc = { location: string; court_count: number; names: string[] };
  const groups = new Map<string, Acc>();
  for (const row of (data ?? []) as { name: string | null; location: string | null }[]) {
    const loc = row.location?.trim() ? row.location.trim() : NO_LOCATION;
    let g = groups.get(loc);
    if (!g) {
      g = { location: loc, court_count: 0, names: [] };
      groups.set(loc, g);
    }
    g.court_count += 1;
    if (row.name && row.name.trim()) g.names.push(row.name.trim());
  }

  return [...groups.values()]
    .sort((a, b) => a.location.localeCompare(b.location))
    .map((g) => ({
      location: g.location,
      court_count: g.court_count,
      court_names: g.names.length > 0 ? g.names.sort().join(' · ') : null,
    }));
}

/* ------------------------------------------------------------------------- */
/* OpenAI function-tool schemas                                              */
/* ------------------------------------------------------------------------- */

export const SEARCH_COURTS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'search_courts',
    description:
      "Search bookable court slots stored in Supabase. Only rows where `available = true` are returned. Provide a `location` keyword (venue name token) and/or a `manilaDate` (YYYY-MM-DD in Asia/Manila) to narrow the window. Use `datetime` (ISO 8601 UTC) only when the user asked about a specific hour.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        location: {
          type: 'string',
          description: 'Free-text venue / location keyword (case-insensitive).',
        },
        manilaDate: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'Manila calendar day to filter slots by, in YYYY-MM-DD.',
        },
        datetime: {
          type: 'string',
          description:
            'ISO 8601 timestamp (UTC, with Z) for slot windows near a specific hour. Use sparingly.',
        },
      },
    },
  },
};

export const LIST_LOCATIONS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'list_locations',
    description:
      'List all distinct court locations with their court counts and names. Use when the user asks "what venues are there?" or to disambiguate a location guess.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
};

export const ALL_TOOLS = [SEARCH_COURTS_TOOL, LIST_LOCATIONS_TOOL];
