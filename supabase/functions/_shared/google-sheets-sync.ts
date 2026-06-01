import {
  getGoogleAccessToken,
  parseGoogleServiceAccount,
} from './google-auth.ts';

const INDEX_SHEET_TITLE = '_Index';
/** Google values:batchUpdate allows up to 100 ranges per request. */
const VALUES_BATCH_RANGES = 80;
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

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
  /** Slots after GOOGLE_SHEETS_SLOT_WINDOW_DAYS filter (before sheet build). */
  slotsInExport: number;
  slotWindowDays: number;
  formattingApplied: boolean;
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
  return 7;
}

function envFlagTrue(name: string): boolean {
  const v = Deno.env.get(name)?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Formatting many tabs burns Edge CPU; skip unless explicitly enabled. */
function shouldApplyFormatting(venues: number, slotsInExport: number): boolean {
  if (envFlagTrue('GOOGLE_SHEETS_APPLY_FORMATTING')) {
    return true;
  }
  if (envFlagTrue('GOOGLE_SHEETS_SKIP_FORMATTING')) {
    return false;
  }
  return venues <= 40 && slotsInExport <= 3000;
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

function formatInTz(iso: string, timeZone: string): {
  date: string;
  day: string;
  time: string;
} {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat('en-PH', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(d);
  const day = new Intl.DateTimeFormat('en-PH', {
    timeZone,
    weekday: 'short',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-PH', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
  return { date, day, time };
}

/** Avoid Intl per slot — Edge CPU limit is ~2s for large exports. */
function formatInTzFast(iso: string): { date: string; day: string; time: string } {
  return {
    date: iso.slice(0, 10),
    day: '—',
    time: iso.slice(11, 16),
  };
}

function bookingLinkFormula(url: string | null): string {
  if (!url?.trim()) {
    return '';
  }
  const safe = url.replace(/"/g, '""');
  return `=HYPERLINK("${safe}","Book")`;
}

export function buildVenueSheetValues(
  venue: VenueGroup,
  slotsByCourt: Map<string, SheetsSlot[]>,
  courtNames: Map<string, string>,
  timeZone: string,
  fastDates = false,
): string[][] {
  const updated = new Intl.DateTimeFormat('en-PH', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date());

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

  allSlots.sort((a, b) => {
    const byTime = a.slot.datetime.localeCompare(b.slot.datetime);
    return byTime !== 0 ? byTime : a.courtName.localeCompare(b.courtName);
  });

  const formatSlot = fastDates ? formatInTzFast : (iso: string) => formatInTz(iso, timeZone);

  const courtSummary = venue.courts.map((c) => c.name).join(', ');

  const rows: string[][] = [
    ['Venue', venue.label],
    ['Courts', courtSummary || '—'],
    ['Location', venue.location ?? '—'],
    ['Source', venue.source ?? '—'],
    ['Booking page', venue.booking_url ?? '—'],
    ['Last sync', `${updated} (${timeZone})`],
    [],
    ['Court', 'Date', 'Day', 'Time slot', 'Start', 'End', 'Book'],
  ];

  for (const { courtName, slot } of allSlots) {
    const start = formatSlot(slot.datetime);
    const end = slot.datetime_end
      ? (fastDates ? formatInTzFast(slot.datetime_end).time : formatInTz(slot.datetime_end, timeZone).time)
      : '—';
    rows.push([
      courtName,
      start.date,
      start.day,
      slot.time_slot?.trim() || start.time,
      start.time,
      end,
      bookingLinkFormula(slot.booking_url),
    ]);
  }

  if (allSlots.length === 0) {
    rows.push(['(no available slots in this sync)', '', '', '', '', '', '']);
  }

  return rows;
}

/** @deprecated Use buildVenueSheetValues for production export. */
export function buildCourtSheetValues(
  court: SheetsCourt,
  slots: SheetsSlot[],
  timeZone: string,
  fastDates = false,
): string[][] {
  const updated = new Intl.DateTimeFormat('en-PH', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date());

  const sorted = [...slots]
    .filter((s) => s.available)
    .sort((a, b) => a.datetime.localeCompare(b.datetime));

  const formatSlot = fastDates ? formatInTzFast : (iso: string) => formatInTz(iso, timeZone);

  const rows: string[][] = [
    ['Court', court.name],
    ['Location', court.location ?? '—'],
    ['Source', court.source ?? '—'],
    ['Price', court.price != null ? String(court.price) : '—'],
    ['Booking page', court.booking_url ?? '—'],
    ['Last sync', `${updated} (${timeZone})`],
    [],
    ['Date', 'Day', 'Time slot', 'Start', 'End', 'Book'],
  ];

  for (const slot of sorted) {
    const start = formatSlot(slot.datetime);
    const end = slot.datetime_end
      ? (fastDates ? formatInTzFast(slot.datetime_end).time : formatInTz(slot.datetime_end, timeZone).time)
      : '—';
    rows.push([
      start.date,
      start.day,
      slot.time_slot?.trim() || start.time,
      start.time,
      end,
      bookingLinkFormula(slot.booking_url),
    ]);
  }

  if (sorted.length === 0) {
    rows.push(['(no available slots in this sync)', '', '', '', '', '']);
  }

  return rows;
}

function buildIndexSheetValues(
  venues: VenueGroup[],
  venueToTitle: Map<string, string>,
  slotCounts: Map<string, number>,
  timeZone: string,
): string[][] {
  const updated = new Intl.DateTimeFormat('en-PH', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date());

  const rows: string[][] = [
    ['Picklebook — court availability'],
    [`Last sync: ${updated} (${timeZone})`],
    ['Open a tab below — one sheet per venue (courts grouped inside).'],
    [],
    ['Venue', 'Location', 'Courts', 'Available slots', 'Sheet tab'],
  ];

  for (const venue of venues) {
    const slots = venue.courts.reduce(
      (sum, court) => sum + (slotCounts.get(court.id) ?? 0),
      0,
    );
    rows.push([
      venue.label,
      venue.location ?? '—',
      String(venue.courts.length),
      String(slots),
      venueToTitle.get(venue.key) ?? '—',
    ]);
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

async function applyReadableFormatting(
  accessToken: string,
  spreadsheetId: string,
  sheetMetas: SheetMeta[],
  venueTitles: Set<string>,
): Promise<void> {
  const requests: Record<string, unknown>[] = [];

  for (const { sheetId, title } of sheetMetas) {
    if (title !== INDEX_SHEET_TITLE && !venueTitles.has(title)) {
      continue;
    }

    const headerRow = title === INDEX_SHEET_TITLE ? 4 : 7;
    const frozenRows = title === INDEX_SHEET_TITLE ? 5 : 8;
    const columnCount = title === INDEX_SHEET_TITLE ? 5 : 7;

    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: headerRow,
          endRowIndex: headerRow + 1,
          startColumnIndex: 0,
          endColumnIndex: columnCount,
        },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
            backgroundColor: { red: 0.85, green: 0.92, blue: 0.83 },
          },
        },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    });
    requests.push({
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: { frozenRowCount: frozenRows },
        },
        fields: 'gridProperties.frozenRowCount',
      },
    });
    requests.push({
      autoResizeDimensions: {
        dimensions: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: 0,
          endIndex: columnCount,
        },
      },
    });
  }

  await batchUpdateSpreadsheet(accessToken, spreadsheetId, requests);
}

