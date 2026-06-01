// Chunked Google Sheets export — keeps each Edge invocation under CPU limits.
// Invoked by sync-courts (chunk 0) and chains subsequent chunks via service-role fetch.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { jsonResponse } from '../_shared/cors.ts';
import {
  type ExportChunkBody,
  type SheetsCourt,
  type SheetsSlot,
  exportGoogleSheetsChunk,
  groupCourtsByVenue,
  packVenueKeyChunks,
  scheduleExportChunk,
  sheetsConfigEnabled,
  slotsPerExportChunk,
} from '../_shared/google-sheets-sync.ts';
import { parseGoogleServiceAccount } from '../_shared/google-auth.ts';

const PAGE_SIZE = 1000;

function slotWindowMs(): number {
  const raw = Deno.env.get('GOOGLE_SHEETS_SLOT_WINDOW_DAYS')?.trim();
  const days = raw && Number.isFinite(Number(raw))
    ? Math.min(30, Math.max(1, Math.floor(Number(raw))))
    : 3;
  return days * 24 * 60 * 60 * 1000;
}

async function loadCourts(
  supabase: ReturnType<typeof createClient>,
): Promise<SheetsCourt[]> {
  const { data, error } = await supabase
    .from('courts')
    .select('external_id, name, location, source, booking_url, price');
  if (error) {
    throw new Error(`Load courts failed: ${error.message}`);
  }

  const courts: SheetsCourt[] = [];
  for (const row of data ?? []) {
    const r = row as Record<string, unknown>;
    const id = typeof r.external_id === 'string' ? r.external_id.trim() : '';
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!id || !name) {
      continue;
    }
    courts.push({
      id,
      name,
      location: typeof r.location === 'string' ? r.location : null,
      source: typeof r.source === 'string' ? r.source : null,
      booking_url: typeof r.booking_url === 'string' ? r.booking_url : null,
      price: typeof r.price === 'number' ? r.price : null,
    });
  }
  return courts;
}

async function loadSlotCountsByCourtId(
  supabase: ReturnType<typeof createClient>,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const now = new Date().toISOString();
  const end = new Date(Date.now() + slotWindowMs()).toISOString();
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('slots')
      .select('court_id, courts!inner(external_id)')
      .eq('available', true)
      .gte('datetime', now)
      .lte('datetime', end)
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      throw new Error(`Load slot counts failed: ${error.message}`);
    }
    if (!data?.length) {
      break;
    }

    for (const row of data) {
      const courts = row.courts as { external_id?: string } | { external_id?: string }[];
      const externalId = Array.isArray(courts)
        ? courts[0]?.external_id
        : courts?.external_id;
      if (!externalId) {
        continue;
      }
      counts.set(externalId, (counts.get(externalId) ?? 0) + 1);
    }

    if (data.length < PAGE_SIZE) {
      break;
    }
    from += PAGE_SIZE;
  }

  return counts;
}

async function loadDbCourtIds(
  supabase: ReturnType<typeof createClient>,
  externalIds: string[],
): Promise<Map<string, number>> {
  if (externalIds.length === 0) {
    return new Map();
  }

  const out = new Map<string, number>();
  for (let i = 0; i < externalIds.length; i += PAGE_SIZE) {
    const batch = externalIds.slice(i, i + PAGE_SIZE);
    const { data, error } = await supabase
      .from('courts')
      .select('id, external_id')
      .in('external_id', batch);
    if (error) {
      throw new Error(`Load court ids failed: ${error.message}`);
    }
    for (const row of data ?? []) {
      const r = row as { id: number; external_id: string };
      if (r.external_id) {
        out.set(r.external_id, r.id);
      }
    }
  }
  return out;
}

