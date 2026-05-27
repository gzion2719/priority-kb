// lib/ingest-schema.ts — Zod boundary shared by the create + update routes.
//
// Single source of truth so the two `/api/ingest*` routes can't drift on
// field constraints. Lives in `lib/` per project convention (lib/auth.ts,
// lib/embedding.ts, lib/log.ts) — App Router would also tolerate this as
// `app/api/ingest/_lib/`, but the existing convention wins.
//
// Two schemas live here. Pick the one matching the HTTP method:
//   - `IngestBody` — full-record schema. Used by `POST /api/ingest`
//     (create) and via the agent path through `ingestThroughAgent*`.
//     `sensitivity` is REQUIRED (no prior value to preserve).
//   - `IngestBodyForPut` — derived from `IngestBody` with
//     `sensitivity` optional. Used by `PUT /api/ingest/[id]` (update)
//     per ADR-0021 §D4 so the M2b #5 worker can omit the field and
//     have the route preserve the current `entries.sensitivity` from
//     the DB — closing the dispatch-to-PUT downgrade race.
//
// If you reach for `IngestBody` on the PUT path, you'll bounce admin
// users who omit `sensitivity`; if you reach for `IngestBodyForPut` on
// the POST path, you'll create entries with `sensitivity = undefined`
// and explode at the DB CHECK. Pick deliberately.

import { z } from "zod";

import { sensitivityEnum } from "@/drizzle/schema";

// `last_verified_at` must be ≤ now + 24h. The 24h slack covers timezone
// differences between the admin's clock and the server's UTC; without it,
// an admin in IDT (+03) posting a same-moment timestamp can land slightly
// ahead of server UTC and get rejected. A far-future date defeats iron
// rule #7's purpose ("we actually verified this on date X").
const FUTURE_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * The body shape accepted by `POST /api/ingest` (create) and
 * `PUT /api/ingest/[id]` (update). Both endpoints accept the full entry
 * shape — partial updates are not modeled in M2a.
 *
 * Iron-rule footprint:
 *   #6  sensitivity is required + enum-constrained (re-derived from
 *       `sensitivityEnum` in `drizzle/schema.ts` — no second source of truth).
 *   #7  source_pointer + last_verified_at are required; future-date capped
 *       at now+24h; source_pointer rejects ASCII control chars.
 */
export const IngestBody = z.object({
  title: z.string().min(1).max(512),
  category: z.string().min(1).max(128),
  tags: z.array(z.string().min(1).max(64)).max(32).default([]),
  body: z.string().min(1).max(200_000),
  source_pointer: z
    .string()
    .min(1)
    .max(2048)
    // Reject ASCII control chars; the value is stored verbatim and
    // rendered in citations + logs. Newlines / nulls break both.
    .refine((s) => !/[\x00-\x1f]/.test(s), { message: "control_chars" }),
  last_verified_at: z
    .string()
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .refine((d) => d.getTime() <= Date.now() + FUTURE_GRACE_MS, {
      message: "future",
    }),
  sensitivity: z.enum(sensitivityEnum),
});

/**
 * PUT-only variant: `sensitivity` is optional so the M2b #5 worker
 * (per [ADR-0021 §D4](../docs/adr/0021-worker-http-callback-architecture.md))
 * can omit the field and have the route preserve the current
 * `entries.sensitivity` value. Closes the dispatch-to-PUT sensitivity-
 * downgrade race where an admin re-tags an entry during the worker's
 * dwell time.
 *
 * POST `/api/ingest` continues to use {@link IngestBody} — creates
 * have no prior value to preserve, so `sensitivity` stays required.
 */
export const IngestBodyForPut = IngestBody.extend({
  sensitivity: z.enum(sensitivityEnum).optional(),
});

/**
 * Project Zod issues to a fixed, leak-safe shape: {path, code}. Never echo
 * the offending value or the original `message` — see WORKFLOW.md secret-
 * redaction rule + ADR-0009 §5 (no raw PII retention).
 */
export function issuesFromZodError(err: z.ZodError): Array<{ path: string; code: string }> {
  return err.issues.map((iss) => ({
    path: iss.path.join("."),
    code: iss.code,
  }));
}
