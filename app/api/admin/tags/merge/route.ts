// app/api/admin/tags/merge/route.ts — M4 #4 PR-B merge endpoint.
//
// Per ADR-0025 D3 + Amendment 2026-05-31 §A9 + Amendment 2026-06-01:
//   Admin posts {from: string[], to: string}. The lib's mergeTags loops full
//   updateEntry per affected entry inside ONE outer db.transaction() — atomic-
//   or-bust per DP1(a). Any per-iteration throw rolls back the outer tx and
//   raises MergeRollbackError carrying the audit_id captured at start; this
//   route catches it and finalizes the start-of-op tag_merge audit row with
//   partial_failure: true + the redacted error class.
//
// Route's responsibilities:
//   - withAdmin gate.
//   - Zod body validation (malformed JSON / wrong shape → 400, NO audit).
//   - Server-side catalog membership re-verification for each from[i] (A5
//     mechanical floor extended to merge: a multi-select form bypass that posts
//     a free-text from element should be rejected at 400 BEFORE the merge runs,
//     because the partial-success failure mode of "N-1 valid + 1 invalid"
//     silently shrinks the affected count without alerting the admin).
//   - Catch TagValidationError from the lib (D9 / A5 / DP2 failure → 400, NO audit).
//   - Catch MergeRollbackError → finalize audit row + return 500.
//   - On unexpected throw before the lib's start audit row: write a fallback
//     tag_merge audit row + return 500 (mirrors PR-A rename/delete pattern).
//
// HTTP status semantics (per the m4-disagree CR decision):
//   - 400: client-side problem (shape, validation, catalog miss). Don't retry
//     without fixing the request.
//   - 500: server-side rollback or catastrophic failure. The forensic surface
//     lives in the audit row's partial_failure_reason. 409 was considered and
//     rejected — outer-tx rollback under DP1 covers both transient (Voyage 5xx)
//     and catastrophic (DB lost) causes; mapping to 409 implies retriable
//     client conflict which is misleading.
//
// Iron-rule notes mirror PR-A:
//   #2  withAdmin enforces admin-only on the server.
//   #6  merge loop preserves each entry's sensitivity (re-read inside FOR UPDATE).
//       Audit row is admin-role-only; no cross-tier leak.
//   #8  lib uses getEmbedder() stub-by-default factory; no live API in tests.
//   #10 admin-direct write; new audit kind doesn't match agent_% so CHECK doesn't fire.

