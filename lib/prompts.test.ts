import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  INGESTION_AGENT_PROMPT,
  INGESTION_AGENT_PROMPT_HASH,
  INGESTION_AGENT_PROMPT_PATH,
  RETRIEVAL_AGENT_PROMPT,
  RETRIEVAL_AGENT_PROMPT_HASH,
  RETRIEVAL_AGENT_PROMPT_PATH,
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

describe("INGESTION_AGENT_PROMPT constant (ADR-0010 §1 system_prompt source)", () => {
  it("is a non-empty string", () => {
    expect(typeof INGESTION_AGENT_PROMPT).toBe("string");
    expect(INGESTION_AGENT_PROMPT.length).toBeGreaterThan(0);
  });

  it("equals the UTF-8 decoding of prompts/ingestion-agent.md", () => {
    const expected = readFileSync(INGESTION_AGENT_PROMPT_PATH, "utf8");
    expect(INGESTION_AGENT_PROMPT).toBe(expected);
  });

  it("hashes (UTF-8-encoded) to INGESTION_AGENT_PROMPT_HASH — provenance round-trip", () => {
    // Iron rule #10: the bytes we send to Anthropic must match the bytes
    // we hash for the audit log. If the file ever gains a BOM or a
    // non-UTF-8 byte sequence, this re-encode-and-hash check diverges and
    // module init would have already thrown. The test pins that the
    // currently-checked-in prompt is byte-identical between buffer-form
    // (hashed) and string-form (sent on the wire). Negative-assertion:
    // an impl that decoded the file with `ascii` or stripped a BOM would
    // produce a different hash here.
    const reencoded = Buffer.from(INGESTION_AGENT_PROMPT, "utf8");
    const roundTripHash = createHash("sha256").update(reencoded).digest("hex");
    expect(roundTripHash).toBe(INGESTION_AGENT_PROMPT_HASH);
  });

  it("does NOT start with a UTF-8 BOM (would have failed module init)", () => {
    // If this assert ever flips, INGESTION_AGENT_PROMPT_HASH would still
    // succeed (raw-Buffer hash includes the BOM) but the string form
    // sent over the wire would too — the round-trip test above would
    // also pass. This is a belt-and-braces invariant explicitly pinning
    // the no-BOM convention rather than relying on roundtrip alone.
    expect(INGESTION_AGENT_PROMPT.charCodeAt(0)).not.toBe(0xfeff);
  });
});

describe("INGESTION_AGENT_PROMPT v0.2.0 content (ADR-0010 §Prompt v0.2.0)", () => {
  // Negative-assertion tests per WORKFLOW.md "Negative-assertion tests
  // distinguish from the regression": each case constructs an assertion
  // that would fail if the v0.2.0 rewrite were silently reverted to the
  // v0.1.0 wording. A "present" assertion alone would pass any prompt
  // that happens to mention the substring; pairing with "old line absent"
  // proves the rewrite actually landed.

  it("bumps the version header to 0.2.0 (and removes the v0.1.0 header)", () => {
    expect(INGESTION_AGENT_PROMPT).toContain(
      '**Version:** 0.2.0 (M2a chat UI ride-along; see ADR-0010 §"Prompt v0.2.0")',
    );
    expect(INGESTION_AGENT_PROMPT).not.toContain(
      "**Version:** 0.1.0 (M2a stub — to be tightened during M2a implementation)",
    );
  });

  it("rewrites PII handling as 'heads-up, not a vote' and drops the orphan audit-metadata line", () => {
    // scrubPii in lib/ingest.ts:127 is unconditional; the v0.1.0 "If
    // admin says no, proceed unchanged but log the decision in the audit
    // metadata" line was contra-factual prose (no audit-metadata channel
    // exists). v0.2.0 reframes as a heads-up.
    expect(INGESTION_AGENT_PROMPT).toContain(
      "I'll strip these before storage — flagging so you know what's being removed. (Stripping happens server-side regardless of your answer; this is a heads-up, not a vote.)",
    );
    expect(INGESTION_AGENT_PROMPT).not.toContain(
      "If admin says no, proceed unchanged but log the decision in the audit metadata.",
    );
  });

  it("adds the search_kb empty-result fallback and fixes the call signature to match SEARCH_KB_INPUT_SCHEMA", () => {
    // SEARCH_KB_INPUT_SCHEMA in lib/agents-tools.ts accepts only
    // {query: string} — the v0.1.0 two-arg `search_kb(..., k=3)` call
    // was wrong against the actual tool schema. v0.2.0 fixes the call
    // shape and adds the ADR-0010 §Prompt v0.2.0 empty-result fallback.
    expect(INGESTION_AGENT_PROMPT).toContain(
      'call `search_kb({query: title + " " + first 200 chars of body})`',
    );
    expect(INGESTION_AGENT_PROMPT).toContain("retrieval_unavailable_m2a");
    expect(INGESTION_AGENT_PROMPT).not.toContain("search_kb(title + first 200 chars of body, k=3)");
  });

  it("aligns the Final confirmation summary with unconditional server-side scrub", () => {
    // After v0.2.0 the admin no longer has a yes/no PII choice, so the
    // confirmation summary reports what was flagged rather than the
    // admin's (non-existent) decision.
    expect(INGESTION_AGENT_PROMPT).toContain("PII flagged for strip: <what>");
    expect(INGESTION_AGENT_PROMPT).not.toContain("PII stripped: <yes/no, what>");
  });
});

