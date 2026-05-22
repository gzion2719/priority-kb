// lib/retrieval-citations.test.ts — citation-validator unit tests +
// source-file mechanical floors.
//
// Every failure-mode test pairs with a positive-control "inverse passes"
// assertion (per WORKFLOW.md negative-assertion section): the change that
// triggers the failure, reverted, yields ok:true. This rules out tautological
// passes where a generic test would succeed even with the floor removed.

import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  UUID_V4_REGEX,
  extractInlineCitations,
  parseSourcesBlock,
  validateCitations,
} from "@/lib/retrieval-citations";
import { STUB_SYNTH_SENTINEL_UUID } from "@/lib/retrieval";

// Three real-shape v4 UUIDs (matching gen_random_uuid() output).
const A = "a3f1c2d4-5e6b-4c7a-9d8e-0f1a2b3c4d5e";
const B = "b29e0712-3456-4789-a012-3456789abcde";
const C = "c1234567-89ab-4cde-9f01-23456789abcd";
// Non-v4 well-formed UUIDs.
const V1 = "a3f1c2d4-5e6b-1c7a-9d8e-0f1a2b3c4d5e"; // version nibble = 1
const V5 = "a3f1c2d4-5e6b-5c7a-9d8e-0f1a2b3c4d5e"; // version nibble = 5
// v4-shape but wrong variant nibble (RFC 4122 requires 8|9|a|b).
const BAD_VARIANT = "a3f1c2d4-5e6b-4c7a-7d8e-0f1a2b3c4d5e"; // variant = 7

