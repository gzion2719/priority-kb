import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  INGESTION_AGENT_PROMPT_HASH,
  INGESTION_AGENT_PROMPT_PATH,
  loadPromptHash,
} from "@/lib/prompts";

describe("loadPromptHash", () => {
  let dir: string;
  let knownPath: string;
  const knownContent = Buffer.from("hello\nworld\n", "utf8");

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "prompts-test-"));
    knownPath = join(dir, "known.md");
    writeFileSync(knownPath, knownContent);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns lowercase hex SHA-256 of the file's raw bytes", () => {
    // Hand-computed expected = sha256("hello\nworld\n") raw bytes.
    const expected = createHash("sha256").update(knownContent).digest("hex");
    const got = loadPromptHash(knownPath);
    expect(got).toBe(expected);
    // Format invariants (the prose contract in lib/prompts.ts).
    expect(got).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the raw Buffer, not a utf8-decoded string (BOM-immune)", () => {
    // A file with a UTF-8 BOM at the start would, if hashed as a utf8
    // string after BOM-stripping, give a different hash than hashing the
    // raw bytes. Asserting raw-byte semantics distinguishes the two.
    const bomPath = join(dir, "bom.md");
    const bomBuf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi", "utf8")]);
    writeFileSync(bomPath, bomBuf);
    const rawHash = createHash("sha256").update(bomBuf).digest("hex");
    const stringHash = createHash("sha256").update("hi", "utf8").digest("hex");
    expect(rawHash).not.toBe(stringHash);
    expect(loadPromptHash(bomPath)).toBe(rawHash);
  });

  it("throws ENOENT when the file does not exist", () => {
    expect(() => loadPromptHash(join(dir, "does-not-exist.md"))).toThrow(/ENOENT/);
  });
});

describe("INGESTION_AGENT_PROMPT_HASH constant", () => {
  it("equals SHA-256 of the actual prompts/ingestion-agent.md bytes (file-sealing)", () => {
    // Negative-assertion: if `lib/prompts.ts` ever swapped to a different
    // file, base64 instead of hex, the utf8-decoded string instead of the
    // raw buffer, or pre-/post-processed the content, this in-test
    // re-computation against the actual file bytes would diverge from the
    // exported constant. Asserting equality here ties the constant to the
    // file's on-disk bytes — distinguishing "constant matches file" from
    // "constant is any plausible-looking 64-hex string".
    const buf = readFileSync(INGESTION_AGENT_PROMPT_PATH);
    const expected = createHash("sha256").update(buf).digest("hex");
    expect(INGESTION_AGENT_PROMPT_HASH).toBe(expected);
  });

  it("is a 64-char lowercase hex string", () => {
    expect(INGESTION_AGENT_PROMPT_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});
