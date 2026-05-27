/** Remove trailing booking-platform tag from scraped `c.location`. */
export function stripBookingSourceFromLocation(location: string): string {
  return location.replace(/\s*\((?:Skedda|PickleHub)\)\s*$/i, '').trim();
}

export function capitalizeFirstChar(s: string): string {
  const t = s.trim();
  if (!t) return t;
  return t.charAt(0).toLocaleUpperCase('en-US') + t.slice(1);
}

/** Directory sidebar: uppercase first letter; hide (Skedda)/(PickleHub) suffix. */
export function formatVenueDirectoryTitle(raw: string): string {
  if (raw === '(No location)') return raw;
  const stripped = stripBookingSourceFromLocation(raw);
  return capitalizeFirstChar(stripped);
}

/** Chat previews: same place formatting without platform parenthetical. */
export function formatVenuePlaceForResponse(raw: string | null | undefined): string {
  if (raw == null || !String(raw).trim()) return '';
  return formatVenueDirectoryTitle(String(raw));
}

/** Human label for booking URL (`source`) in previews. */
export function bookingSourceLabel(sourceUrl: string | null | undefined): string | null {
  if (sourceUrl == null || typeof sourceUrl !== 'string') return null;
  const u = sourceUrl.trim();
  if (!u) return null;
  const lower = u.toLowerCase();
  if (lower.includes('skedda.com')) return 'Skedda';
  if (lower.includes('picklehub.ph')) return 'PickleHub';
  try {
    const host = new URL(u).hostname.replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}
