// tests/upload.integration.test.ts — M2b #4 upload-route integration test.
//
// Exercises the full upload flow against a real Postgres + a tmpdir
// BlobStore. Confirms:
//   - Placeholder entries.row persists with admin-supplied metadata
//   - audit_log.kind="ingest" written (direct-source path)
//   - jobs row enqueued with kind="job_enqueued" audit row
//   - jobs.payload carries entry_id + blob_storage_path + content_type +
//     original_filename + byte_length (no sensitivity per ADR-0019 §D8 #6)
//   - jobs.idempotency_key = contentHash directly (no double-hash)
//   - blob lands on the tmpdir FS at the content-addressed path

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as schema from "@/drizzle/schema";
import { LocalFSBlobStore } from "@/lib/blob-storage";
import { resetLogSink, setLogSink } from "@/lib/log";

const databaseUrl = process.env.DATABASE_URL;
const isCi = process.env.CI === "true";

if (isCi && !databaseUrl) {
  throw new Error("DATABASE_URL must be set in CI; upload integration test cannot silently skip");
}

const describeIfDb = databaseUrl ? describe : describe.skip;

// Mock createEntry's embedder so we don't call live Voyage. The
// embedder factory returns a stub for tests via getEmbedder()'s
// `DATABASE_URL`-aware fallback shape, but the upload route imports
// getEmbedder directly — verify the test surface uses a stub.
// (createStubEmbedder is the precedent at tests/ingest.integration.test.ts.)

