import { todayManila } from './manila';
import type { SearchToolArgs } from './types';

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toHm24(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

/** Parse "6am", "6:30 pm", "06:00" into minutes since midnight (24h). */
function parseClockToken(raw: string, sharedMeridiem?: string): number | null {
  const s = raw.trim().toLowerCase().replace(/\./g, '');

  const hm24 = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (hm24) {
    const h = Number(hm24[1]);
    const m = Number(hm24[2]);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return h * 60 + m;
  }

  const hm12 = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s);
  if (!hm12) return null;

  let h = Number(hm12[1]);
  const min = hm12[2] ? Number(hm12[2]) : 0;
  const mer = (hm12[3] ?? sharedMeridiem)?.toLowerCase();
  if (!mer || min < 0 || min > 59 || h < 1 || h > 12) return null;
  if (mer === 'am') {
    if (h === 12) h = 0;
  } else if (h !== 12) {
    h += 12;
  }
  return h * 60 + min;
}

/**
 * Extract a Manila time window from natural language, e.g. "6am to 11am" → 06:00–11:00.
 * Returns null when no clear range is present.
 */
export function parseTimeRangeFromUserText(text: string): { from: string; to: string } | null {
  const s = text.replace(/[\u2013\u2014]/g, '-');

  let fromMin: number | null = null;
  let toMin: number | null = null;

  let m =
    /\b(?:from\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*(?:to|until|through|-)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i.exec(
      s,
    );
  if (m) {
    fromMin = parseClockToken(m[1]);
    toMin = parseClockToken(m[2]);
  } else {
    m =
      /\b(?:from\s+)?(\d{1,2}(?::\d{2})?)\s*(?:to|until|through|-)\s*(\d{1,2}(?::\d{2})?)\s*(am|pm)\b/i.exec(
        s,
      );
    if (m) {
      fromMin = parseClockToken(m[1], m[3]);
      toMin = parseClockToken(m[2], m[3]);
    } else {
      m = /\b(\d{1,2}:\d{2})\s*(?:to|until|through|-)\s*(\d{1,2}:\d{2})\b/.exec(s);
      if (m) {
        fromMin = parseClockToken(m[1]);
        toMin = parseClockToken(m[2]);
      }
    }
  }

  if (fromMin === null || toMin === null || fromMin >= toMin) return null;
  return { from: toHm24(fromMin), to: toHm24(toMin) };
}

function nextManilaDateOnOrAfter(month: number, day: number, today: string): string | null {
  const [y] = today.split('-').map(Number);
  if (!y) return null;

  for (let year = y; year <= y + 1; year += 1) {
    const candidate = `${year}-${pad2(month)}-${pad2(day)}`;
    if (candidate >= today) return candidate;
  }
  return null;
}

/** Parse "June 9" / "june 9th" into YYYY-MM-DD (next matching Manila date on or after today). */
export function parseManilaDateFromUserText(text: string, today = todayManila()): string | null {
  const monthDay =
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(
      text,
    );
  if (monthDay) {
    const month = MONTHS[monthDay[1].toLowerCase()];
    const day = Number(monthDay[2]);
    if (month && day >= 1 && day <= 31) return nextManilaDateOnOrAfter(month, day, today);
  }

  const dayMonth =
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.exec(
      text,
    );
  if (dayMonth) {
    const day = Number(dayMonth[1]);
    const month = MONTHS[dayMonth[2].toLowerCase()];
    if (month && day >= 1 && day <= 31) return nextManilaDateOnOrAfter(month, day, today);
  }

  return null;
}

/**
 * When the user clearly stated a day/time window, prefer deterministic parsing over
 * small-model tool args (which often misuse `datetime` as a single instant).
 */
export function augmentSearchArgsFromUserMessage(
  picked: SearchToolArgs,
  userMessage: string,
): SearchToolArgs {
  const out = { ...picked };

  const range = parseTimeRangeFromUserText(userMessage);
  if (range) {
    out.manilaTimeFrom = range.from;
    out.manilaTimeTo = range.to;
    delete out.datetime;
  }

  const date = parseManilaDateFromUserText(userMessage);
  if (date) out.manilaDate = date;

  return out;
}
