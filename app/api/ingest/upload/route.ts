// app/api/ingest/upload/route.ts — M2b #4 file upload endpoint.
//
// Admin uploads a binary (PDF, DOCX, screenshot) + structured metadata; the
// route stores the binary via the BlobStore abstraction, creates a
// placeholder `entries` row carrying the admin-supplied tags + sensitivity +
// source_pointer + last_verified_at, then enqueues a job whose payload
// carries the `entry_id` for the M2b #5+ OCR/parse worker to fill in the
// real body via `updateEntry`.
//
// Why a placeholder entry at upload time (not at worker-time):
//   - Iron rule #6 (every entry tagged): the entry exists with `sensitivity`
//     set from the admin's form, so the worker can re-read it at
//     chunk-write time per ADR-0019 §D8 #6 (jobs carry `entry_id` only;
//     no sensitivity snapshot in payload).
//   - Iron rule #7 (source_pointer + last_verified_at): also set at upload
//     time from the admin's form fields.
//   - ADR-0019 §D5 (payload is a control-plane envelope): the binary lives
//     in BlobStore, the path lives in the payload, the entry_id ties the
//     pipeline together.
//
// Atomicity caveat: `createEntry` opens its own transaction, then
// `enqueueJob` opens a separate one. If `enqueueJob` fails after
// `createEntry` commits, the entry is orphaned (placeholder body, no
// queued job). This is rare and manually recoverable (admin can re-upload
// the same content — `idempotencyKey: contentHash` will dedupe the
// re-enqueue). Filed as a BACKLOG follow-up: "atomic createEntry +
// enqueueJob via shared tx-handle pattern (ADR-0019 §D)".
//
// Iron-rule footprint:
//   #1  No secrets in code; blob bytes live on FS (or future S3) gated by
//       admin-only auth.
//   #2  Admin-only via `withAdmin`. The placeholder entry insert is a
//       direct write (via `createEntry`'s direct-source path), consistent
//       with the existing `POST /api/ingest` direct-ingest path.
//   #4  `withAdmin` server-side. Non-admin gets 403.
//   #6  `sensitivity` required + enum-constrained via the shared
//       `IngestBody` Zod schema (sans body).
//   #7  `source_pointer` + `last_verified_at` required by the same schema.
//   #8  No live API calls — embedder injected via factory (same pattern as
//       `POST /api/ingest`).
//   #12 Upload path stays up when Voyage/Claude are down — the placeholder
//       body's chunk + embed runs via the existing degraded-mode-aware
//       embedder factory.
//
// Runtime is pinned to Node: blob storage uses Node `fs`, enqueueJob writes
// via pg, embedder uses Node crypto. Edge runtime would silently break all
// three.

import { NextResponse, type NextRequest } from "next/server";

