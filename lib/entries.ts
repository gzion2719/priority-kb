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
import { buildKeywordTsquerySQL } from "@/lib/keyword-tsquery";

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
    // Canonical keyword-tsquery normalization via lib/keyword-tsquery.ts —
    // the shared module landed 2026-06-01 as the production-tokenization-
    // mirror 2nd-recurrence floor. Migrating this surface to the shared
    // helper retires the KEEP-IN-SYNC comment block this site used to carry.
    where += ` AND tsv @@ ${buildKeywordTsquerySQL(`$${p}`)}`;
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

// ---------------------------------------------------------------------------
// M4 #3 — version history (entries_versions reads)
//
// Read sibling to findEntryForRole + listEntriesForAdmin: powers the read-only
// admin history viewer at /admin/entries/[id]/history. Both functions are
// admin-only by CALL-SITE — the pages enforce role via resolveRoleFromHeader
// + findEntryForRole before calling here. We deliberately skip a SQL role
// filter at this layer because:
//   (a) the metadata (version_no, created_at) is sensitivity-agnostic;
//   (b) the full snapshot's sensitivity is part of the row, so a caller
//       MUST pair this with findEntryForRole on the entry first (which
//       enforces iron-rule #6 at the entry level — if the role can't see
//       the current entry, the page does notFound() before calling here);
//   (c) smearing a role filter into a metadata-only query would over-engineer
//       the read.
// ---------------------------------------------------------------------------

export interface VersionListItem {
  version_no: number;
  created_at: Date;
}

/**
 * Full snapshot of one `entries_versions` row. Note: source_pointer and
 * last_verified_at are NOT included — the snapshot schema does not carry
 * them (see `lib/ingest.ts:343-347`). Revert callers MUST pull those two
 * fields from the current `entries` row, not from a snapshot.
 */
export interface VersionSnapshot {
  version_no: number;
  title: string;
  category: string;
  tags: string[];
  body: string;
  sensitivity: Sensitivity;
  created_at: Date;
}

/**
 * List all versions of an entry, ordered newest first. The list is small-
 * bounded (one row per edit; typical entries have ≤10 versions) so no
 * pagination cap is needed today. Add one when a single entry's history
 * grows past ~100 versions in real usage.
 */
export async function listVersionsForEntry(
  pool: Pool,
  entryId: string,
): Promise<VersionListItem[]> {
  if (!isUuid(entryId)) return [];
  const result = await pool.query<{ version_no: number; created_at: Date }>(
    `SELECT version_no, created_at
       FROM entries_versions
      WHERE entry_id = $1
      ORDER BY version_no DESC`,
    [entryId],
  );
  return result.rows;
}

/**
 * Fetch one version snapshot by (entryId, versionNo). Returns null when
 * the version doesn't exist (unknown entry, unknown version_no, or
 * malformed UUID). Same null-collapse discipline as findEntryForRole.
 */
