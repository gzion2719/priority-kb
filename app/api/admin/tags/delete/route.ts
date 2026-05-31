// app/api/admin/tags/delete/route.ts — M4 #4 PR-A delete endpoint.
//
// Mirrors rename/route.ts shape (same A4 validation-vs-audit policy, same
// A8 no-throw lib contract, same fallback-audit catastrophic path). See
// rename/route.ts for the full reasoning.
//
// Distinct kind on the audit row: "tag_delete" instead of "tag_rename".

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { withAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getEmbedder } from "@/lib/embedding";
import { logEvent } from "@/lib/log";
import * as schema from "@/drizzle/schema";
import { deleteTag, TagValidationError } from "@/lib/tags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DeleteBody = z.object({
  tag: z.string(),
});

async function handler(req: NextRequest): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_request", issues: [{ path: "", code: "invalid_json" }] },
      { status: 400 },
    );
  }

  const zod = DeleteBody.safeParse(parsed);
  if (!zod.success) {
    return NextResponse.json(
      {
        error: "invalid_request",
        issues: zod.error.issues.map((i) => ({ path: i.path.join("."), code: i.code })),
      },
      { status: 400 },
    );
  }

  try {
    const result = await deleteTag({
      db: getDb(),
      embedder: getEmbedder(),
      tag: zod.data.tag,
    });
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
      return NextResponse.json(
        {
          error: "invalid_request",
          issues: [{ path: err.field, code: err.reason, message: err.message }],
        },
        { status: 400 },
      );
    }
    logEvent({
      kind: "route",
      route: "POST /api/admin/tags/delete",
      latency_ms: 0,
      cost_usd: null,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await getDb()
        .insert(schema.audit_log)
        .values({
          kind: "tag_delete",
          prompt_hash: null,
          payload: {
            tag: zod.data.tag,
            affected_entry_ids: [],
            affected_entry_count: 0,
            partial_failure: true,
            partial_failure_reason: `route_caught: ${err instanceof Error ? err.name : "Unknown"}`,
          },
        });
    } catch {
      // Last-ditch.
    }
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

export const POST = withAdmin(handler);
