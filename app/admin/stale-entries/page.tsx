// app/admin/stale-entries/page.tsx — M4 #5 admin stale-entries dashboard (read-only).
//
// Lists entries whose `last_verified_at` is older than STALE_THRESHOLD_DAYS,
// oldest first, with a link to the existing editor per row. Iron-rule #6
// gate lives in lib/entries.ts::listStaleEntries SQL WHERE; the page
// enforces role gate + audit row + notFound collapse mirroring the rest of
// the admin surface.
//
// Scope is read-only: no "mark verified" action, no nightly cron, no
// retrieval-frequency intersection. Those are filed in BACKLOG. The
// dashboard itself ships actionable value today (admin can re-verify
// manually via the existing editor).
//
// Important cross-cut: M4 #3 revert preserves CURRENT `last_verified_at`,
// not the revert moment, by design (revert restores text/structure but
// does NOT re-attest verification freshness). So a reverted entry stays
// stale here until the admin separately re-verifies via the editor.

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";

import * as schema from "@/drizzle/schema";
import { resolveRoleFromHeader, STUB_ROLE_HEADER, type Role } from "@/lib/auth";
import { getDb, getPool } from "@/lib/db";
import {
  listStaleEntries,
  STALE_THRESHOLD_DAYS,
  type EntryListItem,
  type StaleListCursor,
} from "@/lib/entries";
import { getNowMs } from "@/lib/time-now";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE_LIMIT = 25;
const TAG_DISPLAY_CAP = 3;

interface PageProps {
  searchParams: Promise<{
    cursor_last_verified_at?: string | string[];
    cursor_id?: string | string[];
  }>;
}

export default async function AdminStaleEntriesPage({
  searchParams,
}: PageProps): Promise<React.ReactNode> {
  const sp = await searchParams;
  const headerStore = await headers();
  const role = resolveRoleFromHeader(headerStore.get(STUB_ROLE_HEADER));

  if (role !== "admin") {
    await writeStaleAuditRow({ role, cursor: null, resultCount: 0, outcome: "unauthorized" });
    notFound();
  }

  const cursor = parseStaleCursor(sp);

  const result = await listStaleEntries(getPool(), role, {
    limit: PAGE_LIMIT,
    cursor,
  });

  // Read "now" ONCE at the top of the render via the lib/time-now helper,
  // then pass downstream as a prop. See lib/time-now.ts for why the helper
  // exists (React's components-must-be-pure rule + the linter pattern-match
  // for a literal `Date.now()` call in render).
  const nowMs = getNowMs();

  await writeStaleAuditRow({
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
      <nav style={{ fontSize: "0.875rem" }}>
        <Link href="/admin/entries">← Back to entries</Link>
      </nav>

      <header style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <h1 style={{ margin: 0 }}>Stale entries</h1>
        <p style={{ fontSize: "0.875rem", color: "var(--kramer-neutral)", margin: 0 }}>
          Entries un-reverified for more than {STALE_THRESHOLD_DAYS} days, oldest first. Open one in
          the editor to re-attest the verification date. Note: a M4 #3 revert restores content but
          does NOT touch <code>last_verified_at</code> — a reverted entry stays listed here until
          the admin separately re-verifies.
        </p>
      </header>

      {result.rows.length === 0 ? (
        <p data-testid="admin-stale-empty" style={{ opacity: 0.8 }}>
          No stale entries — every entry has been verified within the last {STALE_THRESHOLD_DAYS}{" "}
          days.
        </p>
      ) : (
        <ul
          aria-label="Stale entries"
          data-testid="admin-stale-list"
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
            <StaleEntryCard key={row.id} row={row} nowMs={nowMs} />
          ))}
        </ul>
      )}

      {result.nextCursor !== null && (
        <nav style={{ fontSize: "0.875rem" }}>
          <Link
            data-testid="admin-stale-load-more"
            href={buildStaleHref({ cursor: result.nextCursor })}
          >
            Load more →
          </Link>
        </nav>
      )}
    </main>
  );
}

