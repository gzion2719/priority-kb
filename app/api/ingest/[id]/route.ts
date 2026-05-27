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

import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { entries } from "@/drizzle/schema";
import { withAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getEmbedder } from "@/lib/embedding";
import { EmptyBodyAfterScrubError, EntryNotFoundError, updateEntry } from "@/lib/ingest";
import { IngestBodyForPut, issuesFromZodError } from "@/lib/ingest-schema";
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

  const result = IngestBodyForPut.safeParse(parsed);
  if (!result.success) {
    return NextResponse.json(
      { error: "invalid_request", issues: issuesFromZodError(result.error) },
      { status: 400 },
    );
  }

  // ADR-0021 §D4 — preserve current `entries.sensitivity` when PUT omits
  // it (worker-initiated PUTs do so to close the dispatch-to-PUT
  // downgrade race). Human-admin PUTs continue to supply sensitivity in
  // the body and bypass this read entirely.
  const db = getDb();
  let resolvedSensitivity: (typeof result.data)["sensitivity"];
  if (result.data.sensitivity !== undefined) {
    resolvedSensitivity = result.data.sensitivity;
  } else {
    const rows = await db
      .select({ sensitivity: entries.sensitivity })
      .from(entries)
      .where(eq(entries.id, id));
    if (rows.length === 0) {
      // Same shape as the EntryNotFoundError branch below — surface 404
      // before reaching updateEntry (which would otherwise re-discover
      // the missing row inside its FOR UPDATE).
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    resolvedSensitivity = rows[0]!.sensitivity;
  }

  // ADR-0021 §D3 — optional worker attribution headers logged into
  // audit_log.payload. Browser PUTs omit them; worker PUTs supply both.
  // Build the object so that ONLY defined keys land — passing
  // `{ worker_id: "x", job_id: undefined }` would leak an explicit
  // undefined into downstream consumers that use `"key" in obj` checks.
  const workerId = req.headers.get("x-worker-id") ?? undefined;
  const jobId = req.headers.get("x-worker-job-id") ?? undefined;
  let audit_extra: { worker_id?: string; job_id?: string } | undefined;
  if (workerId !== undefined || jobId !== undefined) {
    audit_extra = {};
    if (workerId !== undefined) audit_extra.worker_id = workerId;
    if (jobId !== undefined) audit_extra.job_id = jobId;
  }

  try {
    const updated = await updateEntry({
      db,
      embedder: getEmbedder(),
      id,
      input: { ...result.data, sensitivity: resolvedSensitivity },
      source: { kind: "direct" },
      audit_extra,
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
