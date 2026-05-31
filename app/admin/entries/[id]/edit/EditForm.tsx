"use client";

// app/admin/entries/[id]/edit/EditForm.tsx — M4 #2 client form.
//
// Thin presentation layer: all parsing / validation / payload shape lives
// in lib/edit-form-helpers.ts + lib/iso-date.ts so the logic is unit-
// testable without RTL or a jsdom env (project convention — see
// lib/agent-chat-state.ts, lib/sse-parse.ts, lib/query-chat-state.ts).
//
// Iron-rule footprint:
//   #4  PUT route is admin-gated via withAdmin; this client adds the
//       stub-auth header so dev-mode fetch authenticates correctly.
//       M5 swaps stub → session cookie.
//   #6  sensitivity is explicit form input over the full enum (the
//       admin form ALWAYS supplies it — IngestBodyForPut's optional
//       sensitivity is the worker-only escape hatch per ADR-0021 §D4).
//   #7  source_pointer + last_verified_at are required form fields;
//       Zod future-grace + control-char rules enforced at the route.
//   #10 direct-path PUT — `prompt_hash` never sent from client; route
//       writes audit with kind:"ingest_update" + prompt_hash:null.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { sensitivityEnum, type Sensitivity } from "@/drizzle/schema";
import { STUB_ROLE_HEADER } from "@/lib/auth";
import {
  findInvalidTags,
  formatRouteErrors,
  parseTagsCsv,
  TAG_MAX_COUNT,
  TAG_MAX_LEN,
  tagsToCsv,
  type EditFormState,
  type RouteErrorResponse,
} from "@/lib/edit-form-helpers";
import { IngestBody } from "@/lib/ingest-schema";
import { toDateInputValue, toIsoWithLocalOffset } from "@/lib/iso-date";

export interface EditFormProps {
  entryId: string;
  initial: {
    title: string;
    category: string;
    tags: string[];
    body: string;
    source_pointer: string;
    /** ISO datetime string from the server. Re-rendered as YYYY-MM-DD. */
    last_verified_at: string;
    sensitivity: Sensitivity;
  };
}

type SubmitStatus =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; errors: Record<string, string> };

