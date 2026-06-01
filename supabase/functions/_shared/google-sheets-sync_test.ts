import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  buildCourtSheetValues,
  sheetTitleForCourt,
} from './google-sheets-sync.ts';

Deno.test('sheetTitleForCourt sanitizes and dedupes', () => {
  const used = new Set<string>();
  const a = sheetTitleForCourt({ id: 'a', name: 'Club [A]', location: null, source: null, booking_url: null, price: null }, used);
  const b = sheetTitleForCourt({ id: 'b', name: 'Club [A]', location: null, source: null, booking_url: null, price: null }, used);
  assertEquals(a, 'Club  A');
  assertEquals(b, 'Club  A (2)');
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
});
