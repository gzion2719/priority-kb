// app/admin/entries/[id]/history/page.tsx — M4 #3 admin version history (list view).
//
// Lists every version of an entry as a card stack, newest first. Each row
// links to the per-version diff + revert page. The current (highest)
// version is rendered with a "current" badge and no diff link. A fresh
// entry (only v1, never edited) renders as a single "current — no prior
// versions" card.
//
// Cache stance + auth shape mirror app/admin/entries/[id]/edit/page.tsx:
// admin-gated server component, force-dynamic, role-or-entry-missing
// collapsed to notFound().

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";

import { resolveRoleFromHeader, STUB_ROLE_HEADER } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { findEntryForRole, listVersionsForEntry } from "@/lib/entries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AdminEntryHistoryPage({
  params,
}: PageProps): Promise<React.ReactNode> {
  const { id } = await params;
  const headerStore = await headers();
  const role = resolveRoleFromHeader(headerStore.get(STUB_ROLE_HEADER));

  if (role !== "admin") notFound();
  const entry = await findEntryForRole(getPool(), id, "admin");
  if (entry === null) notFound();

  const versions = await listVersionsForEntry(getPool(), entry.id);
  // versions is ordered newest first (version_no DESC). The first row's
  // version_no IS the current state's version_no — by the createEntry/
  // updateEntry convention that the latest version_no row's snapshot ==
  // the current entries row.
  const currentVersionNo = versions[0]?.version_no ?? 1;

  return (
    <main
      style={{
        maxWidth: "48rem",
        margin: "0 auto",
        padding: "2rem 1rem",
        display: "flex",
        flexDirection: "column",
        gap: "1.25rem",
      }}
    >
      <nav style={{ fontSize: "0.875rem" }}>
        <Link href="/admin/entries">← Back to entries</Link>
        {" · "}
        <Link href={`/admin/entries/${entry.id}/edit`}>Edit current</Link>
      </nav>

      <header style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <h1 style={{ margin: 0 }}>Version history</h1>
        <p dir="auto" style={{ fontSize: "0.9375rem", color: "var(--kramer-neutral)", margin: 0 }}>
          {entry.title}
        </p>
        <p style={{ fontSize: "0.875rem", color: "var(--kramer-neutral)", margin: 0 }}>
          {versions.length === 1
            ? "Only the current version exists — no prior versions to compare or revert to."
            : `${versions.length} versions on record.`}
        </p>
      </header>

      <ul
        aria-label="Versions"
        data-testid="admin-history-list"
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
        }}
      >
        {versions.map((v) => {
          const isCurrent = v.version_no === currentVersionNo;
          return (
            <li
              key={v.version_no}
              data-testid={`admin-history-row-${v.version_no}`}
              data-current={isCurrent ? "true" : undefined}
              style={{
                background: "rgba(220, 221, 222, 0.04)",
                border: "1px solid var(--kramer-neutral)",
                borderRadius: "0.5rem",
                padding: "0.875rem 1rem",
                display: "flex",
                flexWrap: "wrap",
                gap: "0.75rem",
                alignItems: "baseline",
              }}
            >
              <span style={{ fontSize: "1rem", fontWeight: 600 }}>v{v.version_no}</span>
              {isCurrent && (
                <span
                  data-testid="admin-history-current-badge"
                  style={{
                    fontSize: "0.6875rem",
                    padding: "0.125rem 0.5rem",
                    borderRadius: "999px",
                    border: "1px solid var(--kramer-neutral)",
                    background: "var(--kramer-neutral)",
                    color: "var(--kramer-dark)",
                  }}
                >
                  current
                </span>
              )}
              <span style={{ fontSize: "0.75rem", color: "var(--kramer-neutral)" }}>
                {v.created_at.toISOString().slice(0, 19).replace("T", " ")} UTC
              </span>
              {!isCurrent && (
                <Link
                  href={`/admin/entries/${entry.id}/history/${v.version_no}`}
                  data-testid={`admin-history-compare-link-${v.version_no}`}
                  style={{ marginLeft: "auto", fontSize: "0.8125rem" }}
                >
                  Compare with current →
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