import { NextResponse, type NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { withAdmin } from "@/lib/auth";
import { getDb, getPool } from "@/lib/db";
import { getEmbedder } from "@/lib/embedding";
import { logEvent } from "@/lib/log";
import * as schema from "@/drizzle/schema";
import { listAdminTagsForRole } from "@/lib/admin-tags";
import { mergeTags, MergeRollbackError, TagValidationError, normalizeTag } from "@/lib/tags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Zod gates the wire shape. D9 / A5 / DP2 charset / array-shape validation
// happens inside the lib so non-HTTP callers can't bypass it.
const MergeBody = z.object({
  from: z.array(z.string()).min(1),
  to: z.string(),
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

  const zod = MergeBody.safeParse(parsed);
  if (!zod.success) {
    return NextResponse.json(
      {
        error: "invalid_request",
        issues: zod.error.issues.map((i) => ({ path: i.path.join("."), code: i.code })),
      },
      { status: 400 },
    );
  }

  // Server-side catalog membership re-check on every from[i] (per m3 + B1 CR
  // fixes + ADR-0025 Amendment 2026-06-01). The form uses checkboxes pre-filled
  // from the catalog, so legitimate UI requests always pass; this floor exists
  // for curl/bot bypass attempts. Uses admin role (route is withAdmin-gated),
  // so the catalog covers all sensitivity tiers.
  //
  // B1 CR fix 2026-06-01: normalize each from[i] BEFORE the catalog comparison.
  // The catalog stores already-normalized bytes (every prior write went through
  // updateEntry → D9 normalization). Comparing raw bytes against normalized
  // catalog entries silently rejected legitimate non-form callers (NFC drift,
  // whitespace variants). The lib also normalizes downstream — but the route
  // would have rejected the request before the lib got a chance.
  let adminCatalog: Awaited<ReturnType<typeof listAdminTagsForRole>>;
  try {
    adminCatalog = await listAdminTagsForRole(getPool(), "admin");
  } catch (err) {
    logEvent({
      kind: "route",
      route: "POST /api/admin/tags/merge",
      latency_ms: 0,
      cost_usd: null,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
  const catalogNames = new Set(adminCatalog.map((c) => c.name));
  const normalizedFrom = zod.data.from.map((f) => normalizeTag(f));
  const unknownFromIndexes: number[] = [];
  for (let i = 0; i < normalizedFrom.length; i += 1) {
    if (!catalogNames.has(normalizedFrom[i])) unknownFromIndexes.push(i);
  }
  if (unknownFromIndexes.length > 0) {
    return NextResponse.json(
      {
        error: "invalid_request",
        // Surface the raw bytes the caller sent (not the normalized form) so
        // the admin sees what they actually typed in the error message.
        issues: unknownFromIndexes.map((i) => ({
          path: "from",
          code: "not_in_catalog",
          message: `from element "${zod.data.from[i]}" is not present in the tag catalog`,
        })),
      },
      { status: 400 },
    );
  }

  try {
    const result = await mergeTags({
      db: getDb(),
      embedder: getEmbedder(),
      from: zod.data.from,
      to: zod.data.to,
    });
    // Per the Q1 decision: omit partial_failure when false. The lib's
    // mergeTags returns partial_failure: false on success (the atomic-or-bust
    // path makes any partial-failure scenario throw MergeRollbackError instead).
    return NextResponse.json(
      {
        audit_id: result.audit_id,
        affected_entry_count: result.affected_entry_ids.length,
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
    if (err instanceof MergeRollbackError) {
      // Outer tx rolled back. The start audit row exists (auto-tx before outer
      // tx opened). Finalize it with partial_failure: true so the forensic
      // trail distinguishes rollback failure from no-op merge.
      logEvent({
        kind: "route",
        route: "POST /api/admin/tags/merge",
        latency_ms: 0,
        cost_usd: null,
        status: "error",
        error: `merge_rollback: ${err.cause_class}`,
      });
      try {
        // M3 CR fix 2026-06-01: atomic single-statement UPDATE using pg's
        // jsonb concatenation operator `||`. The original implementation did
        // SELECT payload + UPDATE in two statements with a TOCTOU window where
        // a concurrent writer could clobber the partial_failure fields.
        // `payload || $1::jsonb` preserves every existing key and overwrites
        // only the keys present in the patch — exactly the "splice in
        // partial_failure" semantics, in one statement. Wrapped in its own
        // try/catch: a finalize failure shouldn't mask the 500.
        const patch = JSON.stringify({
          partial_failure: true,
          partial_failure_reason: `rollback: ${err.cause_class}`,
        });
        await getDb()
          .update(schema.audit_log)
          .set({
            payload: sql`${schema.audit_log.payload} || ${patch}::jsonb`,
          })
          .where(eq(schema.audit_log.id, err.audit_id));
      } catch {
        // Finalize failed — observability already captured the rollback above.
      }
      return NextResponse.json({ error: "internal", audit_id: err.audit_id }, { status: 500 });
    }
    // Catastrophic path: pre-audit-row failure (e.g., DB unreachable before
    // the lib's initial INSERT). Write a fallback audit row best-effort.
    logEvent({
      kind: "route",
      route: "POST /api/admin/tags/merge",
      latency_ms: 0,
      cost_usd: null,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    // B2 CR fix 2026-06-01: normalize from/to before the fallback INSERT so
    // the catastrophic-path audit payload uses the same byte representation
    // as the normal path. Normalization is total + no-throw (no D9 charset
    // validation runs here), so this is safe to call on any input that passed
    // Zod's z.string() check.
    const fallbackFrom = zod.data.from.map((f) => normalizeTag(f));
    const fallbackTo = normalizeTag(zod.data.to);
    // N5 CR fix 2026-06-01: surface the fallback audit_id in the 500 response
    // so the catastrophic path matches the rollback path's forensic shape.
    let fallbackAuditId: string | undefined;
    try {
      const [row] = await getDb()
        .insert(schema.audit_log)
        .values({
          kind: "tag_merge",
          prompt_hash: null,
          payload: {
            from: fallbackFrom,
            to: fallbackTo,
            affected_entry_ids: [],
            affected_entry_count: 0,
            partial_failure: true,
            partial_failure_reason: `route_caught: ${err instanceof Error ? err.name : "Unknown"}`,
          },
        })
        .returning({ id: schema.audit_log.id });
      fallbackAuditId = row?.id;
    } catch {
      // Last-ditch — observability already captured the error via logEvent above.
    }
    return NextResponse.json(
      fallbackAuditId !== undefined
        ? { error: "internal", audit_id: fallbackAuditId }
        : { error: "internal" },
      { status: 500 },
    );
  }
}

export const POST = withAdmin(handler);
