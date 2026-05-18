// app/api/ingest/route.ts — M2a item 4.
//
// Admin-only ingest endpoint. Thin wrapper:
//   - withAdmin gates non-admin requests (lib/auth.ts).
//   - Zod validates the body and yields a typed IngestInput.
//   - createEntry runs the orchestrated scrub → chunk → embed → write.
//
// Iron-rule notes:
//   #4  withAdmin enforces admin-only on the server, not in UI.
//   #6  sensitivity is required + enum-constrained at the boundary.
//   #7  source_pointer + last_verified_at required at the boundary.
//   #8  no live API calls in tests — the route's tests inject mocks.
//
// Runtime is pinned to Node: lib/embedding.ts and lib/log.ts both rely on
// Node globals (Node crypto, globalThis singletons, process.stdout). Edge
// runtime would silently break them; the pin makes that a build error.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { withAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getEmbedder } from "@/lib/embedding";
import { createEntry, EmptyBodyAfterScrubError } from "@/lib/ingest";
import { logEvent } from "@/lib/log";
import { sensitivityEnum } from "@/drizzle/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Zod schema — sensitivity enum is re-derived from the Drizzle schema so a
// future enum extension does not require a second source-of-truth edit.
// `.datetime({offset:true})` rejects naive timestamps (no `Z` / `±HH:MM`)
// to match the `timestamp with time zone` column.
// `last_verified_at` must be ≤ now + 24h. The 24h slack covers timezone
// differences between the admin's clock and the server's UTC; without it,
// an admin in IDT (+03) posting a same-moment timestamp can land slightly
// ahead of server UTC and get rejected. A far-future date defeats iron
// rule #7's purpose ("we actually verified this on date X").
const FUTURE_GRACE_MS = 24 * 60 * 60 * 1000;

const IngestBody = z.object({
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
 * Project Zod issues to a fixed, leak-safe shape: {path, code}. Never echo
 * the offending value or the original `message` — see WORKFLOW.md secret-
 * redaction rule + ADR-0009 §5 (no raw PII retention).
 */
function issuesFromZodError(err: z.ZodError): Array<{ path: string; code: string }> {
  return err.issues.map((iss) => ({
    path: iss.path.join("."),
    code: iss.code,
  }));
}

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

  const result = IngestBody.safeParse(parsed);
  if (!result.success) {
    return NextResponse.json(
      { error: "invalid_request", issues: issuesFromZodError(result.error) },
      { status: 400 },
    );
  }

  try {
    const created = await createEntry({
      db: getDb(),
      embedder: getEmbedder(),
      input: result.data,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    if (err instanceof EmptyBodyAfterScrubError) {
      return NextResponse.json(
        { error: "invalid_request", issues: [{ path: "body", code: "empty_after_scrub" }] },
        { status: 400 },
      );
    }
    // Generic 500: never echo `err.message` to the client (could contain
    // PII or stack hints). Observability still gets the detail via
    // logEvent, which applies its own secret-redaction pass.
    logEvent({
      kind: "voyage",
      model: "route",
      model_version: "ingest",
      latency_ms: 0,
      cost_usd: null,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

export const POST = withAdmin(handler);
