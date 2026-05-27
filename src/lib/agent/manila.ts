/**
 * Manila timezone helpers. The scraped slot rows are stored as timestamptz, but
 * users phrase requests in PH local time ("Friday 7pm"). All conversions go
 * through these helpers so behaviour matches the old D1/Hono implementation.
 */
export const MANILA_TZ = 'Asia/Manila';

/** YYYY-MM-DD of a UTC ms value, interpreted in Manila. */
export function manilaDateKey(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MANILA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/**
 * Convert a Manila local date (`YYYY-MM-DD`) into a UTC ISO range covering the
 * full Manila calendar day. Manila is UTC+8 with no DST so this is exact.
 */
export function manilaDateRangeUtc(manilaDate: string): { start: string; end: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(manilaDate.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const start = new Date(`${y}-${mo}-${d}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Today's Manila date (YYYY-MM-DD) at evaluation time. */
export function todayManila(): string {
  return manilaDateKey(Date.now());
}
