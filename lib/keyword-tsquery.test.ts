// lib/keyword-tsquery.test.ts — drift gate for the canonical Hebrew niqqud
// pattern. Production-tokenization-mirror 2nd-recurrence floor (CHATLOG
// 2026-05-30 flag).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildKeywordTsquerySQL,
  HEBREW_COMBINING_MARKS_PATTERN,
  hebrewCombiningMarksRegex,
} from "./keyword-tsquery";

const MIGRATIONS_DIR = join(__dirname, "..", "drizzle", "migrations");

// Canonical hex of the pattern bytes — pinned here for human-readable debugging
// when a drift fires (the error then names a specific byte position).
const CANONICAL_HEX = "d6912dd6bdd6bfd7812dd782d7842dd785d787";

describe("HEBREW_COMBINING_MARKS_PATTERN — byte pin", () => {
  it("UTF-8 hex matches the canonical bytes from migration 0002", () => {
    expect(Buffer.from(HEBREW_COMBINING_MARKS_PATTERN, "utf8").toString("hex")).toBe(CANONICAL_HEX);
  });

  it("is non-empty + contains no surrogate / control / null bytes", () => {
    expect(HEBREW_COMBINING_MARKS_PATTERN.length).toBeGreaterThan(0);
    for (const ch of HEBREW_COMBINING_MARKS_PATTERN) {
      const code = ch.codePointAt(0)!;
      // ASCII hyphen `-` (U+002D) is permitted as a range operator inside the class.
      // Everything else must be in the Hebrew block (U+0590..U+05FF).
      if (code === 0x2d) continue;
      expect(code).toBeGreaterThanOrEqual(0x0590);
      expect(code).toBeLessThanOrEqual(0x05ff);
    }
  });
});

describe("hebrewCombiningMarksRegex — JS RegExp consumer", () => {
  it("matches a niqqud-bearing string", () => {
    // U+05BC DAGESH inside U+0591..U+05BD range.
    const re = hebrewCombiningMarksRegex();
    expect(re.test("עְדִיפוּת")).toBe(true);
  });

  it("does NOT match U+05BE MAQAF (compound-noun separator must survive)", () => {
    // The whole point of the non-contiguous class: maqaf is visible
    // punctuation and stripping it would corrupt compound nouns
    // (בית־ספר → ביתספר). Negative-assertion guards against a future
    // contiguous-range regression.
    const re = hebrewCombiningMarksRegex();
    expect(re.test("בית־ספר")).toBe(false);
  });

  it("does NOT match U+05C6 NUN HAFUKHA (visible punctuation, excluded by design)", () => {
    const re = hebrewCombiningMarksRegex();
    expect(re.test("׆")).toBe(false);
  });

  it("does NOT match Latin / ASCII / spaces", () => {
    const re = hebrewCombiningMarksRegex();
    expect(re.test("vendor supplier")).toBe(false);
    expect(re.test("café")).toBe(false);
  });

  it("returns a fresh RegExp each call (no shared .lastIndex state)", () => {
    const a = hebrewCombiningMarksRegex();
    const b = hebrewCombiningMarksRegex();
    expect(a).not.toBe(b);
  });
});

describe("buildKeywordTsquerySQL — SQL fragment shape", () => {
  it("wraps the param ref in the canonical pipeline shape", () => {
    const sql = buildKeywordTsquerySQL("$1");
    expect(sql).toContain("websearch_to_tsquery('simple', unaccent(regexp_replace($1, '[");
    expect(sql).toContain("]', '', 'g')))");
    // Pattern bytes are inlined verbatim from the canonical constant.
    expect(sql).toContain(HEBREW_COMBINING_MARKS_PATTERN);
  });

  it("accepts any param ref shape ($1, $8, named expression)", () => {
    expect(buildKeywordTsquerySQL("$8")).toContain("regexp_replace($8, '[");
    expect(buildKeywordTsquerySQL("NEW.body")).toContain("regexp_replace(NEW.body, '[");
  });
});

