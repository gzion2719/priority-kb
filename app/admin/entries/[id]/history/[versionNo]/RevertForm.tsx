"use client";

// app/admin/entries/[id]/history/[versionNo]/RevertForm.tsx — M4 #3 revert affordance.
//
// One button: "Revert to v<N>". On click, fires PUT /api/ingest/[id] with
// the snapshot's {title, category, tags, body, sensitivity} + the CURRENT
// entry's {source_pointer, last_verified_at}. The route appends a new
// entries_versions row via updateEntry (non-destructive — old versions
// stay in the trail), re-derives chunks, re-derives caption from the
// reverted body. On 200 → navigate back to the admin list.
//
// Iron-rule footprint matches EditForm.tsx (M4 #2):
//   #2  writes still flow through lib/ingest.ts::updateEntry (sole writer).
//   #4  PUT route admin-gated via withAdmin; client adds the stub-auth
//       header for dev. M5 swaps to session cookie.
//   #6  sensitivity from the SNAPSHOT is sent explicitly (not omitted),
//       so the route uses it rather than IngestBodyForPut's
//       "preserve current" branch (per ADR-0021 §D4 — that branch is the
//       worker-only escape hatch). The page renders a banner above the
//       button when snapshot sensitivity differs from current so the
//       admin sees the tier change BEFORE clicking.
//   #10 direct-path PUT — prompt_hash never sent from client.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { STUB_ROLE_HEADER } from "@/lib/auth";
import { formatRouteErrors, type RouteErrorResponse } from "@/lib/edit-form-helpers";
import type { Sensitivity } from "@/drizzle/schema";

export interface RevertFormProps {
  entryId: string;
  /** The version being reverted TO. */
  versionNo: number;
  /** What the new version_no will be after the revert succeeds. */
  nextVersionNo: number;
  /** Snapshot fields to restore. */
  snapshot: {
    title: string;
    category: string;
    tags: string[];
    body: string;
    sensitivity: Sensitivity;
  };
  /** Preserved-from-current fields the snapshot doesn't carry. */
  preserved: {
    source_pointer: string;
    /** ISO string from server. */
    last_verified_at: string;
  };
}

type SubmitStatus =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; errors: Record<string, string> };

export function RevertForm(props: RevertFormProps): React.ReactNode {
  const router = useRouter();
  const [status, setStatus] = useState<SubmitStatus>({ kind: "idle" });

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setStatus({ kind: "submitting" });

    const payload = {
      title: props.snapshot.title,
      category: props.snapshot.category,
      tags: props.snapshot.tags,
      body: props.snapshot.body,
      // Sensitivity is the snapshot's — load-bearing per iron rule #6.
      // The page banner above the button surfaces any tier change.
      sensitivity: props.snapshot.sensitivity,
      // source_pointer + last_verified_at preserved from CURRENT entry
      // (snapshot doesn't carry them per lib/ingest.ts:343-347). Rationale:
      // revert restores text/structure; it does NOT re-attest verification
      // freshness or change the ticket pointer.
      source_pointer: props.preserved.source_pointer,
      last_verified_at: props.preserved.last_verified_at,
    };

    let res: Response;
    try {
      res = await fetch(`/api/ingest/${props.entryId}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          [STUB_ROLE_HEADER]: "admin",
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      setStatus({
        kind: "error",
        errors: { _form: err instanceof Error ? err.message : "network_error" },
      });
      return;
    }

    if (res.ok) {
      router.push("/admin/entries");
      router.refresh();
      return;
    }

    let body: RouteErrorResponse = { error: `http_${res.status}` };
    try {
      body = (await res.json()) as RouteErrorResponse;
    } catch {
      // Non-JSON error body; keep the http_<status> fallback.
    }
    setStatus({ kind: "error", errors: formatRouteErrors(body) });
  }

  const submitting = status.kind === "submitting";
  const errorMsg =
    status.kind === "error" ? (status.errors._form ?? "see field errors above") : null;

  return (
    <form onSubmit={handleSubmit} aria-label="Revert to version" data-testid="admin-revert-form">
      <p style={{ fontSize: "0.875rem", color: "var(--kramer-neutral)", marginBottom: "0.75rem" }}>
        Reverting writes a new version v{props.nextVersionNo} containing v{props.versionNo}&apos;s
        title, body, tags, category, and sensitivity. The source pointer and last-verified date are
        preserved from the current entry. The full version history is kept — revert is
        non-destructive.
      </p>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <button
          type="submit"
          disabled={submitting}
          data-testid="admin-revert-submit"
          style={{
            fontFamily: "inherit",
            fontSize: "0.9375rem",
            padding: "0.5rem 1rem",
            borderRadius: "0.375rem",
            border: "1px solid var(--kramer-neutral)",
            background: "var(--kramer-neutral)",
            color: "var(--kramer-dark)",
            cursor: submitting ? "wait" : "pointer",
          }}
        >
          {submitting
            ? "Reverting…"
            : `Revert to v${props.versionNo} (creates v${props.nextVersionNo})`}
        </button>
        <Link
          href={`/admin/entries/${props.entryId}/history`}
          style={{
            fontFamily: "inherit",
            fontSize: "0.9375rem",
            padding: "0.5rem 1rem",
            borderRadius: "0.375rem",
            border: "1px solid var(--kramer-neutral)",
            textDecoration: "none",
            color: "inherit",
          }}
        >
          Cancel
        </Link>
      </div>
      {errorMsg !== null && (
        <p
          role="alert"
          data-testid="admin-revert-error"
          style={{ fontSize: "0.8125rem", color: "#ff6b6b", marginTop: "0.5rem" }}
        >
          {errorMsg}
        </p>
      )}
    </form>
  );
}
