// lib/admin-tags.ts — M4 #4 PR-A: tag catalog read for the admin dashboard.
//
// Per ADR-0025 D5: the catalog is derivable as `SELECT DISTINCT unnest(tags) FROM entries`;
// no separate tags table. PR-A surfaces the catalog with per-tag entry counts to the
// /admin/tags dashboard. PR-C will reuse this for the suggestion endpoint with an
// optional ?prefix= filter and the Ingestion Agent's list_tags() tool.
//
// Iron-rule #6 footprint (ADR-0025 D5 "sensitivity filter on the tag list"):
//   The query filters by entries.sensitivity = ANY(sensitivityAllowedForRole(role)).
//   For admin role this is a no-op (all three sensitivities); for user role it
//   suppresses tags that exist ONLY on restricted entries. PR-A's only caller is the
//   admin dashboard, so the filter is functionally dead here — but it ships now so
//   PR-C inherits a tested code path rather than re-adding it later.
//
// The entry_count field is computed over the same role-filtered set per D5 / Amendment A3:
// the count is intentionally role-relative. A tag present on 10 internal + 50 restricted
// entries surfaces as entry_count: 10 to a user-role caller and entry_count: 60 to an
// admin-role caller. Do NOT add a "total" field that exposes the unfiltered count.

import type { Pool } from "pg";

import { sensitivityAllowedForRole, type Role } from "@/lib/auth";

/** One row of the admin-tags catalog. */
export interface AdminTagsCatalogRow {
  /** The tag's verbatim bytes from entries.tags. */
  name: string;
  /** Number of entries in the role-visible set carrying this tag. */
  entry_count: number;
}

/**
 * Returns the role-filtered tag catalog sorted by entry_count DESC then alphabetical.
 *
 * Pattern note: uses a raw pg Pool query (not Drizzle) because the canonical
 * unnest+group_by shape is awkward to express in Drizzle's query builder and the
 * SQL is short + self-documenting. Mirrors the listStaleEntries / listEntriesForAdmin
 * pattern in lib/entries.ts where keyset pagination also drops to raw SQL.
 */
export async function listAdminTagsForRole(pool: Pool, role: Role): Promise<AdminTagsCatalogRow[]> {
  const allowedSensitivities = sensitivityAllowedForRole(role);
  // The subquery alias `t` is required by Postgres for derived tables. The
  // COUNT(*) cast to int handles the bigint -> string node-postgres default;
  // entry_count is bounded by the corpus size (well under INT4_MAX).
  const result = await pool.query<{ name: string; entry_count: number }>(
    `
    SELECT t.tag AS name, COUNT(*)::int AS entry_count
    FROM (
      SELECT unnest(tags) AS tag, sensitivity
      FROM entries
      WHERE sensitivity = ANY($1::text[])
    ) AS t
    GROUP BY t.tag
    ORDER BY entry_count DESC, t.tag ASC
    `,
    [allowedSensitivities],
  );
  return result.rows;
}

/**
 * Canonical enumeration of operation-level tag-management audit kinds. M5 CR
 * fix 2026-06-01: extracted as a single source-of-truth alias so adding a
 * fourth audit kind in a future PR is one edit, not three coordinated edits
 * (the union was previously duplicated in TagAuditRow.kind, the pg query
 * generic in this file, and app/admin/tags/page.tsx's summarizeAuditPayload).
 * Per-row entry-level audit kinds (`ingest`, `ingest_update`, `entry_view`,
 * etc.) are NOT part of this union; they live elsewhere.
 */
export type TagOperationAuditKind = "tag_rename" | "tag_delete" | "tag_merge";

/**
 * Returns the last N tag-management audit_log rows (kind IN tag_rename/tag_delete/tag_merge),
 * newest first, for the dashboard's audit-trail section.
 *
 * Plain raw SQL again — Drizzle's query builder doesn't model `kind IN (...)` cleanly
 * against jsonb returning. Cap at 50; the dashboard surfaces operator-recent forensics
 * only. Older rows are recoverable via direct DB query.
 */
export interface TagAuditRow {
  id: string;
  kind: TagOperationAuditKind;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

export async function listRecentTagAuditRows(pool: Pool, limit = 50): Promise<TagAuditRow[]> {
  const result = await pool.query<{
    id: string;
    kind: TagOperationAuditKind;
    payload: Record<string, unknown>;
    occurred_at: Date;
  }>(
    `
    SELECT id, kind, payload, occurred_at
    FROM audit_log
    WHERE kind IN ('tag_rename', 'tag_delete', 'tag_merge')
    ORDER BY occurred_at DESC
    LIMIT $1
    `,
    [limit],
  );
  return result.rows;
}
