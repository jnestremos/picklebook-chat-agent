'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatVenueDirectoryTitle } from './venue-display';
import styles from './chat.module.css';

export type CourtLocationGroup = {
  location: string;
  court_count: number;
  court_names: string | null;
};

const NO_LOCATION_LABEL = '(No location)';
const NAME_SEP = ' · ';

function splitCourtLabels(s: string | null | undefined): string[] {
  if (!s?.trim()) return [];
  return s
    .split(NAME_SEP)
    .map((p) => p.trim())
    .filter(Boolean);
}

function isSkeddaSpaceLabel(label: string): boolean {
  return /^Space\s+\d+$/i.test(label.trim());
}

/** One-line suffix after "N courts ·" — avoids repeating every Skedda space id. */
function detailSuffixFromNames(court_names: string): string {
  const parts = splitCourtLabels(court_names);
  if (parts.length === 0) return '';

  if (parts.every(isSkeddaSpaceLabel)) {
    return '';
  }

  const namedParts = parts.filter((p) => !isSkeddaSpaceLabel(p));
  const skeddaParts = parts.filter(isSkeddaSpaceLabel);

  if (skeddaParts.length === 0) {
    const maxShow = 4;
    if (parts.length <= maxShow) return parts.join(NAME_SEP);
    return `${parts.slice(0, 3).join(NAME_SEP)} · +${parts.length - 3} more`;
  }

  const maxNamed = 2;
  const head = namedParts.slice(0, maxNamed).join(NAME_SEP);
  const namedMore = namedParts.length - maxNamed;
  const sk = `${skeddaParts.length} space${skeddaParts.length === 1 ? '' : 's'} (IDs)`;
  if (namedMore > 0) return `${head} · +${namedMore} · ${sk}`;
  if (namedParts.length === 0) return sk;
  return `${head} · ${sk}`;
}

/** Subtitle when a single row has exactly one court name to show. */
function singleCourtMeta(court_names: string | null | undefined): string {
  const t = court_names?.trim();
  if (!t) return '';
  const m = /^Space\s+(\d+)$/i.exec(t);
  if (m) return `Space ${m[1]}`;
  return t;
}

function phraseForMessage(row: CourtLocationGroup): string {
  if (row.location === NO_LOCATION_LABEL) {
    const first = splitCourtLabels(row.court_names)[0];
    return first ?? row.location;
  }
  return formatVenueDirectoryTitle(row.location);
}

function detailLine(row: CourtLocationGroup): string | null {
  if (row.court_count <= 1) return null;
  const names = row.court_names?.trim();
  if (!names) return `${row.court_count} courts`;
  const suffix = detailSuffixFromNames(names);
  return suffix
    ? `${row.court_count} courts · ${suffix}`
    : `${row.court_count} courts`;
}

type Props = {
  apiBase: string;
  onInsertVenue: (phrase: string) => void;
  /** Bump this number to force a re-fetch (driven by the realtime pulse). */
  refreshKey?: number;
};

export function CourtDirectoryPanel({ apiBase: base, onInsertVenue, refreshKey }: Props) {
  const [rows, setRows] = useState<CourtLocationGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`${base}/api/courts/locations`);
      const json = (await res.json()) as {
        locations?: CourtLocationGroup[];
        error?: string;
      };
      if (!res.ok) {
        setErr(json.error ?? `HTTP ${res.status}`);
        setRows([]);
        return;
      }
      setRows(Array.isArray(json.locations) ? json.locations : []);
    } catch {
      setErr('Could not load locations');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <section
      className={`${styles.courtDirectory} ${panelOpen ? '' : styles.courtDirectoryCollapsed}`}
      aria-label="Court locations from database"
    >
      <div className={styles.courtDirectoryHeader}>
        <button
          type="button"
          className={styles.courtDirectoryToggle}
          aria-expanded={panelOpen}
          aria-controls="court-directory-panel"
          id="court-directory-toggle"
          onClick={() => setPanelOpen((x) => !x)}
        >
          <span className={styles.courtDirectoryCaret} aria-hidden>
            {panelOpen ? '▼' : '▶'}
          </span>
          <span className={styles.courtDirectoryTitle}>
            Locations (grouped)
          </span>
        </button>
        <button
          type="button"
          className={styles.courtDirectoryRefresh}
          onClick={() => void load()}
        >
          Refresh
        </button>
      </div>
      <div
        id="court-directory-panel"
        className={
          panelOpen
            ? styles.courtDirectoryPanelBody
            : `${styles.courtDirectoryPanelBody} ${styles.courtDirectoryPanelBodyCollapsed}`
        }
        aria-labelledby="court-directory-toggle"
        aria-hidden={!panelOpen}
      >
        {err ? <p className={styles.courtDirectoryError}>{err}</p> : null}
        {loading && rows.length === 0 ? (
          <p className={styles.courtDirectoryMuted}>Loading…</p>
        ) : null}
        {!loading && rows.length === 0 && !err ? (
          <p className={styles.courtDirectoryMuted}>
            No courts in Supabase yet—run a sync first.
          </p>
        ) : null}
        {rows.length > 0 ? (
          <ul className={styles.courtDirectoryScroll}>
            {rows.map((row) => {
              const phrase = phraseForMessage(row);
              const detail = detailLine(row);
              const titleShown = formatVenueDirectoryTitle(row.location);

              return (
                <li key={row.location}>
                  <button
                    type="button"
                    className={styles.courtDirectoryRow}
                    onClick={() => onInsertVenue(phrase)}
                    title={`Insert “${phrase}” into message`}
                  >
                    <span className={styles.courtDirectoryRowMain}>
                      {titleShown}
                    </span>
                    {detail ? (
                      <span className={styles.courtDirectoryRowMeta}>
                        {detail}
                      </span>
                    ) : row.court_count === 1 && row.court_names ? (
                      <span className={styles.courtDirectoryRowMeta}>
                        {singleCourtMeta(row.court_names)}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
