// app/admin/tags/page.tsx — M4 #4 PR-A admin tag management dashboard.
//
// Per ADR-0025 D6 + Amendment A2/A5/A11:
//   - Section 1: catalog list (tag + entry_count, sorted DESC then alphabetical).
//   - Section 2: RenameForm + DeleteForm (catalog pre-fill mechanical floor per A5
//     — the `from`/`tag` inputs are SELECT dropdowns populated from the catalog;
//     no free-text typing of source tags).
//   - Section 3: audit-trail of last 50 tag_rename + tag_delete rows.
// Emits `tag_management_view` audit row on every page load (both served + unauth
// branches) per ADR-0025 A3 / M4 #5 stale_entries_view precedent.
//
// Iron-rule footprint mirrors M4 #5:
//   #4  admin-only via resolveRoleFromHeader; non-admin → audit + notFound().
//   #6  sensitivity filter applied to the catalog read (D5; no-op for admin role).

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";

import * as schema from "@/drizzle/schema";
import { resolveRoleFromHeader, STUB_ROLE_HEADER, type Role } from "@/lib/auth";
import { getDb, getPool } from "@/lib/db";
import {
  listAdminTagsForRole,
  listRecentTagAuditRows,
  type AdminTagsCatalogRow,
  type TagAuditRow,
  type TagOperationAuditKind,
} from "@/lib/admin-tags";

import { RenameForm } from "./RenameForm";
import { DeleteForm } from "./DeleteForm";
import { MergeForm } from "./MergeForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const AUDIT_TRAIL_LIMIT = 50;

export default async function AdminTagsPage(): Promise<React.ReactNode> {
  const headerStore = await headers();
  const role = resolveRoleFromHeader(headerStore.get(STUB_ROLE_HEADER));

  if (role !== "admin") {
    await writeTagManagementViewAuditRow({ role, tagCount: 0, outcome: "unauthorized" });
    notFound();
  }

  // M4 #5 parity + M4 fix from 2026-05-31 PR-A code-CR: the served-branch
  // audit row must fire even if Promise.all throws (e.g., DB drop mid-read).
  // We try the reads, then audit; on a read failure we still audit with
  // tag_count=0 + re-throw for Next.js's error boundary to render.
  let catalog: AdminTagsCatalogRow[];
  let auditRows: TagAuditRow[];
  try {
    [catalog, auditRows] = await Promise.all([
      listAdminTagsForRole(getPool(), role),
      listRecentTagAuditRows(getPool(), AUDIT_TRAIL_LIMIT),
    ]);
  } catch (err) {
    await writeTagManagementViewAuditRow({ role, tagCount: 0, outcome: "served" });
    throw err;
  }

  await writeTagManagementViewAuditRow({
    role,
    tagCount: catalog.length,
    outcome: "served",
  });

  return (
    <main
      style={{
        maxWidth: "60rem",
        margin: "0 auto",
        padding: "2rem 1rem",
        display: "flex",
        flexDirection: "column",
        gap: "1.5rem",
      }}
    >
      <nav style={{ fontSize: "0.875rem" }}>
        <Link href="/admin/entries">← Back to entries</Link>
      </nav>

      <header style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <h1 style={{ margin: 0 }}>Tag management</h1>
        <p style={{ fontSize: "0.875rem", color: "var(--kramer-neutral)", margin: 0 }}>
          Rename or delete tags across the corpus. Each operation loops the existing updateEntry
          pipeline per affected entry (lock, append version, re-chunk, re-embed, audit) — so a
          rename triggers N synchronous Voyage embed calls. Validate the target name carefully;
          renames are reversible only by another rename.
        </p>
      </header>

      <CatalogSection catalog={catalog} />

      <section
        aria-label="Rename or delete a tag"
        style={{ display: "flex", flexDirection: "column", gap: "1rem" }}
      >
        <h2 style={{ margin: 0, fontSize: "1.125rem" }}>Operations</h2>
        {catalog.length === 0 ? (
          // Empty-catalog state is also surfaced by `admin-tags-empty` in
          // CatalogSection above; this duplicate render is the operations
          // section's "no actions available" affordance. m6 code-CR fix:
          // intentional duplication for two different UI surfaces; the
          // testid stays distinct so tests can target either.
          <p style={{ opacity: 0.8 }}>
            No tags in the catalog — add tags to entries first, then return here.
          </p>
        ) : (
          <>
            <RenameForm catalog={catalog.map((c) => c.name)} />
            <DeleteForm catalog={catalog.map((c) => c.name)} />
            <MergeForm catalog={catalog.map((c) => c.name)} />
          </>
        )}
      </section>

      <AuditTrailSection rows={auditRows} />
    </main>
  );
}

