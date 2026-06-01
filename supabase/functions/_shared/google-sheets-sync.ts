import {
  getGoogleAccessToken,
  parseGoogleServiceAccount,
} from './google-auth.ts';

const DEFAULT_SHEET_TITLE = 'Availability';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DATA_COLUMN_COUNT = 6;

export type SheetsCourt = {
  id: string;
  name: string;
  location: string | null;
  source: string | null;
  booking_url: string | null;
  price: number | null;
};

export type SheetsSlot = {
  court_scraper_id: string;
  datetime: string;
  datetime_end: string | null;
  time_slot: string | null;
  available: boolean;
  booking_url: string | null;
};

export type GoogleSheetsSyncResult = {
  spreadsheetId: string;
  courts: number;
  venues: number;
  sheetsCreated: number;
  sheetsUpdated: number;
  sheetsPruned: number;
  slotsWritten: number;
  slotsInExport: number;
  slotWindowDays: number;
  formattingApplied: boolean;
  /** Present when export continues in chained Edge invocations. */
  chunksTotal?: number;
  chunkIndex?: number;
};

export type GoogleSheetsExportTrigger = {
  triggered: true;
  function: 'export/sheets';
};

export type ExportChunkBody = {
  chunk?: number;
  startRow?: number;
  /** Venue keys for this chunk. */
  venueKeys?: string[];
  chunksTotal?: number;
  /** Full chunk plan from chunk 0 — avoids re-scanning slot counts. */
  venueKeyChunks?: string[][];
};

export type ExportChunkRunResult = {
  result: GoogleSheetsSyncResult;
  nextRow: number;
};

export type VenueGroup = {
  key: string;
  label: string;
  location: string | null;
  source: string | null;
  booking_url: string | null;
  courts: SheetsCourt[];
};

type SheetMeta = {
  sheetId: number;
  title: string;
};

function sheetsConfigEnabled(): { spreadsheetId: string } | null {
  const spreadsheetId = Deno.env.get('GOOGLE_SHEETS_SPREADSHEET_ID')?.trim();
  if (!spreadsheetId) {
    return null;
  }
  return { spreadsheetId };
}

function displayTimezone(): string {
  return Deno.env.get('GOOGLE_SHEETS_TIMEZONE')?.trim() || 'Asia/Manila';
}