export async function syncCourtsToGoogleSheets(
  courts: SheetsCourt[],
  slots: SheetsSlot[],
): Promise<GoogleSheetsSyncResult | null> {
  const config = sheetsConfigEnabled();
  if (!config) {
    console.warn(
      '[sync-courts] GOOGLE_SHEETS_SPREADSHEET_ID unset; skipping Google Sheets',
    );
    return null;
  }

  const serviceAccount = parseGoogleServiceAccount();
  if (!serviceAccount) {
    console.warn(
      '[sync-courts] GOOGLE_SERVICE_ACCOUNT_JSON unset; skipping Google Sheets',
    );
    return null;
  }

  const timeZone = displayTimezone();
  const windowDays = slotWindowDays();
  const exportSlots = filterSlotsForSheetsExport(slots, windowDays);
  const accessToken = await getGoogleAccessToken(serviceAccount);
  const { spreadsheetId } = config;

  const venues = groupCourtsByVenue(courts);
  const courtNames = new Map(courts.map((c) => [c.id, c.name]));

  const usedTitles = new Set<string>([INDEX_SHEET_TITLE]);
  const venueToTitle = new Map<string, string>();
  for (const venue of venues) {
    venueToTitle.set(venue.key, sheetTitleForVenue(venue.label, usedTitles));
  }

  const slotCounts = new Map<string, number>();
  const slotsByCourt = new Map<string, SheetsSlot[]>();
  for (const slot of exportSlots) {
    const list = slotsByCourt.get(slot.court_scraper_id) ?? [];
    list.push(slot);
    slotsByCourt.set(slot.court_scraper_id, list);
    slotCounts.set(
      slot.court_scraper_id,
      (slotCounts.get(slot.court_scraper_id) ?? 0) + 1,
    );
  }

  let sheetMetas = await getSpreadsheetSheets(accessToken, spreadsheetId);
  const titleToMeta = new Map(sheetMetas.map((s) => [s.title, s]));

  const addRequests: Record<string, unknown>[] = [];
  let sheetsCreated = 0;

  if (!titleToMeta.has(INDEX_SHEET_TITLE)) {
    addRequests.push({ addSheet: { properties: { title: INDEX_SHEET_TITLE } } });
    sheetsCreated += 1;
  }

  for (const title of venueToTitle.values()) {
    if (!titleToMeta.has(title)) {
      addRequests.push({ addSheet: { properties: { title } } });
      sheetsCreated += 1;
    }
  }

  await batchUpdateSpreadsheet(accessToken, spreadsheetId, addRequests);
  if (addRequests.length > 0) {
    sheetMetas = await getSpreadsheetSheets(accessToken, spreadsheetId);
  }
  titleToMeta.clear();
  for (const s of sheetMetas) {
    titleToMeta.set(s.title, s);
  }

  const desiredTitles = new Set(venueToTitle.values());
  let sheetsPruned = 0;
  if (pruneOrphanSheets()) {
    const deleteRequests: Record<string, unknown>[] = [];
    for (const { sheetId, title } of sheetMetas) {
      if (title === INDEX_SHEET_TITLE) {
        continue;
      }
      if (!desiredTitles.has(title)) {
        deleteRequests.push({ deleteSheet: { sheetId } });
        sheetsPruned += 1;
      }
    }
    await batchUpdateSpreadsheet(accessToken, spreadsheetId, deleteRequests);
    if (deleteRequests.length > 0) {
      sheetMetas = await getSpreadsheetSheets(accessToken, spreadsheetId);
    }
  }

  const valueUpdates: { range: string; values: string[][] }[] = [];
  const formattingApplied = shouldApplyFormatting(venues.length, exportSlots.length);
  const fastDates = !formattingApplied;

  valueUpdates.push({
    range: `${escapeSheetRangeTitle(INDEX_SHEET_TITLE)}!A1`,
    values: buildIndexSheetValues(venues, venueToTitle, slotCounts, timeZone),
  });

  let slotsWritten = 0;
  for (const venue of venues) {
    const title = venueToTitle.get(venue.key)!;
    for (const court of venue.courts) {
      slotsWritten += slotsByCourt.get(court.id)?.length ?? 0;
    }
    valueUpdates.push({
      range: `${escapeSheetRangeTitle(title)}!A1`,
      values: buildVenueSheetValues(
        venue,
        slotsByCourt,
        courtNames,
        timeZone,
        fastDates,
      ),
    });
  }

  for (let i = 0; i < valueUpdates.length; i += VALUES_BATCH_RANGES) {
    await valuesBatchUpdate(
      accessToken,
      spreadsheetId,
      valueUpdates.slice(i, i + VALUES_BATCH_RANGES),
    );
  }

  if (formattingApplied) {
    const venueTitleSet = new Set(venueToTitle.values());
    await applyReadableFormatting(
      accessToken,
      spreadsheetId,
      sheetMetas,
      venueTitleSet,
    );
  }

  return {
    spreadsheetId,
    courts: courts.length,
    venues: venues.length,
    sheetsCreated,
    sheetsUpdated: venues.length,
    sheetsPruned,
    slotsWritten,
    slotsInExport: exportSlots.length,
    slotWindowDays: windowDays,
    formattingApplied,
  };
}
