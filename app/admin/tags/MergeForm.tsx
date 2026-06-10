"use client";

// app/admin/tags/MergeForm.tsx — M4 #4 PR-B merge affordance.
//
// Per ADR-0025 Amendment 2026-06-01 (PR-B catalog-pre-fill extension of A5):
//   The `from` multi-select uses checkboxes per catalog row (no free-text); the
//   `to` input is a SELECT dropdown also bound to the catalog. The server route
//   re-verifies catalog membership on every from[i] as a defensive floor for
//   curl/bot bypass attempts (see app/api/admin/tags/merge/route.ts).
//
// On submit: POST /api/admin/tags/merge {from: string[], to: string}.
//   - 200 → router.refresh() + inline success summary (affected count).
//   - 400 → inline error (Zod / catalog-miss / TagValidationError).
//   - 500 → inline error (MergeRollbackError or catastrophic) — the admin sees
//     the audit_id when surfaced and can correlate with the audit trail section.

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/Button";
import { STUB_ROLE_HEADER } from "@/lib/auth";

export interface MergeFormProps {
  /** Catalog of existing tag names; supplied by the server component. */
  catalog: string[];
}

type SubmitStatus =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string; auditId?: string }
  | { kind: "success"; affectedCount: number; auditId: string };

export function MergeForm({ catalog }: MergeFormProps): React.ReactNode {
  const router = useRouter();
  const [selectedFrom, setSelectedFrom] = useState<Set<string>>(new Set());
  // N4 CR fix 2026-06-01: default `to` to empty rather than catalog[0]. The
  // previous default collided with whatever the admin checked first as a
  // source (toInFrom warning fires immediately). Empty default forces the
  // admin to make an explicit choice.
  const [to, setTo] = useState<string>("");
  const [status, setStatus] = useState<SubmitStatus>({ kind: "idle" });

  function toggleFrom(tag: string): void {
    setSelectedFrom((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        next.add(tag);
      }
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setStatus({ kind: "submitting" });

    const from = Array.from(selectedFrom);
    let res: Response;
    try {
      res = await fetch(`/api/admin/tags/merge`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [STUB_ROLE_HEADER]: "admin",
        },
        body: JSON.stringify({ from, to }),
      });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "network_error",
      });
      return;
    }

    if (res.ok) {
      const body = (await res.json()) as {
        audit_id: string;
        affected_entry_count: number;
      };
      setStatus({
        kind: "success",
        affectedCount: body.affected_entry_count,
        auditId: body.audit_id,
      });
      setSelectedFrom(new Set());
      router.refresh();
      return;
    }

    let errorMessage = `http_${res.status}`;
    let auditId: string | undefined;
    try {
      const body = (await res.json()) as {
        error?: string;
        issues?: Array<{ message?: string; code?: string }>;
        audit_id?: string;
      };
      auditId = body.audit_id;
      const issueMessage = body.issues?.[0]?.message ?? body.issues?.[0]?.code;
      // M2 CR fix 2026-06-01: 500 + audit_id means a rollback (atomic-or-bust
      // fired). Replace the useless "internal" body.error with a
      // rollback-specific message so the admin sees the right recovery story
      // immediately — no entries changed, look up the audit row's
      // partial_failure_reason for cause.
      if (res.status === 500 && auditId !== undefined) {
        errorMessage =
          issueMessage ??
          "Merge rolled back — no entries were changed. See Recent operations for the cause.";
      } else {
        errorMessage = issueMessage ?? body.error ?? errorMessage;
      }
    } catch {
      // Non-JSON body; keep the http_<status> fallback.
    }
    setStatus({ kind: "error", message: errorMessage, auditId });
  }

  const submitting = status.kind === "submitting";
  // Can't submit unless: at least one from is selected, to is non-empty,
  // and to is NOT in the selected-from set (DP2 client-side echo of the
  // server's validation — saves a round-trip).
  const toInFrom = selectedFrom.has(to);
  const canSubmit = !submitting && selectedFrom.size > 0 && to.length > 0 && !toInFrom;

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Merge tags"
      data-testid="admin-tags-merge-form"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        padding: "0.75rem",
        border: "1px solid var(--kramer-neutral)",
        borderRadius: "0.375rem",
      }}
    >
      <h3 style={{ margin: 0, fontSize: "1rem" }}>Merge</h3>
      <p style={{ fontSize: "0.75rem", color: "var(--kramer-neutral)", margin: 0 }}>
        Select one or more source tags to merge into a single target. The merge runs atomically — if
        any entry fails to update, no entries are changed (see Recent operations for forensic
        trail).
      </p>

      <fieldset
        style={{
          border: "1px solid var(--kramer-neutral)",
          borderRadius: "0.375rem",
          padding: "0.5rem",
          margin: 0,
        }}
      >
        <legend
          style={{ fontSize: "0.75rem", color: "var(--kramer-neutral)", padding: "0 0.25rem" }}
        >
          Sources ({selectedFrom.size} selected)
        </legend>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.5rem 1rem",
            maxHeight: "12rem",
            overflowY: "auto",
          }}
        >
          {catalog.map((tag) => (
            <label
              key={tag}
              data-testid={`admin-tags-merge-from-${tag}`}
              style={{
                display: "flex",
                gap: "0.375rem",
                alignItems: "center",
                fontSize: "0.875rem",
                cursor: submitting ? "wait" : "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={selectedFrom.has(tag)}
                onChange={() => toggleFrom(tag)}
                disabled={submitting}
              />
              <span dir="auto">{tag}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <span style={{ fontSize: "0.75rem", color: "var(--kramer-neutral)" }}>Target</span>
          <select
            data-testid="admin-tags-merge-to"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            disabled={submitting || catalog.length === 0}
            required
            style={{
              fontFamily: "inherit",
              fontSize: "0.9375rem",
              padding: "0.375rem 0.5rem",
              minWidth: "12rem",
            }}
          >
            <option value="" disabled>
              — select target —
            </option>
            {catalog.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
        </label>
        <span style={{ alignSelf: "flex-end" }}>
          <Button
            type="submit"
            variant="cta"
            disabled={!canSubmit}
            aria-busy={submitting}
            data-testid="admin-tags-merge-submit"
          >
            {submitting ? "Merging…" : "Merge"}
          </Button>
        </span>
      </div>

      {toInFrom && (
        <p
          role="status"
          data-testid="admin-tags-merge-to-in-from-warning"
          style={{ fontSize: "0.8125rem", color: "#ff6b6b", margin: 0 }}
        >
          Target tag is also in the source list. Deselect it from sources or choose a different
          target.
        </p>
      )}
      {status.kind === "error" && (
        <p
          role="alert"
          data-testid="admin-tags-merge-error"
          style={{ fontSize: "0.8125rem", color: "#ff6b6b", margin: 0 }}
        >
          {status.message}
          {status.auditId !== undefined ? ` (audit ${status.auditId})` : ""}
        </p>
      )}
      {status.kind === "success" && (
        <p
          role="status"
          data-testid="admin-tags-merge-success"
          style={{ fontSize: "0.8125rem", color: "var(--kramer-neutral)", margin: 0 }}
        >
          Merged across {status.affectedCount} {status.affectedCount === 1 ? "entry" : "entries"}{" "}
          (audit {status.auditId}).
        </p>
      )}
    </form>
  );
}
