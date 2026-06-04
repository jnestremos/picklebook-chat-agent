// supabase/functions/sync-courts/index.ts
//
// Invoked by pg_cron or POST /functions/v1/sync-courts.
//
// Flow:
//   1. POST {SCRAPER_SERVICE_URL}/api/scrape  body: { all: true, maxDays: 30 }
//   2. Expect { courts: CourtRow[], slots: SlotRow[] }
//   3. TRUNCATE courts + slots (restart ids at 1)
//   4. Batch insert courts, map scraper court.id → DB bigint id
//   5. Batch insert slots
//   6. POST {COURT_SYNC_WORKER_URL}/sync/index/workflow — incremental Vectorize index (async trigger)
//   (Google Sheets export on court-booking-scraper is disabled for now)
//
// Secrets: SCRAPER_SERVICE_URL (public base URL — NOT localhost from Supabase cloud),
//           SCRAPER_SERVICE_TOKEN (optional),
//           COURT_SYNC_WORKER_URL (picklebook-court-sync Worker base URL),
//           INDEX_SYNC_SECRET (optional; must match Worker if set)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { jsonResponse } from '../_shared/cors.ts';

/** Full scrape (all venues, 30 days) can take ~2 minutes on Render. */
const SCRAPER_TIMEOUT_MS = 180_000;
const INDEX_SYNC_TRIGGER_TIMEOUT_MS = 10_000;

async function triggerVectorizeIndex(): Promise<void> {
  const base = Deno.env.get('COURT_SYNC_WORKER_URL')?.trim();
  if (!base) {
    console.warn('[sync-courts] COURT_SYNC_WORKER_URL unset; skipping Vectorize index');
    return;
  }

  const token = Deno.env.get('INDEX_SYNC_SECRET')?.trim();
  const url = `${base.replace(/\/$/, '')}/sync/index/workflow`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ namespace: 'courts' }),
      signal: AbortSignal.timeout(INDEX_SYNC_TRIGGER_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(
        `[sync-courts] Vectorize index trigger HTTP ${res.status}: ${text.slice(0, 300)}`,
      );
      return;
    }

    const body = await res.json().catch(() => ({}));
    console.log('[sync-courts] Vectorize index workflow started', body);
  } catch (err) {
    console.warn('[sync-courts] Vectorize index trigger failed', err);
  }
}

type ScraperCourt = {
  id: string;
  name: string;
  location: string | null;
  lat: number | null;
  long: number | null;
  price: number | null;
  source: string | null;
  booking_url: string | null;
  skedda_space_id: string | null;
};

type ScraperSlot = {
  scraper_id: string;
  court_scraper_id: string;
  datetime: string;
  datetime_end: string | null;
  time_slot: string | null;
  available: boolean;
  booking_url: string | null;
  skedda_space_id: string | null;
};

type ScrapePayload = {
  courts: ScraperCourt[];
  slots: ScraperSlot[];
};