export async function getVersion(
  pool: Pool,
  entryId: string,
  versionNo: number,
): Promise<VersionSnapshot | null> {
  if (!isUuid(entryId)) return null;
  if (!Number.isInteger(versionNo) || versionNo < 1) return null;
  const result = await pool.query<{
    version_no: number;
    title: string;
    category: string;
    tags: string[];
    body: string;
    sensitivity: Sensitivity;
    created_at: Date;
  }>(
    `SELECT version_no, title, category, tags, body, sensitivity, created_at
       FROM entries_versions
      WHERE entry_id = $1 AND version_no = $2
      LIMIT 1`,
    [entryId, versionNo],
  );
  if (result.rows.length === 0) return null;
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// M4 #5 — stale-entries dashboard (read-only)
//
// `listStaleEntries` powers the admin dashboard at /admin/stale-entries.
// Same iron-rule-#6 discipline as listEntriesForAdmin: the role-derived
// allow-list lands in SQL WHERE at $1, never JS post-hoc-filter. Keyset
// pagination on (last_verified_at ASC, id ASC) so oldest comes first.
//
// Scope is read-only. The ROADMAP item bundles three pieces (cron +
// retrieval-frequency intersection + dashboard); cron and the retrieval-
// frequency intersection are decision-heavy (M2b worker maturity, M5
// hosting) and are filed in BACKLOG. The dashboard ships today.
// ---------------------------------------------------------------------------

/**
 * Default threshold for "stale" — six months un-reverified. The ROADMAP
 * M4 #5 line names "> 6 months ago"; 180 days is the rounded equivalent.
 * Mirrors `LIST_DEFAULT_LIMIT`'s home in this module (a default for the
 * helper's optional param). The page module re-references for UI labels.
 */
export const STALE_THRESHOLD_DAYS = 180;

/**
 * Keyset cursor for `listStaleEntries`. Distinct from `ListCursor` (above)
 * because the orderings encode different ASC/DESC semantics:
 *   - `ListCursor`       — (updated_at DESC, id DESC) for newest-first browsing
 *   - `StaleListCursor`  — (last_verified_at ASC, id ASC) for oldest-first staleness
 * Mixing one for the other would land at a stale-side cursor on the fresh-
 * side helper or vice versa — the typed distinction makes that impossible
 * at the type-checker level.
 */
export interface StaleListCursor {
  lastVerifiedAt: Date;
  id: string;
}

export interface ListStaleOptions {
  /**
   * Entries are "stale" when `last_verified_at < NOW() - INTERVAL`.
   * Default = STALE_THRESHOLD_DAYS * 1 day, in milliseconds.
   */
  olderThanMs?: number;
  limit?: number;
  cursor?: StaleListCursor | null;
}

export interface ListStaleResult {
  rows: EntryListItem[];
  nextCursor: StaleListCursor | null;
}

/**
 * List entries whose `last_verified_at` is older than `olderThanMs`,
 * gated by the requester's sensitivity tier. Oldest first.
 *
 * Iron rule #6: the SQL WHERE always carries `sensitivity = ANY($::text[])`
 * — even for admin (which resolves to all three tiers). Never post-hoc
 * filter in JS. Mirrors `listEntriesForAdmin`'s bind-position convention
 * ($1 allow-list, $2 limit+1 peek-ahead) and clamps limit identically.
 *
 * Postgres interval parameterization: the threshold lands as `$3::interval`
 * with the param being a formatted string `"<days> days"`. The "<days>"
 * value is derived from `olderThanMs` via `Math.max(1, Math.floor(ms /
 * 86_400_000))` — defensive floor of 1 day so a malformed call can't
 * surface the whole table as "stale".
 *
 * @param pool node-postgres Pool
 * @param role admin or user (defense-in-depth — page rejects non-admin
 *             before calling here)
 * @param options.olderThanMs default = STALE_THRESHOLD_DAYS * 24h in ms
 * @param options.limit       default 25, clamped to [1, 100]
 * @param options.cursor      null/undefined for first page; otherwise the
 *                            `nextCursor` returned from the previous call
 *
 * Cursor µs-vs-ms hazard (shared with `listEntriesForAdmin`): Postgres
 * timestamptz is µs-precise; node-postgres truncates to ms on read. A
 * cursor read at ms precision then re-sent compares strictly LESS than
 * the original µs value, which on this ASC walk re-introduces the
 * boundary row on the next page (a row's stored µs value > cursor's
 * truncated ms value → row matches `> cursor` and re-enters page 2).
 * Production write paths (`createEntry`, `updateEntry`) bind JS Date
 * values (ms precision) for `last_verified_at`, so the hazard does NOT
 * manifest on app-written rows. It WOULD manifest on rows written by
 * raw SQL (NOW() arithmetic, fixup scripts, future migrations) — see
 * BACKLOG entry "cursor µs/ms round-trip fix".
 */
export async function listStaleEntries(
  pool: Pool,
  role: Role,
  options: ListStaleOptions = {},
): Promise<ListStaleResult> {
  const rawLimit = options.limit ?? LIST_DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(LIST_MAX_LIMIT, Math.floor(rawLimit)));
  const allowed: Sensitivity[] = sensitivityAllowedForRole(role);
  const cursor = options.cursor ?? null;
  const olderThanMs = options.olderThanMs ?? STALE_THRESHOLD_DAYS * 86_400_000;
  // Defensive floor: a caller passing 0 or a negative number would
  // otherwise turn the whole table into "stale" (every entry is older
  // than `NOW() - 0 days`). Floor at 1 day.
  const days = Math.max(1, Math.floor(olderThanMs / 86_400_000));
  const intervalStr = `${days} days`;

  // Bind-parameter contract (load-bearing — unit tests assert positions):
  //   $1 = sensitivity allow-list (text[]) — iron rule #6
  //   $2 = limit + 1               (peek-ahead)
  //   $3 = interval string         (e.g. "180 days")
  //   $4 = cursor.last_verified_at (optional)
  //   $5 = cursor.id               (optional)
  const params: unknown[] = [allowed, limit + 1, intervalStr];
  let where =
    "sensitivity = ANY($1::text[]) AND last_verified_at IS NOT NULL AND last_verified_at < NOW() - $3::interval";
  if (cursor !== null) {
    where += " AND (last_verified_at, id) > ($4, $5)";
    params.push(cursor.lastVerifiedAt, cursor.id);
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
      ORDER BY last_verified_at ASC, id ASC
      LIMIT $2`,
    params,
  );

  const rows = result.rows;
  if (rows.length <= limit) {
    return { rows, nextCursor: null };
  }
  const pageRows = rows.slice(0, limit);
  const lastOfPage = pageRows[pageRows.length - 1];
  return {
    rows: pageRows,
    nextCursor: { lastVerifiedAt: lastOfPage.last_verified_at, id: lastOfPage.id },
  };
}
