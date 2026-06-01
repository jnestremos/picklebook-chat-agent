import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  buildCombinedSheetValues,
  buildCourtSheetValues,
  buildVenueSectionRows,
  buildVenueSheetValues,
  filterSlotsForSheetsExport,
  groupCourtsByVenue,
  packVenueKeyChunks,
  sheetTitleForCourt,
  slotSheetColumns,
  slotStartEndFromSlot,
  venueKeyForCourt,
} from './google-sheets-sync.ts';

const baseCourt = {
  source: 'picklehub' as const,
  booking_url: 'https://book.example/v',
  price: 500,
};

Deno.test('sheetTitleForCourt sanitizes and dedupes', () => {
  const used = new Set<string>();
  const a = sheetTitleForCourt(
    { id: 'a', name: 'Club [A]', location: null, ...baseCourt },
    used,
  );
  const b = sheetTitleForCourt(
    { id: 'b', name: 'Club [A]', location: null, ...baseCourt },
    used,
  );
  assertEquals(a, 'Club  A');
  assertEquals(b, 'Club  A (2)');
});

Deno.test('groupCourtsByVenue groups courts with the same location', () => {
  const venues = groupCourtsByVenue([
    { id: 'c1', name: 'Court 1', location: 'BGC Sports Hub', ...baseCourt },
    { id: 'c2', name: 'Court 2', location: 'BGC Sports Hub', ...baseCourt },
    { id: 'c3', name: 'Solo Court', location: 'Quezon City', ...baseCourt },
  ]);
  assertEquals(venues.length, 2);
  assertEquals(venues[0].courts.length, 2);
  assertEquals(venues[0].label, 'BGC Sports Hub');
  assertEquals(venueKeyForCourt(venues[0].courts[0]), venueKeyForCourt(venues[0].courts[1]));
});

Deno.test('buildCourtSheetValues includes header and sorted slots', () => {
  const court = {
    id: 'c1',
    name: 'Test Court',
    location: 'Manila',
    source: 'picklehub',
    booking_url: 'https://book.example/c',
    price: 500,
  };
  const values = buildCourtSheetValues(
    court,
    [
      {
        court_scraper_id: 'c1',
        datetime: '2026-06-02T10:00:00.000Z',
        datetime_end: '2026-06-02T11:00:00.000Z',
        time_slot: '10:00 AM',
        available: true,
        booking_url: 'https://book.example/s1',
      },
      {
        court_scraper_id: 'c1',
        datetime: '2026-06-01T09:00:00.000Z',
        datetime_end: null,
        time_slot: null,
        available: true,
        booking_url: null,
      },
    ],
    'Asia/Manila',
  );
  assertEquals(values[0][0], 'Court');
  assertEquals(values[7][0], 'Date');
  assertEquals(values.length, 10);
  assertEquals(values[8][2], '10:00 AM');
  assertEquals(values[8][3], '2026-06-02 10:00:00');
  assertEquals(values[8][4], '2026-06-02 11:00:00');
});

Deno.test('slotStartEndFromSlot splits time_slot range for Start and End', () => {
  const { start, end } = slotStartEndFromSlot({
    court_scraper_id: 'c1',
    datetime: '2026-06-01T15:00:00.000Z',
    datetime_end: '2026-06-01T16:00:00.000Z',
    time_slot: '11:00 pm - 12:00 am',
    available: true,
    booking_url: null,
  });
  assertEquals(start, '11:00 pm');
  assertEquals(end, '12:00 am');
});

Deno.test('slotSheetColumns fills weekday name', () => {
  const cols = slotSheetColumns(
    {
      court_scraper_id: 'c1',
      datetime: '2026-06-01T02:00:00.000Z',
      datetime_end: '2026-06-01T03:00:00.000Z',
      time_slot: '10:00 am - 11:00 am',
      available: true,
      booking_url: null,
    },
    'Asia/Manila',
  );
  assertEquals(cols[0], '2026-06-01');
  assertEquals(cols[1], 'Monday');
  assertEquals(cols[2], '10:00 am - 11:00 am');
  assertEquals(cols[3], '10:00 am');
  assertEquals(cols[4], '11:00 am');
});

