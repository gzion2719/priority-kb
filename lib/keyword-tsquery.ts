// lib/keyword-tsquery.ts — canonical Hebrew niqqud-strip + keyword-tsquery
// normalization pipeline.
//
// 2nd-recurrence floor for the production-tokenization-mirror class (codified
// SESSION_PROTOCOL.md Step 7 sub-rule 2026-05-22). Before this module existed,
// the niqqud-strip character class was hand-written across FOUR production
// surfaces (plus a test-side hex pin):
//
//   1. drizzle/migrations/0002_unaccent_tsv_trigger.sql:43 (index-side trigger)
//   2. lib/retrieval-keyword.ts:68 (retrieval keyword lane) — DRIFTED, used
//      contiguous `[֑-ׇ]` which INCLUDED U+05BE MAQAF; Hebrew compound nouns
//      like בית־ספר silently mismatched the index.
//   3. lib/entries.ts (admin list keyword search) — parallel correct copy
//      with a KEEP-IN-SYNC comment explicitly anticipating this extraction.
//   4. lib/tags.ts NIQQUD_RE (D9 tag validation; JS RegExp)
//
// The test-side pin at lib/entries.test.ts now imports HEBREW_COMBINING_MARKS_PATTERN
// and derives the expected hex from this module (m1 code-CR fix 2026-06-01),
// so the canonical pattern has exactly ONE source of truth post-extraction.
//
// This module consolidates all of them via:
//
//   - HEBREW_COMBINING_MARKS_PATTERN — the canonical character class as a
//     UTF-8 string, byte-identical to migration 0002's regex content.
//   - buildKeywordTsquerySQL(paramRef) — full SQL fragment for the normalization
//     pipeline (regexp_replace niqqud-strip → unaccent → websearch_to_tsquery).
//   - hebrewCombiningMarksRegex() — JS RegExp consumer of the same pattern,
//     for client-side validators (lib/tags.ts D9 validation).
//
// Mechanical floor: `lib/keyword-tsquery.test.ts` reads ALL files in
// drizzle/migrations/*.sql, extracts every regexp_replace pattern containing
// any U+0590..U+05FF character, and asserts each matches HEBREW_COMBINING_MARKS_PATTERN.
// Future drift in any direction fails loudly at test time.
//
// Why the pattern excludes what it excludes (ADR-0013 §2.1 + migration 0002
// header comment): the class is the non-contiguous union of the
// combining-mark subranges in the Hebrew block (U+0591..U+05C7), explicitly
// EXCLUDING U+05BE MAQAF, U+05C0 PASEQ, U+05C3 SOF PASUQ, U+05C6 NUN HAFUKHA.
// Those four code points are visible punctuation, not combining marks;
// stripping the maqaf (U+05BE) silently corrupts compound nouns:
// בית־ספר → ביתספר, which then mismatches the index's `{בית, ספר}` tokens.

/**
 * The canonical Hebrew combining-marks character class — the content between
 * `[` and `]` in the regex literal `/[<pattern>]/`. Byte-identical to migration
 * 0002's `regexp_replace(..., '[<pattern>]', '', 'g')` pattern argument.
 *
 * Hex breakdown (use this for human-readable debugging on drift):
 *   d691 (U+0591) -- start of combining marks
 *   2d (-)
 *   d6bd (U+05BD)
 *   d6bf (U+05BF) -- single (U+05BE MAQAF excluded)
 *   d781 (U+05C1)
 *   2d (-)
 *   d782 (U+05C2) -- end (U+05C0 PASEQ, U+05C3 SOF PASUQ excluded)
 *   d784 (U+05C4)
 *   2d (-)
 *   d785 (U+05C5) -- end (U+05C6 NUN HAFUKHA excluded)
 *   d787 (U+05C7) -- single
 *
 * Full hex: `d6912dd6bdd6bfd7812dd782d7842dd785d787`
 */
export const HEBREW_COMBINING_MARKS_PATTERN = "֑-ֽֿׁ-ׂׄ-ׇׅ";

/**
 * Build the canonical keyword-tsquery normalization SQL fragment for a given
 * parameter reference (e.g., `$1`, `$8`). Mirrors the index-side trigger in
 * migration 0002 exactly so query-side lexemes match index-side lexemes.
 *
 * Output shape: `websearch_to_tsquery('simple', unaccent(regexp_replace(<paramRef>, '[<pattern>]', '', 'g')))`
 *
 * Callers paste this into a SQL template and bind the actual query string to
 * the named parameter. The pattern bytes are interpolated from
 * HEBREW_COMBINING_MARKS_PATTERN — there are no per-caller regex literals.
 *
 * **paramRef MUST be a parameter binding reference (e.g., `$1`, `$8`) or a
 * trusted column reference, NEVER user input.** This function does string
 * interpolation; passing a user-supplied value here would produce a SQL
 * injection surface. The empty-string guard below catches the most common
 * misuse (forgot to compute the param index) but cannot detect injection.
 */
export function buildKeywordTsquerySQL(paramRef: string): string {
  // m2 code-CR fix 2026-06-01: a defensive guard so an empty/whitespace
  // paramRef produces a clear TypeError at call time, not a syntactically-
  // broken SQL string discovered later at query time.
  if (paramRef.trim() === "") {
    throw new TypeError(
      "buildKeywordTsquerySQL: paramRef must be a non-empty parameter reference (e.g., '$1')",
    );
  }
  return `websearch_to_tsquery('simple', unaccent(regexp_replace(${paramRef}, '[${HEBREW_COMBINING_MARKS_PATTERN}]', '', 'g')))`;
}

/**
 * JS RegExp built from the canonical pattern — for client-side validators
 * (e.g., lib/tags.ts D9 tag validation rejects tags containing any of these
 * marks). Returns a fresh RegExp each call so callers don't share `.lastIndex`
 * state across modules (`g` flag intentionally omitted; this regex is used
 * with `.test()` for membership checks, not iteration).
 */
export function hebrewCombiningMarksRegex(): RegExp {
  return new RegExp(`[${HEBREW_COMBINING_MARKS_PATTERN}]`);
}
