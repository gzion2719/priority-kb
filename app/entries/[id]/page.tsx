// app/entries/[id]/page.tsx — M3 item 5 entry detail page (read-only).
//
// Citation targets from the query UI (app/query/page.tsx) and direct
// admin look-ups land here. This is the third surface that enforces
// iron-rule #6 sensitivity (after the ingest write path's CHECK
// constraint and the keyword-lane SQL WHERE); all three must collapse
// "you can't see this" into a shape indistinguishable from "this
// doesn't exist".
//
// Why a server component and not a route handler:
//   - This is rendered HTML, not JSON; the citation Link points here
//     directly (no extra fetch round-trip).
//   - The iron-rule-#6 SQL lives in lib/entries.ts (`findEntryForRole`)
//     which a future /api/entries/[id] route handler could share
//     unchanged. We keep just-in-time discipline: no API route until
//     a JSON consumer (Teams bot, future mobile client) actually
//     needs one.
//   - Auth header parsing reuses `resolveRoleFromHeader` from lib/auth.ts
//     — same canonical parser the route wrappers use, so the page
//     stays in lock-step with `withUserOrAdmin` semantics.
//
// Cache stance: `dynamic = "force-dynamic"` is non-negotiable. A
// `restricted` entry served to an admin must never be cached and
// served on a subsequent `user` request to the same id. Without
// force-dynamic, Next's full route cache would do exactly that.

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";

import * as schema from "@/drizzle/schema";
import { resolveRoleFromHeader, STUB_ROLE_HEADER, type Role } from "@/lib/auth";
import { getDb, getPool } from "@/lib/db";
import { findEntryForRole, type EntryDetail } from "@/lib/entries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Length-bound the id we echo into audit payloads — the URL segment is
// user-controlled. 64 chars is comfortably over the 36-char canonical
// UUID; beyond it we truncate so a future probe can't blow up audit
// row sizes.
const ID_PARAM_MAX_LOG_LEN = 64;

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EntryDetailPage({ params }: PageProps): Promise<React.ReactNode> {
  const { id } = await params;
  const headerStore = await headers();
  const role = resolveRoleFromHeader(headerStore.get(STUB_ROLE_HEADER));

  const entry = await findEntryForRole(getPool(), id, role);

  // Single audit-write call site. The audit row is shape-identical
  // between served and denied branches — same column set, same FK
  // posture (entry_id is ALWAYS null on this row kind, never the
  // served-entry FK), only the `payload.outcome` and `payload.entry_id`
  // differ. Keeping entry_id NULL on both branches removes a remote
  // timing oracle: an FK-validating row vs. a null-FK row could in
  // principle produce divergent Postgres latency under load, which a
  // sufficiently determined attacker could turn into a side channel.
  // The served entry id lives in `payload.entry_id` for forensics.
  await writeViewAuditRow({
    entry,
    role,
    rawId: id,
  });

  if (entry === null) notFound();

  return <EntryView entry={entry} />;
}

async function writeViewAuditRow(args: {
  entry: EntryDetail | null;
  role: Role | null;
  rawId: string;
}): Promise<void> {
  const { entry, role, rawId } = args;
  try {
    await getDb()
      .insert(schema.audit_log)
      .values({
        kind: "entry_view",
        // CHECK `audit_log_prompt_hash_required_for_agent` requires
        // prompt_hash only for `agent_%` kinds. `entry_view` is a
        // user-action audit, not an agent call, so prompt_hash stays null.
        prompt_hash: null,
        // entry_id stays NULL on BOTH branches (see writeViewAuditRow
        // call-site comment for the timing-oracle rationale). The
        // served entry id moves to payload.entry_id for forensics.
        entry_id: null,
        payload: {
          outcome: entry === null ? "not_found_or_unauthorized" : "served",
          // role is always one of "admin" | "user" | null because
          // resolveRoleFromHeader (the only producer) collapses
          // unknown header values to null. Safe to persist verbatim.
          role,
          entry_id: entry?.id ?? null,
          id_param: rawId.slice(0, ID_PARAM_MAX_LOG_LEN),
        },
      });
  } catch {
    // Audit-write failure is non-fatal. The page's user-visible
    // outcome is already decided; surfacing a write error here would
    // turn a viewable entry into a 500 for the user. Mirrors the same
    // policy in app/api/retrieve/route.ts:writeAuditRow.
  }
}

function EntryView({ entry }: { entry: EntryDetail }): React.ReactNode {
  // Tag pills and sensitivity pill mirror the citation-card pill style
  // from app/query/page.tsx (iron rule #13 — reuse brand pattern, do
  // not introduce a second pill primitive).
  // node-postgres' default type parser coerces `timestamptz` to JS Date,
  // which findEntryForRole's row generic reflects. If a future pg-types
  // override returns ISO strings instead, the `.toISOString()` calls
  // below throw; the schema's `notNull()` keeps the value present, but
  // the type is the operative invariant here.
  const verifiedDate = entry.last_verified_at.toISOString().slice(0, 10);
  const updatedDate = entry.updated_at.toISOString().slice(0, 10);

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
        <Link href="/query">← Back to query</Link>
      </nav>

      <header style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        {/*
          Title may be Hebrew or English. dir="auto" delegates to the
          browser's first-strong-character heuristic — same approach the
          admin chat uses per ADR-0010 §13.
        */}
        <h1 dir="auto" style={{ margin: 0 }}>
          {entry.title}
        </h1>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
          <span
            className="sensitivity-pill"
            data-tier={entry.sensitivity}
            data-testid="sensitivity-pill"
          >
            {entry.sensitivity}
          </span>
          <span style={{ fontSize: "0.75rem", color: "var(--kramer-neutral)" }}>
            category: {entry.category}
          </span>
        </div>
        {entry.tags.length > 0 && (
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
            {entry.tags.map((tag) => (
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
          </ul>
        )}
      </header>

      <section
        aria-label="Entry body"
        style={{
          background: "rgba(220, 221, 222, 0.04)",
          border: "1px solid var(--kramer-neutral)",
          borderRadius: "0.5rem",
          padding: "1rem",
        }}
      >
        <div
          data-testid="entry-body"
          dir="auto"
          style={{ whiteSpace: "pre-wrap", lineHeight: "var(--lh-body)" }}
        >
          {entry.body}
        </div>
      </section>

      <footer
        style={{
          fontSize: "0.75rem",
          color: "var(--kramer-neutral)",
          opacity: 0.85,
          display: "flex",
          flexDirection: "column",
          gap: "0.25rem",
        }}
      >
        <div data-testid="entry-source">source: {entry.source_pointer}</div>
        <div>last verified: {verifiedDate}</div>
        <div>last updated: {updatedDate}</div>
        <div style={{ fontFamily: "monospace" }}>id: {entry.id}</div>
      </footer>
    </main>
  );
}
