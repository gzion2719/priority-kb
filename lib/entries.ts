// lib/entries.ts — M3 item 5 data access for entry detail page.
//
// `findEntryForRole(pool, id, role)` is the single function the read-only
// `/entries/[id]` page uses to fetch a row. It is the iron-rule-#6
// enforcement point for the page surface: sensitivity is compiled into
// the SQL WHERE (never post-hoc-filtered), and every auth-failure or
// existence-failure mode collapses to the SAME `null` return so the
// page can `notFound()` without leaking which mode tripped.
//
// Existence-leak side channels closed at this layer:
//   - role === null (no/unknown auth header)        → null
//   - id is not a syntactically valid UUID          → null (no SQL sent)
//   - id is a valid UUID but no row exists          → null
//   - id is a valid UUID, row exists, but the row's
//     sensitivity is outside the role's allow-list  → null
//
// Without the UUID pre-check, Postgres would throw `invalid input syntax
// for type uuid` on malformed ids, surfacing as a 500 from the page —
// which is itself a discriminator (500 vs 404). The regex guards that.

import type { Pool } from "pg";

import { sensitivityAllowedForRole, type Role } from "@/lib/auth";
import type { Sensitivity } from "@/drizzle/schema";

export interface EntryDetail {
  id: string;
  title: string;
  category: string;
  tags: string[];
  body: string;
  /** Display-only label (ADR-0023). Null for rows written before the column existed. */
  caption: string | null;
  source_pointer: string;
  last_verified_at: Date;
  sensitivity: Sensitivity;
  created_at: Date;
  updated_at: Date;
}

// RFC 4122 §3 UUID shape — lowercase or uppercase hex, four hyphens,
// 8-4-4-4-12. We are NOT validating version/variant bits because
// Postgres' `uuid` type accepts any 36-char hex-and-hyphen literal of
// this shape regardless of version (the type stores 128 bits, not a
// version-stamped value). A stricter regex would reject UUIDs the DB
// would accept, breaking parity with `entries.id::text`.
//
// Intentional under-match vs. Postgres' uuid input parser: the brace
// form `{8-4-4-4-12}` and the URN form `urn:uuid:8-4-4-4-12` are
// accepted by Postgres but rejected here. We never emit those forms
// ourselves, and accepting them would force the audit `id_param`
// surface area to accommodate two more code paths. If a future
// integration starts emitting brace/URN uuids, expand here.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Fetch one entry by id, gated by the requester's sensitivity tier.
 *
 * Returns `null` for every failure mode (auth, malformed id, missing
 * row, sensitivity mismatch) — the page maps `null` to `notFound()`.
 * The page MUST NOT branch on auth-failure-vs-missing separately;
 * doing so reopens the existence-leak side channel this function
 * exists to close.
 *
 * @param pool  pg Pool — used directly (rather than Drizzle) to keep
 *              the parameter binding for `sensitivity = ANY($2)`
 *              one-step and reviewable.
 * @param id    raw `[id]` segment from the URL — untrusted.
 * @param role  resolved Role or null (from `resolveRoleFromHeader`).
 */
