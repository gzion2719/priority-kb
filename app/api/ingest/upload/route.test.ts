// app/api/ingest/upload/route.test.ts — unit tests for the upload route.
//
// Mocks the heavy collaborators (DB, embedder, createEntry, enqueueJob)
// because this suite exercises the Zod boundary, multipart parsing,
// content-length / size / content-type guards, and the BlobStore + enqueue
// wiring. End-to-end behaviour against a real Postgres lives in
// tests/upload.integration.test.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetLogSink, setLogSink } from "@/lib/log";

// Silence logEvent NDJSON sink during this suite (the 500-path tests
// write one). Mirrors app/api/ingest/route.test.ts.
beforeAll(() => setLogSink(() => undefined));
afterAll(() => resetLogSink());

// Mock the heavy collaborators BEFORE importing the route.
vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    /* unused — createEntry + enqueueJob are mocked below */
  })),
}));
vi.mock("@/lib/embedding", () => ({
  getEmbedder: vi.fn(() => ({ model: "stub", version: "v1" })),
}));

const createEntryMock = vi.fn();
vi.mock("@/lib/ingest", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ingest")>("@/lib/ingest");
  return {
    ...actual,
    createEntry: (...args: unknown[]) => createEntryMock(...args),
  };
});

const enqueueJobMock = vi.fn();
vi.mock("@/lib/jobs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/jobs")>("@/lib/jobs");
  return {
    ...actual,
    enqueueJob: (...args: unknown[]) => enqueueJobMock(...args),
  };
});

import { POST, setBlobStoreForTests } from "@/app/api/ingest/upload/route";
import { createInMemoryBlobStore } from "@/lib/blob-storage";

const validMetadata = {
  title: "Customer invoice scan",
  category: "ar-invoicing",
  tags: ["scan", "invoice"],
  source_pointer: "ticket://9001",
  last_verified_at: "2026-05-27T10:00:00Z",
  sensitivity: "internal",
};

function pdfFile(bytes = "PDF binary content"): File {
  return new File([bytes], "invoice.pdf", { type: "application/pdf" });
}

function buildForm(opts: {
  file?: File | string;
  metadata?: unknown;
  omitFile?: boolean;
  omitMetadata?: boolean;
}): FormData {
  const fd = new FormData();
  if (!opts.omitFile) {
    if (typeof opts.file === "string") {
      fd.set("file", opts.file);
    } else if (opts.file !== undefined) {
      fd.set("file", opts.file);
    } else {
      fd.set("file", pdfFile());
    }
  }
  if (!opts.omitMetadata) {
    fd.set(
      "metadata",
      typeof opts.metadata === "string"
        ? opts.metadata
        : JSON.stringify(opts.metadata ?? validMetadata),
    );
  }
  return fd;
}

function adminReq(form: FormData): Request {
  return new Request("http://x/api/ingest/upload", {
    method: "POST",
    headers: { "x-stub-user-role": "admin" },
    body: form,
  });
}

function userReq(form: FormData): Request {
  return new Request("http://x/api/ingest/upload", {
    method: "POST",
    headers: { "x-stub-user-role": "user" },
    body: form,
  });
}

beforeEach(() => {
  createEntryMock.mockReset();
  enqueueJobMock.mockReset();
  createEntryMock.mockResolvedValue({
    id: "00000000-0000-0000-0000-0000000000aa",
    version_no: 1,
    chunk_count: 1,
  });
  enqueueJobMock.mockResolvedValue({
    id: "00000000-0000-0000-0000-0000000000bb",
    created: true,
  });
  setBlobStoreForTests(createInMemoryBlobStore());
});

afterEach(() => {
  setBlobStoreForTests(null); // restore the production singleton
  vi.clearAllMocks();
});

