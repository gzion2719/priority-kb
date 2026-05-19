"use client";

// app/admin/ingest/direct/page.tsx — degraded-mode direct-form fallback
// for the Ingestion Agent chat UI (ADR-0010 §7, iron rule #12).
//
// Posts JSON to `POST /api/ingest` with `source: { kind: "direct" }`
// (set server-side at the route). Used when the agent is unavailable
// (`/admin/ingest` 503 -> banner link here) or whenever the admin
// prefers not to chat. The route applies the same Zod boundary + PII
// scrub + embedding pipeline as the agent path; the only difference
// is the missing prompt-hash, which is correct — `source.kind: "direct"`
// audit rows are not subject to the iron-rule-#10 prompt-hash CHECK.
//
// Why a client component: native HTML <form method="POST"> encodes
// application/x-www-form-urlencoded by default, but `POST /api/ingest`
// calls `req.json()` and rejects non-JSON bodies. Native forms also
// cannot set the `x-stub-user-role: admin` header that `withAdmin`
// requires. So the form must be JS-driven.

import { useCallback, useState, type FormEvent } from "react";

import { sensitivityEnum, type Sensitivity } from "@/drizzle/schema";

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "ok"; entryId: string }
  | { kind: "error"; message: string };

export default function DirectIngestPage(): React.ReactElement {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [tagsCsv, setTagsCsv] = useState("");
  const [body, setBody] = useState("");
  const [sourcePointer, setSourcePointer] = useState("");
  // Capture mount-time timestamp once via a lazy useState initializer so
  // we can detect "admin hasn't edited the field" and refresh at submit.
  const [mountTimestamp] = useState(() => new Date().toISOString());
  const [lastVerified, setLastVerified] = useState(() => mountTimestamp);
  const [sensitivity, setSensitivity] = useState<Sensitivity>("internal");
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });

  const onSubmit = useCallback(
    async (ev: FormEvent<HTMLFormElement>) => {
      ev.preventDefault();
      setSubmit({ kind: "submitting" });

      const tags = tagsCsv
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      // If the admin hasn't touched the prefilled timestamp, refresh it
      // at submit time so it's "now", not page-mount time. If they did
      // edit it (anything other than the mount-time value), trust their
      // edit verbatim — admins setting a historical last-verified date
      // is the common path.
      const last_verified_at =
        lastVerified === mountTimestamp ? new Date().toISOString() : lastVerified;

      const payload = {
        title,
        category,
        tags,
        body,
        source_pointer: sourcePointer,
        last_verified_at,
        sensitivity,
      };

      let response: Response;
      try {
        response = await fetch("/api/ingest", {
          method: "POST",
          cache: "no-store",
          headers: {
            "content-type": "application/json",
            "x-stub-user-role": "admin",
          },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        setSubmit({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      if (!response.ok) {
        let detail = `${response.status} ${response.statusText}`;
        try {
          const errBody = (await response.json()) as { error?: string };
          if (errBody.error) detail = `${detail} — ${errBody.error}`;
        } catch {
          // ignore
        }
        setSubmit({ kind: "error", message: detail });
        return;
      }

      try {
        const created = (await response.json()) as { id?: string };
        setSubmit({ kind: "ok", entryId: created.id ?? "(unknown)" });
      } catch (err) {
        setSubmit({
          kind: "error",
          message: `parse: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
    [body, category, lastVerified, mountTimestamp, sensitivity, sourcePointer, tagsCsv, title],
  );

  return (
    <main className="chat-shell">
      <header>
        <h1>Direct Ingest</h1>
        <p style={{ opacity: 0.7, margin: 0 }}>
          Submit an entry without the conversational agent. Use this when the agent is down or you
          already have the entry composed.
        </p>
      </header>

      <form className="direct-form" onSubmit={onSubmit}>
        <label>
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={512}
          />
        </label>
        <label>
          Category
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            required
            maxLength={128}
          />
        </label>
        <label>
          Tags (comma-separated)
          <input value={tagsCsv} onChange={(e) => setTagsCsv(e.target.value)} />
        </label>
        <label>
          Source pointer (ticket #, doc link, conversation ref)
          <input
            value={sourcePointer}
            onChange={(e) => setSourcePointer(e.target.value)}
            required
            maxLength={2048}
          />
        </label>
        <label>
          Last verified (ISO 8601)
          <input value={lastVerified} onChange={(e) => setLastVerified(e.target.value)} required />
        </label>
        <label>
          Sensitivity
          <select
            value={sensitivity}
            onChange={(e) => setSensitivity(e.target.value as Sensitivity)}
          >
            {sensitivityEnum.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Body (markdown)
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            required
            maxLength={200000}
            dir="auto"
          />
        </label>

        <div className="chat-input-row">
          <button type="submit" className="btn cta" disabled={submit.kind === "submitting"}>
            {submit.kind === "submitting" ? "Submitting..." : "Submit entry"}
          </button>
          <a href="/admin/ingest" className="btn">
            Back to chat
          </a>
        </div>

        {submit.kind === "ok" ? (
          <div className="chat-banner info" role="status">
            Entry created: <code>{submit.entryId}</code>
          </div>
        ) : null}
        {submit.kind === "error" ? (
          <div className="chat-banner error" role="alert">
            {submit.message}
          </div>
        ) : null}
      </form>
    </main>
  );
}
