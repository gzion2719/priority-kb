"use client";

// app/admin/tags/RenameForm.tsx — M4 #4 PR-A rename affordance.
//
// Per ADR-0025 Amendment A5 (the catalog pre-fill mechanical floor):
//   The `from` input is a SELECT dropdown populated from the catalog. There is
//   no free-text source-tag input — the admin can only rename tags that
//   actually exist in the corpus. The `to` input is free-text (validated
//   server-side per D9 / lib/tags.ts validateTagStrict).
//
// On submit: POST /api/admin/tags/rename {from, to}. On 200 → router.refresh()
// re-renders the page (catalog + audit trail update). On 400/500 → render the
// error inline.

import { useRouter } from "next/navigation";
import { useState } from "react";

import { STUB_ROLE_HEADER } from "@/lib/auth";

export interface RenameFormProps {
  /** Catalog of existing tag names; supplied by the server component. */
  catalog: string[];
}

type SubmitStatus =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string }
  | { kind: "success"; affectedCount: number; partialFailure: boolean };

export function RenameForm({ catalog }: RenameFormProps): React.ReactNode {
  const router = useRouter();
  const [from, setFrom] = useState<string>(catalog[0] ?? "");
  const [to, setTo] = useState<string>("");
  const [status, setStatus] = useState<SubmitStatus>({ kind: "idle" });

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setStatus({ kind: "submitting" });

    let res: Response;
    try {
      res = await fetch(`/api/admin/tags/rename`, {
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
        affected_entry_count: number;
        partial_failure: boolean;
      };
      setStatus({
        kind: "success",
        affectedCount: body.affected_entry_count,
        partialFailure: body.partial_failure,
      });
      setTo("");
      router.refresh();
      return;
    }

    let errorMessage = `http_${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; issues?: Array<{ message?: string }> };
      const issueMessage = body.issues?.[0]?.message;
      errorMessage = issueMessage ?? body.error ?? errorMessage;
    } catch {
      // Non-JSON body; keep the http_<status> fallback.
    }
    setStatus({ kind: "error", message: errorMessage });
  }

  const submitting = status.kind === "submitting";
  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Rename tag"
      data-testid="admin-tags-rename-form"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        padding: "0.75rem",
        border: "1px solid var(--kramer-neutral)",
        borderRadius: "0.375rem",
      }}
    >
      <h3 style={{ margin: 0, fontSize: "1rem" }}>Rename</h3>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <span style={{ fontSize: "0.75rem", color: "var(--kramer-neutral)" }}>From</span>
          <select
            data-testid="admin-tags-rename-from"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            disabled={submitting || catalog.length === 0}
            required
            style={{
              fontFamily: "inherit",
              fontSize: "0.9375rem",
              padding: "0.375rem 0.5rem",
              minWidth: "12rem",
            }}
          >
            {catalog.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <span style={{ fontSize: "0.75rem", color: "var(--kramer-neutral)" }}>To</span>
          <input
            type="text"
            data-testid="admin-tags-rename-to"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            disabled={submitting}
            required
            maxLength={64}
            style={{
              fontFamily: "inherit",
              fontSize: "0.9375rem",
              padding: "0.375rem 0.5rem",
              minWidth: "12rem",
            }}
          />
        </label>
        <button
          type="submit"
          disabled={submitting || from.length === 0 || to.length === 0}
          data-testid="admin-tags-rename-submit"
          style={{
            fontFamily: "inherit",
            fontSize: "0.9375rem",
            padding: "0.5rem 1rem",
            borderRadius: "0.375rem",
            border: "1px solid var(--kramer-neutral)",
            background: "var(--kramer-neutral)",
            color: "var(--kramer-bg)",
            cursor: submitting ? "wait" : "pointer",
            alignSelf: "flex-end",
          }}
        >
          {submitting ? "Renaming…" : "Rename"}
        </button>
      </div>
      {status.kind === "error" && (
        <p
          role="alert"
          data-testid="admin-tags-rename-error"
          style={{ fontSize: "0.8125rem", color: "#ff6b6b", margin: 0 }}
        >
          {status.message}
        </p>
      )}
      {status.kind === "success" && (
        <p
          role="status"
          data-testid="admin-tags-rename-success"
          style={{ fontSize: "0.8125rem", color: "var(--kramer-neutral)", margin: 0 }}
        >
          Renamed across {status.affectedCount} {status.affectedCount === 1 ? "entry" : "entries"}
          {status.partialFailure ? " (with partial failure — re-submit to finish)" : ""}.
        </p>
      )}
    </form>
  );
}
