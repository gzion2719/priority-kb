// app/api/admin/tags/rename/route.ts — M4 #4 PR-A rename endpoint.
//
// Per ADR-0025 D1 + Amendment A2: admin posts {from, to}; the lib's renameTag
// loops full updateEntry per affected entry (sync; async deferred). The lib
// owns the operation-level audit row (kind:"tag_rename") lifecycle — write at
// start, update at end. The route's job is just:
//   - withAdmin gate
//   - Zod body validation (malformed JSON / wrong shape → 400, NO audit)
//   - Catch TagValidationError from the lib (D9 charset/length failure → 400, NO audit)
//   - Call renameTag and return its result as 200 JSON
//   - On unexpected throw, write a fallback tag_rename audit row + return 500
//
// Iron-rule notes (ADR-0025 Consequences):
//   #2  withAdmin enforces admin-only on the server.
//   #6  rename loop preserves each entry's sensitivity (re-read inside FOR UPDATE).
//   #8  lib uses getEmbedder() stub-by-default factory; no live API in tests.
//   #10 admin-direct write; new audit kind doesn't match agent_% so CHECK doesn't fire.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { withAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getEmbedder } from "@/lib/embedding";
import { logEvent } from "@/lib/log";
import * as schema from "@/drizzle/schema";
import { renameTag, TagValidationError } from "@/lib/tags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Zod gates the wire shape; D9 charset/length validation lives in the lib so
// the rule isn't bypassed by a future non-HTTP caller.
const RenameBody = z.object({
  from: z.string(),
  to: z.string(),
});

async function handler(req: NextRequest): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    // Malformed JSON: per A4 case 1, 400 with no audit row.
    return NextResponse.json(
      { error: "invalid_request", issues: [{ path: "", code: "invalid_json" }] },
      { status: 400 },
    );
  }

  const zod = RenameBody.safeParse(parsed);
  if (!zod.success) {
    // Wrong shape: per A4 case 1, 400 with no audit row.
    return NextResponse.json(
      {
        error: "invalid_request",
        issues: zod.error.issues.map((i) => ({ path: i.path.join("."), code: i.code })),
      },
      { status: 400 },
    );
  }

  try {
    const result = await renameTag({
      db: getDb(),
      embedder: getEmbedder(),
      from: zod.data.from,
      to: zod.data.to,
    });
    // m7 code-CR fix: use affected_entry_ids.length as the surfaced count.
    // The lib's TagOperationResult does not currently expose an uncapped
    // affected_entry_count separately from the array; at the 1000-cap
    // boundary the array.length IS 1000 and the audit row's truncated_count
    // captures the overflow. Route response matches array length by design.
    return NextResponse.json(
      {
        audit_id: result.audit_id,
        affected_entry_count: result.affected_entry_ids.length,
        partial_failure: result.partial_failure,
        ...(result.partial_failure_reason !== undefined
          ? { partial_failure_reason: result.partial_failure_reason }
          : {}),
      },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof TagValidationError) {
      // D9 validation failure at lib boundary: per A4 case 2, 400 with no audit.
      return NextResponse.json(
        {
          error: "invalid_request",
          issues: [{ path: err.field, code: err.reason, message: err.message }],
        },
        { status: 400 },
      );
    }
    // Catastrophic path (per A8): DB unreachable before lib's initial audit
    // INSERT. Write a fallback audit row (best-effort) so the operation is
    // still observable, then return 500.
    logEvent({
      kind: "route",
      route: "POST /api/admin/tags/rename",
      latency_ms: 0,
      cost_usd: null,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await getDb()
        .insert(schema.audit_log)
        .values({
          kind: "tag_rename",
          prompt_hash: null,
          payload: {
            from: zod.data.from,
            to: zod.data.to,
            affected_entry_ids: [],
            affected_entry_count: 0,
            partial_failure: true,
            partial_failure_reason: `route_caught: ${err instanceof Error ? err.name : "Unknown"}`,
          },
        });
    } catch {
      // Last-ditch — observability already captured the error via logEvent above.
    }
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

export const POST = withAdmin(handler);
