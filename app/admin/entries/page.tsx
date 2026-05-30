// app/admin/entries/page.tsx — M4 #1a admin entry browser (list view).
//
// Read-only listing of every entry, keyset-paginated by (updated_at, id),
// linking each row to the existing read-only detail page at /entries/[id].
// Non-admin requests collapse to notFound() — mirrors the /entries/[id]
// auth-fail-and-not-found collapse so the URL surface yields a single
// shape regardless of role.
//
// Why a server component:
//   - Pure rendered HTML, no client-side state.
//   - resolveRoleFromHeader runs on the request thread, same path the
//     detail page uses, so the auth gate stays in lock-step with the
//     route-handler primitives (`withAdmin` / `withUserOrAdmin`).
//   - Cursor decoding is flat query-param (no opaque token) so the URL
//     is debuggable in server logs and `gh` paste-able.
//
// Cache stance: `dynamic = "force-dynamic"` is non-negotiable. The page
// renders restricted-tier rows for admin; Next's full route cache would
// otherwise serve those bytes back on a subsequent non-admin request to
// the same URL. Same rationale as app/entries/[id]/page.tsx.

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";

import * as schema from "@/drizzle/schema";
import { resolveRoleFromHeader, STUB_ROLE_HEADER, type Role } from "@/lib/auth";
import { getDb, getPool } from "@/lib/db";
import { isUuid, listEntriesForAdmin, type EntryListItem, type ListCursor } from "@/lib/entries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE_LIMIT = 25;
// Display-only tag cap — entries.tags has no semantic priority order, so
// "first N" is purely a layout choice, NOT a ranking signal. Documented
// here so future readers don't infer a sort.
const TAG_DISPLAY_CAP = 3;

interface PageProps {
  searchParams: Promise<{
    cursor_updated_at?: string | string[];
    cursor_id?: string | string[];
  }>;
}

export default async function AdminEntriesListPage({
  searchParams,
}: PageProps): Promise<React.ReactNode> {
  const sp = await searchParams;
  const headerStore = await headers();
  const role = resolveRoleFromHeader(headerStore.get(STUB_ROLE_HEADER));

  // Non-admin collapses to notFound() — same shape as a missing route.
  // Audit row is written FIRST (mirrors detail-page discipline), then
  // notFound() throws and unwinds. Forensics survive in audit_log.
  if (role !== "admin") {
    await writeListAuditRow({ role, cursor: null, resultCount: 0, outcome: "unauthorized" });
    notFound();
  }

  const cursor = parseCursor(sp);

  const result = await listEntriesForAdmin(getPool(), role, {
    limit: PAGE_LIMIT,
    cursor,
  });

  await writeListAuditRow({
    role,
    cursor,
    resultCount: result.rows.length,
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
        gap: "1.25rem",
      }}
    >
      <header>
        <h1 style={{ margin: 0 }}>Entries</h1>
        <p style={{ fontSize: "0.875rem", color: "var(--kramer-neutral)", marginTop: "0.25rem" }}>
          Admin browser — read-only. {result.rows.length} row
          {result.rows.length === 1 ? "" : "s"} on this page.
        </p>
      </header>

      {result.rows.length === 0 ? (
        <p data-testid="admin-entries-empty" style={{ opacity: 0.8 }}>
          No entries yet.
        </p>
      ) : (
        <ul
          aria-label="Entries"
          data-testid="admin-entries-list"
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
          }}
        >
          {result.rows.map((row) => (
            <EntryCard key={row.id} row={row} />
          ))}
        </ul>
      )}

      {result.nextCursor !== null && (
        <nav style={{ fontSize: "0.875rem" }}>
          <Link data-testid="admin-entries-load-more" href={buildLoadMoreHref(result.nextCursor)}>
            Load more →
          </Link>
        </nav>
      )}
    </main>
  );
}