describe("UUID_V4_REGEX", () => {
  it("accepts canonical v4 UUIDs", () => {
    expect(UUID_V4_REGEX.test(A)).toBe(true);
    expect(UUID_V4_REGEX.test(B)).toBe(true);
    expect(UUID_V4_REGEX.test(C)).toBe(true);
  });

  it("accepts the stub synth sentinel (00000000-0000-4000-8000-...)", () => {
    expect(UUID_V4_REGEX.test(STUB_SYNTH_SENTINEL_UUID)).toBe(true);
  });

  it("rejects non-v4 versions (1, 5)", () => {
    expect(UUID_V4_REGEX.test(V1)).toBe(false);
    expect(UUID_V4_REGEX.test(V5)).toBe(false);
  });

  it("rejects v4-shape with wrong RFC-4122 variant nibble", () => {
    expect(UUID_V4_REGEX.test(BAD_VARIANT)).toBe(false);
  });

  it("rejects obvious malformed strings", () => {
    expect(UUID_V4_REGEX.test("not-a-uuid")).toBe(false);
    expect(UUID_V4_REGEX.test("")).toBe(false);
    expect(UUID_V4_REGEX.test("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(UUID_V4_REGEX.test(A.toUpperCase())).toBe(true);
  });
});

describe("parseSourcesBlock", () => {
  it("extracts ids from a happy-path Sources line", () => {
    const result = parseSourcesBlock(`some answer.\n\nSources: [${A}, ${B}]`);
    expect(result).not.toBeNull();
    expect(result!.ids).toEqual([A, B]);
  });

  it("returns null when no Sources block present", () => {
    expect(parseSourcesBlock("no citation here at all")).toBeNull();
  });

  it("returns empty ids array for `Sources: []`", () => {
    const result = parseSourcesBlock("answer.\n\nSources: []");
    expect(result!.ids).toEqual([]);
  });

  it("returns empty ids array for `Sources: [   ]` (whitespace-only)", () => {
    const result = parseSourcesBlock("answer.\n\nSources: [   ]");
    expect(result!.ids).toEqual([]);
  });

  it("handles single-id Sources block", () => {
    const result = parseSourcesBlock(`answer.\n\nSources: [${A}]`);
    expect(result!.ids).toEqual([A]);
  });

  it("normalizes CRLF line endings", () => {
    const result = parseSourcesBlock(`answer.\r\n\r\nSources: [${A}]`);
    expect(result).not.toBeNull();
    expect(result!.ids).toEqual([A]);
  });

  it("rejects indented `Sources:` (prompt says 'on its own line')", () => {
    expect(parseSourcesBlock(`answer.\n   Sources: [${A}]`)).toBeNull();
  });

  it("is case-sensitive on `Sources:`", () => {
    expect(parseSourcesBlock(`answer.\n\nsources: [${A}]`)).toBeNull();
    expect(parseSourcesBlock(`answer.\n\nSOURCES: [${A}]`)).toBeNull();
  });
});

describe("extractInlineCitations", () => {
  it("finds bracketed UUID-shaped markers in order", () => {
    const answer = `Claim one [${A}]. Claim two [${B}]. Conflict [${A}][${C}].`;
    expect(extractInlineCitations(answer)).toEqual([A, B, A, C]);
  });

  it("strips the Sources block before scanning (no double-count)", () => {
    const answer = `Use F11 [${A}].\n\nSources: [${A}, ${B}]`;
    const inline = extractInlineCitations(answer);
    // Only the inline `[${A}]` from "Use F11 [...]" — not the IDs inside Sources.
    expect(inline).toEqual([A]);
    // Negative-assertion: if the strip had failed, B would appear.
    expect(inline).not.toContain(B);
  });

  it("strips ALL Sources blocks when called on multi-block input (standalone safety)", () => {
    // Inside validateCitations the multi-block case fires its own
    // discriminant before this runs; standalone callers still need
    // composable strip behaviour.
    const answer = `[${A}]\n\nSources: [${A}]\n\nSources: [${B}, ${C}]`;
    const inline = extractInlineCitations(answer);
    expect(inline).toEqual([A]);
    expect(inline).not.toContain(B);
    expect(inline).not.toContain(C);
  });

  it("returns empty array when no inline citations present", () => {
    expect(extractInlineCitations(`Just prose.\n\nSources: [${A}]`)).toEqual([]);
  });
});

describe("validateCitations — happy path", () => {
  it("returns ok with the cited ids and a stripped body (single citation)", () => {
    const answer = `Press F11 to lock the field [${A}].\n\nSources: [${A}]`;
    const result = validateCitations(answer, [A, B, C]);
    expect(result).toEqual({
      ok: true,
      ids: [A],
      body: `Press F11 to lock the field [${A}].`,
    });
  });

  it("accepts multi-citation with set-equality between inline and Sources", () => {
    const answer = `[${A}] then [${B}].\n\nSources: [${A}, ${B}]`;
    const result = validateCitations(answer, [A, B, C]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ids).toEqual([A, B]);
  });

  it("allows inline duplicates as long as the deduped set matches Sources", () => {
    const answer = `Claim [${A}]. Conflict [${A}][${B}]. Restate [${A}].\n\nSources: [${A}, ${B}]`;
    const result = validateCitations(answer, [A, B, C]);
    expect(result.ok).toBe(true);
  });

  it("accepts Hebrew answer body (UTF-8 round-trip)", () => {
    const answer = `לחץ F11 כדי לנעול את השדה [${A}].\n\nSources: [${A}]`;
    const result = validateCitations(answer, [A]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toContain(`לחץ F11`);
  });

  it("stub synth's bare output deliberately FAILS v0.2.0 set-equality (no inline cite)", () => {
    // lib/retrieval.ts:147 JSDoc: "downstream candidate-set membership check
    // fails — the right layer to surface a citation-set issue." Post-v0.2.0
    // the failure mode is `inline_sources_mismatch` (sources-only sentinel),
    // not membership. This is the test path the route's retry-once exercises.
    const answer = `stub-answer: deadbeef\n\nSources: [${STUB_SYNTH_SENTINEL_UUID}]`;
    const result = validateCitations(answer, [STUB_SYNTH_SENTINEL_UUID]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("inline_sources_mismatch");
  });
});

describe("validateCitations — sources_block_missing", () => {
  it("fails when no Sources block at all", () => {
    const result = validateCitations(`Press F11 [${A}].`, [A]);
    expect(result).toEqual({ ok: false, reason: "sources_block_missing" });
  });

  it("fails on empty answer string", () => {
    const result = validateCitations("", [A]);
    expect(result).toEqual({ ok: false, reason: "sources_block_missing" });
  });

  it("inverse passes: adding the block restores ok", () => {
    const passing = validateCitations(`Press F11 [${A}].\n\nSources: [${A}]`, [A]);
    expect(passing.ok).toBe(true);
  });
});

describe("validateCitations — multiple_sources_blocks", () => {
  it("fails when two Sources blocks are present", () => {
    const answer = `[${A}]\n\nSources: [${A}]\n\nSources: [${B}]`;
    const result = validateCitations(answer, [A, B]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "multiple_sources_blocks") {
      expect(result.count).toBe(2);
    } else {
      throw new Error(`expected multiple_sources_blocks, got ${JSON.stringify(result)}`);
    }
  });

  it("inverse passes: a single Sources block with the same IDs is ok", () => {
    const answer = `[${A}] and [${B}]\n\nSources: [${A}, ${B}]`;
    const result = validateCitations(answer, [A, B]);
    expect(result.ok).toBe(true);
  });
});

describe("validateCitations — trailing_prose_after_sources", () => {
  it("fails when non-whitespace content follows the Sources block", () => {
    const answer = `[${A}]\n\nSources: [${A}]\nsome trailing prose here`;
    const result = validateCitations(answer, [A]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "trailing_prose_after_sources") {
      expect(result.trailing).toContain("trailing prose");
    } else {
      throw new Error(`expected trailing_prose_after_sources, got ${JSON.stringify(result)}`);
    }
  });

  it("tolerates whitespace-only lines after the Sources block", () => {
    const answer = `[${A}]\n\nSources: [${A}]\n\n  \n`;
    const result = validateCitations(answer, [A]);
    expect(result.ok).toBe(true);
  });

  it("inverse passes: removing the trailing prose restores ok", () => {
    const passing = validateCitations(`[${A}]\n\nSources: [${A}]`, [A]);
    expect(passing.ok).toBe(true);
  });
});

describe("validateCitations — sources_block_empty", () => {
  it("fails on `Sources: []`", () => {
    const result = validateCitations(`prose.\n\nSources: []`, [A]);
    expect(result).toEqual({ ok: false, reason: "sources_block_empty" });
  });

  it("fails on whitespace-only `Sources: [   ]`", () => {
    const result = validateCitations(`prose.\n\nSources: [   ]`, [A]);
    expect(result).toEqual({ ok: false, reason: "sources_block_empty" });
  });

  it("inverse passes: adding a real id restores ok", () => {
    const passing = validateCitations(`[${A}].\n\nSources: [${A}]`, [A]);
    expect(passing.ok).toBe(true);
  });
});

describe("validateCitations — invalid_uuid", () => {
  it("fails when Sources contains a non-v4 UUID", () => {
    const answer = `[${V1}]\n\nSources: [${V1}]`;
    const result = validateCitations(answer, [V1]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "invalid_uuid") {
      expect(result.offending_ids).toContain(V1);
    } else {
      throw new Error(`expected invalid_uuid, got ${JSON.stringify(result)}`);
    }
  });

  it("fails on a malformed inline citation even when Sources is clean", () => {
    // M2 fix: union-set v4 check catches inline-only malformed UUIDs with
    // the CORRECT discriminant rather than the misleading
    // `inline_sources_mismatch` that a Sources-only check would produce.
    // V1 is a v1-version UUID (36-char hex shape; passes the inline 36-char
    // extractor regex but fails the v4 version-nibble check).
    const answer = `[${V1}]\n\nSources: [${A}]`;
    const result = validateCitations(answer, [A]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "invalid_uuid") {
      expect(result.offending_ids).toContain(V1);
    } else {
      throw new Error(`expected invalid_uuid, got ${JSON.stringify(result)}`);
    }
  });

  it("invalid_uuid takes precedence over duplicate_id (m1 discriminant-order positive control)", () => {
    // Sources: [bad, bad] — both invalid AND duplicate. Step 5 (UUID) runs
    // before step 6 (dup), so `invalid_uuid` wins. The route's retry prompt
    // gets the more actionable "fix the UUID" message.
    const answer = `prose.\n\nSources: [${V1}, ${V1}]`;
    const result = validateCitations(answer, [V1]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_uuid");
  });

  it("inverse passes: replacing the bad UUID with a real v4 restores ok", () => {
    const passing = validateCitations(`[${A}]\n\nSources: [${A}]`, [A]);
    expect(passing.ok).toBe(true);
  });
});

describe("validateCitations — duplicate_id", () => {
  it("fails when Sources lists the same id twice", () => {
    const answer = `[${A}]\n\nSources: [${A}, ${A}]`;
    const result = validateCitations(answer, [A]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "duplicate_id") {
      expect(result.offending_ids).toEqual([A]);
    } else {
      throw new Error(`expected duplicate_id, got ${JSON.stringify(result)}`);
    }
  });

  it("inverse passes: removing the duplicate restores ok", () => {
    const passing = validateCitations(`[${A}]\n\nSources: [${A}]`, [A]);
    expect(passing.ok).toBe(true);
  });
});

describe("validateCitations — hallucinated_id", () => {
  it("fails when Sources contains an id not in rerankedIds", () => {
    const answer = `[${A}]\n\nSources: [${A}]`;
    const result = validateCitations(answer, [B, C]); // A not in candidate set
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "hallucinated_id") {
      expect(result.offending_ids).toEqual([A]);
    } else {
      throw new Error(`expected hallucinated_id, got ${JSON.stringify(result)}`);
    }
  });

  it("inverse passes: adding A to rerankedIds restores ok", () => {
    const passing = validateCitations(`[${A}]\n\nSources: [${A}]`, [A, B, C]);
    expect(passing.ok).toBe(true);
  });

  it("tolerates duplicate rerankedIds (defensive Set wrap)", () => {
    const passing = validateCitations(`[${A}]\n\nSources: [${A}]`, [A, A, A]);
    expect(passing.ok).toBe(true);
  });
});

describe("validateCitations — inline_sources_mismatch", () => {
  it("fails when Sources is a superset of inline citations", () => {
    const answer = `Claim [${A}].\n\nSources: [${A}, ${B}]`;
    const result = validateCitations(answer, [A, B]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "inline_sources_mismatch") {
      expect(result.sources_only).toEqual([B]);
      expect(result.inline_only).toEqual([]);
    } else {
      throw new Error(`expected inline_sources_mismatch, got ${JSON.stringify(result)}`);
    }
  });

  it("fails when Sources is a subset of inline citations", () => {
    const answer = `Claim [${A}] and [${B}].\n\nSources: [${A}]`;
    const result = validateCitations(answer, [A, B]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "inline_sources_mismatch") {
      expect(result.inline_only).toEqual([B]);
      expect(result.sources_only).toEqual([]);
    } else {
      throw new Error(`expected inline_sources_mismatch, got ${JSON.stringify(result)}`);
    }
  });

  it("inverse passes: making the sets equal restores ok", () => {
    const passing = validateCitations(`[${A}] and [${B}].\n\nSources: [${A}, ${B}]`, [A, B]);
    expect(passing.ok).toBe(true);
  });
});

describe("validateCitations — edge cases the route layer can hit", () => {
  it("bare Sources-only answer (no body, no inline cites) fails inline_sources_mismatch", () => {
    // No prose at all — just the Sources block. The model that produced
    // this skipped every claim-citation but at least emitted Sources.
    // Set-equality fails (sources_only=[A], inline empty).
    const result = validateCitations(`Sources: [${A}]`, [A]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "inline_sources_mismatch") {
      expect(result.sources_only).toEqual([A]);
      expect(result.inline_only).toEqual([]);
    } else {
      throw new Error(`expected inline_sources_mismatch, got ${JSON.stringify(result)}`);
    }
  });

  it("inline citation AFTER Sources block: trailing_prose wins over inline-count drift", () => {
    // The trailing-prose check fires BEFORE inline extraction would have a
    // chance to mis-count `[B]` as a real inline citation. Pinning the
    // discriminant order so a future refactor that moves trailing-prose
    // detection past inline extraction breaks here.
    const answer = `[${A}]\n\nSources: [${A}]\n[${B}] orphan`;
    const result = validateCitations(answer, [A, B]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("trailing_prose_after_sources");
  });
});

describe("validateCitations — discriminant precedence pins", () => {
  it("multiple_sources_blocks wins over trailing_prose_after_sources", () => {
    // Two Sources blocks AND content after the second. Step 2 fires before step 3.
    const answer = `[${A}]\n\nSources: [${A}]\n\nSources: [${B}]\ntrailing`;
    const result = validateCitations(answer, [A, B]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("multiple_sources_blocks");
  });

  it("multiple_sources_blocks wins over invalid_uuid in second block", () => {
    const answer = `[${A}]\n\nSources: [${A}]\n\nSources: [${V1}]`;
    const result = validateCitations(answer, [A, V1]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("multiple_sources_blocks");
  });

  it("invalid_uuid wins over hallucinated_id", () => {
    // V1 is a v1 UUID (fails v4 check). It's also not in rerankedIds.
    // Step 5 (UUID) fires before step 7 (membership).
    const answer = `[${V1}]\n\nSources: [${V1}]`;
    const result = validateCitations(answer, [A]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_uuid");
  });

  it("hallucinated_id wins over inline_sources_mismatch", () => {
    // A inline + A in Sources is set-equal, but A is not in rerankedIds.
    // Hallucinated check fires first.
    const answer = `[${A}]\n\nSources: [${A}]`;
    const result = validateCitations(answer, [B]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("hallucinated_id");
  });
});

describe("validateCitations — malformed-list discriminant", () => {
  it("`Sources: [,A]` surfaces as invalid_uuid with empty string in offending_ids", () => {
    // The empty-element collapse to `sources_block_empty` was misleading;
    // a malformed list is more accurately invalid_uuid (the empty slot
    // fails the v4 regex). Verifies the M2 fix discriminant.
    const result = validateCitations(`[${A}]\n\nSources: [,${A}]`, [A]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "invalid_uuid") {
      expect(result.offending_ids).toContain("");
    } else {
      throw new Error(`expected invalid_uuid, got ${JSON.stringify(result)}`);
    }
  });
});

// ─── Source-file mechanical floors ─────────────────────────────────────────

describe("retrieval-citations.ts — source-file mechanical floors", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "retrieval-citations.ts"), "utf8");

  it("source file reads no environment (purity floor: helper takes data, not config)", () => {
    expect(src).not.toMatch(/process\.env/);
  });

  it("source file imports no DB driver (no `pg`, anchored)", () => {
    expect(src).not.toMatch(/from\s+["']pg["']/);
  });

  it("source file imports no SDK (iron rule #8: voyageai/openai/cohere/google/anthropic)", () => {
    expect(src).not.toMatch(/from\s+["']voyage(ai)?["']/);
    expect(src).not.toMatch(/from\s+["']@anthropic[/-]/);
    expect(src).not.toMatch(/from\s+["']openai["']/);
    expect(src).not.toMatch(/from\s+["']cohere-ai["']/);
    expect(src).not.toMatch(/from\s+["']@google\/generative-ai["']/);
  });

  it("source file does NOT emit logs (route layer owns LogEvent per ADR-0012 §8)", () => {
    // Anchored to function-call syntax to avoid self-trigger on the word
    // "log" appearing in JSDoc prose. Catches the actual call sites only.
    expect(src).not.toMatch(/console\.(log|warn|error|info)\s*\(/);
    expect(src).not.toMatch(/from\s+["']@\/lib\/log["']/);
  });

  it("positive control: env regex catches a synthetic env-namespace read", () => {
    const synthetic = `const k = process.env.FOO;`;
    expect(synthetic).toMatch(/process\.env/);
  });

  it("positive control: pg-import regex catches a synthetic `pg` import", () => {
    const synthetic = `import { Pool } from "pg";`;
    expect(synthetic).toMatch(/from\s+["']pg["']/);
  });

  it("positive control: pg-import regex does NOT match `pgvector` substring", () => {
    const synthetic = `// uses pgvector HNSW indexing`;
    expect(synthetic).not.toMatch(/from\s+["']pg["']/);
  });

  it("positive control: console.log call regex fires on actual call but not on prose", () => {
    expect(`console.log("x")`).toMatch(/console\.(log|warn|error|info)\s*\(/);
    expect(`// prose mentioning console.log behavior`).not.toMatch(
      /console\.(log|warn|error|info)\s*\(/,
    );
  });

  it("positive control: @anthropic regex catches an SDK import but not prose mentioning it", () => {
    expect(`import Anthropic from "@anthropic-ai/sdk";`).toMatch(/from\s+["']@anthropic[/-]/);
    // The helper's own header comment mentions "Anthropic SDK normalizes
    // to LF" — verify that bare prose mention does NOT trigger the
    // anchored from-import regex.
    expect(`// Anthropic SDK normalizes to LF`).not.toMatch(/from\s+["']@anthropic[/-]/);
  });
});
