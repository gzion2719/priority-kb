import { describe, expect, it } from "vitest";

import {
  CHUNKING_POLICY_VERSION,
  DEFAULT_CHUNK_TOKENS,
  DEFAULT_OVERLAP_TOKENS,
  MIN_TRAILING_TOKENS,
  TITLE_CLIP_CHARS,
  VOYAGE_MAX_INPUT_TOKENS,
  buildEmbedInput,
  chunk,
  computeForbiddenRanges,
  embedInputTokenCount,
  getRawSlice,
} from "./chunk";

// Repeated sentence used to build deterministically long bodies. Each repetition
// produces well above one token so even modest counts cross the chunk threshold.
const SENTENCE =
  "Priority's order entry screen rejects the line when quantity drops below the minimum stocking level. ";

function buildLongBody(repetitions: number, separator = "\n\n"): string {
  return Array.from({ length: repetitions }, () => SENTENCE.trim()).join(separator) + separator;
}

describe("chunk — ADR-0009 §1 short-entry single-chunk case", () => {
  it("returns a single chunk equal to the whole body when token count ≤ size", () => {
    const body = "Short OCR output: invoice header. Total: 100 NIS.";
    const chunks = chunk(body);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunk_index).toBe(0);
    expect(chunks[0].chunk_total).toBe(1);
    expect(chunks[0].content_start).toBe(0);
    expect(chunks[0].content_end).toBe(body.length);
    expect(chunks[0].chunking_policy_version).toBe(CHUNKING_POLICY_VERSION);
  });

  it("returns [] for empty body (defined contract for the slicing layer)", () => {
    expect(chunk("")).toEqual([]);
  });
});

describe("chunk — ADR-0009 §1 long-form chunking + overlap", () => {
  it("produces multiple chunks with ~60-token overlap on a long paragraph-separated body", () => {
    const body = buildLongBody(200);
    const chunks = chunk(body);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].chunk_total).toBe(chunks.length);
    expect(chunks.every((c) => c.chunk_total === chunks.length)).toBe(true);
    expect(chunks.every((c, i) => c.chunk_index === i)).toBe(true);
    // Every non-last chunk should be close to DEFAULT_CHUNK_TOKENS (allow boundary snap drift).
    for (const c of chunks.slice(0, -1)) {
      expect(c.token_count).toBeLessThanOrEqual(DEFAULT_CHUNK_TOKENS + DEFAULT_OVERLAP_TOKENS);
    }
    // Consecutive chunks must overlap: chunk[i+1].content_start < chunk[i].content_end.
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i + 1].content_start).toBeLessThan(chunks[i].content_end);
    }
  });

  it("ADR-0009 §1 trailing-merge: a final fragment <minTrailing tokens is absorbed into the prior chunk", () => {
    // Custom small overlap+minTrailing: make the natural trailing fragment small,
    // then prove the last chunk's content_end is the body's end AND that its
    // token_count exceeds what the unmerged trailing fragment would have been.
    const body = buildLongBody(40);
    const tinyMinTrailing = 80;
    const chunks = chunk(body, { size: 80, overlap: 10, minTrailing: tinyMinTrailing });
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const last = chunks[chunks.length - 1];
    expect(last.content_end).toBe(body.normalize("NFC").length);
    expect(last.token_count).toBeGreaterThanOrEqual(tinyMinTrailing);
  });

  it("body of exactly DEFAULT_CHUNK_TOKENS produces a single chunk", () => {
    // Build body, encode, slice to exactly DEFAULT_CHUNK_TOKENS via the proxy.
    // SENTENCE is ~16 tokens; 32 sentences ≈ 512 tokens — slightly over.
    // We'll measure and trim by chars until token count == DEFAULT_CHUNK_TOKENS.
    let body = SENTENCE.repeat(32);
    while (embedInputTokenCount(body) > DEFAULT_CHUNK_TOKENS) body = body.slice(0, -1);
    if (embedInputTokenCount(body) === DEFAULT_CHUNK_TOKENS) {
      const chunks = chunk(body);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].content_end).toBe(body.length);
    }
  });
});

