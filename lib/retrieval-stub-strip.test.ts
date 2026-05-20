import { describe, expect, it } from "vitest";

import { stripSynthSourcesBlock } from "@/lib/retrieval-stub-strip";

describe("stripSynthSourcesBlock — trailing-only, idempotent, no-op safe", () => {
  it("strips the trailing stub Sources block in the canonical shape", () => {
    const input = "stub-answer: deadbeef\n\nSources: [00000000-0000-4000-8000-000000000000]";
    expect(stripSynthSourcesBlock(input)).toBe("stub-answer: deadbeef");
  });

  it("strips with a single-space variant `Sources: [...]`", () => {
    expect(stripSynthSourcesBlock("a Sources: [x]")).toBe("a");
  });

  it("strips with no-space variant `Sources:[...]`", () => {
    expect(stripSynthSourcesBlock("a Sources:[x]")).toBe("a");
  });

  it("strips with CRLF line endings", () => {
    expect(
      stripSynthSourcesBlock("answer\r\nSources: [00000000-0000-4000-8000-000000000000]"),
    ).toBe("answer");
  });

  it("is a no-op when no Sources block is present (idempotent)", () => {
    // Distinguishes from a buggy strip that nukes the answer when the
    // regex partially matches "Sources" prose. The function MUST be
    // safe to compose with itself.
    const noBlock = "this is just a regular answer with no citations";
    expect(stripSynthSourcesBlock(noBlock)).toBe(noBlock);
    expect(stripSynthSourcesBlock(stripSynthSourcesBlock(noBlock))).toBe(noBlock);
  });

  it("is a no-op on the empty string", () => {
    expect(stripSynthSourcesBlock("")).toBe("");
  });

  it("preserves a Sources mention that is NOT at end-of-string (negative-assertion)", () => {
    // The regex is anchored to `$`. A future live-synth answer that says
    // "see the Sources: [x, y] cited above" mid-paragraph must NOT be
    // truncated. This test fails if the anchor were dropped.
    const midBody =
      "See Sources: [00000000-0000-4000-8000-000000000000] for details. Then conclude.";
    expect(stripSynthSourcesBlock(midBody)).toBe(midBody);
  });

  it("strips the LAST trailing block when multiple Sources mentions exist", () => {
    // The middle mention is preserved; only the trailing block goes.
    const input = "see Sources: [a] earlier.\n\nSources: [b]";
    expect(stripSynthSourcesBlock(input)).toBe("see Sources: [a] earlier.");
  });

  it("does NOT strip case-mismatched non-`Sources` text like `Source: [x]`", () => {
    // Distinguishes the keyword: the helper matches `Sources` (with the
    // 's'), not the singular `Source`. A regression that dropped the 's'
    // would over-match.
    const input = "answer Source: [x]";
    expect(stripSynthSourcesBlock(input)).toBe(input);
  });

  it("strips with case-insensitive Sources keyword (live-synth tolerance)", () => {
    expect(stripSynthSourcesBlock("answer sources: [x]")).toBe("answer");
    expect(stripSynthSourcesBlock("answer SOURCES: [x]")).toBe("answer");
  });

  it("strips trailing whitespace after the bracket", () => {
    expect(stripSynthSourcesBlock("answer\n\nSources: [x]\n  \t")).toBe("answer");
  });
});