function StaleEntryCard({
  row,
  nowMs,
}: {
  row: EntryListItem;
  /** Pre-computed `Date.now()` from the page render — see hoist comment. */
  nowMs: number;
}): React.ReactNode {
  // UTC-anchored day delta: matches the rest of the admin surface's UTC
  // convention (entry-list page uses toISOString().slice(0,10)). An admin
  // in IDT sees the same "N days ago" as one in UTC for the same row.
  const daysAgo = Math.floor((nowMs - row.last_verified_at.getTime()) / 86_400_000);
  const verifiedDate = row.last_verified_at.toISOString().slice(0, 10);
  const visibleTags = row.tags.slice(0, TAG_DISPLAY_CAP);
  const hiddenTagCount = row.tags.length - visibleTags.length;

  return (
    <li
      data-testid={`admin-stale-row-${row.id}`}
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
        <Link
          href={`/admin/entries/${row.id}/edit`}
          data-testid="admin-stale-edit-link"
          style={{ marginLeft: "auto", fontSize: "0.75rem" }}
        >
          Edit
        </Link>
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
            <li style={{ fontSize: "0.75rem", color: "var(--kramer-neutral)", opacity: 0.7 }}>
              +{hiddenTagCount} more
            </li>
          )}
        </ul>
      )}

      <div
        data-testid="admin-stale-days-ago"
        style={{ fontSize: "0.75rem", color: "var(--kramer-neutral)", opacity: 0.85 }}
      >
        verified {verifiedDate} — {daysAgo} days ago
      </div>
    </li>
  );
}

function buildStaleHref(state: { cursor: StaleListCursor | null }): string {
  if (state.cursor === null) return "/admin/stale-entries";
  const params = new URLSearchParams();
  params.set("cursor_last_verified_at", state.cursor.lastVerifiedAt.toISOString());
  params.set("cursor_id", state.cursor.id);
  return `/admin/stale-entries?${params.toString()}`;
}

function parseStaleCursor(sp: {
  cursor_last_verified_at?: string | string[];
  cursor_id?: string | string[];
}): StaleListCursor | null {
  const rawAt = firstParam(sp.cursor_last_verified_at);
  const rawId = firstParam(sp.cursor_id);
  if (rawAt === null || rawId === null) return null;
  // UUID shape check via the same regex precedent as the entries browser.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId)) return null;
  const ms = Date.parse(rawAt);
  if (!Number.isFinite(ms)) return null;
  return { lastVerifiedAt: new Date(ms), id: rawId };
}

function firstParam(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.length > 0 ? value[0] : null;
  return value;
}

/**
 * Audit row for the stale-entries page render. Distinct kind from
 * `entry_list_view` because the forensic question is different:
 *   - `entry_list_view`     answers "who browsed the entries catalog?"
 *   - `stale_entries_view`  answers "who's been monitoring KB freshness?"
 * Useful for compliance/quality audits — "did anyone look at staleness
 * this quarter?" is a yes/no question with a date-bound query.
 *
 * `entry_id` stays NULL on both branches (timing-oracle nullification
 * mirrors entries-list precedent). `prompt_hash` stays null (user-action
 * audit, not an agent call); the CHECK on `audit_log` does not fire
 * because the kind doesn't match `agent_%`.
 */
async function writeStaleAuditRow(args: {
  role: Role | null;
  cursor: StaleListCursor | null;
  resultCount: number;
  outcome: "served" | "unauthorized";
}): Promise<void> {
  try {
    await getDb()
      .insert(schema.audit_log)
      .values({
        kind: "stale_entries_view",
        prompt_hash: null,
        entry_id: null,
        payload: {
          outcome: args.outcome,
          role: args.role,
          result_count: args.resultCount,
          threshold_days: STALE_THRESHOLD_DAYS,
          cursor:
            args.cursor === null
              ? null
              : {
                  last_verified_at: args.cursor.lastVerifiedAt.toISOString(),
                  id: args.cursor.id,
                },
        },
      });
  } catch {
    // Audit-write failure is non-fatal. Mirrors detail-page policy.
  }
}