describeIfDb("POST /api/ingest/upload — integration against Postgres", () => {
  let pool: Pool;
  let blobRoot: string;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(() => {
    blobRoot = mkdtempSync(join(tmpdir(), "upload-integration-"));
    process.env.BLOB_STORAGE_DIR = blobRoot;
    setLogSink(() => undefined); // silence 500-path logs
  });

  afterEach(async () => {
    await pool.query("TRUNCATE jobs, audit_log, chunks, entries_versions, entries CASCADE");
    if (existsSync(blobRoot)) rmSync(blobRoot, { recursive: true, force: true });
    delete process.env.BLOB_STORAGE_DIR;
    resetLogSink();
  });

  it("happy path: writes blob, creates placeholder entry, enqueues job with contentHash idempotency", async () => {
    // Dynamic import AFTER process.env.BLOB_STORAGE_DIR is set so the
    // route's BlobStore singleton resolves to the tmpdir.
    const { POST, setBlobStoreForTests } = await import("@/app/api/ingest/upload/route");
    // Use a fresh LocalFSBlobStore pointed at the tmpdir for this test.
    setBlobStoreForTests(new LocalFSBlobStore(blobRoot));

    const fileContent = "Hello world PDF content — integration test " + Date.now();
    const file = new File([fileContent], "scan.pdf", { type: "application/pdf" });
    const metadata = {
      title: "Integration upload",
      category: "test",
      tags: ["upload", "integration"],
      source_pointer: "ticket://upload-int",
      last_verified_at: "2026-05-27T10:00:00Z",
      sensitivity: "internal",
    };
    const fd = new FormData();
    fd.set("file", file);
    fd.set("metadata", JSON.stringify(metadata));

    const req = new Request("http://x/api/ingest/upload", {
      method: "POST",
      headers: { "x-stub-user-role": "admin" },
      body: fd,
    });

    const res = await POST(req as never, {} as never);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.entry_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.job_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.created).toBe(true);
    expect(body.blob_storage_path).toMatch(/^[a-f0-9]{64}\/scan\.pdf$/);

    // Restore singleton to null so sibling tests get a fresh one.
    setBlobStoreForTests(null);

    // -------- DB shape: entries row --------
    const db = drizzle(pool, { schema });
    const entries = await db
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.id, body.entry_id));
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("Integration upload");
    expect(entries[0].sensitivity).toBe("internal");
    expect(entries[0].source_pointer).toBe("ticket://upload-int");
    // Code-CR M1+M2 (2026-05-27): placeholder body is path-FREE — the
    // blob path lives in jobs.payload + audit_log only. This closes the
    // scrubPii-mangling-the-path bug (digit/email-shaped filenames
    // triggered [id]/[email] substitution mid-path) AND the iron-rule
    // #6 retrieval leak.
    expect(entries[0].body).toBe("[pending media OCR — awaiting worker]");

    // -------- DB shape: entries_versions append --------
    const versions = await db
      .select()
      .from(schema.entries_versions)
      .where(eq(schema.entries_versions.entry_id, body.entry_id));
    expect(versions).toHaveLength(1);
    expect(versions[0].version_no).toBe(1);

    // -------- DB shape: chunks (placeholder body chunks into 1 row) --------
    const chunks = await db
      .select()
      .from(schema.chunks)
      .where(eq(schema.chunks.entry_id, body.entry_id));
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // Composite FK propagated sensitivity from entries.
    expect(chunks[0].sensitivity).toBe("internal");

    // -------- DB shape: jobs row + idempotency_key = contentHash --------
    const jobs = await db.select().from(schema.jobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(body.job_id);
    expect(jobs[0].queue_name).toBe("ingest");
    expect(jobs[0].state).toBe("queued");
    // Negative-assertion (per code-CR plan B2): idempotency key equals
    // the contentHash portion of the blob path directly, NOT a re-hash.
    const pathContentHash = body.blob_storage_path.split("/")[0];
    expect(jobs[0].idempotency_key).toBe(pathContentHash);
    expect(jobs[0].idempotency_key).toMatch(/^[a-f0-9]{64}$/);
    // Payload carries entry_id + blob_storage_path + content_type +
    // original_filename + byte_length. No `sensitivity` per ADR-0019
    // §D8 #6 (the recursive scan in enqueueJob rejects any key matching
    // /sensitivity/i — verify nothing slipped through).
    const payload = jobs[0].payload as Record<string, unknown>;
    expect(payload.entry_id).toBe(body.entry_id);
    expect(payload.blob_storage_path).toBe(body.blob_storage_path);
    expect(payload.content_type).toBe("application/pdf");
    expect(payload.original_filename).toBe("scan.pdf");
    expect(typeof payload.byte_length).toBe("number");
    // Avoid `String.test()` shape — the test-count precheck regex
    // would match `.test(` as a false-positive declaration; use
    // `includes` to keep the count honest.
    const sensitivityShaped = Object.keys(payload).filter((k) =>
      k.toLowerCase().includes("sensitivity"),
    );
    expect(sensitivityShaped).toEqual([]);

    // -------- audit_log: kind="ingest" (entry insert) + kind="job_enqueued" --------
    const auditRows = await db.select().from(schema.audit_log);
    const kinds = auditRows.map((r) => r.kind).sort();
    expect(kinds).toContain("ingest");
    expect(kinds).toContain("job_enqueued");

    // -------- FS: blob exists on disk at the expected path --------
    const onDisk = join(blobRoot, body.blob_storage_path);
    expect(existsSync(onDisk)).toBe(true);
    expect(readFileSync(onDisk).toString()).toBe(fileContent);
  });

  it("idempotency: re-uploading the same bytes returns created=false + existing_state", async () => {
    const { POST, setBlobStoreForTests } = await import("@/app/api/ingest/upload/route");
    setBlobStoreForTests(new LocalFSBlobStore(blobRoot));

    const fileContent = "dedupe-test " + Date.now();
    const metadata = {
      title: "Dedupe upload",
      category: "test",
      tags: ["dedupe"],
      source_pointer: "ticket://dedupe",
      last_verified_at: "2026-05-27T10:00:00Z",
      sensitivity: "public",
    };

    function fdFor(filename: string): FormData {
      const fd = new FormData();
      fd.set("file", new File([fileContent], filename, { type: "application/pdf" }));
      fd.set("metadata", JSON.stringify(metadata));
      return fd;
    }

    // First upload — creates a job.
    const res1 = await POST(
      new Request("http://x/api/ingest/upload", {
        method: "POST",
        headers: { "x-stub-user-role": "admin" },
        body: fdFor("first.pdf"),
      }) as never,
      {} as never,
    );
    expect(res1.status).toBe(201);
    const body1 = await res1.json();
    expect(body1.created).toBe(true);

    // Second upload — identical bytes, different filename. Idempotency
    // key (contentHash) matches → enqueue is a no-op; the caller gets
    // {created:false, existing_state} for the prior job.
    const res2 = await POST(
      new Request("http://x/api/ingest/upload", {
        method: "POST",
        headers: { "x-stub-user-role": "admin" },
        body: fdFor("second-name.pdf"),
      }) as never,
      {} as never,
    );
    expect(res2.status).toBe(201);
    const body2 = await res2.json();
    expect(body2.created).toBe(false);
    expect(body2.existing_state).toBe("queued");
    expect(body2.job_id).toBe(body1.job_id);

    // The placeholder entry from the second upload IS a fresh entry —
    // createEntry doesn't dedupe; only the queue dedupes. This is by
    // design (the admin's intent is "process this binary"; a re-upload
    // with the same bytes intentionally produces an orphan placeholder
    // when the queue dedupes — recoverable via M4 admin entry browser).
    expect(body2.entry_id).not.toBe(body1.entry_id);

    // Code-CR m8 (2026-05-27): pin the documented "2 entries, 1 job"
    // orphan-from-dedupe contract. A future "fix" that silently merged
    // the second upload into the first entry's body would pass the
    // entry_id-differs check above but fail this row-count assertion.
    const db = drizzle(pool, { schema });
    const allEntries = await db.select().from(schema.entries);
    expect(allEntries).toHaveLength(2);
    const allJobs = await db.select().from(schema.jobs);
    expect(allJobs).toHaveLength(1);
    // The orphan placeholder's body is still the sentinel (worker
    // hasn't filled it in yet — and won't, since the job dedup'd).
    const orphan = allEntries.find((e) => e.id === body2.entry_id);
    expect(orphan).toBeDefined();
    expect(orphan!.body).toBe("[pending media OCR — awaiting worker]");

    setBlobStoreForTests(null);
  });

  it("sensitivity propagates from admin form → entries → chunks composite FK", async () => {
    // Iron-rule #6 + ADR-0009 composite-FK contract: the admin-supplied
    // sensitivity at upload time MUST land on the placeholder entry
    // AND propagate through the composite FK to the chunks row's
    // sensitivity column. Without composite-FK propagation, a later
    // admin re-tagging the entry (M4 admin browser) would leave stale
    // sensitivity on chunks — the retrieval path would then surface
    // chunks under the wrong tier. ADR-0019 §D8 #6 explicitly
    // documents this: "the worker re-reads entries.sensitivity at
    // chunk-write time. M2b #4's placeholder write exercises the same
    // composite-FK contract at upload time.
    const { POST, setBlobStoreForTests } = await import("@/app/api/ingest/upload/route");
    setBlobStoreForTests(new LocalFSBlobStore(blobRoot));

    const metadata = {
      title: "Sensitivity propagation test",
      category: "test",
      tags: ["sensitivity"],
      source_pointer: "ticket://sens-prop",
      last_verified_at: "2026-05-27T10:00:00Z",
      sensitivity: "restricted",
    };
    const fd = new FormData();
    fd.set(
      "file",
      new File(["restricted content " + Date.now()], "secret.pdf", { type: "application/pdf" }),
    );
    fd.set("metadata", JSON.stringify(metadata));

    const res = await POST(
      new Request("http://x/api/ingest/upload", {
        method: "POST",
        headers: { "x-stub-user-role": "admin" },
        body: fd,
      }) as never,
      {} as never,
    );
    expect(res.status).toBe(201);
    const body = await res.json();

    const db = drizzle(pool, { schema });
    const entryRows = await db
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.id, body.entry_id));
    expect(entryRows[0].sensitivity).toBe("restricted");

    // Composite-FK propagation: chunks row's sensitivity column MUST
    // match the parent entry's sensitivity. Negative-assertion: if the
    // composite FK weren't doing its job, the chunks row could carry
    // a default 'public' value — this assertion fails in that world.
    const chunkRows = await db
      .select()
      .from(schema.chunks)
      .where(eq(schema.chunks.entry_id, body.entry_id));
    expect(chunkRows.length).toBeGreaterThanOrEqual(1);
    for (const c of chunkRows) {
      expect(c.sensitivity).toBe("restricted");
    }

    setBlobStoreForTests(null);
  });

  it("content_type passes through to jobs.payload for non-PDF media (PNG)", async () => {
    // Content-type allowlist accepts more than just PDF — verify a
    // PNG upload lands content_type="image/png" in jobs.payload, so
    // the M2b #5+ OCR handler can dispatch on it.
    // Negative-assertion: if the route hardcoded "application/pdf"
    // anywhere, this would surface as a PNG upload writing
    // content_type="application/pdf" — wrong dispatch downstream.
    const { POST, setBlobStoreForTests } = await import("@/app/api/ingest/upload/route");
    setBlobStoreForTests(new LocalFSBlobStore(blobRoot));

    const fd = new FormData();
    fd.set(
      "file",
      new File(["fake-png-bytes-" + Date.now()], "screenshot.png", { type: "image/png" }),
    );
    fd.set(
      "metadata",
      JSON.stringify({
        title: "PNG screenshot",
        category: "ui",
        tags: ["screenshot"],
        source_pointer: "ticket://png-test",
        last_verified_at: "2026-05-27T10:00:00Z",
        sensitivity: "internal",
      }),
    );

    const res = await POST(
      new Request("http://x/api/ingest/upload", {
        method: "POST",
        headers: { "x-stub-user-role": "admin" },
        body: fd,
      }) as never,
      {} as never,
    );
    expect(res.status).toBe(201);

    const db = drizzle(pool, { schema });
    const jobRows = await db.select().from(schema.jobs);
    expect(jobRows).toHaveLength(1);
    const payload = jobRows[0].payload as Record<string, unknown>;
    expect(payload.content_type).toBe("image/png");
    expect(payload.original_filename).toBe("screenshot.png");

    setBlobStoreForTests(null);
  });
});