describe("MULTI-MIGRATION DRIFT GATE (production-tokenization-mirror floor)", () => {
  // Scans every .sql file in drizzle/migrations/ for `regexp_replace(...)`
  // calls whose pattern argument contains ANY character in the Hebrew block
  // (U+0590..U+05FF). Each such pattern MUST match HEBREW_COMBINING_MARKS_PATTERN
  // byte-for-byte. Adding a new migration with a different Hebrew pattern
  // fails this gate loudly — the canonical surface is lib/keyword-tsquery.ts
  // and migrations that need niqqud-strip MUST inline its content verbatim.
  //
  // Parser: matches `regexp_replace(<args>, '[<pattern>]', ...)` even when
  // `<args>` spans multiple lines and contains internal commas (e.g.,
  // `coalesce(NEW.title, '')`). Strategy: lex through the SQL byte-by-byte
  // looking for `'[` opener after a `,`, then the matching `]'`. Naive regex
  // can't handle the multi-line case (per plan-CR B3 finding 2026-06-01).
  function extractPatternsContainingHebrew(sql: string): {
    patterns: string[];
    unterminated: number;
  } {
    const patterns: string[] = [];
    // M1 code-CR fix 2026-06-01: count unterminated `'[` openings so the
    // outer test can fail loud rather than silently passing on a truncated
    // / malformed file.
    let unterminated = 0;
    // Find every `regexp_replace(` and parse forward.
    const callRe = /regexp_replace\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(sql)) !== null) {
      // From here, scan to find the first `'[` after a top-level comma. We
      // track paren depth so `coalesce(NEW.title, '')`'s comma isn't mistaken
      // for the regexp_replace arg separator.
      let i = m.index + m[0].length; // past "regexp_replace("
      let depth = 1;
      let inString = false;
      while (i < sql.length && depth > 0) {
        const ch = sql[i];
        if (inString) {
          if (ch === "'" && sql[i + 1] === "'") {
            i += 2; // SQL escaped single quote
            continue;
          }
          if (ch === "'") {
            inString = false;
          }
          i += 1;
          continue;
        }
        if (ch === "'") {
          inString = true;
          // Check if this is the `'[` pattern opener (start of pattern arg).
          if (sql[i + 1] === "[") {
            // Find matching `]'`.
            const closeIdx = sql.indexOf("]'", i + 2);
            if (closeIdx >= 0) {
              const pattern = sql.substring(i + 2, closeIdx);
              // Only flag patterns containing Hebrew-block characters.
              if (/[֐-׿]/.test(pattern)) {
                patterns.push(pattern);
              }
              i = closeIdx + 2;
              inString = false;
              continue;
            }
            // M1 fix: opening `'[` with no matching `]'` is a malformed
            // file (truncated, edited mid-statement). Count it so the
            // outer test surfaces the file with a clear diagnostic.
            unterminated += 1;
          }
          i += 1;
          continue;
        }
        if (ch === "(") depth += 1;
        if (ch === ")") depth -= 1;
        i += 1;
      }
    }
    return { patterns, unterminated };
  }

  // M2 code-CR fix 2026-06-01: extend the drift gate to scan production TS
  // files for inlined regexp_replace patterns. The shared module is the
  // single source of truth; a future contributor re-inlining the regex in
  // lib/**/*.ts would bypass the migration-only scan above. This second
  // scan catches that exact regression class.
  function extractPatternsFromTsSource(src: string): string[] {
    const hits: string[] = [];
    // Looser parser for TS: match any `regexp_replace(<anything>, '[<pattern>]'`
    // where <pattern> contains a Hebrew-block character. Both template
    // literals and plain strings are covered (the helper emits exactly this
    // shape; a stray inline would too).
    const reTs = /regexp_replace\s*\([^,]*?,\s*['"`]\s*\[([^\]]*[֐-׿][^\]]*)\]/g;
    let m: RegExpExecArray | null;
    while ((m = reTs.exec(src)) !== null) {
      hits.push(m[1]);
    }
    return hits;
  }

  it("every Hebrew-bearing regexp_replace pattern in drizzle/migrations/*.sql matches the canonical constant", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(0); // sanity: migrations exist
    const allMismatches: Array<{ file: string; pattern: string; hex: string }> = [];
    const allUnterminated: Array<{ file: string; count: number }> = [];
    let totalPatterns = 0;
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      const { patterns, unterminated } = extractPatternsContainingHebrew(sql);
      if (unterminated > 0) allUnterminated.push({ file, count: unterminated });
      for (const pattern of patterns) {
        totalPatterns += 1;
        if (pattern !== HEBREW_COMBINING_MARKS_PATTERN) {
          allMismatches.push({
            file,
            pattern,
            hex: Buffer.from(pattern, "utf8").toString("hex"),
          });
        }
      }
    }
    // M1 code-CR fix 2026-06-01: surface unterminated `'[` openings explicitly
    // so a malformed migration file fails loud rather than being silently
    // skipped + masked by the positive-control on other files.
    expect(
      allUnterminated,
      `unterminated regexp_replace pattern openings detected: ${JSON.stringify(allUnterminated, null, 2)}`,
    ).toEqual([]);
    expect(
      allMismatches,
      `drift detected: migrations contain a Hebrew-bearing regex pattern that does not match HEBREW_COMBINING_MARKS_PATTERN. expected hex: ${CANONICAL_HEX}. found: ${JSON.stringify(allMismatches, null, 2)}`,
    ).toEqual([]);
    // Positive control: we must have found at least one match (migration 0002).
    // A future maintenance edit that DROPS the niqqud-strip from migration 0002
    // would silently pass an empty-set check; the positive control distinguishes
    // "no drift" from "no patterns scanned at all".
    expect(totalPatterns).toBeGreaterThan(0);
  });

  it("no production TS file under lib/ inlines a Hebrew-bearing regexp_replace pattern (M2 code-CR fix)", () => {
    // The shared module lib/keyword-tsquery.ts is the single source of truth;
    // every production caller MUST route through buildKeywordTsquerySQL or
    // hebrewCombiningMarksRegex. A future contributor re-inlining a literal
    // regex pattern in lib/**/*.ts would bypass the migration-only scan and
    // silently re-create today's drift class. This gate catches that
    // regression at test time.
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip nested node_modules (defensive; should not exist under lib/).
          if (entry.name === "node_modules") continue;
          out.push(...walk(full));
        } else if (
          entry.isFile() &&
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts")
        ) {
          out.push(full);
        }
      }
      return out;
    }
    const libDir = join(__dirname, "..", "lib");
    const tsFiles = walk(libDir).filter(
      // Allow the canonical source file to hold the pattern in its constant.
      (p) => !p.endsWith(`${"keyword-tsquery"}.ts`),
    );
    expect(tsFiles.length).toBeGreaterThan(0); // sanity: lib has TS files
    const inlineHits: Array<{ file: string; pattern: string }> = [];
    for (const file of tsFiles) {
      const src = readFileSync(file, "utf8");
      const patterns = extractPatternsFromTsSource(src);
      for (const pattern of patterns) {
        inlineHits.push({ file: file.replace(libDir, "lib"), pattern });
      }
    }
    expect(
      inlineHits,
      `production TS file inlines a Hebrew regex pattern instead of using buildKeywordTsquerySQL/hebrewCombiningMarksRegex from lib/keyword-tsquery.ts. found: ${JSON.stringify(inlineHits, null, 2)}`,
    ).toEqual([]);
  });

  it("scanner correctly handles multi-line regexp_replace calls (B3 plan-CR repro)", () => {
    // Sanity check on the parser: a regexp_replace whose first arg is a
    // multi-line `coalesce(NEW.title, '') || ...` block (as migration 0002
    // actually has) must still extract the pattern correctly. A naive
    // /regexp_replace\([^,]+, '\[([^\]]+)\]'/ regex would capture the comma
    // inside coalesce — this fixture proves the depth-aware scanner works.
    const fixture = `
      CREATE FUNCTION x() RETURNS trigger AS $$
      BEGIN
        NEW.tsv := to_tsvector('simple', unaccent(
          regexp_replace(
            coalesce(NEW.title, '') || ' '
            || array_to_string(NEW.tags, ' '),
            '[${HEBREW_COMBINING_MARKS_PATTERN}]',
            '',
            'g'
          )
        ));
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `;
    const { patterns, unterminated } = extractPatternsContainingHebrew(fixture);
    expect(unterminated).toBe(0);
    expect(patterns).toEqual([HEBREW_COMBINING_MARKS_PATTERN]);
  });
});
