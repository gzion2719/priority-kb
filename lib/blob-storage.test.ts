// lib/blob-storage.test.ts — unit tests for BlobStore + LocalFSBlobStore.
//
// Test posture: each test allocates its own tmpdir via `fs.mkdtempSync(...)`;
// vitest workers can run in parallel without colliding on a shared
// `./blob-storage/dev` directory.

import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LocalFSBlobStore,
  createInMemoryBlobStore,
  sanitizeOriginalName,
} from "@/lib/blob-storage";

describe("sanitizeOriginalName", () => {
  it("strips directory separators", () => {
    expect(sanitizeOriginalName("foo/bar.pdf")).toBe("foo_bar.pdf");
    expect(sanitizeOriginalName("foo\\bar.pdf")).toBe("foo_bar.pdf");
  });

  it("strips leading dots to block . and .. segments", () => {
    expect(sanitizeOriginalName("..")).toBe("file");
    expect(sanitizeOriginalName(".hidden")).toBe("hidden");
    // ../etc/passwd → / replaced first → .._etc_passwd → leading . stripped
    // → _etc_passwd. The leading separator-replacement underscore is fine;
    // mid-string `..` is harmless because the result is a single path segment.
    expect(sanitizeOriginalName("../etc/passwd")).toBe("_etc_passwd");
  });

  it("strips ASCII control chars + Windows-unsafe chars + shell metacharacters", () => {
    // 1 underscore from `:`, 6 underscores from `<>"|?*` = 7 underscores total.
    expect(sanitizeOriginalName('foo:bar<>"|?*.pdf')).toBe("foo_bar______.pdf");
    expect(sanitizeOriginalName("foo\x00bar.pdf")).toBe("foo_bar.pdf");
    expect(sanitizeOriginalName("foo\x1fbar.pdf")).toBe("foo_bar.pdf");
    // Code-CR m6 (2026-05-27): shell-metachar defense-in-depth. Each
    // of `` ` ``, `$`, `;`, `&`, `(`, `)` maps to `_`. Not a complete
    // shell-escape — the M2b #5+ worker owns its own escaping — but
    // closes the most common command-injection metacharacter classes
    // at the route layer.
    // `$`, `(`, `/`, `)` → 4 underscores. The literal "rm -rf " survives
    // (the sanitizer strips metacharacters, not command verbs — without
    // metacharacters the residual text is not exec'able).
    expect(sanitizeOriginalName("$(rm -rf /).pdf")).toBe("__rm -rf __.pdf");
    expect(sanitizeOriginalName("`whoami`.txt")).toBe("_whoami_.txt");
    expect(sanitizeOriginalName("foo;bar&baz.pdf")).toBe("foo_bar_baz.pdf");
  });

  it("caps length at 200 chars", () => {
    const long = "a".repeat(300) + ".pdf";
    const out = sanitizeOriginalName(long);
    expect(out.length).toBe(200);
  });

  it("returns 'file' when sanitization empties the name", () => {
    expect(sanitizeOriginalName("")).toBe("file");
    expect(sanitizeOriginalName("...")).toBe("file");
    expect(sanitizeOriginalName("////")).toBe("____"); // separators replaced, not empty
  });

  it("preserves normal filenames untouched", () => {
    expect(sanitizeOriginalName("report.pdf")).toBe("report.pdf");
    expect(sanitizeOriginalName("Priority Screenshot.png")).toBe("Priority Screenshot.png");
    expect(sanitizeOriginalName("invoice-2026-05.docx")).toBe("invoice-2026-05.docx");
  });

  it("strips leading ~ to block home-dir expansion if name leaks to shell", () => {
    // Code-CR m1: leading ~ joined to a shell path could expand to $HOME.
    // The sha256 prefix neutralizes path traversal but the shell-display
    // surface deserves its own defense.
    expect(sanitizeOriginalName("~/foo.pdf")).toBe("_foo.pdf");
    expect(sanitizeOriginalName("~root/bar.pdf")).toBe("root_bar.pdf");
  });

  it("trims trailing dots and spaces (Windows Win32 API collision defense)", () => {
    // Windows file APIs strip these silently; pre-trimming keeps the
    // in-memory store and the FS impl consistent across platforms.
    expect(sanitizeOriginalName("foo.")).toBe("foo");
    expect(sanitizeOriginalName("foo.pdf.")).toBe("foo.pdf");
    expect(sanitizeOriginalName("foo ")).toBe("foo");
    expect(sanitizeOriginalName("foo.pdf  ")).toBe("foo.pdf");
    expect(sanitizeOriginalName("foo. . .")).toBe("foo");
  });

  it("maps Windows reserved device names to 'file' fallback", () => {
    // CON, PRN, AUX, NUL, COM1-9, LPT1-9 are reserved on Windows — even
    // creating a file named NUL.txt redirects to the null device on legacy
    // tooling. We map the BASENAME (before the first .) to lowercase and
    // reject the reserved set.
    expect(sanitizeOriginalName("CON")).toBe("file");
    expect(sanitizeOriginalName("NUL.txt")).toBe("file");
    expect(sanitizeOriginalName("COM1.pdf")).toBe("file");
    expect(sanitizeOriginalName("lpt9.docx")).toBe("file");
    expect(sanitizeOriginalName("AUX")).toBe("file");
    // Non-reserved names with reserved-looking prefixes pass through.
    expect(sanitizeOriginalName("CONSOLE.txt")).toBe("CONSOLE.txt");
    expect(sanitizeOriginalName("COM10.pdf")).toBe("COM10.pdf");
  });

  it("NFC-normalizes so combining-character variants collide", () => {
    // Café with NFD (combining acute) vs NFC (precomposed) — same logical
    // name, byte-different. After NFC normalize, both produce the same
    // sanitized output.
    const nfd = "Café.pdf"; // C-a-f-e + combining acute
    const nfc = "Café.pdf"; // C-a-f-é
    expect(sanitizeOriginalName(nfd)).toBe(sanitizeOriginalName(nfc));
    expect(sanitizeOriginalName(nfd)).toBe("Café.pdf");
  });
});