function EntryCard({ row }: { row: EntryListItem }): React.ReactNode {
  const verifiedDate = row.last_verified_at.toISOString().slice(0, 10);
  const updatedDate = row.updated_at.toISOString().slice(0, 10);
  const visibleTags = row.tags.slice(0, TAG_DISPLAY_CAP);
  const hiddenTagCount = row.tags.length - visibleTags.length;

  return (
    <li
      style={{
        background: "rgba(220, 221, 222, 0.04)",
        border: "1px solid var(--kramer-neutral)",
        borderRadius: "0.5rem",
        padding: "0.875rem 1rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "baseline" }}>
        <Link
          href={`/entries/${row.id}`}
          dir="auto"
          style={{ fontSize: "1.0625rem", fontWeight: 600 }}
        >
          {row.title}
        </Link>
        <span
          className="sensitivity-pill"
          data-tier={row.sensitivity}
          data-testid="sensitivity-pill"
        >
          {row.sensitivity}
        </span>
        <span style={{ fontSize: "0.75rem", color: "var(--kramer-neutral)" }}>
          category: {row.category}
        </span>
      </div>

      {visibleTags.length > 0 && (
        <ul
          aria-label="Tags"
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexWrap: "wrap",
            gap: "0.375rem",
          }}
        >
          {visibleTags.map((tag) => (
            <li
              key={tag}
              style={{
                fontSize: "0.75rem",
                padding: "0.125rem 0.5rem",
                borderRadius: "999px",
                border: "1px solid var(--kramer-neutral)",
                opacity: 0.85,
              }}
            >
              {tag}
            </li>
          ))}
          {hiddenTagCount > 0 && (
            <li
              style={{
                fontSize: "0.75rem",
                color: "var(--kramer-neutral)",
                opacity: 0.7,
              }}
            >
              +{hiddenTagCount} more
            </li>
          )}
        </ul>
      )}

      <div style={{ fontSize: "0.75rem", color: "var(--kramer-neutral)", opacity: 0.85 }}>
        verified {verifiedDate} · updated {updatedDate}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Cursor: flat query-param pair (?cursor_updated_at=ISO&cursor_id=UUID).
// Validation is strict — any malformed value collapses to "no cursor" and
// the user gets page 1. Never throw; never 500 on a bad URL.
// ---------------------------------------------------------------------------
function parseCursor(sp: {
  cursor_updated_at?: string | string[];
  cursor_id?: string | string[];
}): ListCursor | null {
  const rawAt = firstParam(sp.cursor_updated_at);
  const rawId = firstParam(sp.cursor_id);
  if (rawAt === null || rawId === null) return null;
  if (!isUuid(rawId)) return null;
  const ms = Date.parse(rawAt);
  if (!Number.isFinite(ms)) return null;
  // Round-trip precision: node-postgres already truncates timestamptz to
  // ms when materializing JS Date (Date can't represent µs), so the cursor
  // we emit is ms-precision in the first place; toISOString → Date.parse
  // preserves it exactly. Postgres column precision (µs) matters only if
  // a future raw-SQL caller seeds rows with sub-ms timestamps.
  return { updatedAt: new Date(ms), id: rawId };
}

// Repeated-param policy: `?cursor_updated_at=A&cursor_updated_at=B` uses
// `A` and silently drops `B`. Either silent-first or reject-as-malformed
// would be defensible; first-wins matches Next's typical convention and
// is the friendliest to copy-pasted "Load more" links.
function firstParam(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.length > 0 ? value[0] : null;
  return value;
}

function buildLoadMoreHref(cursor: ListCursor): string {
  const params = new URLSearchParams({
    cursor_updated_at: cursor.updatedAt.toISOString(),
    cursor_id: cursor.id,
  });
  return `/admin/entries?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Audit row. Mirrors the detail-page discipline (entry_view): one row per
// page render, served AND denied branches, single jsonb payload. The kind
// `entry_list_view` is new — it's a user-action audit (not an agent call),
// so prompt_hash stays null and the CHECK
// `audit_log_prompt_hash_required_for_agent` is satisfied.
// ---------------------------------------------------------------------------
async function writeListAuditRow(args: {
  role: Role | null;
  cursor: ListCursor | null;
  resultCount: number;
  outcome: "served" | "unauthorized";
}): Promise<void> {
  try {
    await getDb()
      .insert(schema.audit_log)
      .values({
        kind: "entry_list_view",
        prompt_hash: null,
        // entry_id stays NULL — this is a list-view, not a per-entry read.
        // Per-row entry ids would re-introduce a timing oracle (FK-validating
        // single row vs. a list-shaped payload). Forensics use payload.
        entry_id: null,
        payload: {
          outcome: args.outcome,
          role: args.role,
          result_count: args.resultCount,
          cursor:
            args.cursor === null
              ? null
              : {
                  updated_at: args.cursor.updatedAt.toISOString(),
                  id: args.cursor.id,
                },
        },
      });
  } catch {
    // Audit-write failure is non-fatal. Mirrors detail-page policy:
    // never turn an audit failure into a 500 for the user.
  }
}