function availabilitySheetTitle(): string {
  const title = Deno.env.get('GOOGLE_SHEETS_SHEET_TITLE')?.trim();
  if (title) {
    return title.replace(/[\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || DEFAULT_SHEET_TITLE;
  }
  return DEFAULT_SHEET_TITLE;
}

function pruneOrphanSheets(): boolean {
  const v = Deno.env.get('GOOGLE_SHEETS_PRUNE_ORPHANS')?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Only export slots starting within this many days (keeps Edge CPU under Supabase limits). */
function slotWindowDays(): number {
  const raw = Deno.env.get('GOOGLE_SHEETS_SLOT_WINDOW_DAYS')?.trim();
  if (raw && Number.isFinite(Number(raw))) {
    return Math.min(30, Math.max(1, Math.floor(Number(raw))));
  }
  return 3;
}

function maxSlotsPerExport(): number {
  const raw = Deno.env.get('GOOGLE_SHEETS_MAX_SLOTS')?.trim();
  if (raw && Number.isFinite(Number(raw))) {
    return Math.max(200, Math.floor(Number(raw)));
  }
  return 2500;
}

export function slotsPerExportChunk(): number {
  const raw = Deno.env.get('GOOGLE_SHEETS_SLOTS_PER_CHUNK')?.trim();
  if (raw && Number.isFinite(Number(raw))) {
    return Math.min(1500, Math.max(150, Math.floor(Number(raw))));
  }
  return 500;
}

function sortVenueSlots(): boolean {
  return envFlagTrue('GOOGLE_SHEETS_SORT_SLOTS');
}

function envFlagTrue(name: string): boolean {
  const v = Deno.env.get(name)?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Formatting burns Edge CPU — off unless explicitly enabled. */
function shouldApplyFormatting(_venues: number, _slotsInExport: number): boolean {
  return envFlagTrue('GOOGLE_SHEETS_APPLY_FORMATTING');
}

export function filterSlotsForSheetsExport(
  slots: SheetsSlot[],
  windowDays: number,
): SheetsSlot[] {
  const now = Date.now();
  const endMs = now + windowDays * 24 * 60 * 60 * 1000;
  return slots.filter((slot) => {
    if (!slot.available) {
      return false;
    }
    const t = Date.parse(slot.datetime);
    return !Number.isNaN(t) && t >= now - 60_000 && t <= endMs;
  });
}

/** Stable grouping key: same location or booking page → one venue tab. */
export function venueKeyForCourt(court: SheetsCourt): string {
  const loc = court.location?.trim().toLowerCase();
  if (loc) {
    return `loc:${loc}`;
  }

  const url = court.booking_url?.trim();
  if (url) {
    try {
      const parsed = new URL(url);
      return `url:${parsed.origin}${parsed.pathname}`.toLowerCase();
    } catch {
      return `url:${url.toLowerCase()}`;
    }
  }

  return `court:${court.id}`;
}

/** Human-readable venue name for tab title and sheet header. */
export function venueLabelForCourt(court: SheetsCourt): string {
  const location = court.location?.trim();
  if (location) {
    return location;
  }

  const stripped = court.name
    .replace(/\s*[-–|]\s*(court\s*)?\d+.*$/i, '')
    .replace(/\s*\(\s*court\s*\d+\s*\)\s*$/i, '')
    .trim();
  return stripped || court.name;
}

export function groupCourtsByVenue(courts: SheetsCourt[]): VenueGroup[] {
  const map = new Map<string, VenueGroup>();

  for (const court of courts) {
    const key = venueKeyForCourt(court);
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        label: venueLabelForCourt(court),
        location: court.location,
        source: court.source,
        booking_url: court.booking_url,
        courts: [],
      };
      map.set(key, group);
    }
    group.courts.push(court);
  }

  for (const group of map.values()) {
    if (group.courts.length > 1) {
      const withLocation = group.courts.find((c) => c.location?.trim());
      if (withLocation) {
        group.label = venueLabelForCourt(withLocation);
        group.location = withLocation.location;
      }
    }
    group.courts.sort((a, b) => a.name.localeCompare(b.name));
  }

  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Sheet tab title: unique, ≤100 chars, no \\ / ? * [ ] */
export function sheetTitleForVenue(
  label: string,
  usedTitles: Set<string>,
): string {
  let base = label
    .replace(/[\\/?*[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) {
    base = 'Venue';
  }
  base = base.slice(0, 85);

  let title = base;
  let n = 2;
  while (usedTitles.has(title)) {
    const suffix = ` (${n})`;
    title = `${base.slice(0, Math.max(1, 100 - suffix.length))}${suffix}`;
    n += 1;
  }
  usedTitles.add(title);
  return title;
}

/** @deprecated Use sheetTitleForVenue — kept for tests that pass court.name directly. */
export function sheetTitleForCourt(
  court: SheetsCourt,
  usedTitles: Set<string>,
): string {
  return sheetTitleForVenue(venueLabelForCourt(court), usedTitles);
}

export function escapeSheetRangeTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/** Plain ISO datetime for sheet cells — no UTC time slicing. */
export function plainDateTimeValue(iso: string | null | undefined): string {
  if (!iso?.trim()) {
    return '—';
  }
  return iso.replace(/\.\d{3}Z?$/, '').replace('T', ' ').replace(/Z$/, '').trim();
}

const weekdayCacheByTz = new Map<string, Map<string, string>>();

/** Long weekday name (Monday, Tuesday, …) cached per date in timezone. */
export function weekdayNameForIso(
  iso: string,
  timeZone: string,
): string {
  let cache = weekdayCacheByTz.get(timeZone);
  if (!cache) {
    cache = new Map();
    weekdayCacheByTz.set(timeZone, cache);
  }

  const dateKey = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));

  let name = cache.get(dateKey);
  if (!name) {
    name = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long',
    }).format(new Date(iso));
    cache.set(dateKey, name);
  }
  return name;
}

export function slotStartEndFromSlot(slot: SheetsSlot): { start: string; end: string } {
  const ts = slot.time_slot?.trim();
  if (ts) {
    const m = ts.match(/^(.+?)\s*[-–]\s*(.+)$/);
    if (m) {
      return { start: m[1].trim(), end: m[2].trim() };
    }
  }
  return {
    start: plainDateTimeValue(slot.datetime),
    end: plainDateTimeValue(slot.datetime_end),
  };
}

export function prewarmWeekdayCache(slots: SheetsSlot[], timeZone: string): void {
  const seen = new Set<string>();
  for (const slot of slots) {
    const prefix = slot.datetime.slice(0, 10);
    if (seen.has(prefix)) {
      continue;
    }
    seen.add(prefix);
    weekdayNameForIso(slot.datetime, timeZone);
  }
}

export function packVenueKeyChunks(
  venues: VenueGroup[],
  slotCountByCourtId: Map<string, number>,
  maxSlotsPerChunk: number,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let slotCount = 0;

  const venueSlots = (venue: VenueGroup): number =>
    venue.courts.reduce((sum, court) => sum + (slotCountByCourtId.get(court.id) ?? 0), 0);

  for (const venue of venues) {
    const count = venueSlots(venue);
    if (current.length > 0 && slotCount + count > maxSlotsPerChunk) {
      chunks.push(current);
      current = [];
      slotCount = 0;
    }
    current.push(venue.key);
    slotCount += count;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

export function buildSheetPreambleRows(
  timeZone: string,
  windowDays: number,
): string[][] {
  const updated = new Intl.DateTimeFormat('en-PH', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date());

  return [
    ['Picklebook — court availability'],
    [`Last sync: ${updated} (${timeZone}) · next ${windowDays} days`],
    ['All venues below — scroll or filter by venue name.'],
    [],
  ];
}

export function slotSheetColumns(
  slot: SheetsSlot,
  timeZone: string,
): [string, string, string, string, string] {
  const date = slot.datetime.slice(0, 10);
  const day = weekdayNameForIso(slot.datetime, timeZone);
  const timeSlot = slot.time_slot?.trim() || '—';
  const { start, end } = slotStartEndFromSlot(slot);
  return [date, day, timeSlot, start, end];
}

export function buildVenueSectionRows(
  venue: VenueGroup,
  slotsByCourt: Map<string, SheetsSlot[]>,
  courtNames: Map<string, string>,
  timeZone: string,
): string[][] {
  type SlotRow = { courtName: string; slot: SheetsSlot };
  const allSlots: SlotRow[] = [];
  for (const court of venue.courts) {
    const courtName = courtNames.get(court.id) ?? court.name;
    for (const slot of slotsByCourt.get(court.id) ?? []) {
      if (slot.available) {
        allSlots.push({ courtName, slot });
      }
    }
  }

  if (sortVenueSlots()) {
    allSlots.sort((a, b) => {
      const byTime = a.slot.datetime.localeCompare(b.slot.datetime);
      return byTime !== 0 ? byTime : a.courtName.localeCompare(b.courtName);
    });
  }

  prewarmWeekdayCache(allSlots.map((row) => row.slot), timeZone);

  const courtSummary = venue.courts.map((c) => c.name).join(', ');

  const rows: string[][] = [
    ['Venue', venue.label],
    ['Courts', courtSummary || '—'],
    ['Location', venue.location ?? '—'],
    ['Source', venue.source ?? '—'],
    ['Booking page', venue.booking_url ?? '—'],
    [],
    ['Court', 'Date', 'Day', 'Time slot', 'Start', 'End'],
  ];

  for (const { courtName, slot } of allSlots) {
    const [date, day, timeSlot, start, end] = slotSheetColumns(slot, timeZone);
    rows.push([courtName, date, day, timeSlot, start, end]);
  }

  if (allSlots.length === 0) {
    rows.push(['(no available slots in this sync)', '', '', '', '', '']);
  }

  return rows;
}

export function buildCombinedSheetValues(
  venues: VenueGroup[],
  slotsByCourt: Map<string, SheetsSlot[]>,
  courtNames: Map<string, string>,
  timeZone: string,
  windowDays: number,
): string[][] {
  const rows = buildSheetPreambleRows(timeZone, windowDays);

  for (let i = 0; i < venues.length; i++) {
    if (i > 0) {
      rows.push([]);
    }
    rows.push(
      ...buildVenueSectionRows(venues[i], slotsByCourt, courtNames, timeZone),
    );
  }

  return rows;
}

/** @deprecated Use buildVenueSectionRows / buildCombinedSheetValues. */
export function buildVenueSheetValues(
  venue: VenueGroup,
  slotsByCourt: Map<string, SheetsSlot[]>,
  courtNames: Map<string, string>,
  timeZone: string,
): string[][] {
  return buildVenueSectionRows(venue, slotsByCourt, courtNames, timeZone);
}

/** @deprecated Use buildVenueSheetValues for production export. */
export function buildCourtSheetValues(
  court: SheetsCourt,
  slots: SheetsSlot[],
  timeZone: string,
): string[][] {
  const updated = new Intl.DateTimeFormat('en-PH', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date());

  const sorted = [...slots]
    .filter((s) => s.available)
    .sort((a, b) => a.datetime.localeCompare(b.datetime));

  const rows: string[][] = [
    ['Court', court.name],
    ['Location', court.location ?? '—'],
    ['Source', court.source ?? '—'],
    ['Price', court.price != null ? String(court.price) : '—'],
    ['Booking page', court.booking_url ?? '—'],
    ['Last sync', `${updated} (${timeZone})`],
    [],
    ['Date', 'Day', 'Time slot', 'Start', 'End'],
  ];

  for (const slot of sorted) {
    rows.push(slotSheetColumns(slot, timeZone));
  }

  if (sorted.length === 0) {
    rows.push(['(no available slots in this sync)', '', '', '', '']);
  }

  return rows;
}

async function sheetsFetch(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = path.startsWith('http') ? path : `${SHEETS_API}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function getSpreadsheetSheets(
  accessToken: string,
  spreadsheetId: string,
): Promise<SheetMeta[]> {
  const res = await sheetsFetch(
    accessToken,
    `/${spreadsheetId}?fields=sheets(properties(sheetId,title))`,
  );
  if (!res.ok) {
    throw new Error(`Sheets metadata ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = (await res.json()) as {
    sheets?: { properties?: { sheetId?: number; title?: string } }[];
  };
  const out: SheetMeta[] = [];
  for (const sheet of body.sheets ?? []) {
    const sheetId = sheet.properties?.sheetId;
    const title = sheet.properties?.title;
    if (sheetId != null && title) {
      out.push({ sheetId, title });
    }
  }
  return out;
}

async function batchUpdateSpreadsheet(
  accessToken: string,
  spreadsheetId: string,
  requests: Record<string, unknown>[],
): Promise<void> {
  if (requests.length === 0) {
    return;
  }

  for (let i = 0; i < requests.length; i += 100) {
    const chunk = requests.slice(i, i + 100);
    const res = await sheetsFetch(accessToken, `/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: chunk }),
    });
    if (!res.ok) {
      throw new Error(
        `Sheets batchUpdate ${res.status}: ${(await res.text()).slice(0, 400)}`,
      );
    }
  }
}

async function valuesClear(
  accessToken: string,
  spreadsheetId: string,
  range: string,
): Promise<void> {
  const res = await sheetsFetch(
    accessToken,
    `/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  if (!res.ok) {
    throw new Error(
      `Sheets values clear ${res.status}: ${(await res.text()).slice(0, 400)}`,
    );
  }
}

async function valuesBatchUpdate(
  accessToken: string,
  spreadsheetId: string,
  data: { range: string; values: string[][] }[],
): Promise<void> {
  if (data.length === 0) {
    return;
  }

  for (let i = 0; i < data.length; i += 100) {
    const chunk = data.slice(i, i + 100);
    const res = await sheetsFetch(
      accessToken,
      `/${spreadsheetId}/values:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data: chunk,
        }),
      },
    );
    if (!res.ok) {
      throw new Error(
        `Sheets values batchUpdate ${res.status}: ${(await res.text()).slice(0, 400)}`,
      );
    }
  }
}

async function applySingleSheetFormatting(
  accessToken: string,
  spreadsheetId: string,
  sheetId: number,
): Promise<void> {
  await batchUpdateSpreadsheet(accessToken, spreadsheetId, [
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: { frozenRowCount: 4 },
        },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    {
      autoResizeDimensions: {
        dimensions: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: 0,
          endIndex: DATA_COLUMN_COUNT,
        },
      },
    },
  ]);
}

async function valuesPut(
  accessToken: string,
  spreadsheetId: string,
  range: string,
  values: string[][],
): Promise<void> {
  const res = await sheetsFetch(
    accessToken,
    `/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', body: JSON.stringify({ values }) },
  );
  if (!res.ok) {
    throw new Error(
      `Sheets values PUT ${res.status}: ${(await res.text()).slice(0, 400)}`,
    );
  }
}

async function writeRowsAt(
  accessToken: string,
  spreadsheetId: string,
  sheetTitle: string,
  startRow: number,
  values: string[][],
): Promise<number> {
  if (values.length === 0) {
    return startRow;
  }
  const range = `${escapeSheetRangeTitle(sheetTitle)}!A${startRow}`;
  await valuesPut(accessToken, spreadsheetId, range, values);
  return startRow + values.length;
}

async function ensureAvailabilitySheet(
  accessToken: string,
  spreadsheetId: string,
  sheetTitle: string,
  clearSheet: boolean,
): Promise<{ sheetId: number; sheetsCreated: number; sheetsPruned: number }> {
  let sheetMetas = await getSpreadsheetSheets(accessToken, spreadsheetId);
  const batchRequests: Record<string, unknown>[] = [];
  let sheetsCreated = 0;
  let sheetsPruned = 0;

  if (!sheetMetas.some((s) => s.title === sheetTitle)) {
    batchRequests.push({ addSheet: { properties: { title: sheetTitle } } });
    sheetsCreated += 1;
  }

  if (pruneOrphanSheets()) {
    for (const { sheetId, title } of sheetMetas) {
      if (title !== sheetTitle) {
        batchRequests.push({ deleteSheet: { sheetId } });
        sheetsPruned += 1;
      }
    }
  }

  await batchUpdateSpreadsheet(accessToken, spreadsheetId, batchRequests);
  if (batchRequests.length > 0) {
    sheetMetas = await getSpreadsheetSheets(accessToken, spreadsheetId);
  }

  const targetSheet = sheetMetas.find((s) => s.title === sheetTitle);
  if (!targetSheet) {
    throw new Error(`Google Sheets tab "${sheetTitle}" not found after setup`);
  }

  if (clearSheet) {
    const sheetRange = escapeSheetRangeTitle(sheetTitle);
    await valuesClear(accessToken, spreadsheetId, `${sheetRange}!A:F`);
  }

  return { sheetId: targetSheet.sheetId, sheetsCreated, sheetsPruned };
}

export function triggerGoogleSheetsExport(): GoogleSheetsExportTrigger | null {
  const base = Deno.env.get('COURT_SYNC_WORKER_URL')?.trim();
  if (!base) {
    console.warn(
      '[sync-courts] COURT_SYNC_WORKER_URL unset; skipping Google Sheets export',
    );
    return null;
  }

  const token = Deno.env.get('INDEX_SYNC_SECRET')?.trim();
  const url = `${base.replace(/\/$/, '')}/export/sheets`;

  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: '{}',
  }).catch((err) => {
    console.warn(
      '[sync-courts] export/sheets trigger failed',
      err instanceof Error ? err.message : err,
    );
  });

  return { triggered: true, function: 'export/sheets' };
}

export function scheduleExportChunk(body: ExportChunkBody): void {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim();
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim();
  if (!supabaseUrl || !serviceRoleKey) {
    return;
  }

  const url = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/export-google-sheets`;
  fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }).catch((err) => {
    console.warn(
      '[export-google-sheets] chained chunk failed',
      err instanceof Error ? err.message : err,
    );
  });
}

export async function exportGoogleSheetsChunk(params: {
  venues: VenueGroup[];
  venueKeys: string[];
  slotsByCourt: Map<string, SheetsSlot[]>;
  courtNames: Map<string, string>;
  courtsCount: number;
  chunkIndex: number;
  chunksTotal: number;
  startRow: number;
}): Promise<ExportChunkRunResult | null> {
  const config = sheetsConfigEnabled();
  const serviceAccount = parseGoogleServiceAccount();
  if (!config || !serviceAccount) {
    return null;
  }

  const timeZone = displayTimezone();
  const windowDays = slotWindowDays();
  const sheetTitle = availabilitySheetTitle();
  const accessToken = await getGoogleAccessToken(serviceAccount);
  const { spreadsheetId } = config;

  const venueByKey = new Map(params.venues.map((v) => [v.key, v]));
  const chunkVenues = params.venueKeys
    .map((key) => venueByKey.get(key))
    .filter((v): v is VenueGroup => v != null);

  let sheetsCreated = 0;
  let sheetsPruned = 0;
  let sheetId = 0;

  if (params.chunkIndex === 0) {
    const setup = await ensureAvailabilitySheet(
      accessToken,
      spreadsheetId,
      sheetTitle,
      true,
    );
    sheetsCreated = setup.sheetsCreated;
    sheetsPruned = setup.sheetsPruned;
    sheetId = setup.sheetId;
  } else {
    const setup = await ensureAvailabilitySheet(
      accessToken,
      spreadsheetId,
      sheetTitle,
      false,
    );
    sheetId = setup.sheetId;
  }

  let row = params.startRow;
  if (params.chunkIndex === 0) {
    row = await writeRowsAt(
      accessToken,
      spreadsheetId,
      sheetTitle,
      row,
      buildSheetPreambleRows(timeZone, windowDays),
    );
  }

  let slotsWritten = 0;
  for (let i = 0; i < chunkVenues.length; i++) {
    if (params.chunkIndex > 0 || i > 0) {
      row = await writeRowsAt(accessToken, spreadsheetId, sheetTitle, row, [[]]);
    }
    const section = buildVenueSectionRows(
      chunkVenues[i],
      params.slotsByCourt,
      params.courtNames,
      timeZone,
    );
    row = await writeRowsAt(
      accessToken,
      spreadsheetId,
      sheetTitle,
      row,
      section,
    );
    for (const court of chunkVenues[i].courts) {
      slotsWritten += params.slotsByCourt.get(court.id)?.length ?? 0;
    }
  }

  const formattingApplied = params.chunkIndex === params.chunksTotal - 1 &&
    shouldApplyFormatting(params.venues.length, slotsWritten);
  if (formattingApplied) {
    await applySingleSheetFormatting(accessToken, spreadsheetId, sheetId);
  }

  const nextChunk = params.chunkIndex + 1;

  return {
    result: {
      spreadsheetId,
      courts: params.courtsCount,
      venues: params.venues.length,
      sheetsCreated,
      sheetsUpdated: 1,
      sheetsPruned,
      slotsWritten,
      slotsInExport: slotsWritten,
      slotWindowDays: windowDays,
      formattingApplied,
      chunksTotal: params.chunksTotal,
      chunkIndex: params.chunkIndex,
    },
    nextRow: row,
  };
}

/** @deprecated sync-courts now triggers export-google-sheets instead. */
export async function syncCourtsToGoogleSheets(
  _courts: SheetsCourt[],
  _slots: SheetsSlot[],
): Promise<GoogleSheetsSyncResult | null> {
  const triggered = triggerGoogleSheetsExport();
  if (!triggered) {
    return null;
  }
  return {
    spreadsheetId: '',
    courts: _courts.length,
    venues: 0,
    sheetsCreated: 0,
    sheetsUpdated: 0,
    sheetsPruned: 0,
    slotsWritten: 0,
    slotsInExport: 0,
    slotWindowDays: slotWindowDays(),
    formattingApplied: false,
  };
}
