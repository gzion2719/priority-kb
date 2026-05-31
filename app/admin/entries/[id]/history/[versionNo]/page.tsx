// app/admin/entries/[id]/history/[versionNo]/page.tsx — M4 #3 diff + revert view.
//
// Renders snapshot of version N alongside current entry: per-field
// changed/unchanged markers; body shown as unified line-level diff via
// lib/text-diff.ts. When snapshot.sensitivity != current.sensitivity, a
// prominent banner names both tiers BEFORE the revert button is reachable
// (iron-rule #6 UX side — admin understands what they're tagging).
//
// When versionNo === current MAX, the page renders without a revert
// button (no-op revert), shows the snapshot as "this is the current
// version", and links back to the history list.

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";

import { resolveRoleFromHeader, STUB_ROLE_HEADER } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { findEntryForRole, getVersion, listVersionsForEntry } from "@/lib/entries";
import { diffLines } from "@/lib/text-diff";

import { RevertForm } from "./RevertForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Strict integer URL segment — `Number.parseInt("3xyz", 10) === 3` would
// silently accept malformed input; the regex test pre-rejects that class.
const VERSION_SEGMENT_RE = /^\d+$/;

interface PageProps {
  params: Promise<{ id: string; versionNo: string }>;
}

export default async function AdminEntryHistoryDetailPage({
  params,
}: PageProps): Promise<React.ReactNode> {
  const { id, versionNo: versionSeg } = await params;

  if (!VERSION_SEGMENT_RE.test(versionSeg)) notFound();
  const versionNo = Number.parseInt(versionSeg, 10);
  if (!Number.isInteger(versionNo) || versionNo < 1) notFound();

  const headerStore = await headers();
  const role = resolveRoleFromHeader(headerStore.get(STUB_ROLE_HEADER));
  if (role !== "admin") notFound();

  const entry = await findEntryForRole(getPool(), id, "admin");
  if (entry === null) notFound();

  const snapshot = await getVersion(getPool(), entry.id, versionNo);
  if (snapshot === null) notFound();

  const versions = await listVersionsForEntry(getPool(), entry.id);
  const currentVersionNo = versions[0]?.version_no ?? 1;
  const isCurrentVersion = versionNo === currentVersionNo;

  const bodyDiff = diffLines(snapshot.body, entry.body);

  return (
    <main
      style={{
        maxWidth: "56rem",
        margin: "0 auto",
        padding: "2rem 1rem",
        display: "flex",
        flexDirection: "column",
        gap: "1.25rem",
      }}
    >
      <nav style={{ fontSize: "0.875rem" }}>
        <Link href={`/admin/entries/${entry.id}/history`}>← Back to history</Link>
      </nav>

      <header style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <h1 style={{ margin: 0 }}>
          v{versionNo} vs v{currentVersionNo} (current)
        </h1>
        <p dir="auto" style={{ fontSize: "0.9375rem", color: "var(--kramer-neutral)", margin: 0 }}>
          {entry.title}
        </p>
        <p style={{ fontSize: "0.75rem", color: "var(--kramer-neutral)", margin: 0 }}>
          v{versionNo} written {snapshot.created_at.toISOString().slice(0, 19).replace("T", " ")}{" "}
          UTC
        </p>
      </header>

      {isCurrentVersion && (
        <p
          data-testid="admin-history-detail-current-banner"
          style={{
            padding: "0.75rem 1rem",
            border: "1px solid var(--kramer-neutral)",
            borderRadius: "0.5rem",
            background: "rgba(220, 221, 222, 0.04)",
          }}
        >
          This is the current version. Nothing to revert.
        </p>
      )}

      {!isCurrentVersion && snapshot.sensitivity !== entry.sensitivity && (
        <p
          role="alert"
          data-testid="admin-history-sensitivity-warning"
          style={{
            padding: "0.75rem 1rem",
            border: "1px solid #ff6b6b",
            borderRadius: "0.5rem",
            background: "rgba(255, 107, 107, 0.08)",
            fontSize: "0.9375rem",
          }}
        >
          Reverting will change sensitivity from <strong>{entry.sensitivity}</strong> to{" "}
          <strong>{snapshot.sensitivity}</strong>. Confirm this is intentional before submitting.
        </p>
      )}

      <FieldDiff label="Title" before={snapshot.title} after={entry.title} dir="auto" />
      <FieldDiff label="Category" before={snapshot.category} after={entry.category} />
      <FieldDiff
        label="Tags"
        before={snapshot.tags.join(", ")}
        after={entry.tags.join(", ")}
        dir="auto"
      />
      <FieldDiff label="Sensitivity" before={snapshot.sensitivity} after={entry.sensitivity} />

      <section
        aria-label="Body diff"
        data-testid="admin-history-body-diff"
        style={{
          background: "rgba(220, 221, 222, 0.04)",
          border: "1px solid var(--kramer-neutral)",
          borderRadius: "0.5rem",
          padding: "1rem",
        }}
      >
        <h2 style={{ fontSize: "0.9375rem", margin: "0 0 0.5rem 0" }}>Body</h2>
        {bodyDiff.oversized ? (
          <p data-testid="admin-history-body-oversized" style={{ fontSize: "0.875rem" }}>
            Body is too large to render a line-by-line diff. Open v{versionNo} and the current entry
            directly to compare.
          </p>
        ) : (
          <pre
            dir="auto"
            style={{
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "0.8125rem",
              lineHeight: 1.4,
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {bodyDiff.chunks.map((c, i) => (
              <span
                key={i}
                data-kind={c.kind}
                style={{
                  display: "block",
                  paddingLeft: "1.5rem",
                  textIndent: "-1.5rem",
                  background:
                    c.kind === "add"
                      ? "rgba(46, 160, 67, 0.15)"
                      : c.kind === "remove"
                        ? "rgba(248, 81, 73, 0.15)"
                        : "transparent",
                }}
              >
                {c.kind === "add" ? "+ " : c.kind === "remove" ? "- " : "  "}
                {c.text}
              </span>
            ))}
          </pre>
        )}
      </section>

      {!isCurrentVersion && (
        <section
          aria-label="Revert"
          style={{
            border: "1px solid var(--kramer-neutral)",
            borderRadius: "0.5rem",
            padding: "1rem",
          }}
        >
          <h2 style={{ fontSize: "0.9375rem", margin: "0 0 0.5rem 0" }}>Revert</h2>
          <RevertForm
            entryId={entry.id}
            versionNo={versionNo}
            nextVersionNo={currentVersionNo + 1}
            snapshot={{
              title: snapshot.title,
              category: snapshot.category,
              tags: snapshot.tags,
              body: snapshot.body,
              sensitivity: snapshot.sensitivity,
            }}
            preserved={{
              source_pointer: entry.source_pointer,
              last_verified_at: entry.last_verified_at.toISOString(),
            }}
          />
        </section>
      )}
    </main>
  );
}

function FieldDiff({
  label,
  before,
  after,
  dir,
}: {
  label: string;
  before: string;
  after: string;
  dir?: "auto" | "ltr" | "rtl";
}): React.ReactNode {
  const changed = before !== after;
  return (
    <div
      data-testid={`admin-history-field-${label.toLowerCase()}`}
      data-changed={changed ? "true" : "false"}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(7rem, max-content) 1fr 1fr",
        gap: "0.5rem 1rem",
        alignItems: "baseline",
        padding: "0.5rem 0.75rem",
        borderRadius: "0.375rem",
        background: changed ? "rgba(255, 211, 0, 0.06)" : "transparent",
      }}
    >
      <span style={{ fontSize: "0.875rem", fontWeight: 600 }}>{label}</span>
      <span
        dir={dir}
        style={{
          fontSize: "0.875rem",
          color: changed ? "inherit" : "var(--kramer-neutral)",
          textDecoration: changed ? "line-through" : "none",
        }}
      >
        {before === "" ? <em style={{ opacity: 0.6 }}>(empty)</em> : before}
      </span>
      <span dir={dir} style={{ fontSize: "0.875rem" }}>
        {after === "" ? <em style={{ opacity: 0.6 }}>(empty)</em> : after}
      </span>
    </div>
  );
}
