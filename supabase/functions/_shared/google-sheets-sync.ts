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
  sheetsCreated: number;
  sheetsUpdated: number;
  sheetsPruned: number;
  slotsWritten: number;
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

/** Sheet tab title: unique, ≤100 chars, no \\ / ? * [ ] */
export function sheetTitleForCourt(
  court: SheetsCourt,
  usedTitles: Set<string>,
): string {
  let base = court.name
    .replace(/[\\/?*[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) {
    base = court.id.replace(/[\\/?*[\]]/g, '_').slice(0, 60);
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

function bookingLinkFormula(url: string | null): string {
  if (!url?.trim()) {
    return '';
  }
  const safe = url.replace(/"/g, '""');
  return `=HYPERLINK("${safe}","Book")`;
}

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
    ['Date', 'Day', 'Time slot', 'Start', 'End', 'Book'],
  ];

  for (const slot of sorted) {
    const start = formatInTz(slot.datetime, timeZone);
    const end = slot.datetime_end
      ? formatInTz(slot.datetime_end, timeZone).time
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
  courts: SheetsCourt[],
  courtToTitle: Map<string, string>,
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
    ['Open a tab below — one sheet per court.'],
    [],
    ['Court', 'Location', 'Available slots', 'Sheet tab'],
  ];

  const sorted = [...courts].sort((a, b) => a.name.localeCompare(b.name));
  for (const court of sorted) {
    rows.push([
      court.name,
      court.location ?? '—',
      String(slotCounts.get(court.id) ?? 0),
      courtToTitle.get(court.id) ?? '—',
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
  courtTitles: Set<string>,
): Promise<void> {
  const requests: Record<string, unknown>[] = [];

  for (const { sheetId, title } of sheetMetas) {
    if (title !== INDEX_SHEET_TITLE && !courtTitles.has(title)) {
      continue;
    }

    const headerRow = title === INDEX_SHEET_TITLE ? 4 : 7;
    const frozenRows = title === INDEX_SHEET_TITLE ? 5 : 8;

    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: headerRow,
          endRowIndex: headerRow + 1,
          startColumnIndex: 0,
          endColumnIndex: title === INDEX_SHEET_TITLE ? 4 : 6,
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
          endIndex: title === INDEX_SHEET_TITLE ? 4 : 6,
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
  const accessToken = await getGoogleAccessToken(serviceAccount);
  const { spreadsheetId } = config;

  const usedTitles = new Set<string>([INDEX_SHEET_TITLE]);
  const courtToTitle = new Map<string, string>();
  for (const court of courts) {
    courtToTitle.set(court.id, sheetTitleForCourt(court, usedTitles));
  }

  const slotCounts = new Map<string, number>();
  const slotsByCourt = new Map<string, SheetsSlot[]>();
  for (const slot of slots) {
    if (!slot.available) {
      continue;
    }
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

  for (const title of courtToTitle.values()) {
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

  const desiredTitles = new Set(courtToTitle.values());
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

  valueUpdates.push({
    range: `${escapeSheetRangeTitle(INDEX_SHEET_TITLE)}!A1`,
    values: buildIndexSheetValues(courts, courtToTitle, slotCounts, timeZone),
  });

  let slotsWritten = 0;
  for (const court of courts) {
    const title = courtToTitle.get(court.id)!;
    const courtSlots = slotsByCourt.get(court.id) ?? [];
    slotsWritten += courtSlots.length;
    valueUpdates.push({
      range: `${escapeSheetRangeTitle(title)}!A1`,
      values: buildCourtSheetValues(court, courtSlots, timeZone),
    });
  }

  for (let i = 0; i < valueUpdates.length; i += VALUES_BATCH_RANGES) {
    await valuesBatchUpdate(
      accessToken,
      spreadsheetId,
      valueUpdates.slice(i, i + VALUES_BATCH_RANGES),
    );
  }

  const courtTitleSet = new Set(courtToTitle.values());
  await applyReadableFormatting(
    accessToken,
    spreadsheetId,
    sheetMetas,
    courtTitleSet,
  );

  return {
    spreadsheetId,
    courts: courts.length,
    sheetsCreated,
    sheetsUpdated: courts.length,
    sheetsPruned,
    slotsWritten,
  };
}
