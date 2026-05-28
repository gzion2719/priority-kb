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
