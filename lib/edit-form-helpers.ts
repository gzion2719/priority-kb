// lib/edit-form-helpers.ts — pure helpers for the M4 #2 admin entry editor.
//
// The EditForm client component delegates parsing / validation / payload
// shape to this module so the logic is unit-testable without RTL or a
// jsdom env (project convention — see lib/agent-chat-state.ts,
// lib/sse-parse.ts, lib/query-chat-state.ts).

import type { Sensitivity } from "@/drizzle/schema";

/** Max length per tag — mirrors IngestBody's tag string-length constraint. */
export const TAG_MAX_LEN = 64;
/** Max number of tags — mirrors IngestBody's tags-array length cap. */
export const TAG_MAX_COUNT = 32;

/**
 * Parse a CSV input string into a tags array. Trim each token, drop
 * empty tokens, preserve order. NO comma-in-tag escape mechanism —
 * documented limitation (BACKLOG: chip-input UX upgrade).
 *
 * The PUT route's Zod boundary will reject over-length tags (≤ 64
 * chars) and over-count arrays (≤ 32 tags); this helper does NOT
 * enforce those caps. Use `findInvalidTags` for client-side preflight.
 */
export function parseTagsCsv(input: string): string[] {
  if (input.length === 0) return [];
  return input
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Inverse of `parseTagsCsv` for prefilling the form input from a stored array. */
export function tagsToCsv(tags: readonly string[]): string {
  return tags.join(", ");
}

/**
 * Client-side preflight on the tags array. Returns the indexes of tags
 * that violate IngestBody's per-element constraints. Empty result means
 * the tags are safe to submit.
 */
export function findInvalidTags(tags: readonly string[]): {
  tooLong: number[];
  tooMany: boolean;
} {
  const tooLong: number[] = [];
  tags.forEach((t, i) => {
    if (t.length > TAG_MAX_LEN) tooLong.push(i);
  });
  return { tooLong, tooMany: tags.length > TAG_MAX_COUNT };
}

/**
 * Shape of the PUT route's error response. Documented at
 * `app/api/ingest/[id]/route.ts` — Zod errors are projected via
 * `issuesFromZodError` to `{path, code}` per WORKFLOW.md secret-
 * redaction rule (no value echoing).
 */
export interface RouteErrorResponse {
  error: string;
  issues?: Array<{ path: string; code: string }>;
}

/**
 * Project a route error response to a per-field error map for the form
 * UI. The `path` is dotted (e.g. "last_verified_at"); a top-level error
 * (e.g. `error: "invalid_json"`) lands under the sentinel key `_form`.
 *
 * First issue per path wins; later issues on the same path are dropped
 * silently — rare in practice since a single field usually produces one
 * Zod issue, but the policy is documented to avoid drift.
 */
export function formatRouteErrors(resp: RouteErrorResponse): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(resp.issues) && resp.issues.length > 0) {
    for (const iss of resp.issues) {
      const key = iss.path.length === 0 ? "_form" : iss.path;
      if (out[key] === undefined) out[key] = iss.code;
    }
    return out;
  }
  out._form = resp.error;
  return out;
}

/** Controlled state for the EditForm component. */
export interface EditFormState {
  title: string;
  category: string;
  tagsCsv: string;
  body: string;
  source_pointer: string;
  /** YYYY-MM-DD from `<input type="date">`. Empty string means "not set". */
  last_verified_at: string;
  sensitivity: Sensitivity;
}
