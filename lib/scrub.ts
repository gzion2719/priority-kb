// lib/scrub.ts — M2a simple PII scrub.
//
// Runs at ingest, BEFORE `entries.body` is written (ADR-0009 §5). Iron rule
// note: there is no `body_raw` column; raw PII is not retained. M2b will
// replace this with the stronger pass that handles customer names, prices,
// vendor IDs per ROADMAP M2b.
//
// Conservative-by-design: false positives ([redacted] on a non-PII token)
// are preferable to false negatives (real PII reaching disk). Patterns are
// scoped to the three M2a categories named in ROADMAP M2a line 42.
//
// Monotonic: scrub is one-way (ADR-0009 §7). Re-running scrub on already-
// scrubbed text is a no-op for the patterns below.

/** Replacement tokens. Stable strings; chunk offsets care about lengths. */
export const EMAIL_TOKEN = "[email]";
export const PHONE_TOKEN = "[phone]";
export const ID_TOKEN = "[id]";

// Email — RFC 5322 lite. Required `.` + TLD ≥ 2 letters; rejects bare
// `a@b` (which is technically valid but is overwhelmingly noise in
// Priority bodies). `\b` boundaries keep multi-word lines intact.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Phone — three concrete shapes Israeli admins paste from tickets. Each
// shape REQUIRES a structural marker (a leading `+` country code, or a
// leading `0` local prefix) so we never compete with the bare-digit ID
// pass below. Word boundaries on both ends prevent eating into SKUs.
//
//   +country grouped: +972-50-1234567 / +1 (415) 555-1234 / +44 20 7946 0958
//   local grouped:    050-1234567 / 03-9123456
//   local solid:      0501234567
const PHONE_RES: ReadonlyArray<RegExp> = [
  // +country: leading +, 1-3 digit country, then 7-13 more digits with
  // separators. `(?!\w)` rejects "+12abc".
  /\+\d{1,3}(?:[-.\s]?\(?\d{1,4}\)?){1,4}[-.\s]?\d{2,4}(?!\w)/g,
  // local solid: 10-digit IL mobile starting with 0, bare.
  /(?<!\w)0\d{9}(?!\w)/g,
  // local grouped: 0XX-NNNNNNN, 03-NNNNNNN, etc. Requires at least one
  // separator so it doesn't collide with the solid form.
  /(?<!\w)0\d{1,2}[-.\s]\d{3,4}[-.\s]?\d{3,4}(?!\w)/g,
];

// ID — standalone digit run of 7–12, not adjacent to other word chars and
// not preceded by `+` (which would make it part of a phone country code).
// Israeli teudat zehut is 9 digits; passport variants vary.
const ID_RE = /(?<![\w+])\d{7,12}(?![\w])/g;

/**
 * Scrub PII from a body string. Order matters: email → phone → ID. The
 * phone pass uses a permissive regex with a post-filter so we don't blanket-
 * rewrite numeric sequences; the ID pass runs after phone so multi-group
 * phone numbers (which contain ID-length digit runs) don't get the wrong
 * token.
 *
 * Returns the scrubbed body. The returned string MUST be the value stored
 * in `entries.body` so chunk offsets (which index post-scrub) remain valid.
 */
export function scrubPii(body: string): string {
  let out = body.replace(EMAIL_RE, EMAIL_TOKEN);
  for (const re of PHONE_RES) {
    out = out.replace(re, PHONE_TOKEN);
  }
  out = out.replace(ID_RE, ID_TOKEN);
  return out;
}
