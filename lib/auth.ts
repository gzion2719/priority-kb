/**
 * Stub authentication for admin-only routes (M2a).
 *
 * Reads the `x-stub-user-role` request header and gates handler execution.
 * This is dev-only; M5 swaps it for a Microsoft Entra ID middleware (see
 * ROADMAP.md M5). The stub's contract is shaped so the swap is a one-file
 * change: route handlers continue to call `withAdmin(handler)` and the
 * implementation behind it changes.
 *
 * Iron-rule enforcement:
 *   - Non-negotiable #4: admin-only writes are gated server-side, not
 *     UI-hidden. `withAdmin` is the single server-side primitive — handler
 *     bodies are unreachable without passing through it.
 *
 * Role-recognition semantics:
 *   - `x-stub-user-role: admin` → handler runs.
 *   - `x-stub-user-role: user`  → 403 {error:"forbidden"} (recognized role,
 *                                  insufficient permission).
 *   - Any other header value — missing, empty, wrong case ("Admin"),
 *     unknown role ("superuser"), or comma-joined duplicates
 *     ("admin, user") → 401 {error:"unauthorized"} with
 *     `WWW-Authenticate: Bearer realm="stub"` (RFC 7235 §4.1; M5 keeps
 *     the same scheme and swaps the realm value). ASCII-whitespace
 *     padding is normalized away by the Fetch Headers spec on
 *     set/append, so no in-helper trim is needed.
 *
 * The strict 401-vs-403 split: 401 means "we cannot identify you"; 403
 * means "we know who you are and you are not allowed". Present-but-invalid
 * lands in 401 because we cannot establish identity from a malformed value.
 *
 * Observability: rejection events are NOT logged here. The first route
 * consumer (`POST /api/ingest` per ROADMAP M2a item 4) logs the
 * request-level event including the auth outcome. Adding helper-level
 * logging now would emit silent telemetry under `npm test`.
 */

import type { NextRequest } from "next/server";

export type Role = "admin" | "user";

/**
 * App Router route handler signature. The context arg is generic so
 * dynamic-segment routes (`app/api/.../[id]/route.ts`) can declare their
 * own `{ params: Promise<{ id: string }> }` shape and have it preserved
 * through the wrapper.
 */
export type RouteHandler<C = unknown> = (
  req: NextRequest,
  context: C,
) => Promise<Response> | Response;

// Lowercase; `Headers.get()` is case-insensitive on lookup, so this
// matches `X-Stub-User-Role` and any other casing on the wire.
const HEADER_NAME = "x-stub-user-role";

const UNAUTHORIZED_HEADERS = {
  "content-type": "application/json",
  "www-authenticate": 'Bearer realm="stub"',
} as const;

const FORBIDDEN_HEADERS = {
  "content-type": "application/json",
} as const;

const UNAUTHORIZED_BODY = JSON.stringify({ error: "unauthorized" });
const FORBIDDEN_BODY = JSON.stringify({ error: "forbidden" });

function unauthorized(): Response {
  return new Response(UNAUTHORIZED_BODY, { status: 401, headers: UNAUTHORIZED_HEADERS });
}

function forbidden(): Response {
  return new Response(FORBIDDEN_BODY, { status: 403, headers: FORBIDDEN_HEADERS });
}

/**
 * Wraps an App Router route handler so it only runs for admin requests.
 *
 * @param handler The route handler to gate. Receives the original
 *                `NextRequest` and App Router context unchanged.
 * @returns A handler with the same signature. On admin requests, the
 *          wrapped handler runs and its response is returned verbatim.
 *          On non-admin requests, a rejection `Response` (401 or 403)
 *          is returned and the wrapped handler is NOT invoked.
 *
 * @example
 *   export const POST = withAdmin(async (req) => {
 *     const body = await req.json();
 *     // ... admin-only work ...
 *     return Response.json({ ok: true });
 *   });
 */
export function withAdmin<C>(handler: RouteHandler<C>): RouteHandler<C> {
  return (req, context) => {
    const raw = req.headers.get(HEADER_NAME);
    if (raw === "admin") return handler(req, context);
    if (raw === "user") return forbidden();
    return unauthorized();
  };
}
