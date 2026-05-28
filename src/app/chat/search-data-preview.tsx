'use client';

import { useEffect, useMemo, useState } from 'react';
import { bookingSourceLabel, formatVenuePlaceForResponse } from './venue-display';
import {
  orderedVenueLocationsInRank,
  venueLocationFromRow,
  VENUE_PAGE_SIZE,
} from './venue-locations';
import styles from './chat.module.css';

type SlotRow = {
  id?: unknown;
  name?: string | null;
  location?: string | null;
  source?: string | null;
  price?: number | null | unknown;
  slot_id?: unknown;
  datetime?: string | null;
  datetime_end?: string | null;
  time_slot?: string | null;
  booking_url?: string | null;
  court_booking_url?: string | null;
  slot_booking_url?: string | null;
};

function asSlotRows(data: unknown): SlotRow[] {
  if (!Array.isArray(data)) return [];
  return data.filter((x) => x && typeof x === 'object') as SlotRow[];
}

function manilaDateKeyUtc(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

const manilaHmFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const manilaWeekdayFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  weekday: 'short',
});

const manilaDateShortFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  month: 'short',
  day: 'numeric',
});

function courtKey(row: SlotRow): string {
  const id = row.id;
  if (typeof id === 'string' || typeof id === 'number') return String(id);
  const nm = typeof row.name === 'string' ? row.name.trim() : '';
  const loc = typeof row.location === 'string' ? row.location.trim() : '';
  return nm || loc ? `${nm}\x00${loc}` : '__';
}

function venueLabel(row: SlotRow): string {
  const n = typeof row.name === 'string' ? row.name.trim() : '';
  const l =
    typeof row.location === 'string' ? formatVenuePlaceForResponse(row.location.trim()) : '';
  const v = [n, l].filter(Boolean).join(' — ');
  return v || String(row.id ?? 'Court');
}

function venueSource(row: SlotRow): string | null {
  const src =
    typeof row.source === 'string' && row.source.trim() ?
      bookingSourceLabel(row.source.trim())
    : null;
  if (src) return src;
  const bu =
    typeof row.booking_url === 'string'
      ? row.booking_url
      : typeof row.slot_booking_url === 'string'
        ? row.slot_booking_url
        : typeof row.court_booking_url === 'string'
          ? row.court_booking_url
          : undefined;
  return bookingSourceLabel(bu);
}

function slotCaption(row: SlotRow): string {
  const ts = typeof row.time_slot === 'string' ? row.time_slot.trim() : '';
  if (ts) return ts.replace(/\s*-\s*/g, ' – ').replace(/\s+/g, ' ').trim();
  const iso = typeof row.datetime === 'string' ? row.datetime : '';
  if (!iso) return 'Slot';
  return iso.replace('T', ' ').replace('Z', ' UTC').slice(0, 19);
}