describe("POST /api/ingest/upload — auth passthrough (withAdmin wiring)", () => {
  it("rejects non-admin without invoking createEntry or enqueueJob", async () => {
    const res = await POST(userReq(buildForm({})) as never, {} as never);
    expect(res.status).toBe(403);
    // Negative-assertion: if withAdmin weren't wired, the mocks would
    // have been called. Asserting NOT-called distinguishes "auth gates
    // the route" from "auth wrapped but ignored".
    expect(createEntryMock).not.toHaveBeenCalled();
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/ingest/upload — happy path", () => {
  it("returns 201 with entry_id + job_id + blob path on success", async () => {
    const res = await POST(adminReq(buildForm({})) as never, {} as never);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.entry_id).toBe("00000000-0000-0000-0000-0000000000aa");
    expect(body.job_id).toBe("00000000-0000-0000-0000-0000000000bb");
    expect(body.created).toBe(true);
    expect(body.blob_storage_path).toMatch(/^[a-f0-9]{64}\/invoice\.pdf$/);
    expect(typeof body.bytes).toBe("number");
  });

  it("calls createEntry with metadata + path-free placeholder body", async () => {
    await POST(adminReq(buildForm({})) as never, {} as never);
    expect(createEntryMock).toHaveBeenCalledTimes(1);
    const call = createEntryMock.mock.calls[0]![0];
    expect(call.input.title).toBe(validMetadata.title);
    expect(call.input.sensitivity).toBe(validMetadata.sensitivity);
    expect(call.input.source_pointer).toBe(validMetadata.source_pointer);
    // Code-CR M1+M2 (2026-05-27): placeholder body is path-FREE — the
    // blob path lives in jobs.payload + audit_log only. This closes both
    // (a) the scrubPii-mangling-the-path bug (digit/email-shaped
    // filenames triggered [id]/[email] substitution mid-path) AND (b)
    // the iron-rule #6 semantic leak (retrieval users could see the
    // original filename + content-fingerprint in citation text).
    expect(call.input.body).toBe("[pending media OCR — awaiting worker]");
    expect(call.input.body).not.toContain("/"); // no path leak
    expect(call.input.body).not.toMatch(/[a-f0-9]{16,}/); // no hash leak
    expect(call.source).toEqual({ kind: "direct" });
  });

  it("placeholder body is invariant to original filename (scrubPii-mangling defense)", async () => {
    // Code-CR M1 negative-assertion (2026-05-27): if a future
    // implementer reverts to "[pending media OCR — blob: <path>]" using
    // an interpolation that includes the filename, this test would fail
    // because a phone/id/email-shaped filename would land [phone]/[id]/
    // [email] tokens in entries.body after scrubPii. The assertion that
    // the body is the literal constant — regardless of the filename —
    // pins the path-free contract.
    const phonyFile = new File(["bytes"], "0501234567.pdf", {
      type: "application/pdf",
    });
    await POST(adminReq(buildForm({ file: phonyFile })) as never, {} as never);
    const call = createEntryMock.mock.calls[0]![0];
    expect(call.input.body).toBe("[pending media OCR — awaiting worker]");
  });

  it("calls enqueueJob with idempotencyKey = contentHash directly (NOT sha256 of path)", async () => {
    await POST(adminReq(buildForm({})) as never, {} as never);
    expect(enqueueJobMock).toHaveBeenCalledTimes(1);
    const args = enqueueJobMock.mock.calls[0]![1];
    expect(args.queue).toBe("ingest");
    expect(args.payload.entry_id).toBe("00000000-0000-0000-0000-0000000000aa");
    expect(args.payload.blob_storage_path).toMatch(/^[a-f0-9]{64}\/invoice\.pdf$/);
    expect(args.payload.content_type).toBe("application/pdf");
    // Code-CR m6 (2026-05-27): payload's original_filename is the
    // SANITIZED form, matching what's already in blob.path. The raw
    // admin name is dropped before the queue so a future shell-exec'ing
    // worker can't be tricked into RCE via shell-metacharacter names.
    expect(args.payload.original_filename).toBe("invoice.pdf");
    // Negative-assertion (per code-CR plan B2): idempotencyKey is the
    // raw content sha256 — exactly the 64-hex prefix of the path. If
    // the route re-hashed the path, the key would differ from the
    // path prefix.
    const pathPrefix = (args.payload.blob_storage_path as string).split("/")[0];
    expect(args.idempotencyKey).toBe(pathPrefix);
    expect(args.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it("enqueueJob payload contains no sensitivity-shaped keys (ADR-0019 §D8 #6 negative pin)", async () => {
    // Code-CR m9 (2026-05-27): enqueueJob's recursive scan rejects any
    // payload key matching /sensitivity/i at any depth. The route's
    // payload shape is `{entry_id, blob_storage_path, content_type,
    // original_filename, byte_length}` — none match today. This test
    // catches a future maintainer who copy-pastes a sensitivity field
    // into the payload (e.g., during a "convenience" change). The scan
    // would reject the enqueue at runtime, but the test catches it at
    // unit-test time before the gate.
    await POST(adminReq(buildForm({})) as never, {} as never);
    const args = enqueueJobMock.mock.calls[0]![1];
    const keys = Object.keys(args.payload);
    const sensitivityShaped = keys.filter((k) => /sensitivity/i.test(k));
    expect(sensitivityShaped).toEqual([]);
  });

  it("sanitizes original filename in jobs.payload (shell-metachar defense)", async () => {
    // Code-CR m6 (2026-05-27): raw admin-supplied names with shell-
    // metachar content land sanitized in the payload, NOT as-supplied.
    // The sanitizer strips metacharacters (`$`, `(`, `)`, `` ` ``, `;`,
    // `&`) — without those, the residual text is not shell-exec'able.
    // The sanitizer does NOT (and cannot, while preserving usability)
    // remove command-verb literals like `rm -rf` — defense-in-depth at
    // the route layer is metacharacter-strip, not body-strip.
    const hostileFile = new File(["bytes"], "$(rm -rf /).pdf", {
      type: "application/pdf",
    });
    await POST(adminReq(buildForm({ file: hostileFile })) as never, {} as never);
    const args = enqueueJobMock.mock.calls[0]![1];
    const name: string = args.payload.original_filename;
    // No shell metacharacters present after sanitization.
    expect(name).not.toMatch(/[`$;&()<>:"|?*\\/]/);
    // The control chars + Windows-unsafe class is also gone.
    expect(name).not.toMatch(/[\x00-\x1f]/);
  });

  it("returns existing_state on idempotency conflict (created=false)", async () => {
    enqueueJobMock.mockResolvedValue({
      id: "00000000-0000-0000-0000-0000000000cc",
      created: false,
      existingState: "done",
    });
    const res = await POST(adminReq(buildForm({})) as never, {} as never);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.existing_state).toBe("done");
  });
});

describe("POST /api/ingest/upload — validation paths", () => {
  it("returns 400 when 'file' field is missing", async () => {
    const fd = new FormData();
    fd.set("metadata", JSON.stringify(validMetadata));
    const res = await POST(adminReq(fd) as never, {} as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    expect(body.issues[0].path).toBe("file");
    expect(body.issues[0].code).toBe("missing");
    expect(createEntryMock).not.toHaveBeenCalled();
  });

  it("returns 400 when 'metadata' field is missing", async () => {
    const fd = new FormData();
    fd.set("file", pdfFile());
    const res = await POST(adminReq(fd) as never, {} as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    expect(body.issues[0].path).toBe("metadata");
  });

  it("returns 400 on malformed JSON metadata", async () => {
    const fd = new FormData();
    fd.set("file", pdfFile());
    fd.set("metadata", "{not json");
    const res = await POST(adminReq(fd) as never, {} as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    expect(body.issues[0].code).toBe("invalid_json");
  });

  it("returns 400 when metadata fails Zod validation (missing sensitivity)", async () => {
    const incomplete = { ...validMetadata } as Record<string, unknown>;
    delete incomplete.sensitivity;
    const res = await POST(adminReq(buildForm({ metadata: incomplete })) as never, {} as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    expect(body.issues.some((i: { path: string }) => i.path === "sensitivity")).toBe(true);
  });

  it("returns 415 for disallowed content-type", async () => {
    const txtFile = new File(["plain text"], "notes.txt", { type: "text/plain" });
    const res = await POST(adminReq(buildForm({ file: txtFile })) as never, {} as never);
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error).toBe("unsupported_media_type");
    expect(body.issues[0].path).toBe("file.type");
  });
});

describe("POST /api/ingest/upload — size cap", () => {
  it("returns 413 when Content-Length exceeds UPLOAD_MAX_BYTES", async () => {
    const oversize = "X".repeat(100); // small bytes, but Content-Length header lies
    const fd = buildForm({ file: new File([oversize], "x.pdf", { type: "application/pdf" }) });
    const req = new Request("http://x/api/ingest/upload", {
      method: "POST",
      headers: {
        "x-stub-user-role": "admin",
        "content-length": String(20 * 1024 * 1024), // 20MB header (over 10MB limit)
      },
      body: fd,
    });
    const res = await POST(req as never, {} as never);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("payload_too_large");
    // Pre-check fires BEFORE multipart parse → createEntry never runs.
    expect(createEntryMock).not.toHaveBeenCalled();
  });

  it("returns 413 when post-buffer file size exceeds the limit (chunked-encoding fallback)", async () => {
    // No Content-Length header in this Request (Request constructor
    // doesn't auto-add one for FormData on Node), so the pre-check is
    // skipped and the post-buffer check fires. We synthesize a small
    // file but lower the limit via env to trigger the check.
    const prev = process.env.UPLOAD_MAX_BYTES;
    process.env.UPLOAD_MAX_BYTES = "5"; // 5 bytes — anything beats it
    try {
      const big = pdfFile("PDF binary content"); // ~17 bytes
      const res = await POST(adminReq(buildForm({ file: big })) as never, {} as never);
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toBe("payload_too_large");
    } finally {
      if (prev !== undefined) process.env.UPLOAD_MAX_BYTES = prev;
      else delete process.env.UPLOAD_MAX_BYTES;
    }
  });
});

describe("POST /api/ingest/upload — failure paths", () => {
  it("returns 500 when createEntry throws (NOT EmptyBodyAfterScrub)", async () => {
    createEntryMock.mockRejectedValue(new Error("DB down"));
    const res = await POST(adminReq(buildForm({})) as never, {} as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal");
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });

  it("returns 500 + entry_id when enqueueJob fails after createEntry committed", async () => {
    enqueueJobMock.mockRejectedValue(new Error("queue down"));
    const res = await POST(adminReq(buildForm({})) as never, {} as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal");
    // entry_id is surfaced so the admin can correlate the orphan
    // placeholder entry to a re-upload attempt.
    expect(body.entry_id).toBe("00000000-0000-0000-0000-0000000000aa");
    expect(body.issues[0].code).toBe("enqueue_failed");
  });
});
