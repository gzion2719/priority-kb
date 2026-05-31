"use client";

// app/admin/tags/DeleteForm.tsx — M4 #4 PR-A delete affordance.
//
// Per ADR-0025 D8 + Amendment A5: tag SELECT pre-filled from catalog (no
// free-text source-tag input). On submit POST /api/admin/tags/delete {tag};
// on 200 router.refresh() re-renders the page.

import { useRouter } from "next/navigation";
import { useState } from "react";

import { STUB_ROLE_HEADER } from "@/lib/auth";

export interface DeleteFormProps {
  catalog: string[];
}

type SubmitStatus =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string }
  | { kind: "success"; affectedCount: number; partialFailure: boolean };

export function DeleteForm({ catalog }: DeleteFormProps): React.ReactNode {
  const router = useRouter();
  const [tag, setTag] = useState<string>(catalog[0] ?? "");
  const [status, setStatus] = useState<SubmitStatus>({ kind: "idle" });

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setStatus({ kind: "submitting" });

    let res: Response;
    try {
      res = await fetch(`/api/admin/tags/delete`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [STUB_ROLE_HEADER]: "admin",
        },
        body: JSON.stringify({ tag }),
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
      router.refresh();
      return;
    }

    let errorMessage = `http_${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; issues?: Array<{ message?: string }> };
      errorMessage = body.issues?.[0]?.message ?? body.error ?? errorMessage;
    } catch {
      // Non-JSON body.
    }
    setStatus({ kind: "error", message: errorMessage });
  }

  const submitting = status.kind === "submitting";
  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Delete tag"
      data-testid="admin-tags-delete-form"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        padding: "0.75rem",
        border: "1px solid var(--kramer-neutral)",
        borderRadius: "0.375rem",
      }}
    >
      <h3 style={{ margin: 0, fontSize: "1rem" }}>Delete</h3>
      <p style={{ fontSize: "0.75rem", color: "var(--kramer-neutral)", margin: 0 }}>
        Removes the tag from every entry that has it. Re-embedding runs synchronously per affected
        entry; large catalogs may take a while.
      </p>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <span style={{ fontSize: "0.75rem", color: "var(--kramer-neutral)" }}>Tag</span>
          <select
            data-testid="admin-tags-delete-tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            disabled={submitting || catalog.length === 0}
            required
            style={{
              fontFamily: "inherit",
              fontSize: "0.9375rem",
              padding: "0.375rem 0.5rem",
              minWidth: "12rem",
            }}
          >
            {catalog.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={submitting || tag.length === 0}
          data-testid="admin-tags-delete-submit"
          style={{
            fontFamily: "inherit",
            fontSize: "0.9375rem",
            padding: "0.5rem 1rem",
            borderRadius: "0.375rem",
            border: "1px solid #ff6b6b",
            background: "transparent",
            color: "#ff6b6b",
            cursor: submitting ? "wait" : "pointer",
            alignSelf: "flex-end",
          }}
        >
          {submitting ? "Deleting…" : "Delete"}
        </button>
      </div>
      {status.kind === "error" && (
        <p
          role="alert"
          data-testid="admin-tags-delete-error"
          style={{ fontSize: "0.8125rem", color: "#ff6b6b", margin: 0 }}
        >
          {status.message}
        </p>
      )}
      {status.kind === "success" && (
        <p
          role="status"
          data-testid="admin-tags-delete-success"
          style={{ fontSize: "0.8125rem", color: "var(--kramer-neutral)", margin: 0 }}
        >
          Deleted from {status.affectedCount} {status.affectedCount === 1 ? "entry" : "entries"}
          {status.partialFailure ? " (with partial failure — re-submit to finish)" : ""}.
        </p>
      )}
    </form>
  );
}
