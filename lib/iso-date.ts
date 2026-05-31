// lib/iso-date.ts — date helpers for the M4 #2 admin entry editor.
//
// Bridges `<input type="date">` (which always returns "YYYY-MM-DD" or "")
// to the ISO 8601 with-offset shape required by IngestBody.last_verified_at
// (Zod `.datetime({ offset: true })`). Two representable choices when
// converting date-only → datetime:
//
//   (a) Emit UTC midnight:                "${YYYY-MM-DD}T00:00:00.000Z"
//   (b) Emit local-midnight with offset:  "${YYYY-MM-DD}T00:00:00±HH:MM"
//
// We pick (b). Rationale: the admin's intent for "I verified this on
// 2026-05-31" is local-calendar-day; (a) collapses an IDT input to UTC
// previous-day 21:00, which (i) loses the calendar-day intent and
// (ii) shows as a different date when re-rendered in a different tz.
// Emitting with the admin's local offset preserves the user-intended
// calendar day across re-renders.
//
// Zod 3.23's `.datetime({ offset: true })` accepts both `Z` and `±HH:MM`
// as valid offset designators; this module always emits `±HH:MM`.

const YYYY_MM_DD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Convert a browser `<input type="date">` value to ISO 8601 with the
 * admin's local timezone offset. Throws RangeError on a malformed input
 * (the input element guarantees the shape, so a throw surfaces a caller
 * bug — not user input — and should never reach the user in practice).
 */
export function toIsoWithLocalOffset(yyyyMmDd: string): string {
  const m = YYYY_MM_DD_RE.exec(yyyyMmDd);
  if (!m) throw new RangeError(`expected YYYY-MM-DD, got ${JSON.stringify(yyyyMmDd)}`);
  const [, year, month, day] = m;
  // Local-midnight Date so getTimezoneOffset returns the offset that
  // applies on that calendar day (DST-aware).
  const localMidnight = new Date(Number(year), Number(month) - 1, Number(day));
  // getTimezoneOffset returns minutes WEST of UTC; flip sign for ISO
  // (which encodes minutes EAST of UTC).
  const offsetMin = -localMidnight.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${year}-${month}-${day}T00:00:00${sign}${hh}:${mm}`;
}

/**
 * Convert an ISO 8601 datetime (as stored in `entries.last_verified_at`,
 * surfaced to JS as a `Date`) to the "YYYY-MM-DD" shape consumed by
 * `<input type="date">`. The conversion uses the LOCAL calendar day —
 * mirroring `toIsoWithLocalOffset`'s round-trip contract.
 */
export function toDateInputValue(d: Date): string {
  const year = String(d.getFullYear()).padStart(4, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
