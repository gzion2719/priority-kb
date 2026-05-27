// lib/blob-storage.ts — M2b #4 blob storage abstraction.
//
// Admin-uploaded media (PDF, DOCX, screenshots) is stored here; the worker
// (M2b #5+) reads from the path to run OCR / parse pipelines. The queue
// payload carries the path string only — binaries never live in `jobs.payload`
// per ADR-0019 §D5.
//
// M2b ships the local-filesystem implementation. M5 hosting replaces it with
// an S3-compatible implementation behind the same interface; the route +
// worker don't change. See BACKLOG "S3 BlobStore implementation" entry.
//
// Iron-rule footprint:
//   #6  Stored binaries are server-side only — never URL-addressable. The
//       blob's parent entry row carries `sensitivity`; the BlobStore itself
//       has no notion of sensitivity. Access flows only through admin-gated
//       routes + the worker process — never through a public URL.
//   #12 Local FS implementation is independent of Voyage/Claude; the upload
//       path stays up when those vendors are out.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Result of a successful {@link BlobStore.put} call.
 *
 * The `path` is the implementation-specific identifier (a relative FS path
 * for `LocalFSBlobStore`, an S3 object key for the future S3 impl). The
 * route + worker treat it as an opaque string and only re-pass it to
 * {@link BlobStore.get}/{@link BlobStore.put} (the future read path lands at
 * M2b #5).
 *
 * `contentHash` is the SHA-256 of the binary content as 64 lowercase hex
 * chars. Returned alongside the path so the upload route can use it
 * directly as the `idempotencyKey` for the enqueueJob call without
 * re-hashing the path (which would be double-hashing — see ADR-0019 §D3
 * idempotency-key recommendation).
 */
export interface BlobPutResult {
  path: string;
  bytes: number;
  contentHash: string;
}

/**
 * Storage abstraction for admin-uploaded media. Implementations:
 *
 *   - {@link LocalFSBlobStore} — M2b development implementation; writes
 *     under `BLOB_STORAGE_DIR` (defaults to `./blob-storage/dev`).
 *   - S3-compatible implementation lands at M5 (see BACKLOG entry); same
 *     interface so the route + worker don't need to change.
 *
 * Test harnesses use {@link createInMemoryBlobStore} which holds bytes in
 * a Map and never touches disk.
 */
export interface BlobStore {
  /**
   * Store the binary content; return the storage path + size + content hash.
   *
   * Content-addressed path shape: `<sha256-of-content>/<sanitized-name>`.
   * Same content with the same name produces the same path; same content
   * with a different name produces a different path under the same sha256
   * directory. The natural dedupe surface is the `contentHash` itself
   * (caller passes that to enqueueJob's idempotencyKey), not the path.
   *
   * Idempotent: storing identical content at the same path is a no-op
   * (writes the same bytes; the FS impl uses `writeFile` which is overwrite
   * but the bytes are equal so the on-disk result is unchanged).
   *
   * @param buffer binary content (any byte sequence).
   * @param contentType MIME type, retained by the caller via the queue
   *   payload — `put` does not store it in any sidecar metadata (no
   *   `.json` sibling is written). M2b is read-only on contentType.
   * @param originalName client-supplied filename. Sanitized before joining
   *   into the path; never trusted verbatim.
   */
  put(buffer: Buffer, contentType: string, originalName: string): Promise<BlobPutResult>;
}

/**
 * Sanitize a client-supplied filename for use in the storage path.
 *
 * Threat model: a malicious admin (or a captured admin session) supplies
 * `originalName: "../../etc/passwd"` or `originalName: "C:\\Windows\\System32"`
 * to attempt path traversal. The LocalFSBlobStore joins under
 * `BLOB_STORAGE_DIR` so a `..` segment could escape the directory.
 *
 * Sanitization layers (code-CR m1, m2, m6 — 2026-05-27 hardening):
 *   1. NFC normalize first so combining-character variants of the same
 *      logical filename produce the same sanitized result. Without this,
 *      `Café́.pdf` (NFD with trailing combining acute) and `Café.pdf`
 *      (NFC) hash-different downstream.
 *   2. Strip directory separators (`/`, `\`).
 *   3. Strip leading `.` (blocks `.` / `..` segments) AND leading `~`
 *      (blocks home-dir expansion if `original_filename` is ever
 *      interpolated into a shell path downstream).
 *   4. Strip ASCII control chars + the file-unsafe set on Windows
 *      (`<>:"|?*`) + a defense-in-depth set of shell metacharacters
 *      (`` ` ``, `$`, `;`, `&`, `(`, `)`). The shell-metachar strip is
 *      NOT a complete shell-escape; it's a route-layer cheap defense
 *      against the most common command-injection metacharacter classes
 *      in case the M2b #5+ worker ever shell-exec's against the
 *      filename. The worker still owns its own escaping.
 *   5. Trim trailing dots and spaces (Windows Win32 file APIs strip
 *      these, so `"foo."` and `"foo"` collide on disk — collapsing them
 *      pre-FS keeps the in-memory store and FS impl consistent).
 *   6. Reject Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`,
 *      `COM1-9`, `LPT1-9`) — checked against the basename portion (before
 *      the first `.`). Reserved names map to the fallback `"file"`.
 *   7. Cap length at 200 chars to avoid FS-limit issues on Windows
 *      (260 chars MAX_PATH minus headroom for the sha256 prefix).
 *   8. If the sanitized result is empty, return `"file"` as the fallback.
 *
 * Note: the `<sha256>/` prefix from the content-addressed scheme is the
 * primary directory traversal defense — even an un-sanitized name lands
 * under a 64-hex directory we created. Sanitization is the second layer
 * AND closes the downstream-display / shell-interpolation surface where
 * the raw name might leak through `jobs.payload.original_filename`.
 */
const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

export function sanitizeOriginalName(name: string): string {
  let s = name.normalize("NFC");
  s = s.replace(/[/\\]/g, "_");
  s = s.replace(/^[.~]+/, "");
  s = s.replace(/[\x00-\x1f<>:"|?*`$;&()]/g, "_");
  s = s.replace(/[.\s]+$/, "");
  if (s.length > 200) s = s.slice(0, 200);
  if (s.length === 0) return "file";
  const basename = (s.split(".")[0] ?? "").toLowerCase();
  if (WINDOWS_RESERVED_NAMES.has(basename)) return "file";
  return s;
}

/**
 * Local-filesystem {@link BlobStore} implementation.
 *
 * Root directory is read from `BLOB_STORAGE_DIR` env var at construction;
 * defaults to `./blob-storage/dev` (added to `.gitignore` in the same PR
 * that introduces this module so dev devs don't accidentally commit
 * uploaded content).
 *
 * Layout:
 *   <BLOB_STORAGE_DIR>/<sha256-of-content>/<sanitized-original-name>
 *
 * Each top-level subdirectory is exactly 64 lowercase hex chars (the
 * content sha256). The filename portion is the sanitized client-supplied
 * name. The implementation creates parent directories with `mkdir
 * -p`-equivalent behavior (`recursive: true`).
 */
export class LocalFSBlobStore implements BlobStore {
  private readonly root: string;

  constructor(root: string | undefined = process.env.BLOB_STORAGE_DIR) {
    this.root = root ?? "./blob-storage/dev";
  }

  async put(buffer: Buffer, _contentType: string, originalName: string): Promise<BlobPutResult> {
    const contentHash = createHash("sha256").update(buffer).digest("hex");
    const safeName = sanitizeOriginalName(originalName);
    const dir = join(this.root, contentHash);
    await mkdir(dir, { recursive: true });
    const fullPath = join(dir, safeName);
    await writeFile(fullPath, buffer);
    // Return the path RELATIVE to root so the queue payload + audit_log
    // don't contain machine-specific absolute paths. The worker
    // reconstructs the absolute path by joining root + this string.
    return {
      path: `${contentHash}/${safeName}`,
      bytes: buffer.byteLength,
      contentHash,
    };
  }
}

/**
 * In-memory {@link BlobStore} for tests. Stores bytes in a Map keyed by
 * the relative path. Never touches disk; safe for parallel vitest workers
 * and zero cleanup between tests.
 *
 * The shape mirrors {@link LocalFSBlobStore} exactly so tests can swap
 * the implementation without changing route code.
 */
export function createInMemoryBlobStore(): BlobStore & {
  readonly contents: ReadonlyMap<string, Buffer>;
} {
  const contents = new Map<string, Buffer>();
  return {
    contents,
    async put(buffer, _contentType, originalName) {
      const contentHash = createHash("sha256").update(buffer).digest("hex");
      const safeName = sanitizeOriginalName(originalName);
      const path = `${contentHash}/${safeName}`;
      contents.set(path, Buffer.from(buffer));
      return { path, bytes: buffer.byteLength, contentHash };
    },
  };
}