describe("chunk — ADR-0009 §3 boundary preference", () => {
  it("prefers a paragraph break (rank 3) over a closer sentence break (rank 2) within the search window", () => {
    // Construct a scenario where a sentence-end sits AT the target offset and a
    // paragraph break sits earlier (within the search window). If rank is
    // honored, the paragraph break wins despite being farther from the target.
    const para = SENTENCE.repeat(20);
    const body = para + "\n\n" + para;
    const tokenCount = embedInputTokenCount(body);
    // Aim the size slightly past the paragraph break so the natural sentence
    // boundaries are *closer* to the target than the \n\n.
    const chunks = chunk(body, { size: Math.floor(tokenCount / 2) + 3 });
    expect(chunks.length).toBeGreaterThan(1);
    const paraBreakAt = body.indexOf("\n\n") + 2;
    expect(chunks[0].content_end).toBe(paraBreakAt);
  });

  it("ADR-0009 §3 never splits inside a fenced code block", () => {
    const head = SENTENCE.repeat(120);
    const fence = "```python\n" + "x = 1\n".repeat(40) + "```\n";
    const tail = SENTENCE.repeat(60);
    const body = head + fence + tail;
    const chunks = chunk(body);
    const fenceStart = body.indexOf("```python");
    const fenceEnd = body.indexOf("```\n", fenceStart) + "```\n".length;
    for (const c of chunks) {
      // No boundary may land strictly inside the fenced range.
      expect(c.content_end <= fenceStart || c.content_end >= fenceEnd).toBe(true);
      expect(c.content_start <= fenceStart || c.content_start >= fenceEnd).toBe(true);
    }
  });

  it("ADR-0009 §3 never splits inside a Markdown table row", () => {
    const head = SENTENCE.repeat(120);
    const row =
      "| Field             | Value with a very long description that we do not want split |\n";
    const tail = SENTENCE.repeat(40);
    const body = head + row + tail;
    const chunks = chunk(body);
    const rowStart = body.indexOf("| Field");
    const rowEnd = rowStart + row.length;
    for (const c of chunks) {
      const offsets = [c.content_start, c.content_end];
      for (const o of offsets) {
        expect(o <= rowStart || o >= rowEnd).toBe(true);
      }
    }
  });

  it("Hebrew body honors ASCII sentence enders for boundary detection", () => {
    // Modern Priority UI Hebrew uses ASCII . ? ! per ADR-0009 §3.
    const sentence = "צריך לבדוק את המספר של הלקוח לפני שמירת ההזמנה. ";
    const body = sentence.repeat(120);
    const chunks = chunk(body);
    expect(chunks.length).toBeGreaterThan(1);
    // No assertion about token_count exact value; pgvector/Voyage tokenization is
    // proxy-only (ADR-0009 §2). Just confirm we produced multiple chunks and the
    // offsets are in-bounds.
    for (const c of chunks) {
      expect(c.content_start).toBeGreaterThanOrEqual(0);
      expect(c.content_end).toBeLessThanOrEqual(body.normalize("NFC").length);
      expect(c.content_start).toBeLessThan(c.content_end);
    }
  });
});

describe("chunk — ADR-0009 §5 NFC normalization invariant", () => {
  it("produces identical ChunkSlice[] for composed and decomposed equivalents", () => {
    // U+00E9 (é, composed) vs U+0065 U+0301 (e + combining acute, decomposed).
    const composed = ("Caf" + "é" + " ").repeat(80);
    const decomposed = ("Caf" + "é" + " ").repeat(80);
    expect(composed).not.toBe(decomposed);
    expect(composed.normalize("NFC")).toBe(decomposed.normalize("NFC"));
    const cChunks = chunk(composed);
    const dChunks = chunk(decomposed);
    expect(cChunks).toEqual(dChunks);
  });
});

