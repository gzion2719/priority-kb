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

import type { Sensitivity } from "@/drizzle/schema";

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
export const STUB_ROLE_HEADER = "x-stub-user-role";

/**
 * Canonical role parser. Single source of truth for stub-auth header
 * interpretation — both the route-handler wrappers below and the
 * server-component entry-detail page at app/entries/[id]/page.tsx
 * call this, so a future M5 swap to Entra ID only edits one function.
 *
 * Returns the recognized `Role` for exact-match `"admin"` or `"user"`,
 * else `null`. Anything-else collapses to `null` indistinguishably:
 *   - missing header (`raw === null`)
 *   - empty string
 *   - wrong case (`"Admin"`)
 *   - unknown roles (`"superuser"`)
 *   - comma-joined duplicate headers (`"admin, user"` from
 *     Headers.append spec)
 *
 * The wrappers below add their own 401-vs-403 semantics on top of
 * this null/admin/user trichotomy; the page uses `null` directly to
 * collapse all auth-failure cases into the same `notFound()` shape
 * (existence-leak defense for iron rule #6 — see lib/entries.ts).
 */
export function resolveRoleFromHeader(raw: string | null): Role | null {
  if (raw === "admin") return "admin";
  if (raw === "user") return "user";
  return null;
}

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
    const role = resolveRoleFromHeader(req.headers.get(STUB_ROLE_HEADER));
    if (role === "admin") return handler(req, context);
    if (role === "user") return forbidden();
    return unauthorized();
  };
}

/**
 * Route-handler signature with the authenticated `Role` injected as the
 * third arg. Used by `withUserOrAdmin` so handlers can derive the
 * `sensitivity_allowed[]` array from a known-good role without re-reading
 * the header (and without risking a casing mismatch between auth and the
 * downstream SQL).
 */
export type AuthenticatedRouteHandler<C = unknown> = (
  req: NextRequest,
  context: C,
  role: Role,
) => Promise<Response> | Response;

/**
 * Wraps an App Router route handler so it only runs for authenticated
 * requests (either `admin` or `user`), injecting the resolved `Role` as
 * the third handler arg. The retrieval surface uses this — admins and
 * end users both query the KB; iron-rule #6 is enforced downstream by
 * mapping `role → sensitivity_allowed[]` and compiling it into SQL
 * WHERE (never as a post-hoc filter).
 *
 * Role-recognition semantics:
 *   - `x-stub-user-role: admin` → handler runs with role="admin".
 *   - `x-stub-user-role: user`  → handler runs with role="user".
 *   - Anything else → 401 (same shape as `withAdmin`'s unauthorized
 *                    path: WWW-Authenticate Bearer realm="stub").
 *
 * There is no 403 path here by construction: both recognized roles are
 * authorized to query. Per-row authorization is the SQL's job.
 *
 * The wrapper does NOT log the resolved role — observability lives in
 * the route's `finally{}` audit-row write, where the role is part of
 * the audit payload.
 */
export function withUserOrAdmin<C>(handler: AuthenticatedRouteHandler<C>): RouteHandler<C> {
  return (req, context) => {
    const role = resolveRoleFromHeader(req.headers.get(STUB_ROLE_HEADER));
    if (role === null) return unauthorized();
    return handler(req, context, role);
  };
}

/**
 * Maps an authenticated role to the iron-rule-#6 sensitivity allow-list.
 *
 *   - admin → ['public', 'internal', 'restricted']
 *   - user  → ['public', 'internal']
 *
 * Authoritative source: ADR-0012 §6 table (`docs/adr/0012-retrieval-pipeline.md`).
 * The three-tier enum's design intent is that `restricted` IS the admin-only
 * escape hatch — `internal` is org-internal and reachable by authenticated
 * end users. A mapping that hid `internal` from user-role would collapse
 * the three-tier enum to functional two-tier (`internal` ≡ `restricted`).
 *
 * The mapping is total over the `Role` union; any handler that calls this
 * has already passed `withUserOrAdmin`'s gate, so there is no fallback
 * branch and no `[]` default — an empty allow-list would silently degrade
 * retrieval to "no content" instead of failing the auth layer.
 */
export function sensitivityAllowedForRole(role: Role): Sensitivity[] {
  // Returns a fresh mutable array per call so downstream consumers (e.g.
  // keywordCandidates(pool, query, sensitivity, limit)) can pass it as
  // Sensitivity[] without a readonly cast. The mapping itself is total
  // and immutable; we just avoid forcing readonly into the public type.
  if (role === "admin") return ["public", "internal", "restricted"];
  return ["public", "internal"];
}
