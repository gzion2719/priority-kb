// app/admin/entries/[id]/edit/page.tsx — M4 #2 admin entry editor (server view).
//
// Loads the entry via findEntryForRole(admin), writes an `entry_edit_view`
// audit row (parallel to `entry_view` / `entry_list_view` — see
// writeEditAuditRow comment for the forensic question this audit kind
// answers), and renders the client EditForm component.
//
// Cache stance + auth shape mirror app/entries/[id]/page.tsx and
// app/admin/entries/page.tsx — same iron-rule-#6 cache-poisoning defense;
// same role-gate-or-notFound collapse so the URL surface yields a single
// shape regardless of role (auth failure, missing row, malformed UUID
// all surface as Next's 404).

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";

import * as schema from "@/drizzle/schema";
import { resolveRoleFromHeader, STUB_ROLE_HEADER, type Role } from "@/lib/auth";
import { getDb, getPool } from "@/lib/db";
import { findEntryForRole, type EntryDetail } from "@/lib/entries";

import { EditForm } from "./EditForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Same id-echo cap as app/entries/[id]/page.tsx — bound the audit row.
const ID_PARAM_MAX_LOG_LEN = 64;

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AdminEntryEditPage({ params }: PageProps): Promise<React.ReactNode> {
  const { id } = await params;
  const headerStore = await headers();
  const role = resolveRoleFromHeader(headerStore.get(STUB_ROLE_HEADER));

  // Two failure modes collapsed to the SAME notFound() shape:
  //   (a) non-admin role
  //   (b) entry missing OR sensitivity-mismatch — for the admin role
  //       (b) only fires on truly missing entries since admin's allow-
  //       list is the full enum.
  // Audit row is written BEFORE notFound() so forensics survive the 404.
  const entry = role === "admin" ? await findEntryForRole(getPool(), id, "admin") : null;

  await writeEditAuditRow({ entry, role, rawId: id });

  if (role !== "admin" || entry === null) notFound();

  // Current MAX(version_no) for display in the form header. Informational
  // — pairs with the BACKLOG If-Match lock-token follow-up (PR body): stub-
  // auth single-admin reality today makes UX-level lost-update rare; until
  // the lock token lands with M5 multi-admin auth, this number is the
  // user-visible mitigation that lets the admin see "I'm about to write v4."
  const versionRow = await getPool().query<{ max: number }>(
    `SELECT COALESCE(MAX(version_no), 1) AS max FROM entries_versions WHERE entry_id = $1`,
    [entry.id],
  );
  const currentVersionNo = versionRow.rows[0]?.max ?? 1;

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
        <Link href={`/admin/entries/${entry.id}/history`}>View history</Link>
      </nav>

      <header style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <h1 style={{ margin: 0 }}>Edit entry</h1>
        <p
          data-testid="admin-edit-version-banner"
          style={{ fontSize: "0.875rem", color: "var(--kramer-neutral)", margin: 0 }}
        >
          Current version: v{currentVersionNo} — this edit becomes v{currentVersionNo + 1}.
        </p>
      </header>

      <EditForm
        entryId={entry.id}
        initial={{
          title: entry.title,
          category: entry.category,
          tags: entry.tags,
          body: entry.body,
          source_pointer: entry.source_pointer,
          last_verified_at: entry.last_verified_at.toISOString(),
          sensitivity: entry.sensitivity,
        }}
      />
    </main>
  );
}

/**
 * Audit row for the editor-page render. Distinct from `entry_view`
 * because the forensic question is different:
 *   - `entry_view`         answers "who has read this entry?"
 *   - `entry_edit_view`    answers "who opened the editor (regardless of
 *                          whether they submitted)?"
 * That split is forensically valuable when reconciling an unexpected
 * `ingest_update` row against admin intent — was the edit deliberate
 * (preceded by an editor-view) or accidental (a direct PUT with no
 * preceding editor-view audit). The two kinds OR cheaply in downstream
 * queries.
 *
 * `entry_id` stays NULL on BOTH branches to nullify the timing-oracle
 * side channel (mirrors app/entries/[id]/page.tsx); the served entry id
 * lives in payload.entry_id for forensics. The CHECK
 * `audit_log_prompt_hash_required_for_agent` does not fire because
 * `entry_edit_view` does not match the `agent_%` prefix.
 */
async function writeEditAuditRow(args: {
  entry: EntryDetail | null;
  role: Role | null;
  rawId: string;
}): Promise<void> {
  const { entry, role, rawId } = args;
  try {
    await getDb()
      .insert(schema.audit_log)
      .values({
        kind: "entry_edit_view",
        prompt_hash: null,
        entry_id: null,
        payload: {
          outcome: entry === null ? "not_found_or_unauthorized" : "served",
          role,
          entry_id: entry?.id ?? null,
          id_param: rawId.slice(0, ID_PARAM_MAX_LOG_LEN),
        },
      });
  } catch {
    // Audit-write failure is non-fatal. Mirrors detail-page policy:
    // never turn an audit failure into a 500 for the user.
  }
}