import { withAdmin } from "@/lib/auth";
import { LocalFSBlobStore, sanitizeOriginalName, type BlobStore } from "@/lib/blob-storage";
import { getDb } from "@/lib/db";
import { getEmbedder } from "@/lib/embedding";
import { createEntry, EmptyBodyAfterScrubError } from "@/lib/ingest";
import { IngestBody, issuesFromZodError } from "@/lib/ingest-schema";
import { enqueueJob } from "@/lib/jobs";
import { logEvent } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 10 MiB default — env-tunable for ops who need to lift it. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
function maxBytes(): number {
  const env = process.env.UPLOAD_MAX_BYTES;
  if (env === undefined) return DEFAULT_MAX_BYTES;
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

/**
 * Allowlist of accepted MIME types. The M2b #5/#6/#7 OCR + parse handlers
 * are written against this set; any new content-type requires a new
 * handler PR.
 */
const ALLOWED_CONTENT_TYPES = new Set<string>([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

/**
 * Form-field metadata shape. Same fields as `IngestBody` minus `body` —
 * the route injects the placeholder body itself. `IngestBody` is the
 * source of truth for the field-level validation rules (length caps,
 * sensitivity enum, source_pointer control-char rejection,
 * last_verified_at future-cap, …); the upload route reuses it by
 * omitting `body` from the shape and injecting the placeholder server-
 * side. This means a future tightening of `IngestBody` (e.g., a new
 * sensitivity tier) flows automatically to the upload path.
 */
const UploadMetadata = IngestBody.omit({ body: true });

/**
 * Sentinel body for placeholder entries. The M2b #5+ worker replaces this
 * post-OCR via `updateEntry`. Long enough to clear the post-scrub empty
 * body check.
 *
 * Path-free by design (code-CR M1+M2, 2026-05-27):
 *
 *   1. `lib/scrub.ts scrubPii` runs INSIDE `createEntry` against the body
 *      before storage. It replaces digit-runs with `[id]`, email-shaped
 *      tokens with `[email]`, phone-shaped runs with `[phone]`. A
 *      placeholder containing a `<sha256>/<filename>` path is corrupted
 *      whenever the filename's hex/digit runs match those heuristics —
 *      the documented "audit-log correlation pointer" then no longer
 *      exists in the stored body.
 *
 *   2. The placeholder entry is retrievable via `/api/retrieve`
 *      (sensitivity-gated) while its body is still the sentinel. A body
 *      containing the blob path leaks both (a) the content-fingerprint
 *      (sha256 prefix) and (b) the original filename — which may itself
 *      carry customer/vendor PII (e.g., `ACME Q4 invoice.pdf`).
 *
 * Correlation lives in `jobs.payload.blob_storage_path` (worker-only)
 * and `audit_log` (admin-only) — neither user-retrievable.
 */
const PLACEHOLDER_BODY = "[pending media OCR — awaiting worker]";

// Module-level BlobStore singleton. Defaults to LocalFSBlobStore for M2b;
// M5 swaps in an S3 implementation behind the same interface. Tests
// substitute via `setBlobStoreForTests` (kept out of the production
// surface — exported only at the module level here for the test seam).
let blobStoreSingleton: BlobStore | null = null;
function getBlobStore(): BlobStore {
  if (blobStoreSingleton === null) {
    blobStoreSingleton = new LocalFSBlobStore();
  }
  return blobStoreSingleton;
}

/** Test seam — DO NOT call from production code. */
export function setBlobStoreForTests(store: BlobStore | null): void {
  blobStoreSingleton = store;
}

async function handler(req: NextRequest): Promise<Response> {
  // ---------- Step 1: Content-Length pre-check ----------
  // Reject oversize uploads BEFORE buffering the full body via
  // `req.formData()` — avoids a 100MB malicious upload from an admin-
  // credentialed session pinning event-loop CPU on parser work.
  // Chunked-encoding requests AND malformed-header requests fall through
  // to the Step 5 post-buffer length check (code-CR m4, 2026-05-27 —
  // tightened comment to acknowledge both cases).
  const declaredLen = req.headers.get("content-length");
  const limit = maxBytes();
  if (declaredLen !== null) {
    const n = Number(declaredLen);
    if (Number.isFinite(n) && n > limit) {
      return NextResponse.json(
        { error: "payload_too_large", issues: [{ path: "file", code: "exceeds_max_bytes" }] },
        { status: 413 },
      );
    }
  }

  // ---------- Step 2: parse multipart ----------
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "invalid_request", issues: [{ path: "", code: "invalid_multipart" }] },
      { status: 400 },
    );
  }

  // ---------- Step 3: extract + validate fields ----------
  const fileField = form.get("file");
  if (!(fileField instanceof File)) {
    return NextResponse.json(
      { error: "invalid_request", issues: [{ path: "file", code: "missing" }] },
      { status: 400 },
    );
  }

  const metadataField = form.get("metadata");
  if (typeof metadataField !== "string") {
    return NextResponse.json(
      { error: "invalid_request", issues: [{ path: "metadata", code: "missing" }] },
      { status: 400 },
    );
  }

  let metadataParsed: unknown;
  try {
    metadataParsed = JSON.parse(metadataField);
  } catch {
    return NextResponse.json(
      { error: "invalid_request", issues: [{ path: "metadata", code: "invalid_json" }] },
      { status: 400 },
    );
  }

  const metaResult = UploadMetadata.safeParse(metadataParsed);
  if (!metaResult.success) {
    return NextResponse.json(
      { error: "invalid_request", issues: issuesFromZodError(metaResult.error) },
      { status: 400 },
    );
  }

  // ---------- Step 4: content-type allowlist ----------
  const contentType = fileField.type;
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return NextResponse.json(
      {
        error: "unsupported_media_type",
        issues: [{ path: "file.type", code: "not_allowlisted" }],
      },
      { status: 415 },
    );
  }

  // ---------- Step 5: materialize buffer + post-buffer size check ----------
  // Code-CR m3 (2026-05-27): check the actually-buffered byteLength,
  // not `fileField.size`. If the parser ever returns a buffer longer
  // than the File metadata claimed, the buffer-side check catches it.
  // Order: materialize first, then check, then call BlobStore.
  let buffer: Buffer;
  try {
    buffer = Buffer.from(await fileField.arrayBuffer());
  } catch {
    return NextResponse.json(
      { error: "invalid_request", issues: [{ path: "file", code: "unreadable" }] },
      { status: 400 },
    );
  }
  if (buffer.byteLength > limit) {
    return NextResponse.json(
      { error: "payload_too_large", issues: [{ path: "file", code: "exceeds_max_bytes" }] },
      { status: 413 },
    );
  }

  // ---------- Step 6: store binary in BlobStore ----------
  let blob: { path: string; bytes: number; contentHash: string };
  try {
    blob = await getBlobStore().put(buffer, contentType, fileField.name);
  } catch (err) {
    logEvent({
      kind: "route",
      route: "POST /api/ingest/upload",
      latency_ms: 0,
      cost_usd: null,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "internal", issues: [{ path: "file", code: "blob_storage_failed" }] },
      { status: 500 },
    );
  }

  // ---------- Step 7: create placeholder entry ----------
  // The placeholder body lands in `entries.body` and gets chunked +
  // embedded by the existing pipeline (a single ~30-char chunk). When
  // M2b #5+ wires the OCR handler, the worker calls `updateEntry` with
  // the real body which triggers re-chunking + re-embedding via
  // `entries_versions` append. Until then, the placeholder entry is
  // retrievable but its sole chunk's content is the sentinel string —
  // dashboards / retrievers see it as "this entry is pending OCR."
  let entryId: string;
  try {
    const created = await createEntry({
      db: getDb(),
      embedder: getEmbedder(),
      input: {
        title: metaResult.data.title,
        category: metaResult.data.category,
        tags: metaResult.data.tags,
        body: PLACEHOLDER_BODY,
        source_pointer: metaResult.data.source_pointer,
        last_verified_at: metaResult.data.last_verified_at,
        sensitivity: metaResult.data.sensitivity,
      },
      source: { kind: "direct" },
    });
    entryId = created.id;
  } catch (err) {
    if (err instanceof EmptyBodyAfterScrubError) {
      // Defensive — the placeholder body cannot trigger this branch
      // unless `scrubPii` is updated to strip the literal sentinel text.
      // Surface as 500 with a stable code so the test surface can pin it.
      return NextResponse.json(
        { error: "internal", issues: [{ path: "body", code: "placeholder_scrubbed_empty" }] },
        { status: 500 },
      );
    }
    logEvent({
      kind: "route",
      route: "POST /api/ingest/upload",
      latency_ms: 0,
      cost_usd: null,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }

  // ---------- Step 8: enqueue job ----------
  // Idempotency key = contentHash directly (NOT sha256(blob_storage_path)
  // which would double-hash; the path already encodes the content hash).
  // Re-uploading identical bytes with a different filename produces the
  // same contentHash → enqueue is a no-op, caller sees the prior job's
  // existingState.
  let job: Awaited<ReturnType<typeof enqueueJob>>;
  try {
    job = await enqueueJob(getDb(), {
      queue: "ingest",
      payload: {
        entry_id: entryId,
        blob_storage_path: blob.path,
        content_type: contentType,
        // Sanitized filename in the payload (code-CR m6, 2026-05-27).
        // The raw admin-supplied name could carry shell metacharacters
        // (`$(rm -rf /)`, `'; DROP TABLE jobs;--`) that the M2b #5+
        // OCR-handler subprocess invocation must not shell-exec. The
        // sanitized form is also what's already in `blob.path` — match
        // them so dashboards see the same name on both fields.
        original_filename: sanitizeOriginalName(fileField.name),
        byte_length: blob.bytes,
      },
      idempotencyKey: blob.contentHash,
    });
  } catch (err) {
    // The placeholder entry has already committed. We don't roll it back
    // here — the orphan is recoverable (admin re-uploads → same
    // contentHash → either succeeds the second time, or hits an
    // already-existing job for the same content). Surface a 500 with
    // entry_id so the caller can correlate.
    logEvent({
      kind: "route",
      route: "POST /api/ingest/upload",
      latency_ms: 0,
      cost_usd: null,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "internal", entry_id: entryId, issues: [{ path: "job", code: "enqueue_failed" }] },
      { status: 500 },
    );
  }

  // ---------- Step 9: success response ----------
  const responseBody: Record<string, unknown> = {
    entry_id: entryId,
    job_id: job.id,
    created: job.created,
    blob_storage_path: blob.path,
    bytes: blob.bytes,
  };
  if (!job.created) {
    responseBody.existing_state = job.existingState;
  }
  return NextResponse.json(responseBody, { status: 201 });
}

export const POST = withAdmin(handler);