export function EditForm({ entryId, initial }: EditFormProps): React.ReactNode {
  const router = useRouter();
  const [state, setState] = useState<EditFormState>({
    title: initial.title,
    category: initial.category,
    tagsCsv: tagsToCsv(initial.tags),
    body: initial.body,
    source_pointer: initial.source_pointer,
    last_verified_at: toDateInputValue(new Date(initial.last_verified_at)),
    sensitivity: initial.sensitivity,
  });
  const [status, setStatus] = useState<SubmitStatus>({ kind: "idle" });

  // Live tag preview — render the parsed array so the admin sees what
  // will actually be submitted (per plan-CR M4).
  const parsedTags = parseTagsCsv(state.tagsCsv);
  const tagPreflight = findInvalidTags(parsedTags);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setStatus({ kind: "submitting" });

    let isoLastVerified: string;
    try {
      isoLastVerified = toIsoWithLocalOffset(state.last_verified_at);
    } catch {
      setStatus({ kind: "error", errors: { last_verified_at: "invalid_date" } });
      return;
    }

    const payload = {
      title: state.title,
      category: state.category,
      tags: parsedTags,
      body: state.body,
      source_pointer: state.source_pointer,
      last_verified_at: isoLastVerified,
      sensitivity: state.sensitivity,
    };

    // Client-side preflight against the same Zod schema the route uses
    // — single source of truth (per plan-CR Q11). If the client passes,
    // the server's parse is guaranteed to pass modulo server-side state
    // (e.g., the entry being deleted between page load and submit → 404).
    const preflight = IngestBody.safeParse(payload);
    if (!preflight.success) {
      const errors: Record<string, string> = {};
      for (const iss of preflight.error.issues) {
        const key = iss.path.length === 0 ? "_form" : iss.path.join(".");
        if (errors[key] === undefined) errors[key] = iss.code;
      }
      setStatus({ kind: "error", errors });
      return;
    }

    let res: Response;
    try {
      res = await fetch(`/api/ingest/${entryId}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          // Stub-auth header — dev only. M5 swaps to session cookie.
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
      // Navigate back to the list (per plan-CR m9) — admin's mental
      // model is "I came from a row; return to the row's neighborhood."
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
  const errors = status.kind === "error" ? status.errors : {};

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Edit entry"
      data-testid="admin-edit-form"
      style={formStyle}
    >
      <Field id="title" label="Title" error={errors.title}>
        <input
          id="title"
          type="text"
          value={state.title}
          dir="auto"
          maxLength={512}
          required
          onChange={(e) => setState({ ...state, title: e.target.value })}
          style={textInputStyle}
        />
      </Field>

      <Field id="category" label="Category" error={errors.category}>
        <input
          id="category"
          type="text"
          value={state.category}
          maxLength={128}
          required
          onChange={(e) => setState({ ...state, category: e.target.value })}
          style={textInputStyle}
        />
      </Field>

      <Field id="tags" label="Tags (comma-separated)" error={errors.tags}>
        <input
          id="tags"
          type="text"
          value={state.tagsCsv}
          dir="auto"
          onChange={(e) => setState({ ...state, tagsCsv: e.target.value })}
          style={textInputStyle}
        />
        <div
          data-testid="admin-edit-tags-preview"
          style={{ fontSize: "0.75rem", marginTop: "0.25rem", color: "var(--kramer-neutral)" }}
        >
          {parsedTags.length === 0 ? (
            "No tags."
          ) : (
            <>
              <span>
                {parsedTags.length} tag{parsedTags.length === 1 ? "" : "s"}:
              </span>{" "}
              {parsedTags.map((t, i) => (
                <span
                  key={i}
                  style={{
                    display: "inline-block",
                    padding: "0.0625rem 0.375rem",
                    margin: "0 0.125rem",
                    border: "1px solid var(--kramer-neutral)",
                    borderRadius: "999px",
                    background: tagPreflight.tooLong.includes(i)
                      ? "rgba(255, 0, 0, 0.15)"
                      : "transparent",
                  }}
                >
                  {t}
                </span>
              ))}
            </>
          )}
        </div>
        {tagPreflight.tooLong.length > 0 && (
          <p style={errorTextStyle}>
            Tag too long (max {TAG_MAX_LEN} chars) at index
            {tagPreflight.tooLong.length > 1 ? "es" : ""} {tagPreflight.tooLong.join(", ")}.
          </p>
        )}
        {tagPreflight.tooMany && <p style={errorTextStyle}>Too many tags (max {TAG_MAX_COUNT}).</p>}
      </Field>

      <Field id="body" label="Body" error={errors.body}>
        <textarea
          id="body"
          value={state.body}
          dir="auto"
          required
          rows={12}
          onChange={(e) => setState({ ...state, body: e.target.value })}
          style={{ ...textInputStyle, fontFamily: "inherit", resize: "vertical" }}
        />
      </Field>

      <Field id="source_pointer" label="Source pointer" error={errors.source_pointer}>
        <input
          id="source_pointer"
          type="text"
          value={state.source_pointer}
          maxLength={2048}
          required
          onChange={(e) => setState({ ...state, source_pointer: e.target.value })}
          style={textInputStyle}
        />
      </Field>

      <Field id="last_verified_at" label="Last verified" error={errors.last_verified_at}>
        <input
          id="last_verified_at"
          type="date"
          value={state.last_verified_at}
          required
          onChange={(e) => setState({ ...state, last_verified_at: e.target.value })}
          style={textInputStyle}
        />
      </Field>

      <Field id="sensitivity" label="Sensitivity" error={errors.sensitivity}>
        <select
          id="sensitivity"
          value={state.sensitivity}
          onChange={(e) => setState({ ...state, sensitivity: e.target.value as Sensitivity })}
          style={textInputStyle}
        >
          {sensitivityEnum.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </Field>

      {errors._form !== undefined && (
        <p role="alert" data-testid="admin-edit-form-error" style={errorTextStyle}>
          {errors._form}
        </p>
      )}

      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button
          type="submit"
          disabled={submitting}
          data-testid="admin-edit-submit"
          style={primaryButtonStyle}
        >
          {submitting ? "Saving…" : "Save changes"}
        </button>
        <Link href="/admin/entries" style={secondaryLinkStyle}>
          Cancel
        </Link>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
      <label htmlFor={id} style={{ fontSize: "0.875rem", fontWeight: 600 }}>
        {label}
      </label>
      {children}
      {error !== undefined && (
        <p data-testid={`admin-edit-error-${id}`} style={errorTextStyle}>
          {error}
        </p>
      )}
    </div>
  );
}

const formStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  background: "rgba(220, 221, 222, 0.04)",
  border: "1px solid var(--kramer-neutral)",
  borderRadius: "0.5rem",
  padding: "1.25rem",
};

const textInputStyle: React.CSSProperties = {
  fontFamily: "inherit",
  fontSize: "0.9375rem",
  padding: "0.5rem 0.75rem",
  borderRadius: "0.375rem",
  border: "1px solid var(--kramer-neutral)",
  background: "rgba(220, 221, 222, 0.04)",
  color: "inherit",
};

const errorTextStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "#ff6b6b",
  margin: 0,
};

const primaryButtonStyle: React.CSSProperties = {
  fontFamily: "inherit",
  fontSize: "0.9375rem",
  padding: "0.5rem 1rem",
  borderRadius: "0.375rem",
  border: "1px solid var(--kramer-neutral)",
  background: "var(--kramer-neutral)",
  color: "var(--kramer-bg)",
  cursor: "pointer",
};

const secondaryLinkStyle: React.CSSProperties = {
  fontFamily: "inherit",
  fontSize: "0.9375rem",
  padding: "0.5rem 1rem",
  borderRadius: "0.375rem",
  border: "1px solid var(--kramer-neutral)",
  textDecoration: "none",
  color: "inherit",
  display: "inline-flex",
  alignItems: "center",
};
