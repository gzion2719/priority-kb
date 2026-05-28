// lib/caption.ts — display-only entry caption derivation (M2b #7 / ADR-0023 D1).
//
// A caption is a short human-readable label for an entry, shown on the
// entry-detail page. Per ADR-0023:
//   - DISPLAY-ONLY: never embedded, never chunked, never added to the
//     keyword-search tsvector. It adds ~zero retrieval value (it is a
//     substring of the body, which is already embedded + indexed) and the
//     point is the citation/detail surface, not recall.
//   - Derived from the POST-PII-scrub canonical body (`entries.body`), never
//     from raw OCR output — deriving from raw OCR would surface PII the scrub
//     removed (iron rule #6). The write path (lib/ingest.ts) calls this with
//     `derived.canonicalBody`, which is already `scrubPii(...).normalize("NFC")`.
//   - Heuristic: the first non-empty line of the body, grapheme-safe-clipped.
//     A richer role-aware caption (Azure `prebuilt-layout` heading roles) is a
//     deferred upgrade gated in ADR-0023 D4.
//
// No-throw contract (load-bearing — see ADR-0023 D5 / Step 7b Q9): this
// function is TOTAL. It never throws on any string input and returns `null`
// when the body has no non-empty line. A display-only caption must never be
// able to regress the critical ingest write path; the write path already
// rejects an empty post-scrub body upstream (EmptyBodyAfterScrubError), so in
// practice the `null` return is the whitespace-only safety net, not a hot path.

import { safeSnippetSlice } from "@/lib/snippet";

// Display clip for the caption. Distinct from the citation-snippet cap
// (CANDIDATE_SNIPPET_MAX_CHARS = 240): a caption is a one-line label, not a
// multi-sentence preview, so it is tighter.
export const CAPTION_DISPLAY_CLIP_CHARS = 160;

/**
 * Derive a display-only caption from a post-scrub canonical body.
 *
 * Returns the first non-empty line of `body`, trimmed and grapheme-safely
 * clipped to {@link CAPTION_DISPLAY_CLIP_CHARS} (re-using `safeSnippetSlice`
 * so the cut never splits a Hebrew niqqud combining sequence or a UTF-16
 * surrogate pair, appending "…" when truncated).
 *
 * Returns `null` when no non-empty line exists (whitespace-only body).
 *
 * Line splitting uses `/\r?\n/` so CRLF bodies (Windows-pasted text, OCR
 * flatten) don't leave a trailing `\r` on the extracted line; the per-line
 * `.trim()` also strips any stray `\r`.
 *
 * TOTAL function — never throws. See module header no-throw contract.
 */
export function deriveCaption(body: string): string | null {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length > 0) {
      // Clip the extracted LINE, never the whole body — a short first line
      // followed by a long remainder must yield just the short line.
      return safeSnippetSlice(line, CAPTION_DISPLAY_CLIP_CHARS);
    }
  }
  return null;
}
