import { MANILA_TZ } from './manila';
import type { SearchToolArgs, SlotRow } from './types';

export type BriefingVenue = {
  location: string;
  court_count: number;
  slot_count: number;
  courts: Array<{
    court_id: number;
    name: string;
    price_php: number | null;
    slots: Array<{
      slot_id: number;
      start_manila: string;
      end_manila: string | null;
    }>;
  }>;
};

export type SlotSearchBriefing = {
  query: SearchToolArgs;
  found: boolean;
  slot_count: number;
  court_count: number;
  venue_count: number;
  venues: BriefingVenue[];
  /** Pre-rendered facts for the formatter LLM — deduped, grounded, no raw row dump. */
  facts_only: string;
};

const manilaHmFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: MANILA_TZ,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const manilaDateFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: MANILA_TZ,
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

function formatManilaTime(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return manilaHmFmt.format(new Date(t));
}

function slotStartMinutesManila(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: MANILA_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(t));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return hour * 60 + minute;
}

function parseHmToMinutes(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function slotStartMinutesFromRow(row: SlotRow): number | null {
  const fromDatetime = slotStartMinutesManila(row.datetime);
  if (fromDatetime !== null) return fromDatetime;
  return parseTimeSlotStartMinutes(row.time_slot);
}

/** Parse leading clock from scraper strings like "6:00 AM - 7:00 AM". */
function parseTimeSlotStartMinutes(timeSlot: string | null): number | null {
  if (!timeSlot?.trim()) return null;
  const head = timeSlot.trim().split(/\s*[-–—]\s*/)[0]?.trim();
  if (!head) return null;

  const hm24 = /^(\d{1,2}):(\d{2})$/.exec(head);
  if (hm24) {
    const h = Number(hm24[1]);
    const m = Number(hm24[2]);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return h * 60 + m;
  }

  const hm12 = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(head);
  if (!hm12) return null;
  let h = Number(hm12[1]);
  const m = hm12[2] ? Number(hm12[2]) : 0;
  const mer = hm12[3].toLowerCase();
  if (m < 0 || m > 59 || h < 1 || h > 12) return null;
  if (mer === 'am') {
    if (h === 12) h = 0;
  } else if (h !== 12) {
    h += 12;
  }
  return h * 60 + m;
}

/** Filter slots to a Manila local time window (inclusive start, exclusive end). */
export function filterSlotsByManilaTimeWindow(
  rows: SlotRow[],
  from?: string,
  to?: string,
): SlotRow[] {
  const fromMin = from ? parseHmToMinutes(from) : null;
  const toMin = to ? parseHmToMinutes(to) : null;
  if (fromMin === null && toMin === null) return rows;

  return rows.filter((row) => {
    const start = slotStartMinutesFromRow(row);
    if (start === null) return false;
    if (fromMin !== null && start < fromMin) return false;
    if (toMin !== null && start >= toMin) return false;
    return true;
  });
}

function queryLabel(query: SearchToolArgs): string {
  const parts: string[] = [];
  if (query.location) parts.push(`venue keyword "${query.location}"`);
  if (query.manilaDate) {
    const t = Date.parse(`${query.manilaDate}T12:00:00+08:00`);
    parts.push(
      Number.isNaN(t) ?
        `date ${query.manilaDate}`
      : `date ${manilaDateFmt.format(new Date(t))} (Asia/Manila)`,
    );
  }
  if (query.manilaTimeFrom || query.manilaTimeTo) {
    const from = query.manilaTimeFrom ?? '…';
    const to = query.manilaTimeTo ?? '…';
    parts.push(`time window ${from}–${to} Manila`);
  }
  return parts.length > 0 ? parts.join(', ') : 'open slots (no filters)';
}

function formatSlotRange(start: string, end: string | null): string {
  return end ? `${start}–${end}` : start;
}

const MAX_VENUES_IN_BRIEF = 5;
const MAX_COURTS_PER_VENUE = 12;
const MAX_SLOTS_PER_COURT = 16;

/** Build a deduped, grounded briefing — the only slot facts the formatter LLM may use. */
export function buildSlotSearchBriefing(
  rows: SlotRow[],
  query: SearchToolArgs,
): SlotSearchBriefing {
  const venueMap = new Map<
    string,
    Map<number, { name: string; price: number | null; slots: SlotRow[] }>
  >();

  for (const row of rows) {
    const loc = row.location?.trim() || '(No location)';
    let courts = venueMap.get(loc);
    if (!courts) {
      courts = new Map();
      venueMap.set(loc, courts);
    }
    let court = courts.get(row.id);
    if (!court) {
      court = {
        name: row.name?.trim() || `Court ${row.id}`,
        price: row.price ?? null,
        slots: [],
      };
      courts.set(row.id, court);
    }
    court.slots.push(row);
  }

  const venues: BriefingVenue[] = [...venueMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, MAX_VENUES_IN_BRIEF)
    .map(([location, courtsMap]) => {
      const courts = [...courtsMap.entries()]
        .sort(([, a], [, b]) => a.name.localeCompare(b.name))
        .slice(0, MAX_COURTS_PER_VENUE)
        .map(([court_id, c]) => {
          const slots = c.slots
            .sort((a, b) => Date.parse(a.datetime ?? '') - Date.parse(b.datetime ?? ''))
            .slice(0, MAX_SLOTS_PER_COURT)
            .map((s) => ({
              slot_id: s.slot_id,
              start_manila: formatManilaTime(s.datetime) ?? '?',
              end_manila: formatManilaTime(s.datetime_end),
            }));
          return {
            court_id,
            name: c.name,
            price_php: c.price,
            slots,
          };
        });
      const slot_count = courts.reduce((n, c) => n + c.slots.length, 0);
      return {
        location,
        court_count: courts.length,
        slot_count,
        courts,
      };
    });

  const courtIds = new Set(rows.map((r) => r.id));
  const slot_count = rows.length;
  const court_count = courtIds.size;
  const venue_count = venueMap.size;

  const lines: string[] = [
    `SEARCH: ${queryLabel(query)}`,
    `TOTALS: ${slot_count} open slot(s), ${court_count} court(s), ${venue_count} venue location(s).`,
    `(Each listed time is one bookable slot. Do not call slots "courts".)`,
  ];

  if (slot_count === 0) {
    lines.push('RESULT: No matching open slots in the database for this search.');
  } else {
    const showing = Math.min(MAX_VENUES_IN_BRIEF, venue_count);
    lines.push(
      `FIRST VENUES (${showing} of ${venue_count} — user can load more in the schedule table):`,
    );
    for (const v of venues) {
      lines.push(
        `- ${v.location}: ${v.court_count} court(s), ${v.slot_count} slot(s) in this summary`,
      );
      for (const c of v.courts) {
        const price =
          c.price_php != null ? `, ₱${Math.round(Number(c.price_php))}` : '';
        const times = c.slots
          .map((s) => formatSlotRange(s.start_manila, s.end_manila))
          .join(', ');
        const truncated =
          c.slots.length >= MAX_SLOTS_PER_COURT ? ' (times truncated in summary)' : '';
        lines.push(`  • ${c.name}${price}: ${times}${truncated}`);
      }
    }
    if (venue_count > MAX_VENUES_IN_BRIEF) {
      lines.push(
        `(${venue_count - MAX_VENUES_IN_BRIEF} more venue location(s) exist — mention the total count but only name venues listed above; the UI paginates the rest.)`,
      );
    }
  }

  return {
    query,
    found: slot_count > 0,
    slot_count,
    court_count,
    venue_count,
    venues,
    facts_only: lines.join('\n'),
  };
}

/** Deterministic fallback if the formatter LLM fails. */
export function buildDeterministicReply(briefing: SlotSearchBriefing): string {
  if (!briefing.found) {
    return `I don't see any open slots for ${queryLabel(briefing.query)}. Want to try a different day or venue?`;
  }

  if (briefing.venue_count === 1 && briefing.venues[0]) {
    const v = briefing.venues[0];
    return `I found ${briefing.slot_count} open slot${briefing.slot_count === 1 ? '' : 's'} at ${v.location} across ${briefing.court_count} court${briefing.court_count === 1 ? '' : 's'}. Scroll the schedule below for exact times.`;
  }

  const showing = briefing.venues.slice(0, 5).map((v) => v.location);
  const names = showing.join(', ');
  const moreVenues =
    briefing.venue_count > showing.length ?
      ` ${briefing.venue_count - showing.length} more venue${briefing.venue_count - showing.length === 1 ? '' : 's'} also have openings — use "Show more venues" in the schedule below.`
    : '';

  return `I found ${briefing.slot_count} open slot${briefing.slot_count === 1 ? '' : 's'} across ${briefing.court_count} court${briefing.court_count === 1 ? '' : 's'} at ${briefing.venue_count} venue location${briefing.venue_count === 1 ? '' : 's'}. Starting with ${names}.${moreVenues}`;
}
