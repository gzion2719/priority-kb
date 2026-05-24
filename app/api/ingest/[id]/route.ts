// app/api/ingest/[id]/route.ts — M2a item 5 (update path).
//
// Admin-only PUT endpoint. Same Zod boundary as create (`POST /api/ingest`):
// full-body update, not partial. Append-only version history via
// `entries_versions`; old chunks deleted + re-derived per ADR-0009 §7.
//
// 404 semantics: the route returns `{error:"not_found"}` when the id is
// unknown. `EntryNotFoundError` is thrown by `updateEntry` BEFORE any
// write happens (the SELECT FOR UPDATE finds zero rows), so there is no
// partial-state to clean up.
//
// Runtime is pinned to Node for the same reasons as the create route.

import { NextResponse, type NextRequest } from "next/server";

import { withAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getEmbedder } from "@/lib/embedding";
import { EmptyBodyAfterScrubError, EntryNotFoundError, updateEntry } from "@/lib/ingest";
import { IngestBody, issuesFromZodError } from "@/lib/ingest-schema";
import { logEvent } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// UUID v4 shape — same as `gen_random_uuid()` in Postgres. The route
// rejects malformed ids with 400 before doing any DB work; the DB would
// reject them anyway with a less useful error.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteContext = { params: Promise<{ id: string }> };

async function handler(req: NextRequest, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "invalid_request", issues: [{ path: "id", code: "invalid_uuid" }] },
      { status: 400 },
    );
  }

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
    const updated = await updateEntry({
      db: getDb(),
      embedder: getEmbedder(),
      id,
      input: result.data,
      source: { kind: "direct" },
    });
    return NextResponse.json(updated, { status: 200 });
  } catch (err) {
    if (err instanceof EntryNotFoundError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (err instanceof EmptyBodyAfterScrubError) {
      return NextResponse.json(
        { error: "invalid_request", issues: [{ path: "body", code: "empty_after_scrub" }] },
        { status: 400 },
      );
    }
    logEvent({
      kind: "route",
      route: "PUT /api/ingest/[id]",
      latency_ms: 0,
      cost_usd: null,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

export const PUT = withAdmin<RouteContext>(handler);