Deno.test('buildVenueSectionRows merges courts into one table', () => {
  const venue = groupCourtsByVenue([
    { id: 'c1', name: 'Court 1', location: 'BGC Hub', ...baseCourt },
    { id: 'c2', name: 'Court 2', location: 'BGC Hub', ...baseCourt },
  ])[0];
  const slotsByCourt = new Map([
    [
      'c1',
      [{
        court_scraper_id: 'c1',
        datetime: '2026-06-02T10:00:00.000Z',
        datetime_end: null,
        time_slot: '10:00 AM',
        available: true,
        booking_url: null,
      }],
    ],
    [
      'c2',
      [{
        court_scraper_id: 'c2',
        datetime: '2026-06-01T09:00:00.000Z',
        datetime_end: null,
        time_slot: null,
        available: true,
        booking_url: null,
      }],
    ],
  ]);
  const courtNames = new Map([['c1', 'Court 1'], ['c2', 'Court 2']]);
  const values = buildVenueSectionRows(venue, slotsByCourt, courtNames, 'Asia/Manila');
  assertEquals(values[0][0], 'Venue');
  assertEquals(values[6][0], 'Court');
  assertEquals(values[7][0], 'Court 2');
  assertEquals(values[8][0], 'Court 1');
});

Deno.test('buildCombinedSheetValues stacks venues with blank separators', () => {
  const venues = groupCourtsByVenue([
    { id: 'c1', name: 'Court 1', location: 'BGC Hub', ...baseCourt },
    { id: 'c2', name: 'Court 2', location: 'Quezon City', ...baseCourt },
  ]);
  const slotsByCourt = new Map([
    [
      'c1',
      [{
        court_scraper_id: 'c1',
        datetime: '2026-06-02T10:00:00.000Z',
        datetime_end: null,
        time_slot: '10:00 AM',
        available: true,
        booking_url: null,
      }],
    ],
  ]);
  const courtNames = new Map([['c1', 'Court 1'], ['c2', 'Court 2']]);
  const values = buildCombinedSheetValues(
    venues,
    slotsByCourt,
    courtNames,
    'Asia/Manila',
    7,
  );
  assertEquals(values[0][0], 'Picklebook — court availability');
  assertEquals(values[4][0], 'Venue');
  assertEquals(values[4][1], 'BGC Hub');
  assertEquals(values[11][0], 'Court 1');
  assertEquals(values[12][0], '');
  assertEquals(values[13][0], 'Venue');
  assertEquals(values[13][1], 'Quezon City');
});

Deno.test('packVenueKeyChunks splits by slot budget', () => {
  const venues = groupCourtsByVenue([
    { id: 'c1', name: 'Court 1', location: 'A', ...baseCourt },
    { id: 'c2', name: 'Court 2', location: 'A', ...baseCourt },
    { id: 'c3', name: 'Court 3', location: 'B', ...baseCourt },
  ]);
  const counts = new Map([
    ['c1', 300],
    ['c2', 300],
    ['c3', 100],
  ]);
  const chunks = packVenueKeyChunks(venues, counts, 500);
  assertEquals(chunks.length, 2);
  assertEquals(chunks[0].length, 1);
  assertEquals(chunks[1].length, 1);
});
  const now = Date.now();
  const inWindow = new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString();
  const outWindow = new Date(now + 10 * 24 * 60 * 60 * 1000).toISOString();
  const filtered = filterSlotsForSheetsExport(
    [
      {
        court_scraper_id: 'c1',
        datetime: inWindow,
        datetime_end: null,
        time_slot: null,
        available: true,
        booking_url: null,
      },
      {
        court_scraper_id: 'c1',
        datetime: outWindow,
        datetime_end: null,
        time_slot: null,
        available: true,
        booking_url: null,
      },
      {
        court_scraper_id: 'c1',
        datetime: inWindow,
        datetime_end: null,
        time_slot: null,
        available: false,
        booking_url: null,
      },
    ],
    7,
  );
  assertEquals(filtered.length, 1);
  assertEquals(filtered[0].datetime, inWindow);
});
