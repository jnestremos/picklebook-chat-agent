/** Venues per page when the user did not name a specific venue. */
export const VENUE_PAGE_SIZE = 5;

export function venueLocationFromRow(row: { location?: string | null }): string {
  const loc = row.location?.trim();
  return loc || '(No location)';
}

/** Unique venue locations in first-seen order (preserves search ranking). */
export function orderedVenueLocationsInRank<T extends { location?: string | null }>(
  rows: T[],
): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const row of rows) {
    const loc = venueLocationFromRow(row);
    if (!seen.has(loc)) {
      seen.add(loc);
      order.push(loc);
    }
  }
  return order;
}
