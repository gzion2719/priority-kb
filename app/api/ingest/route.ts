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

import { withAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getEmbedder } from "@/lib/embedding";
import { createEntry, EmptyBodyAfterScrubError } from "@/lib/ingest";
import { IngestBody, issuesFromZodError } from "@/lib/ingest-schema";
import { logEvent } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