describe("LocalFSBlobStore", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "blob-storage-test-"));
  });

  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it("writes content-addressed path under root", async () => {
    const store = new LocalFSBlobStore(root);
    const content = Buffer.from("hello world");
    const result = await store.put(content, "text/plain", "hello.txt");

    // contentHash should be a 64-hex lowercase string.
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.bytes).toBe(11);
    expect(result.path).toBe(`${result.contentHash}/hello.txt`);

    const onDisk = readFileSync(join(root, result.path));
    expect(onDisk).toEqual(content);
  });

  it("idempotent: identical content + name produces identical path on second put", async () => {
    const store = new LocalFSBlobStore(root);
    const content = Buffer.from("same bytes");
    const first = await store.put(content, "text/plain", "x.txt");
    const second = await store.put(content, "text/plain", "x.txt");

    expect(second.path).toBe(first.path);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.bytes).toBe(first.bytes);
    // The file's still there with the same content; second put overwrote
    // with identical bytes (a no-op as far as on-disk state goes).
    expect(readFileSync(join(root, second.path))).toEqual(content);
  });

  it("same content with different name → same content-hash dir, different filename", async () => {
    const store = new LocalFSBlobStore(root);
    const content = Buffer.from("dedup-candidate");
    const a = await store.put(content, "text/plain", "alpha.txt");
    const b = await store.put(content, "text/plain", "beta.txt");

    expect(a.contentHash).toBe(b.contentHash);
    expect(a.path).not.toBe(b.path);
    expect(a.path).toMatch(/\/alpha\.txt$/);
    expect(b.path).toMatch(/\/beta\.txt$/);

    // Both live under the same content-hash directory.
    expect(existsSync(join(root, a.path))).toBe(true);
    expect(existsSync(join(root, b.path))).toBe(true);
  });

  it("different content → different content-hash directories", async () => {
    const store = new LocalFSBlobStore(root);
    const a = await store.put(Buffer.from("A"), "text/plain", "x.txt");
    const b = await store.put(Buffer.from("B"), "text/plain", "x.txt");

    expect(a.contentHash).not.toBe(b.contentHash);
    expect(a.path).not.toBe(b.path);
  });

  it("path-traversal-shaped originalName is sanitized before joining", async () => {
    const store = new LocalFSBlobStore(root);
    const content = Buffer.from("hostile");
    const result = await store.put(content, "text/plain", "../../etc/passwd");

    // The primary defense is two-layered:
    //   1. `originalName` separators (`/`, `\`) are replaced with `_` so
    //      the sanitized result is always a single filename segment, never
    //      a multi-segment path.
    //   2. The path joins under <root>/<sha256>/<sanitized> — even if the
    //      sanitized name contains `..` (impossible to use as a traversal
    //      since it's in mid-string, not a path component), the join
    //      cannot escape <root>/<sha256>.
    expect(result.path).not.toContain("/etc/");
    expect(result.path).not.toContain("\\etc\\");
    // Sanitized name is a single segment — at most one `/` in the path
    // (the one between the hash dir and the filename).
    const slashCount = (result.path.match(/\//g) ?? []).length;
    expect(slashCount).toBe(1);
    const fullPath = join(root, result.path);
    // Negative-assertion: the file must NOT have landed outside the
    // tmpdir root. Without separator-replacement, `join(root,
    // "../../etc/passwd")` would resolve out of root.
    expect(fullPath.startsWith(root)).toBe(true);
    // Also verify the file genuinely landed inside root and is readable.
    expect(existsSync(fullPath)).toBe(true);
    expect(readFileSync(fullPath)).toEqual(content);
  });

  it("missing-env fallback path uses './blob-storage/dev' default (with cwd swap)", async () => {
    // Code-CR M4 (2026-05-27): the prior assertion was tautological
    // (`expect(store).toBeInstanceOf(LocalFSBlobStore)` — the constructor
    // always returns its own type, so this passed even if the default
    // root string was misspelled). Stronger pin: chdir into a fresh
    // tmpdir, clear the env, call put(), confirm the file lands at
    // `./blob-storage/dev/<hash>/<name>` relative to cwd.
    const prevEnv = process.env.BLOB_STORAGE_DIR;
    const prevCwd = process.cwd();
    const chdirRoot = mkdtempSync(join(tmpdir(), "blob-default-cwd-"));
    delete process.env.BLOB_STORAGE_DIR;
    try {
      process.chdir(chdirRoot);
      const store = new LocalFSBlobStore();
      const result = await store.put(Buffer.from("default-root"), "text/plain", "d.txt");
      const expectedRoot = join(chdirRoot, "blob-storage", "dev");
      const expectedFull = join(expectedRoot, result.path);
      // Negative-assertion: if the default were `./blog-storage/dev`
      // (typo) the file would land elsewhere and this existsSync would
      // be false.
      expect(existsSync(expectedFull)).toBe(true);
      expect(readFileSync(expectedFull).toString()).toBe("default-root");
    } finally {
      process.chdir(prevCwd);
      if (prevEnv !== undefined) process.env.BLOB_STORAGE_DIR = prevEnv;
      if (existsSync(chdirRoot)) rmSync(chdirRoot, { recursive: true, force: true });
    }
  });

  it("explicit root parameter wins over env var", async () => {
    process.env.BLOB_STORAGE_DIR = "/some/other/path/that/should/not/be/used";
    try {
      const store = new LocalFSBlobStore(root);
      const result = await store.put(Buffer.from("env-vs-arg"), "text/plain", "t.txt");
      expect(existsSync(join(root, result.path))).toBe(true);
    } finally {
      delete process.env.BLOB_STORAGE_DIR;
    }
  });

  it("empty-buffer put still writes a (zero-byte) file", async () => {
    const store = new LocalFSBlobStore(root);
    const result = await store.put(Buffer.alloc(0), "application/octet-stream", "empty.bin");
    expect(result.bytes).toBe(0);
    // sha256("") is the well-known constant.
    expect(result.contentHash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(existsSync(join(root, result.path))).toBe(true);
  });

  it("path uses POSIX-style forward slashes regardless of platform", async () => {
    const store = new LocalFSBlobStore(root);
    const result = await store.put(Buffer.from("x"), "text/plain", "y.txt");
    // The returned `path` is intentionally hash + "/" + name — the queue
    // payload and audit_log carry this string verbatim, so it MUST be
    // platform-independent. Negative-assertion: if the implementation
    // used path.join (which is `\` on Windows), this would fail there.
    expect(result.path).toMatch(/^[a-f0-9]{64}\/y\.txt$/);
    expect(result.path).not.toContain("\\");
  });
});

describe("createInMemoryBlobStore", () => {
  it("stores bytes in the contents Map keyed by path", async () => {
    const store = createInMemoryBlobStore();
    const result = await store.put(Buffer.from("in-mem"), "text/plain", "m.txt");
    expect(store.contents.has(result.path)).toBe(true);
    expect(store.contents.get(result.path)).toEqual(Buffer.from("in-mem"));
  });

  it("isolates buffer mutation: storing a mutable buffer then mutating it does not corrupt store", async () => {
    const store = createInMemoryBlobStore();
    const mutable = Buffer.from("original");
    const result = await store.put(mutable, "text/plain", "m.txt");
    mutable.fill("X"); // mutate AFTER put
    // Negative-assertion: if the in-memory store retained the caller's
    // buffer reference, the stored content would now be "XXXXXXXX". The
    // assertion that it's still "original" proves the store copied the
    // buffer at put time. Without `Buffer.from(buffer)` defensive copy
    // this test would fail.
    expect(store.contents.get(result.path)?.toString()).toBe("original");
  });

  it("mirrors LocalFSBlobStore content-hash + path shape", async () => {
    const store = createInMemoryBlobStore();
    const result = await store.put(Buffer.from("shape-check"), "text/plain", "x.txt");
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.path).toBe(`${result.contentHash}/x.txt`);
    expect(result.bytes).toBe(11);
  });
});