describe("computeForbiddenRanges — ADR-0009 §3", () => {
  it("ignores an unclosed fence (treats it as not-a-fence)", () => {
    const body = "intro\n```python\nx = 1\nno closing fence\nend\n";
    const ranges = computeForbiddenRanges(body);
    // Range for the unclosed fence should NOT be present.
    expect(ranges.find((r) => r[0] === body.indexOf("```python"))).toBeUndefined();
  });

  it("detects paired fenced blocks", () => {
    const body = "intro\n```ts\nconst x = 1;\n```\nouter\n";
    const ranges = computeForbiddenRanges(body);
    expect(ranges.length).toBeGreaterThan(0);
    const fenceStart = body.indexOf("```ts");
    const fenceEnd = body.indexOf("```\n", fenceStart) + "```\n".length;
    const found = ranges.find((r) => r[0] === fenceStart && r[1] >= fenceEnd);
    expect(found).toBeDefined();
  });

  it("detects per-row table ranges, not whole-table ranges", () => {
    const body = "intro\n| a | b |\n| c | d |\n\nouter\n";
    const ranges = computeForbiddenRanges(body);
    // Two separate row ranges — gap between them is legal.
    const row1Start = body.indexOf("| a");
    const row2Start = body.indexOf("| c");
    expect(ranges.some((r) => r[0] === row1Start)).toBe(true);
    expect(ranges.some((r) => r[0] === row2Start)).toBe(true);
  });

  it("detects inline code spans", () => {
    const body = "use the `quantity` field to set the qty\n";
    const ranges = computeForbiddenRanges(body);
    const inlineStart = body.indexOf("`quantity`");
    expect(ranges.some((r) => r[0] === inlineStart)).toBe(true);
  });
});

describe("buildEmbedInput + getRawSlice — ADR-0009 §6", () => {
  it("prepends Title and Tags lines and a blank-line separator", () => {
    const body = "post-scrub canonical body content";
    const out = buildEmbedInput({
      title: "PO Receipt — Validation Errors",
      tags: ["po", "validation"],
      body,
      content_start: 0,
      content_end: body.length,
    });
    expect(out.startsWith("Title: PO Receipt — Validation Errors\n")).toBe(true);
    expect(out).toContain("\nTags: po, validation\n\n");
    expect(out.endsWith(body)).toBe(true);
  });

  it("clips title to TITLE_CLIP_CHARS chars", () => {
    const longTitle = "T".repeat(TITLE_CLIP_CHARS + 100);
    const out = buildEmbedInput({
      title: longTitle,
      tags: [],
      body: "x",
      content_start: 0,
      content_end: 1,
    });
    // Title appears exactly once with the clipped length.
    const titleLine = out.split("\n", 1)[0];
    expect(titleLine).toBe("Title: " + "T".repeat(TITLE_CLIP_CHARS));
  });

  it("getRawSlice returns the body slice without the embed prefix (greppable separation)", () => {
    const body = "abcdefghij";
    expect(getRawSlice(body, 2, 7)).toBe("cdefg");
  });
});

describe("embedInputTokenCount — ADR-0009 §2 32k safety check", () => {
  it("returns a positive proxy count for a normal input", () => {
    const input = buildEmbedInput({
      title: "demo",
      tags: ["a"],
      body: SENTENCE.repeat(20),
      content_start: 0,
      content_end: SENTENCE.repeat(20).length,
    });
    const count = embedInputTokenCount(input);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(VOYAGE_MAX_INPUT_TOKENS);
  });

  it("throws when the embed input exceeds VOYAGE_MAX_INPUT_TOKENS", () => {
    // SENTENCE is ~16 tokens; 4000 repetitions ≈ 64k tokens — well past 32k.
    const oversized = SENTENCE.repeat(4000);
    const input = buildEmbedInput({
      title: "huge",
      tags: ["huge"],
      body: oversized,
      content_start: 0,
      content_end: oversized.length,
    });
    expect(() => embedInputTokenCount(input)).toThrow(/exceeds VOYAGE_MAX_INPUT_TOKENS/);
  });
});
