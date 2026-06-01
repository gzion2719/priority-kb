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

describe("INGESTION_AGENT_PROMPT v0.3.0 content (ADR-0010 §Prompt v0.3.0 + ADR-0025 D5 PR-C)", () => {
  // Negative-assertion tests per WORKFLOW.md "Negative-assertion tests
  // distinguish from the regression": each case constructs an assertion
  // that would fail if the v0.3.0 rewrite were silently reverted to the
  // v0.2.0 wording. A "present" assertion alone would pass any prompt
  // that happens to mention the substring; pairing with "old line absent"
  // proves the rewrite actually landed.
  //
  // PR-C v0.3.0 bump adds the list_tags() tool integration; the v0.2.0
  // negative assertions stay in place to ensure neither v0.1.0 nor v0.2.0
  // wording leaks back through a future rewrite.

  it("bumps the version header to 0.3.0 (and removes the v0.2.0 header + v0.1.0 header)", () => {
    expect(INGESTION_AGENT_PROMPT).toContain(
      '**Version:** 0.3.0 (M4 #4 PR-C: `list_tags` tool; see ADR-0010 §"Prompt v0.3.0" + ADR-0025 D5)',
    );
    expect(INGESTION_AGENT_PROMPT).not.toContain(
      '**Version:** 0.2.0 (M2a chat UI ride-along; see ADR-0010 §"Prompt v0.2.0")',
    );
    expect(INGESTION_AGENT_PROMPT).not.toContain(
      "**Version:** 0.1.0 (M2a stub — to be tightened during M2a implementation)",
    );
  });

  it("instructs the agent to call list_tags() while collecting the tags field (PR-C)", () => {
    // Negative-assertion: the v0.2.0 line that said only "Reuse existing
    // tags when possible (suggest from existing taxonomy)" with NO concrete
    // tool call must be gone — v0.3.0 names the tool + prefix call shape
    // explicitly so the agent has a mechanical path to follow.
    expect(INGESTION_AGENT_PROMPT).toContain("`list_tags({prefix: <2-3 chars from admin input>})`");
    expect(INGESTION_AGENT_PROMPT).toContain("prefer the catalog's exact byte form");
    expect(INGESTION_AGENT_PROMPT).not.toContain(
      "`tags[]` — 1-5 short tags. Reuse existing tags when possible (suggest from existing taxonomy).",
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

describe("RETRIEVAL_AGENT_PROMPT v0.4.0 content (M3 acceptance — same-language citation tie-breaker; single-best-cite + Sources block contract preserved)", () => {
  // Negative-assertion tests per WORKFLOW.md "Negative-assertion tests
  // distinguish from the regression": each pairs a "present" check with
  // an "alternative-absent" check. v0.4.0 adds a same-language citation
  // tie-breaker on top of v0.3.0's single-best-cite default; both layered
  // on the v0.2.0 Sources-block contract (ADR-0012 §D + §5). A future bump
  // (or accidental relaxation of any rule) breaks loudly here.

  it("uses the canonical header (and not a partial-prefix variant)", () => {
    expect(RETRIEVAL_AGENT_PROMPT).toContain("# Retrieval Agent — System Prompt");
    // Distinguish from a plausible-but-wrong variant that omits the
    // dash-suffix (e.g., "# Retrieval Agent" alone). A test asserting
    // only the prefix would pass for any header that happened to start
    // with those words.
    expect(RETRIEVAL_AGENT_PROMPT).not.toMatch(/^# Retrieval Agent\n/);
  });

  it("declares v0.4.0 with the full M3-acceptance parenthetical and is NOT v0.1.0/0.2.0/0.3.0", () => {
    // Pin the FULL parenthetical, not just the version number — a future
    // edit that bumps the version but forgets to update the explanatory
    // suffix would pass a substring-only check.
    expect(RETRIEVAL_AGENT_PROMPT).toContain(
      "**Version:** 0.4.0 (M3 acceptance — same-language citation tie-breaker; single-best-cite + Sources block contract preserved)",
    );
    // If the prompt ever bumps to a new version, these tests fail and
    // the bumper is forced to update the assertion explicitly.
    expect(RETRIEVAL_AGENT_PROMPT).not.toContain("**Version:** 0.1.0");
    expect(RETRIEVAL_AGENT_PROMPT).not.toContain(
      "**Version:** 0.2.0 (M3 item 3 stage E — Sources block contract pinned)",
    );
    expect(RETRIEVAL_AGENT_PROMPT).not.toContain(
      "**Version:** 0.3.0 (M3 acceptance — single-best-cite tightening; Sources block contract preserved)",
    );
  });

  it("pins the v0.3.0 single-best-cite tightening (default ONE citation per claim) — preserved in v0.4.0", () => {
    // The v0.3.0 behavioral change is preserved verbatim in v0.4.0: prefer a
    // single most-directly-answering entry per claim. Multi-citation only for
    // the narrow same-claim-multi-source-agreement case.
    expect(RETRIEVAL_AGENT_PROMPT).toMatch(
      /cite the single most directly answering entry per claim/i,
    );
    // Forbid the v0.2.0 over-citation framing that v0.3.0 removed.
    expect(RETRIEVAL_AGENT_PROMPT).not.toContain("If two entries agree, cite both");
  });

  it("pins the v0.4.0 same-language citation tie-breaker", () => {
    // The behavioral addition in v0.4.0: when EN+HE siblings both directly
    // answer, prefer the one matching the user's query language. Framed as
    // a tie-breaker, NOT a hard rule (so a genuinely-more-complete other-
    // language entry can still be cited on the merits). Pin a contiguous
    // phrase via regex so the test doesn't pass on unrelated language mentions.
    expect(RETRIEVAL_AGENT_PROMPT).toMatch(/Same-language citation tie-breaker/i);
    expect(RETRIEVAL_AGENT_PROMPT).toMatch(/prefer the one matching the user's query language/i);
    // Negative-assertion: forbid an absolute "always cite same-language"
    // framing that would conflict with citing-on-the-merits when the other
    // language is genuinely more directly answering.
    expect(RETRIEVAL_AGENT_PROMPT).not.toContain("always cite the same-language entry");
    expect(RETRIEVAL_AGENT_PROMPT).not.toContain("never cite an entry in a different language");
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

  // ── v0.2.0 Sources-block contract assertions (ADR-0012 §D + §5) ─────────

  it("pins the trailing Sources: block as a required output element with UUID-v4-shaped examples", () => {
    // The literal "Sources:" + block-example token must appear in the
    // prompt body. ADR-0012 §5 server-side regex is
    // /^Sources:\s*\[([^\]]*)\]\s*$/m and step 3 requires UUID v4 — the
    // prompt's example IDs must therefore be UUID-v4-shaped, not the
    // short 6-hex-char shapes that a literal regression to v0.1.0 style
    // would produce.
    expect(RETRIEVAL_AGENT_PROMPT).toMatch(
      /Sources:\s*\[[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/,
    );
    expect(RETRIEVAL_AGENT_PROMPT).toContain("trailing `Sources:` block");
    // Negative-assertion: the v0.1.0-era short-hex example shape would
    // teach the model a shape §5 rejects. Forbid its return.
    expect(RETRIEVAL_AGENT_PROMPT).not.toMatch(/Sources:\s*\[[a-f0-9]{6},/);
  });

  it("pins inline-citations ↔ Sources-block set equality (audit-row honesty)", () => {
    // Without equality, model can emit [a][b] inline and Sources: [c] —
    // ADR-0012 §5 validation passes (c ∈ reranked_ids) but the audit
    // row's citation_ids diverges from what the user actually saw.
    expect(RETRIEVAL_AGENT_PROMPT).toContain("set of IDs you cited inline");
    expect(RETRIEVAL_AGENT_PROMPT).toMatch(/Not a subset, not a superset.*equal/i);
  });

  it("forbids duplicate IDs in the Sources block (set semantics)", () => {
    // ADR-0012 §5 doesn't say, but the audit row's citation_ids[] is a
    // set in spirit; duplicates inflate the count without adding
    // information. Pin the contiguous phrase via a single regex so the
    // test doesn't silently pass on a prompt that mentions "each ID
    // appears" and "exactly once" in unrelated sentences.
    expect(RETRIEVAL_AGENT_PROMPT).toMatch(/each ID appears\s+\*\*exactly once\*\*/);
    expect(RETRIEVAL_AGENT_PROMPT).toContain("no duplicates");
  });

  it("pins the Sources block as the AUTHORITATIVE citation list (matches ADR-0012 §E audit semantics)", () => {
    // The audit row pulls citation_ids[] from the Sources block. If the
    // prompt fails to pin this, models may treat inline as authoritative
    // and the audit log diverges.
    expect(RETRIEVAL_AGENT_PROMPT).toContain("authoritative citation list");
  });

  it("pins the route-contract assumption that retrieved_entries[] is non-empty", () => {
    // The empty-Sources fail-mode is avoided by route-layer short-circuit
    // BEFORE invoking synth. The prompt documents this assumption so the
    // model doesn't try to guard against an impossible empty-array case.
    expect(RETRIEVAL_AGENT_PROMPT).toContain("guaranteed non-empty");
  });

  it("rewrites the no-relevant-content branch to inline-cite every considered entry_id (preserves set-equality)", () => {
    // v0.1.0's no-content branch emitted just a stock template with no
    // Sources — would have failed §5 step 1 (missing block). v0.2.0
    // requires inline citations of all considered IDs in the canned
    // sentence so set-equality with Sources holds trivially and iron
    // rule #3 is upheld. Pin the contiguous instruction via a single
    // regex — `toContain("every")` alone is a tautology (the word
    // "every" appears multiple times in unrelated prompt sections).
    expect(RETRIEVAL_AGENT_PROMPT).toMatch(
      /Inline-cite\s+\*\*every\*\*\s+`entry_id`\s+from\s+`retrieved_entries\[\]`/,
    );
    // Pin the example sentence shape so a future edit doesn't drop the
    // inline-citation markers from the canned no-content template.
    expect(RETRIEVAL_AGENT_PROMPT).toMatch(/I considered \[id1\]\[id2\]\[id3\] but none of them/);
  });

  it("forbids characterizing Sources as optional or omittable (defense-in-depth against weakening rewrites)", () => {
    // Hash-roundtrip tests catch file drift; these substring checks catch
    // semantic drift in a rewrite that bumps the version + edits prose.
    expect(RETRIEVAL_AGENT_PROMPT).not.toContain("Sources block is optional");
    expect(RETRIEVAL_AGENT_PROMPT).not.toContain("you may omit Sources");
    expect(RETRIEVAL_AGENT_PROMPT).not.toContain("Sources is recommended");
    expect(RETRIEVAL_AGENT_PROMPT).not.toMatch(/Sources.*encouraged/i);
  });

  it("explicitly requires the Sources block even on long-reasoning responses (ADR-0012 §9 mitigation at model layer)", () => {
    // ADR-0012 §9 Negative: "Models occasionally drop trailing blocks
    // under heavy multi-step reasoning; the retry-once policy mitigates
    // but does not eliminate." Restate the mitigation at the model layer
    // so the retry path is the second line of defense, not the first.
    // Flexible regex tolerates hyphenation drift ("long-reasoning" vs
    // "long reasoning"); the semantic claim is what matters.
    expect(RETRIEVAL_AGENT_PROMPT).toMatch(/long[-\s]reasoning/);
  });

  it("pins iron rule #6 — restricted entries are filtered out before the prompt sees them", () => {
    // Defense-in-depth pin: if a future edit silently deletes this
    // assurance, the prompt looks safe to hand restricted content to
    // (it isn't — the filter is route-side per ADR-0012 §6, but the
    // prompt's worldview is upstream of that). Keep the prose linked.
    expect(RETRIEVAL_AGENT_PROMPT).toMatch(/filtered out before this prompt/);
  });

  it("pins the on-its-own-line constraint matching the §5 multiline-anchored regex", () => {
    // ADR-0012 §5 regex `/^Sources:\s*\[([^\]]*)\]\s*$/m` anchors `^`/`$`
    // to line boundaries. Prompt teaches "on its own line" — not "must be
    // the LAST line" (which the regex doesn't actually enforce).
    expect(RETRIEVAL_AGENT_PROMPT).toContain("on its own line");
    // Defend against a future rewrite that overclaims regex strictness.
    expect(RETRIEVAL_AGENT_PROMPT).not.toMatch(/must be the LAST line/);
  });
});