function parseRowMs(row: SlotRow): number | null {
  const raw = typeof row.datetime === 'string' ? row.datetime.trim() : '';
  if (!raw) return null;
  const norm = (/[zZ]|[-+]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(/\.\d+$/, '')}Z`) as string;
  const ms = Date.parse(norm);
  return Number.isNaN(ms) ? null : ms;
}

function priceLabel(p: unknown): string | null {
  if (typeof p !== 'number' || !Number.isFinite(p)) return null;
  return `₱${p}`;
}

function bookUrls(row: SlotRow): string | undefined {
  if (typeof row.booking_url === 'string' && row.booking_url.trim()) return row.booking_url.trim();
  if (typeof row.slot_booking_url === 'string' && row.slot_booking_url.trim())
    return row.slot_booking_url.trim();
  if (typeof row.court_booking_url === 'string' && row.court_booking_url.trim())
    return row.court_booking_url.trim();
  return undefined;
}

function pushRk(bucket: Map<string, SlotRow[]>, rk: string, row: SlotRow) {
  const cur = bucket.get(rk);
  if (cur) cur.push(row);
  else bucket.set(rk, [row]);
}

function normVenueHay(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s*[—–-]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Venue labels share generic words (“pickle”, “indoor”); counting them produced false positives
 * (e.g. “Pickle World” ranked for “Pickle Hive”). Matches use full phrase containment and
 * discriminative tokens only — see `/skills.md` in this repo.
 */
const GENERIC_VENUE_TOKENS = new Set([
  'pickle',
  'pickleball',
  'court',
  'courts',
  'indoor',
  'outdoor',
  'outdoors',
  'center',
  'centre',
  'sports',
  'club',
  'complex',
]);

/** Narrow calendar columns / sort boost need a real lexical tie, not a shared generic word. */
export const MIN_VENUE_HINT_SCORE = 260;

function discriminativeVenueWords(hintSegNorm: string): string[] {
  return hintSegNorm
    .split(/\s+/)
    .filter((w) => w.length > 2 && !GENERIC_VENUE_TOKENS.has(w));
}

/** Per segment (split on and / comma); returns 0 unless phrase or discriminative word hits. */
function singleHintSegmentScore(headerNorm: string, hintSegNorm: string): number {
  if (!hintSegNorm || !headerNorm) return 0;

  let phraseScore = 0;
  if (
    hintSegNorm.length >= 6 &&
    (headerNorm.includes(hintSegNorm) || hintSegNorm.includes(headerNorm))
  ) {
    phraseScore = 4000;
  }

  const disc = discriminativeVenueWords(hintSegNorm);
  let discScore = 0;
  for (const w of disc) {
    if (headerNorm.includes(w))
      discScore = Math.max(discScore, 200 + Math.min(w.length, 24) * 35);
  }

  if (!disc.length) {
    if (hintSegNorm.length >= 5 && hintSegNorm.length <= 64 && headerNorm.includes(hintSegNorm))
      return Math.max(phraseScore, 3500);
    return phraseScore;
  }

  return Math.max(phraseScore, discScore);
}

/** Split "A and B", "A, B" so multi-venue asks rank both groups of columns. */
export function venueSearchHintScores(header: string, rawHint?: string): number {
  if (!rawHint?.trim()) return 0;
  const headerNorm = normVenueHay(header);
  const parts = rawHint
    .split(/\s*(?:,\s*|\s+\+\s+|\s+(?:and)\s+|\s*&\s*)\s*/i)
    .map((s) => normVenueHay(s))
    .filter(Boolean);
  if (parts.length === 0) return 0;
  return Math.max(...parts.map((p) => singleHintSegmentScore(headerNorm, p)));
}

export function venueHeaderMatchesSearchHint(header: string, rawHint?: string): boolean {
  return venueSearchHintScores(header, rawHint) >= MIN_VENUE_HINT_SCORE;
}

function pickSearchLocationHint(meta?: Record<string, unknown>): string | undefined {
  if (!meta) return undefined;
  const s = meta.search;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return undefined;
  const loc = (s as Record<string, unknown>).location;
  return typeof loc === 'string' && loc.trim() ? loc.trim() : undefined;
}

function formatManilaTimeRow(ms: number, multiDay: boolean): string {
  const d = new Date(ms);
  const hm = manilaHmFmt.format(d);
  if (!multiDay) return hm;
  return `${manilaWeekdayFmt.format(d)} ${manilaDateShortFmt.format(d)} · ${hm}`;
}

type CourtCol = {
  key: string;
  header: string;
  sample: SlotRow;
  byRk: Map<string, SlotRow[]>;
};

/** How many slot rows landed in this column (prioritize searched / active venues). */
function courtTotalHits(col: CourtCol): number {
  let n = 0;
  for (const list of col.byRk.values()) {
    n += list.length;
  }
  return n;
}

type AxisTimed = { kind: 't'; ms: number };
type AxisUntimed = { kind: 'u'; courtKey: string; caption: string };

function timedMsFromColumns(columns: CourtCol[]): Set<number> {
  const ms = new Set<number>();
  for (const col of columns) {
    for (const rk of col.byRk.keys()) {
      if (rk.startsWith('t:')) ms.add(Number(rk.slice(2)));
    }
  }
  return ms;
}

type PreparedSlotCalendar = {
  cols: Map<string, CourtCol>;
  sortedCourts: CourtCol[];
  /** Columns whose header matches `searchHint` (strict); empty array if hint missing. */
  relevantCourtsStrict: CourtCol[];
  timedMsFull: Set<number>;
  uAxesFull: AxisUntimed[];
};

function prepareSlotCalendar(rows: SlotRow[], searchHint?: string): PreparedSlotCalendar {
  const cols = new Map<string, CourtCol>();

  const timedMsFull = new Set<number>();
  const uAxesFull: AxisUntimed[] = [];
  const uSeenSig = new Set<string>();

  for (const sr of rows) {
    const key = courtKey(sr);
    let col = cols.get(key);
    if (!col) {
      col = { key, header: venueLabel(sr), sample: sr, byRk: new Map() };
      cols.set(key, col);
    }
    const ms = parseRowMs(sr);
    if (ms !== null) {
      timedMsFull.add(ms);
      pushRk(col.byRk, `t:${ms}`, sr);
      continue;
    }
    const cap = slotCaption(sr);
    pushRk(col.byRk, `u:${cap}`, sr);
    const sig = `${key}\0${cap}`;
    if (!uSeenSig.has(sig)) {
      uSeenSig.add(sig);
      uAxesFull.push({ kind: 'u', courtKey: key, caption: cap });
    }
  }

  const sortedCourts = [...cols.values()].sort((a, b) => {
    const ma = venueSearchHintScores(a.header, searchHint);
    const mb = venueSearchHintScores(b.header, searchHint);
    if (mb !== ma) return mb - ma;
    const hb = courtTotalHits(b);
    const ha = courtTotalHits(a);
    if (hb !== ha) return hb - ha;
    return a.header.localeCompare(b.header, undefined, { sensitivity: 'base' });
  });

  const relevantCourtsStrict = searchHint?.trim()
    ? sortedCourts.filter((c) => venueHeaderMatchesSearchHint(c.header, searchHint))
    : [];

  const courtOrderIdx = new Map(sortedCourts.map((c, i) => [c.key, i]));
  uAxesFull.sort((a, b) => {
    const ia = courtOrderIdx.get(a.courtKey) ?? sortedCourts.length;
    const ib = courtOrderIdx.get(b.courtKey) ?? sortedCourts.length;
    if (ia !== ib) return ia - ib;
    return a.caption.localeCompare(b.caption);
  });

  return { cols, sortedCourts, relevantCourtsStrict, timedMsFull, uAxesFull };
}

function renderCell(srList: SlotRow[] | undefined) {
  const hits = srList ?? [];
  if (!hits.length) return <span className={styles.slotUnifiedDash}>—</span>;
  return (
    <div className={styles.slotUnifiedCellStack}>
      {hits.map((sr, ii) => {
        const url = bookUrls(sr);
        const explicit =
          typeof sr.time_slot === 'string' && sr.time_slot.trim().length > 0;
        const subKey = `${String(sr.slot_id ?? ii)}`;
        return (
          <div key={subKey} className={styles.slotUnifiedSlot}>
            {explicit ? <span className={styles.slotUnifiedRange}>{slotCaption(sr)}</span> : null}
            {url ? (
              <a
                className={styles.slotBookLink}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                Book
              </a>
            ) : (
              <span className={styles.slotUnifiedOpen}>Open</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function venueLocationFromCol(col: CourtCol): string {
  return venueLocationFromRow(col.sample);
}

function orderedVenueLocationsFromCourts(courts: CourtCol[]): string[] {
  return orderedVenueLocationsInRank(courts.map((c) => c.sample));
}

/** One calendar matrix: Manila time down the rows, each court/venue column across. */
function AllVenuesCalendarGrid({
  prep,
  showAllVenues,
  displayCourts,
}: {
  prep: PreparedSlotCalendar;
  showAllVenues: boolean;
  displayCourts: CourtCol[];
}) {
  const { cols, sortedCourts, relevantCourtsStrict, timedMsFull, uAxesFull } = prep;

  const canNarrow =
    !!relevantCourtsStrict.length && relevantCourtsStrict.length < sortedCourts.length;
  const useNarrowView = canNarrow && !showAllVenues;
  const courtsForGrid =
    useNarrowView ?
      displayCourts.filter((c) =>
        relevantCourtsStrict.some((r) => r.key === c.key),
      )
    : displayCourts;

  const timedMsAxis = useNarrowView ? timedMsFromColumns(courtsForGrid) : timedMsFull;
  const displayKeys = new Set(courtsForGrid.map((c) => c.key));
  const uAxes = useNarrowView ? uAxesFull.filter((u) => displayKeys.has(u.courtKey)) : uAxesFull;

  const manilaDates = new Set<string>();
  for (const ms of timedMsAxis) manilaDates.add(manilaDateKeyUtc(ms));
  const multiDay = manilaDates.size > 1;

  const axisTimed: AxisTimed[] = [...timedMsAxis].sort((a, b) => a - b).map((ms) => ({ kind: 't', ms }));
  const axisAll: (AxisTimed | AxisUntimed)[] = [...axisTimed, ...uAxes];

  if (courtsForGrid.length === 0 || axisAll.length === 0) return null;

  return (
    <div className={styles.slotUnifiedWrap}>
      <table className={styles.slotUnifiedTable}>
        <thead>
          <tr>
            <th scope="col" className={styles.slotUnifiedCorner}>
              Manila time
            </th>
            {courtsForGrid.map((c) => {
              const src = venueSource(c.sample);
              const price = priceLabel(c.sample.price);
              return (
                <th key={c.key} scope="col" className={styles.slotUnifiedCourtHead}>
                  <span className={styles.slotUnifiedCourtTitle}>{c.header}</span>
                  {src ? <span className={styles.slotUnifiedCourtSrc}>{src}</span> : null}
                  {price ? <span className={styles.slotUnifiedCourtPrice}>{price}</span> : null}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {axisAll.map((ax) => {
            if (ax.kind === 't') {
              const rk = `t:${ax.ms}`;
              return (
                <tr key={rk}>
                  <th scope="row" className={styles.slotUnifiedTime}>
                    {formatManilaTimeRow(ax.ms, multiDay)}
                  </th>
                  {courtsForGrid.map((col) => {
                    const list = col.byRk.get(rk);
                    const has = !!(list && list.length > 0);
                    return (
                      <td
                        key={`${rk}-${col.key}`}
                        className={has ? styles.slotUnifiedTdOpen : styles.slotUnifiedTdEmpty}
                      >
                        {has ?
                          renderCell(list)
                        : <span className={styles.slotUnifiedDash}>—</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            }

            const u = ax as AxisUntimed;
            const rowKey = `u:${u.courtKey}:${u.caption}`;
            return (
              <tr key={rowKey}>
                <th scope="row" className={styles.slotUnifiedTimeUntimed}>
                  <span className={styles.slotUnifiedUntimedLbl}>
                    {cols.get(u.courtKey)?.header ?? 'Court'}
                  </span>
                  <span className={styles.slotUnifiedUntimedCap}>{u.caption}</span>
                </th>
                {courtsForGrid.map((col) => {
                  const rk = `u:${u.caption}`;
                  const hits = col.key === u.courtKey ? col.byRk.get(rk) : undefined;
                  const has = !!(hits && hits.length > 0);
                  return (
                    <td
                      key={`${rowKey}-${col.key}`}
                      className={has ? styles.slotUnifiedTdOpen : styles.slotUnifiedTdEmpty}
                    >
                      {col.key === u.courtKey ? renderCell(hits) : (
                        <span className={styles.slotUnifiedDash}>—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function SearchDataPreview({
  data,
  meta,
}: {
  data: unknown;
  meta?: Record<string, unknown>;
}) {
  const searchHint = pickSearchLocationHint(meta);
  const hasVenueFilter = !!searchHint?.trim();

  const prep = useMemo(() => {
    const r = asSlotRows(data);
    if (r.length === 0) return null;
    return prepareSlotCalendar(r, searchHint);
  }, [data, searchHint]);

  const [showAllVenues, setShowAllVenues] = useState(false);
  const [venuePages, setVenuePages] = useState(1);

  useEffect(() => {
    setShowAllVenues(false);
    setVenuePages(1);
  }, [data, searchHint]);

  if (!prep) return null;

  const venueLocationOrder = orderedVenueLocationsFromCourts(prep.sortedCourts);
  const totalVenueCount = venueLocationOrder.length;

  const visibleVenueCount =
    hasVenueFilter ?
      totalVenueCount
    : Math.min(venuePages * VENUE_PAGE_SIZE, totalVenueCount);
  const visibleVenueNames = venueLocationOrder.slice(0, visibleVenueCount);
  const visibleVenueSet = new Set(visibleVenueNames);

  const displayCourts =
    hasVenueFilter ?
      prep.sortedCourts
    : prep.sortedCourts.filter((c) => visibleVenueSet.has(venueLocationFromCol(c)));

  const remainingVenues = hasVenueFilter ? 0 : totalVenueCount - visibleVenueCount;
  const nextVenueBatch = Math.min(VENUE_PAGE_SIZE, remainingVenues);

  const narrowable =
    hasVenueFilter &&
    prep.relevantCourtsStrict.length > 0 &&
    prep.relevantCourtsStrict.length < prep.sortedCourts.length;
  const hiddenOtherCount =
    narrowable ? prep.sortedCourts.length - prep.relevantCourtsStrict.length : 0;

  const previewTitle =
    hasVenueFilter ?
      'Open slots · matching venues'
    : `Open slots · ${visibleVenueCount} of ${totalVenueCount} venue${totalVenueCount === 1 ? '' : 's'}`;

  return (
    <div className={styles.slotPreview} aria-label="Structured search results">
      <div className={styles.slotPreviewTitle}>{previewTitle}</div>
      {!hasVenueFilter && visibleVenueNames.length > 0 ?
        <ol className={styles.slotVenuePageList}>
          {visibleVenueNames.map((name) => (
            <li key={name} className={styles.slotVenuePageItem}>
              {name}
            </li>
          ))}
        </ol>
      : null}
      <p className={styles.slotCalendarBlurb}>
        {hasVenueFilter ?
          'Matching columns for your venue search are shown first. Green cells are bookable openings; scroll the grid sideways when viewing every court.'
        : `Showing the first ${visibleVenueCount} venue location${visibleVenueCount === 1 ? '' : 's'}. Green cells are bookable openings; load more venues below until every location is listed.`}
      </p>
      <div className={styles.slotCalendarOuter}>
        <AllVenuesCalendarGrid
          prep={prep}
          showAllVenues={showAllVenues}
          displayCourts={displayCourts}
        />
      </div>
      {!hasVenueFilter && remainingVenues > 0 ?
        <button
          type="button"
          className={styles.slotVenuesToggle}
          onClick={() => setVenuePages((p) => p + 1)}
        >
          {`Show ${nextVenueBatch} more venue${nextVenueBatch === 1 ? '' : 's'} (${visibleVenueCount} of ${totalVenueCount} shown)`}
        </button>
      : null}
      {narrowable ?
        <button
          type="button"
          className={styles.slotVenuesToggle}
          onClick={() => setShowAllVenues((v) => !v)}
        >
          {showAllVenues ?
            'Show searched venues only'
          : `Show ${hiddenOtherCount} other venue${hiddenOtherCount === 1 ? '' : 's'} in this result`}
        </button>
      : null}
    </div>
  );
}