describe("RETRIEVAL_AGENT_PROMPT_HASH constant", () => {
  it("equals SHA-256 of the actual prompts/retrieval-agent.md bytes (file-sealing)", () => {
    // Mirror of the INGESTION_AGENT_PROMPT_HASH file-sealing test. Ties
    // the exported constant to the file's on-disk bytes — distinguishes
    // "constant matches file" from "constant is any plausible-looking
    // 64-hex string".
    const buf = readFileSync(RETRIEVAL_AGENT_PROMPT_PATH);
    const expected = createHash("sha256").update(buf).digest("hex");
    expect(RETRIEVAL_AGENT_PROMPT_HASH).toBe(expected);
  });

  it("is a 64-char lowercase hex string", () => {
    expect(RETRIEVAL_AGENT_PROMPT_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("RETRIEVAL_AGENT_PROMPT constant (M3 item 3 system_prompt source)", () => {
  it("is a non-empty string", () => {
    expect(typeof RETRIEVAL_AGENT_PROMPT).toBe("string");
    expect(RETRIEVAL_AGENT_PROMPT.length).toBeGreaterThan(0);
  });

  it("equals the UTF-8 decoding of prompts/retrieval-agent.md", () => {
    const expected = readFileSync(RETRIEVAL_AGENT_PROMPT_PATH, "utf8");
    expect(RETRIEVAL_AGENT_PROMPT).toBe(expected);
  });

  it("hashes (UTF-8-encoded) to RETRIEVAL_AGENT_PROMPT_HASH — provenance round-trip", () => {
    // Iron rule #10: the bytes we send to Anthropic must match the bytes
    // we hash for the audit log. If the file ever gains a BOM or a
    // non-UTF-8 byte sequence, this re-encode-and-hash check diverges
    // and module init would have already thrown.
    const reencoded = Buffer.from(RETRIEVAL_AGENT_PROMPT, "utf8");
    const roundTripHash = createHash("sha256").update(reencoded).digest("hex");
    expect(roundTripHash).toBe(RETRIEVAL_AGENT_PROMPT_HASH);
  });

  it("does NOT start with a UTF-8 BOM (would have failed module init)", () => {
    expect(RETRIEVAL_AGENT_PROMPT.charCodeAt(0)).not.toBe(0xfeff);
  });
});

describe("RETRIEVAL_AGENT_PROMPT v0.1.0 content (M3 item 1 — pinned non-negotiables)", () => {
  // Negative-assertion tests per WORKFLOW.md "Negative-assertion tests
  // distinguish from the regression": each pairs a "present" check with
  // an "alternative-absent" check. Pinning v0.1.0's canonical wording
  // means a future v0.2.0 (or accidental edit) breaks loudly here rather
  // than at the route layer when M3 item 3 wires up the consumer.

  it("uses the canonical header (and not a partial-prefix variant)", () => {
    expect(RETRIEVAL_AGENT_PROMPT).toContain("# Retrieval Agent — System Prompt");
    // Distinguish from a plausible-but-wrong variant that omits the
    // dash-suffix (e.g., "# Retrieval Agent" alone). A test asserting
    // only the prefix would pass for any header that happened to start
    // with those words.
    expect(RETRIEVAL_AGENT_PROMPT).not.toMatch(/^# Retrieval Agent\n/);
  });

  it("declares v0.1.0 (M3 stub) and is NOT yet at a tightened later version", () => {
    expect(RETRIEVAL_AGENT_PROMPT).toContain("**Version:** 0.1.0");
    // If M3 item 3 ever bumps the prompt to a new version, this test
    // fails and the bumper is forced to update the assertion explicitly,
    // re-reading the new content.
    expect(RETRIEVAL_AGENT_PROMPT).not.toContain("**Version:** 0.2.0");
  });

  it("pins the no-synthesis-from-training-data non-negotiable (iron rule #12 + AGENTS.md)", () => {
    // Without this constraint, the route would have to enforce
    // post-hoc that the answer cites only provided entries. The prompt
    // is the first line of defense.
    expect(RETRIEVAL_AGENT_PROMPT).toContain("Do not synthesize");
    // Distinguish from a softer "prefer to cite" framing that would
    // pass if the model invented a synthesis when entries were thin.
    expect(RETRIEVAL_AGENT_PROMPT).not.toContain("you may supplement with general knowledge");
  });

  it("pins the must-cite-every-claim contract (AGENTS.md §Retrieval Agent non-negotiable)", () => {
    expect(RETRIEVAL_AGENT_PROMPT).toContain("must cite every claim");
    // No-citation-no-claim is the inverse of the documented non-negotiable
    // ("Never answer without at least one citation"). A prompt that
    // dropped citation entirely would pass a "mentions citations
    // somewhere" check but fail this directional assertion.
    expect(RETRIEVAL_AGENT_PROMPT).not.toContain("citations are optional");
  });

  it("pins the language-mirror rule (AGENTS.md §Retrieval Agent + CLAUDE.md language convention)", () => {
    expect(RETRIEVAL_AGENT_PROMPT).toContain("mirror the user's input language");
    expect(RETRIEVAL_AGENT_PROMPT).toContain("Hebrew → Hebrew, English → English");
    // Defend against silently flipping to the operating-language
    // English-only rule that CLAUDE.md scopes to Claude↔user
    // conversations (not retrieval).
    expect(RETRIEVAL_AGENT_PROMPT).not.toContain("always respond in English");
  });
});
