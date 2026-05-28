/**
 * Flat slot-row shape returned to the chat UI. Mirrors what
 * `apps/web/src/app/chat/search-data-preview.tsx` consumes — the FE treats
 * `id` / `slot_id` as opaque, so using the bigint primary keys (numbers) is fine.
 */
export type SlotRow = {
  /** Court id (bigint from public.courts). */
  id: number;
  name: string | null;
  location: string | null;
  source: string | null;
  /** Court-level price (slots table has no price column). */
  price: number | null;
  /** Slot id (bigint from public.slots). */
  slot_id: number;
  datetime: string | null;
  datetime_end: string | null;
  time_slot: string | null;
  /** Effective booking URL — slot-level when present, otherwise court-level. */
  booking_url: string | null;
  /** Original court-level booking URL (used by FE for fallback rendering). */
  court_booking_url: string | null;
  /** Original slot-level booking URL. */
  slot_booking_url: string | null;
  /** Optional Skedda space id (carried through for debugging / future use). */
  skedda_space_id: string | null;
  available: boolean | null;
};

export type SearchToolArgs = {
  location?: string;
  manilaDate?: string;
  /** Manila local start time HH:MM (24h), inclusive — e.g. 13:00 for 1pm. */
  manilaTimeFrom?: string;
  /** Manila local end time HH:MM (24h), exclusive — e.g. 18:00 for 6pm. */
  manilaTimeTo?: string;
  datetime?: string;
};

export type AgentMeta = {
  search?: SearchToolArgs;
  hint?: string;
};

export type ChatTurn = { role: 'user' | 'assistant' | 'system'; content: string };

export type AgentResponse = {
  message: string;
  data?: SlotRow[];
  meta?: AgentMeta;
};