async function loadSlotsForCourts(
  supabase: ReturnType<typeof createClient>,
  externalIds: string[],
): Promise<Map<string, SheetsSlot[]>> {
  const slotsByCourt = new Map<string, SheetsSlot[]>();
  if (externalIds.length === 0) {
    return slotsByCourt;
  }

    const dbIdToExternal = await loadDbCourtIds(supabase, externalIds);
  const externalByDbId = new Map<number, string>();
  for (const [ext, id] of dbIdToExternal.entries()) {
    externalByDbId.set(id, ext);
  }
  const dbIds = [...dbIdToExternal.values()];
  if (dbIds.length === 0) {
    return slotsByCourt;
  }

  const now = new Date().toISOString();
  const end = new Date(Date.now() + slotWindowMs()).toISOString();
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('slots')
      .select('court_id, datetime, datetime_end, time_slot, booking_url, available')
      .eq('available', true)
      .gte('datetime', now)
      .lte('datetime', end)
      .in('court_id', dbIds)
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      throw new Error(`Load slots failed: ${error.message}`);
    }
    if (!data?.length) {
      break;
    }

    for (const row of data) {
      const r = row as Record<string, unknown>;
      const courtId = r.court_id as number;
      const externalId = externalByDbId.get(courtId);
      if (!externalId || typeof r.datetime !== 'string') {
        continue;
      }

      const slot: SheetsSlot = {
        court_scraper_id: externalId,
        datetime: r.datetime,
        datetime_end: typeof r.datetime_end === 'string' ? r.datetime_end : null,
        time_slot: typeof r.time_slot === 'string' ? r.time_slot : null,
        available: true,
        booking_url: typeof r.booking_url === 'string' ? r.booking_url : null,
      };
      const list = slotsByCourt.get(externalId) ?? [];
      list.push(slot);
      slotsByCourt.set(externalId, list);
    }

    if (data.length < PAGE_SIZE) {
      break;
    }
    from += PAGE_SIZE;
  }

  return slotsByCourt;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return jsonResponse({ ok: true });
  }

  if (!sheetsConfigEnabled() || !parseGoogleServiceAccount()) {
    return jsonResponse(
      { ok: false, error: 'Google Sheets secrets not configured' },
      { status: 400 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as ExportChunkBody;
  const chunkIndex = Math.max(0, Math.floor(body.chunk ?? 0));
  const startRow = Math.max(1, Math.floor(body.startRow ?? 1));

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const courts = await loadCourts(supabase);
    const venues = groupCourtsByVenue(courts);
    const courtNames = new Map(courts.map((c) => [c.id, c.name]));

    let venueKeyChunks: string[][];
    if (chunkIndex === 0) {
      const slotCountByCourtId = await loadSlotCountsByCourtId(supabase);
      venueKeyChunks = packVenueKeyChunks(
        venues,
        slotCountByCourtId,
        slotsPerExportChunk(),
      );
    } else if (body.venueKeyChunks?.length) {
      venueKeyChunks = body.venueKeyChunks;
    } else {
      throw new Error('Chained chunk requires venueKeyChunks from chunk 0');
    }

    const chunksTotal = body.chunksTotal ?? venueKeyChunks.length;

    if (chunkIndex === 0 && chunksTotal === 0) {
      return jsonResponse({
        ok: true,
        message: 'No venues with slots in export window',
        chunkIndex,
      });
    }

    if (chunkIndex >= chunksTotal) {
      return jsonResponse({ ok: true, done: true, chunkIndex });
    }

    const venueKeys = body.venueKeys?.length
      ? body.venueKeys
      : venueKeyChunks[chunkIndex];
    const externalIds = new Set<string>();
    const venueByKey = new Map(venues.map((v) => [v.key, v]));
    for (const key of venueKeys) {
      const venue = venueByKey.get(key);
      for (const court of venue?.courts ?? []) {
        externalIds.add(court.id);
      }
    }

    const slotsByCourt = await loadSlotsForCourts(
      supabase,
      [...externalIds],
    );

    const run = await exportGoogleSheetsChunk({
      venues,
      venueKeys,
      slotsByCourt,
      courtNames,
      courtsCount: courts.length,
      chunkIndex,
      chunksTotal,
      startRow,
    });

    const nextChunk = chunkIndex + 1;
    if (run && nextChunk < chunksTotal) {
      scheduleExportChunk({
        chunk: nextChunk,
        startRow: run.nextRow,
        chunksTotal,
        venueKeys: venueKeyChunks[nextChunk],
        venueKeyChunks,
      });
    }

    return jsonResponse({
      ok: true,
      google_sheets: run?.result ?? null,
      chunkIndex,
      chunksTotal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[export-google-sheets] error', message);
    return jsonResponse({ ok: false, error: message, chunkIndex }, { status: 500 });
  }
});