function asTrimmedString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function asFinitePrice(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asCoord(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asIsoTimestamp(v: unknown): string | null {
  const s = asTrimmedString(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function asBoolean(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true' || t === '1' || t === 'yes') return true;
    if (t === 'false' || t === '0' || t === 'no') return false;
  }
  return fallback;
}

function parseCourt(raw: unknown): ScraperCourt | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = asTrimmedString(r.id);
  const name = asTrimmedString(r.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    location: asTrimmedString(r.location),
    lat: asCoord(r.lat),
    long: asCoord(r.lng) ?? asCoord(r.long),
    price: asFinitePrice(r.price),
    source: asTrimmedString(r.source),
    booking_url: asTrimmedString(r.booking_url),
    skedda_space_id: asTrimmedString(r.skedda_space_id),
  };
}

function parseSlot(raw: unknown): ScraperSlot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const scraper_id = asTrimmedString(r.id);
  const court_scraper_id = asTrimmedString(r.court_id);
  const datetime = asIsoTimestamp(r.datetime);
  if (!scraper_id || !court_scraper_id || !datetime) return null;
  return {
    scraper_id,
    court_scraper_id,
    datetime,
    datetime_end: asIsoTimestamp(r.datetime_end),
    time_slot: asTrimmedString(r.time_slot),
    available: asBoolean(r.available, true),
    booking_url: asTrimmedString(r.booking_url),
    skedda_space_id: asTrimmedString(r.skedda_space_id),
  };
}

async function fetchScrapePayload(): Promise<ScrapePayload> {
  const scraperBase = Deno.env.get('SCRAPER_SERVICE_URL');
  if (!scraperBase) throw new Error('SCRAPER_SERVICE_URL secret is not set');

  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(scraperBase)) {
    throw new Error(
      'SCRAPER_SERVICE_URL points to localhost — Supabase Edge cannot reach it. Deploy the scraper or use a public URL.',
    );
  }

  const scraperUrl = `${scraperBase.replace(/\/$/, '')}/api/scrape`;
  const token = Deno.env.get('SCRAPER_SERVICE_TOKEN');
  const isNgrok = /ngrok-free\.app|ngrok\.io|ngrok\.app/i.test(scraperBase);

  const res = await fetch(scraperUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      // ngrok free tier returns an HTML interstitial to non-browser clients without this.
      ...(isNgrok ? { 'ngrok-skip-browser-warning': 'true' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ all: true, maxDays: 30 }),
    signal: AbortSignal.timeout(SCRAPER_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Scraper responded ${res.status}: ${body.slice(0, 500)}`);
  }

  const rawText = await res.text();
  let payload: unknown;
  try {
    payload = JSON.parse(rawText);
  } catch {
    const hint =
      isNgrok || rawText.includes('ngrok')
        ? ' (ngrok may be blocking the request — ensure ngrok is running and add header ngrok-skip-browser-warning: true)'
        : '';
    throw new Error(
      `Scraper did not return JSON${hint}: ${rawText.slice(0, 300)}`,
    );
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('Scraper payload is not a JSON object');
  }

  const obj = payload as Record<string, unknown>;
  const courtsRaw = Array.isArray(obj.courts) ? obj.courts : [];
  const slotsRaw = Array.isArray(obj.slots) ? obj.slots : [];

  const courts: ScraperCourt[] = [];
  for (const c of courtsRaw) {
    const parsed = parseCourt(c);
    if (parsed) courts.push(parsed);
  }

  const slots: ScraperSlot[] = [];
  for (const s of slotsRaw) {
    const parsed = parseSlot(s);
    if (parsed) slots.push(parsed);
  }

  return { courts, slots };
}

type CourtInsertRow = {
  external_id: string;
  name: string;
  location: string | null;
  source: string | null;
  booking_url: string | null;
  price: number | null;
  lat: number | null;
  long: number | null;
  skedda_space_id: string | null;
};

function toCourtInsert(c: ScraperCourt): CourtInsertRow {
  return {
    external_id: c.id,
    name: c.name,
    location: c.location,
    source: c.source,
    booking_url: c.booking_url,
    price: c.price,
    lat: c.lat,
    long: c.long,
    skedda_space_id: c.skedda_space_id,
  };
}

async function clearTables(
  supabase: ReturnType<typeof createClient>,
): Promise<void> {
  const { error } = await supabase.rpc('truncate_courts_and_slots');
  if (error) throw new Error(`Truncate courts/slots failed: ${error.message}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return jsonResponse({ ok: true });

  const startedAt = Date.now();
  const timings: Record<string, number> = {};

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error(
        'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not provided by the runtime',
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const scrapeStarted = Date.now();
    const { courts: scraperCourts, slots: scraperSlots } =
      await fetchScrapePayload();
    timings.scrape_ms = Date.now() - scrapeStarted;

    const CHUNK = 100;

    // 1. Clear existing rows (TRUNCATE RESTART IDENTITY — ids start at 1 again).
    const clearStarted = Date.now();
    await clearTables(supabase);
    timings.clear_ms = Date.now() - clearStarted;

    // 2. Insert courts and build scraper id → DB id map.
    const courtsStarted = Date.now();
    const courtRows = scraperCourts.map(toCourtInsert);
    const scraperIdToDbId = new Map<string, number>();

    for (let i = 0; i < courtRows.length; i += CHUNK) {
      const batch = courtRows.slice(i, i + CHUNK);
      const { data, error } = await supabase
        .from('courts')
        .insert(batch)
        .select('id, external_id');
      if (error) {
        throw new Error(
          `Insert courts batch ${i / CHUNK + 1} failed: ${error.message}`,
        );
      }
      for (const row of data ?? []) {
        const r = row as { id: number; external_id: string };
        if (r.external_id) scraperIdToDbId.set(r.external_id, r.id);
      }
    }
    timings.courts_ms = Date.now() - courtsStarted;

    // 3. Insert slots.
    const slotsStarted = Date.now();

    type SlotInsert = {
      court_id: number;
      datetime: string;
      datetime_end: string | null;
      time_slot: string | null;
      booking_url: string | null;
      available: boolean;
      skedda_space_id: string | null;
    };

    const slotRows: SlotInsert[] = [];
    let droppedNoCourt = 0;
    let droppedUnavailable = 0;

    for (const ss of scraperSlots) {
      if (!ss.available) {
        droppedUnavailable += 1;
        continue;
      }
      const dbCourtId = scraperIdToDbId.get(ss.court_scraper_id);
      if (!dbCourtId) {
        droppedNoCourt += 1;
        continue;
      }
      slotRows.push({
        court_id: dbCourtId,
        datetime: ss.datetime,
        datetime_end: ss.datetime_end,
        time_slot: ss.time_slot,
        booking_url: ss.booking_url,
        available: ss.available,
        skedda_space_id: ss.skedda_space_id,
      });
    }

    if (slotRows.length > 0) {
      for (let i = 0; i < slotRows.length; i += CHUNK) {
        const batch = slotRows.slice(i, i + CHUNK);
        const { error: insErr } = await supabase.from('slots').insert(batch);
        if (insErr)
          throw new Error(`Insert slots batch failed: ${insErr.message}`);
      }
    }
    timings.slots_ms = Date.now() - slotsStarted;

    const indexStarted = Date.now();
    await triggerVectorizeIndex();
    timings.index_trigger_ms = Date.now() - indexStarted;

    return jsonResponse({
      ok: true,
      courts_inserted: scraperCourts.length,
      slots_scraped: scraperSlots.length,
      slots_inserted: slotRows.length,
      slots_dropped_no_court: droppedNoCourt,
      slots_dropped_unavailable: droppedUnavailable,
      timings,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[sync-courts] error', message);
    return jsonResponse(
      {
        ok: false,
        error: message,
        timings,
        elapsed_ms: Date.now() - startedAt,
      },
      { status: 500 },
    );
  }
});
