// app/api/admin/tags/route.ts — M4 #4 PR-C suggest endpoint.
//
// Per ADR-0025 D5: GET /api/admin/tags?prefix=<string> returns the role-
// filtered catalog sorted by entry_count DESC then alphabetical, with optional
// case-insensitive ILIKE prefix match. The route is admin-only via withAdmin;
// the lib's role-relative entry_count is a no-op here (admin sees all
// sensitivities), but the role plumbing exists for PR-C-future-callers (e.g.
// the Ingestion Agent tool — see app/api/agent/ingest/route.ts dispatchTool
// "list_tags" case which calls the same lib with the agent's resolved role).
//
// Iron-rule notes:
//   #2  withAdmin enforces admin-only on the server.
//   #6  sensitivity filter parameter is wired (no-op for admin role; defends
//       against future caller changes).
//
// Per ADR-0025 D5 the response shape is { tags: Array<{ name, entry_count }> }.

import { NextResponse, type NextRequest } from "next/server";

import { withAdmin } from "@/lib/auth";
import { listAdminTagsForRole } from "@/lib/admin-tags";
import { getPool } from "@/lib/db";
import { logEvent } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handler(req: NextRequest): Promise<Response> {
  // M3 plan-CR fix: normalize searchParams.get's `string | null` →
  // `string | undefined`, then trim, then if-empty treat as undefined (full
  // catalog). Empty-string ≡ no filter, same as missing. The lib applies
  // the same normalization defensively, but doing it route-side too keeps
  // the wire contract observable from the route's own input shape.
  // Use `new URL(req.url)` instead of `req.nextUrl` for test-portability:
  // `req.nextUrl` is a NextRequest-only field, but route tests instantiate
  // plain `Request` objects (mirrors PR-A rename/delete route test pattern).
  // Both NextRequest and Request expose `.url`, so URL.parse round-trips
  // identically in either environment.
  const rawPrefix = new URL(req.url).searchParams.get("prefix");
  const prefix = rawPrefix !== null && rawPrefix.trim() !== "" ? rawPrefix.trim() : undefined;

  // B1 plan-CR fix: NO length cap on the prefix. D5 doesn't specify one,
  // withAdmin gates the surface, and Next.js's default request size limit
  // bounds the worst case. A defensive cap based on MAX_TAG_LENGTH would
  // also conflate UTF-16 .length with NFC code-point counting (D9's measure)
  // and silently reject legitimate Hebrew prefix queries.

  try {
    const tags = await listAdminTagsForRole(getPool(), "admin", { prefix });
    return NextResponse.json({ tags }, { status: 200 });
  } catch (err) {
    logEvent({
      kind: "route",
      route: "GET /api/admin/tags",
      latency_ms: 0,
      cost_usd: null,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

export const GET = withAdmin(handler);