export async function findEntryForRole(
  pool: Pool,
  id: string,
  role: Role | null,
): Promise<EntryDetail | null> {
  if (role === null) return null;
  if (!isUuid(id)) return null;

  const allowed: Sensitivity[] = sensitivityAllowedForRole(role);

  // sensitivity = ANY($2::text[]) keeps the allow-list in SQL WHERE
  // — iron rule #6. The `::text[]` cast lets node-postgres pass a
  // JS string[] as a Postgres text array without ad-hoc quoting.
  const result = await pool.query<{
    id: string;
    title: string;
    category: string;
    tags: string[];
    body: string;
    caption: string | null;
    source_pointer: string;
    last_verified_at: Date;
    sensitivity: Sensitivity;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, title, category, tags, body, caption, source_pointer,
            last_verified_at, sensitivity, created_at, updated_at
       FROM entries
      WHERE id = $1
        AND sensitivity = ANY($2::text[])
      LIMIT 1`,
    [id, allowed],
  );

  if (result.rows.length === 0) return null;
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// M4 #1a — listEntriesForAdmin
//
// Read sibling to findEntryForRole: powers the read-only admin entries
// browser at /admin/entries. Mirrors the iron-rule-#6 discipline of the
// detail-path: sensitivity is compiled into the SQL WHERE via
// `sensitivityAllowedForRole(role)` even though `admin` resolves to all
// three tiers — the gate is the SQL, never JS post-hoc filtering. An
// accidental future call with role="user" therefore degrades to the
// correct user-tier allow-list rather than leaking restricted rows.
//
// Pagination is keyset on (updated_at, id) — see migration 0006 for the
// matching btree. Cursor semantics: `(updated_at, id) < ($1, $2)` is
// Postgres row-comparison in NATURAL (ASC) lex order, which is precisely
// "after the cursor in DESC,DESC sort order". No OFFSET — keyset survives
// concurrent inserts without page drift or duplicate rows.
// ---------------------------------------------------------------------------

export interface EntryListItem {
  id: string;
  title: string;
  category: string;
  tags: string[];
  sensitivity: Sensitivity;
  last_verified_at: Date;
  updated_at: Date;
}

export interface ListCursor {
  updatedAt: Date;
  id: string;
}

// M4 #1b — admin facet filters. All three filters are SINGLE-VALUE in
// this slice; multi-value variants are queued in BACKLOG. Tag matching
// is CASE-SENSITIVE exact (matches storage — lib/ingest.ts writes tags
// verbatim, no normalization). Filter case-mismatch silently returns
// empty; the page must therefore render a chip only for POST-VALIDATION
// filters so an unhonored typo never shows as "active."
export interface ListFilters {
  category?: string;
  tag?: string;
  sensitivity?: Sensitivity;
}

export interface ListEntriesOptions {
  limit?: number;
  cursor?: ListCursor | null;
  filters?: ListFilters;
  /**
   * Free-text search query (M4 #1c). Matched against the trigger-maintained
   * `entries.tsv` column via `websearch_to_tsquery('simple', unaccent(
   * regexp_replace($, '<niqqud-class>', '', 'g')))`. Pre-validated via
   * `validateSearchQuery` at the page layer — callers MUST NOT pass raw
   * URL strings without validation (no length cap or control-char
   * rejection happens inside the SQL builder).
   */
  query?: string;
}

export interface ListEntriesResult {
  rows: EntryListItem[];
  nextCursor: ListCursor | null;
}

const LIST_DEFAULT_LIMIT = 25;
const LIST_MAX_LIMIT = 100;
/**
 * Length cap for raw category / tag filter strings. Strings longer than
 * this are treated as no-filter (returned `null` by the validators);
 * keeps the audit payload bounded and prevents the URL surface from
 * being a log-amplification vector. Real category/tag values are short
 * (≤ ~50 chars in practice).
 */
const FILTER_STRING_MAX = 200;

const SENSITIVITY_VALUES = new Set<Sensitivity>(["public", "internal", "restricted"]);

/**
 * Validate a free-text filter param (category or tag). Returns the
 * trimmed string if non-empty and within the length cap, else `null`
 * (treat-as-no-filter). The page MUST render a chip only when this
 * returns non-null — otherwise a typo (e.g., `?tag=<201 chars>`) would
 * show as an "active" filter the SQL never honored.
 */
// ASCII control range + DEL — rejecting these in filter strings keeps
// the chip-row from rendering an invisible-but-active chip (a stray
// newline value would show as an empty pill with no × target) and
// prevents the audit payload from carrying log-poisoning whitespace.
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;

export function validateFilterString(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Trim BEFORE the length check so a 200-char string of leading
  // whitespace doesn't sneak past the cap.
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > FILTER_STRING_MAX) return null;
  if (CONTROL_CHAR_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Validate a sensitivity filter against the canonical enum. Case-sensitive
 * — `?sensitivity=PUBLIC` returns null (no normalization to lowercase).
 * Returns `null` for any value outside the three known tiers.
 */
export function validateSensitivityFilter(raw: unknown): Sensitivity | null {
  if (typeof raw !== "string") return null;
  if (!SENSITIVITY_VALUES.has(raw as Sensitivity)) return null;
  return raw as Sensitivity;
}

/**
 * Length cap for raw search query strings (M4 #1c). Larger than
 * FILTER_STRING_MAX because legitimate search inputs are often
 * multi-keyword sentences. Over-length collapses to no-query — same
 * "treat-as-no-filter" discipline as validateFilterString.
 */
const SEARCH_QUERY_MAX = 500;

/**
 * Validate a free-text search query. Trim, reject whitespace-only,
 * reject control chars, length cap. Returns the trimmed string when
 * valid, else `null`. A typo like `?q=%0A` therefore renders no chip
 * and emits no `tsv @@ ...` clause — the chip-row never claims a
 * filter the SQL is ignoring.
 */
export function validateSearchQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > SEARCH_QUERY_MAX) return null;
  if (CONTROL_CHAR_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * List entries for the admin browser, gated by the requester's sensitivity
 * tier. Returns rows ordered by `updated_at DESC, id DESC` (deterministic
 * tiebreak on ties) and a keyset `nextCursor` when more rows exist.
 *
 * Iron rule #6: the SQL WHERE always carries `sensitivity = ANY($::text[])`
 * — even for admin (which resolves to all three tiers). Never post-hoc
 * filter in JS.
 *
 * @param pool node-postgres Pool
 * @param role admin or user (the page should reject non-admin earlier;
 *             user-role behavior is defined here as a defense-in-depth
 *             property, not a UI affordance)
 * @param options.limit  default 25, clamped to [1, 100]
 * @param options.cursor null/undefined for first page; otherwise the
 *                       `nextCursor` returned from the previous call
 */
export async function listEntriesForAdmin(
  pool: Pool,
  role: Role,
  options: ListEntriesOptions = {},
): Promise<ListEntriesResult> {
  const rawLimit = options.limit ?? LIST_DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(LIST_MAX_LIMIT, Math.floor(rawLimit)));
  const allowed: Sensitivity[] = sensitivityAllowedForRole(role);
  const cursor = options.cursor ?? null;
  const filters = options.filters ?? {};
  const query = options.query ?? null;

  // Bind-parameter contract (load-bearing — unit tests assert on these
  // positions; do NOT reorder without updating lib/entries.test.ts):
  //   $1 = sensitivity allow-list  (text[]) — ALWAYS present (iron rule #6)
  //   $2 = limit + 1               (peek-ahead — see file-top comment)
  //   $3 = cursor.updated_at       (optional; only when cursor !== null)
  //   $4 = cursor.id               (optional; only when cursor !== null)
  //   $N+ = filter params, appended in this order when present:
  //         category, tag, sensitivity-filter
  //
  // Filters AND-compose with the allow-list rather than REPLACING it:
  // a non-admin requesting `sensitivity=restricted` produces
  // `sensitivity = $X AND sensitivity = ANY($1::text[])` — empty result
  // at the DB level. The allow-list is never widened by a filter, and
  // iron rule #6 stays mechanically obvious in the SQL.
  //
  // Performance note: there is no index on `category` and no GIN on
  // `tags`; the filter clauses are evaluated during the keyset btree
  // walk (the planner uses entries_updated_at_id_idx for ORDER BY and
  // applies the filter predicates in-place). Fine at the current
  // corpus scale (~33 entries post-M3 seed); revisit when a filter
  // facet is the slow lane on a real-traffic dashboard. BACKLOG entry
  // covers the index strategy.
  const params: unknown[] = [allowed, limit + 1];
  let where = "sensitivity = ANY($1::text[])";
  if (cursor !== null) {
    where += " AND (updated_at, id) < ($3, $4)";
    params.push(cursor.updatedAt, cursor.id);
  }
  if (filters.category !== undefined) {
    const p = params.length + 1;
    where += ` AND category = $${p}`;
    params.push(filters.category);
  }
  if (filters.tag !== undefined) {
    const p = params.length + 1;
    // CASE-SENSITIVE exact match against an element of tags[].
    // Mismatched case (e.g., filter "Receipt" vs stored "receipt")
    // silently returns []. See ListFilters JSDoc for the rationale.
    where += ` AND $${p} = ANY(tags)`;
    params.push(filters.tag);
  }
  if (filters.sensitivity !== undefined) {
    const p = params.length + 1;
    where += ` AND sensitivity = $${p}`;
    params.push(filters.sensitivity);
  }
  if (query !== null) {
    const p = params.length + 1;
    // CANONICAL niqqud-strip class — byte-identical to migration 0002 line 43
    // (the index-side trigger). Non-contiguous: includes U+0591..U+05BD
    // (combining marks) + U+05BF (rafe) + U+05C1..U+05C2 (sin/shin dot) +
    // U+05C4..U+05C5 (mark + dot) + U+05C7 (qamats qatan). DELIBERATELY
    // EXCLUDES U+05BE MAQAF, U+05C0 PASEQ, U+05C3 SOF PASUQ, U+05C6 NUN
    // HAFUKHA — those are visible punctuation; stripping the maqaf would
    // silently corrupt compound nouns (בית־ספר → ביתספר).
    //
    // KEEP IN SYNC with THREE sites — any change here must land in all:
    //   1. drizzle/migrations/0002_unaccent_tsv_trigger.sql:43 (index-side trigger)
    //   2. lib/retrieval-keyword.ts:68 (retrieval keyword lane)
    //   3. lib/entries.ts (this file — admin list keyword search)
    // BACKLOG entry tracks extracting a shared `lib/keyword-tsquery.ts`
    // module + fixing the existing drift at retrieval-keyword.ts:68
    // (which currently uses the contiguous range '[U+0591-U+05C7]'). The
    // shared-module extraction is the 3rd-recurrence mechanical floor per
    // feedback_prefer_mechanical_over_prose; queued for next session.
    where += ` AND tsv @@ websearch_to_tsquery('simple', unaccent(regexp_replace($${p}, '[֑-ֽֿׁ-ׂׄ-ׇׅ]', '', 'g')))`;
    params.push(query);
  }

  const result = await pool.query<{
    id: string;
    title: string;
    category: string;
    tags: string[];
    sensitivity: Sensitivity;
    last_verified_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, title, category, tags, sensitivity, last_verified_at, updated_at
       FROM entries
      WHERE ${where}
      ORDER BY updated_at DESC, id DESC
      LIMIT $2`,
    params,
  );

  const rows = result.rows;
  if (rows.length <= limit) {
    return { rows, nextCursor: null };
  }
  // Peek-ahead disclosed that more rows exist; the cursor is the LAST
  // row of the CURRENT page (not the peek itself). Next page query is
  // `(updated_at, id) < lastOfPage` — strictly less — so the peek row
  // (which we did NOT return in the current page) becomes the FIRST
  // row of the next page. Using `peek` here with `<` would silently
  // skip the peek row from the next page; using `peek` with `<=` would
  // also work but conflates two strategies. Stay with last-of-page + `<`.
  const pageRows = rows.slice(0, limit);
  const lastOfPage = pageRows[pageRows.length - 1];
  return {
    rows: pageRows,
    nextCursor: { updatedAt: lastOfPage.updated_at, id: lastOfPage.id },
  };
}
