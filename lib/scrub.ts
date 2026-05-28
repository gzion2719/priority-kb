// lib/scrub.ts — PII scrub. M2a categories (email/phone/id) + M2b stronger
// pass (price, label-anchored vendor/customer id). Customer NAMES remain
// out of scope: NER-hard, deferred per ADR-0024 + ROADMAP M2b #8 (BACKLOG).
//
// Runs at ingest, BEFORE `entries.body` is written (ADR-0009 §5). Iron rule
// note: there is no `body_raw` column; raw PII is not retained. This is the
// SINGLE choke point all bodies pass through — both M2a text ingest and the
// M2b worker-extracted (parsed/OCR'd) path delegate here via
// `lib/ingest.ts::deriveChunksAndEmbeddings` (ADR-0021 Option Y: the Python
// worker has no embed/write surface, so there is no second scrub to keep in
// sync). See ADR-0024.
//
// Conservative-by-design: false positives ([redacted] on a non-PII token)
// are preferable to false negatives (real PII reaching disk).
//
// Monotonic: scrub is one-way (ADR-0009 §7). Re-running scrub on already-
// scrubbed text is a no-op — every replacement token contains no digit,
// currency marker, or label that any pattern below can re-match.

/** Replacement tokens. Stable strings; chunk offsets care about lengths. */
export const EMAIL_TOKEN = "[email]";
export const PHONE_TOKEN = "[phone]";
export const ID_TOKEN = "[id]";
export const PRICE_TOKEN = "[price]";

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

// Price — a number with a currency marker adjacent on EITHER side. The
// currency marker (symbol or 3-letter ISO code) is mandatory so bare numbers
// (versions, error codes, quantities, years) survive untouched — the marker
// is what distinguishes a price from any other digit run.
//
// Number core `\d(?:[\d.,]{0,18}\d)?` accepts grouped (`1,234.50`), European
// (`1.234,56`), and separator-less (`1500`, common in OCR) runs, and always
// ENDS on a digit so a trailing sentence period / comma is not eaten. The
// `{0,18}` bound on the inner run is NOT cosmetic: the two suffix patterns
// assert the currency marker only after the number core, so on a long
// marker-less digit blob (an OCR'd invoice table) an unbounded core re-scans
// from every offset → O(N²). Bounding the core to a realistic price length
// keeps every pattern linear.
//
// Symbols: ₪ $ € £ — matched by literal adjacency (`\s?` allows one optional
// space). A `\b` word boundary does NOT assert between a space and `₪`/`$`
// (non-word chars), so `\b`-anchoring would silently miss `50 ₪` — adjacency
// matching is required. Codes: NIS/ILS/USD/EUR/GBP, case-insensitive,
// `\b`-bounded on the letter side (a word boundary DOES apply to letters).
const PRICE_RES: ReadonlyArray<RegExp> = [
  // symbol prefix: ₪1,500 / $99.99 / €1.234,56 / £50
  /[₪$€£]\s?\d(?:[\d.,]{0,18}\d)?/g,
  // symbol suffix: 50 ₪ / 1500₪
  /\d(?:[\d.,]{0,18}\d)?\s?[₪$€£]/g,
  // code prefix: ILS 1500 / NIS1234
  /\b(?:NIS|ILS|USD|EUR|GBP)\s?\d(?:[\d.,]{0,18}\d)?/gi,
  // code suffix: 1,234.50 NIS / 99USD
  /\d(?:[\d.,]{0,18}\d)?\s?(?:NIS|ILS|USD|EUR|GBP)\b/gi,
];

// Vendor / customer ID — Priority stores these as a CHAR(16) free-form key
// (shown on the Hebrew form columns "מס. לקוח" / "מס. ספק"). The value cannot
// be matched by shape — a 16-char free-form key collides with everything — so
// the redaction is LABEL-ANCHORED: match the Hebrew label, then redact the
// adjacent value token. The value capture is ASCII-alphanumeric (plus -_/),
// which (a) matches the real key shape and (b) stops at a following Hebrew
// word, so "מס. לקוח חדש נוצר" ("customer no. new created") is NOT redacted.
// Separator includes `\s*` so an OCR line break between label and value is
// tolerated. The regex operates on byte/logical order (label first), which
// is what OCR emits regardless of RTL visual rendering; a value that appears
// before its label in *logical* order is NOT handled — shape-matching the
// value to recover that would flood false positives. See ADR-0024.
//
// Capture group 1 is the label+separator (preserved); the value after it is
// replaced with ID_TOKEN. Runs AFTER the ID pass would otherwise see the
// value, but BEFORE it in scrubPii order so an alphanumeric value (e.g.
// `C-1024`, which the bare ID pass cannot catch) is still redacted.
//
// The value run is unbounded (`*`, not `{0,15}`): the real key is CHAR(16),
// but the whole captured run is replaced anyway, so bounding it would leave
// the trailing digits of an over-length OCR'd value (e.g. a 20-digit blob)
// un-redacted — the bare ID pass can't recover them (they sit adjacent to
// the `]` of the inserted `[id]`). Redacting the whole adjacent run is the
// conservative-over-leak choice. The run is a flat greedy class (no nested
// quantifier) so it stays linear.
const VENDOR_LABEL_RE =
  /((?:מס['׳.]?|מספר)\s*(?:לקוח|ספק)\s*[:\-]?\s*)([A-Za-z0-9][A-Za-z0-9\-_/]*)/g;

/**
 * Scrub PII from a body string. Order matters: email → phone → price →
 * vendor-label → ID.
 *
 * - phone before price/ID: a permissive phone regex with structural markers
 *   so we don't blanket-rewrite numeric sequences.
 * - price before vendor-label and ID: a currency-adjacent digit run becomes
 *   `[price]` rather than `[id]`, and the price token is removed before the
 *   ID pass would treat its digits as an identifier.
 * - vendor-label before ID: a label-anchored value is redacted (incl.
 *   alphanumeric keys the bare ID pass cannot catch); a purely numeric value
 *   is redacted here too, so the trailing ID pass is a no-op on it.
 *
 * Returns the scrubbed body. The returned string MUST be the value stored
 * in `entries.body` so chunk offsets (which index post-scrub) remain valid.
 */
export function scrubPii(body: string): string {
  let out = body.replace(EMAIL_RE, EMAIL_TOKEN);
  for (const re of PHONE_RES) {
    out = out.replace(re, PHONE_TOKEN);
  }
  for (const re of PRICE_RES) {
    out = out.replace(re, PRICE_TOKEN);
  }
  out = out.replace(VENDOR_LABEL_RE, (_m, labelAndSep: string) => labelAndSep + ID_TOKEN);
  out = out.replace(ID_RE, ID_TOKEN);
  return out;
}
