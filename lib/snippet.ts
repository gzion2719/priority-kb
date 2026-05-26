// lib/snippet.ts — citation-preview snippet projection helpers (M4 #6).
//
// Two concerns this module isolates from the orchestrator:
//   1. stripSynthRepPrefix — keyword-only entries enter `boundaries[].body`
//      as `synthesizeKeywordOnlyRepresentative(title, body)` which prepends
//      `# ${title}\n` (lib/retrieval-rerank-input.ts:128). The citation
//      card already shows the title above the hover preview, so leaving
//      the prefix in the snippet would double the title in the UI. Strip
//      it when present; pass through unchanged for ANN-best-chunk bodies
//      that never carried the prefix.
//   2. safeSnippetSlice — cap the snippet at N chars + ellipsis, backing
//      off the cut so it never lands in the middle of a Unicode combining
//      sequence (Hebrew niqqud, vowel marks) or a UTF-16 surrogate pair.
//      ADR-0009 stores entries.body as post-scrub NFC; NFC does NOT
//      compose niqqud onto base letters (they remain separate code points
//      U+05B0-U+05C7), so a naïve `.slice(0, 240)` can split a base+mark
//      pair and render an orphan base on the snippet edge.
//
// Used at lib/retrieval-pipeline.ts at the candidates-event emission site.
// v1 cap is 240 chars (~2-4 sentences in either Hebrew or English); see
// ADR-0012 Amendment 2026-05-26 §"Candidates wire-shape extension".

export const CANDIDATE_SNIPPET_MAX_CHARS = 240;
export const SNIPPET_ELLIPSIS = "…";

/**
 * Strip the `# ${title}\n` prefix from a body string when present.
 *
 * Keyword-only entries enter `boundaries[].body` with this prefix
 * (lib/retrieval-rerank-input.ts `synthesizeKeywordOnlyRepresentative`).
 * ANN-best-chunk bodies never carry it. The check is exact-match against
 * the entry's own title — a regression that stripped any leading `# …\n`
 * line would silently delete real h1 markdown from a chunk.
 */
export function stripSynthRepPrefix(body: string, title: string): string {
  const prefix = `# ${title}\n`;
  return body.startsWith(prefix) ? body.slice(prefix.length) : body;
}

/**
 * Slice `body` to at most `maxChars` chars; append "…" when truncated.
 *
 * Backs off the cut to avoid two failure modes:
 *  - Splitting a Unicode combining sequence (mark category `\p{M}`). The
 *    only concern is visual integrity at the snippet edge: leaving a base
 *    letter on the edge with its niqqud dropped is acceptable; leaving a
 *    base letter on the edge with the NEXT char being a mark would mean
 *    we kept the base but dropped its diacritic — back off one more so
 *    we drop the base too and the snippet ends on a clean grapheme.
 *  - Orphaning a UTF-16 high surrogate. If `body.charCodeAt(cut-1)` is
 *    a high surrogate (0xD800-0xDBFF) we'd keep half of a surrogate pair;
 *    back off one more.
 */
export function safeSnippetSlice(
  body: string,
  maxChars: number = CANDIDATE_SNIPPET_MAX_CHARS,
): string {
  if (body.length <= maxChars) return body;
  let cut = maxChars;
  // Back off while the next char (the one we'd drop first) is a mark —
  // this means the kept tail ends on a base whose diacritic we're about
  // to lose. Back off to drop base + mark together. `charAt` returns ""
  // for out-of-bounds positions (which `\p{M}` does not match) so the
  // loop terminates cleanly on a pathological all-marks body without a
  // non-null assertion.
  while (cut > 0 && /\p{M}/u.test(body.charAt(cut))) cut--;
  // Back off if the kept tail ends in a high surrogate (unpaired half).
  if (cut > 0) {
    const lastKept = body.charCodeAt(cut - 1);
    if (lastKept >= 0xd800 && lastKept <= 0xdbff) cut--;
  }
  return body.slice(0, cut) + SNIPPET_ELLIPSIS;
}

/**
 * Compose the two transformations in the order the orchestrator needs:
 * strip the synth-rep prefix BEFORE capping. Slice-then-strip would cap
 * the prefix-bearing body to 240 chars (keeping the title-line bytes)
 * and only then strip — yielding a shorter user-visible snippet for no
 * benefit. Strip-then-slice gives the user 240 chars of actual content.
 */
export function projectCandidateSnippet(
  body: string,
  title: string,
  maxChars: number = CANDIDATE_SNIPPET_MAX_CHARS,
): string {
  return safeSnippetSlice(stripSynthRepPrefix(body, title), maxChars);
}