function CatalogSection({ catalog }: { catalog: AdminTagsCatalogRow[] }): React.ReactNode {
  return (
    <section
      aria-label="Tag catalog"
      style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
    >
      <h2 style={{ margin: 0, fontSize: "1.125rem" }}>Catalog ({catalog.length})</h2>
      {catalog.length === 0 ? (
        <p data-testid="admin-tags-empty" style={{ opacity: 0.8 }}>
          No tags found in any entry.
        </p>
      ) : (
        <ul
          data-testid="admin-tags-catalog"
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.25rem",
          }}
        >
          {catalog.map((row) => (
            <li
              key={row.name}
              data-testid={`admin-tags-row-${row.name}`}
              style={{
                display: "flex",
                gap: "0.75rem",
                padding: "0.375rem 0.75rem",
                background: "rgba(220, 221, 222, 0.04)",
                border: "1px solid var(--kramer-neutral)",
                borderRadius: "0.375rem",
                fontSize: "0.875rem",
                alignItems: "baseline",
              }}
            >
              <span dir="auto" style={{ flex: 1 }}>
                {row.name}
              </span>
              <span style={{ color: "var(--kramer-neutral)" }}>
                {row.entry_count} {row.entry_count === 1 ? "entry" : "entries"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AuditTrailSection({ rows }: { rows: TagAuditRow[] }): React.ReactNode {
  return (
    <section
      aria-label="Recent tag operations"
      style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
    >
      <h2 style={{ margin: 0, fontSize: "1.125rem" }}>Recent operations</h2>
      {rows.length === 0 ? (
        <p data-testid="admin-tags-no-audit" style={{ opacity: 0.8 }}>
          No tag operations recorded yet.
        </p>
      ) : (
        <ul
          data-testid="admin-tags-audit"
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.25rem",
          }}
        >
          {rows.map((row) => (
            <AuditRowItem key={row.id} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AuditRowItem({ row }: { row: TagAuditRow }): React.ReactNode {
  const when = row.occurred_at.toISOString().slice(0, 19).replace("T", " ");
  const summary = summarizeAuditPayload(row.kind, row.payload);
  return (
    <li
      data-testid={`admin-tags-audit-${row.id}`}
      style={{
        padding: "0.375rem 0.75rem",
        background: "rgba(220, 221, 222, 0.04)",
        border: "1px solid var(--kramer-neutral)",
        borderRadius: "0.375rem",
        fontSize: "0.8125rem",
        display: "flex",
        gap: "0.75rem",
        alignItems: "baseline",
      }}
    >
      <span style={{ color: "var(--kramer-neutral)", fontVariantNumeric: "tabular-nums" }}>
        {when}
      </span>
      <span style={{ flex: 1 }} dir="auto">
        {summary}
      </span>
    </li>
  );
}

function summarizeAuditPayload(
  kind: TagOperationAuditKind,
  payload: Record<string, unknown>,
): string {
  const count =
    typeof payload.affected_entry_count === "number"
      ? payload.affected_entry_count
      : Array.isArray(payload.affected_entry_ids)
        ? payload.affected_entry_ids.length
        : 0;
  const partial = payload.partial_failure === true ? " (PARTIAL FAILURE)" : "";
  if (kind === "tag_rename") {
    const from = typeof payload.from === "string" ? payload.from : "?";
    const to = typeof payload.to === "string" ? payload.to : "?";
    return `rename "${from}" → "${to}" — ${count} ${count === 1 ? "entry" : "entries"}${partial}`;
  }
  if (kind === "tag_merge") {
    const from = Array.isArray(payload.from)
      ? (payload.from as unknown[]).map((s) => (typeof s === "string" ? s : "?")).join(", ")
      : "?";
    const to = typeof payload.to === "string" ? payload.to : "?";
    return `merge [${from}] → "${to}" — ${count} ${count === 1 ? "entry" : "entries"}${partial}`;
  }
  const tag = typeof payload.tag === "string" ? payload.tag : "?";
  return `delete "${tag}" — ${count} ${count === 1 ? "entry" : "entries"}${partial}`;
}

/**
 * Per ADR-0025 D4 / Amendment A3: tag_management_view audit row written on
 * every page load. Mirrors M4 #5 stale_entries_view shape (writes on both
 * served + unauthorized branches for timing-oracle parity).
 *
 * Payload shape: { tag_count: number, outcome: "served" | "unauthorized" }
 *   - tag_count: 0 on the unauthorized branch (per amendment A3).
 *   - prompt_hash: null (not an agent call).
 *   - entry_id: null (operation is corpus-wide, not entry-specific).
 */
async function writeTagManagementViewAuditRow(args: {
  role: Role | null;
  tagCount: number;
  outcome: "served" | "unauthorized";
}): Promise<void> {
  try {
    await getDb()
      .insert(schema.audit_log)
      .values({
        kind: "tag_management_view",
        prompt_hash: null,
        entry_id: null,
        payload: {
          tag_count: args.tagCount,
          outcome: args.outcome,
          role: args.role,
        },
      });
  } catch {
    // Audit-write failure is non-fatal. Mirrors stale-entries-page policy.
  }
}
