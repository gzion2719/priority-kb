import { describe, expect, it } from "vitest";

import { diffLines, MAX_DIFF_LINES } from "@/lib/text-diff";

describe("diffLines — equality fast-path", () => {
  it("identical strings → all context, no chunks of type add/remove", () => {
    const out = diffLines("line one\nline two", "line one\nline two");
    expect(out.oversized).toBe(false);
    expect(out.chunks.every((c) => c.kind === "context")).toBe(true);
    expect(out.chunks.map((c) => c.text)).toEqual(["line one", "line two"]);
  });

  it("empty input on both sides → single empty context line", () => {
    expect(diffLines("", "")).toEqual({
      chunks: [{ kind: "context", text: "" }],
      oversized: false,
    });
  });
});

describe("diffLines — empty-side fast paths", () => {
  it("empty oldText → all chunks are add", () => {
    const out = diffLines("", "a\nb");
    expect(out.chunks).toEqual([
      { kind: "add", text: "a" },
      { kind: "add", text: "b" },
    ]);
  });

  it("empty newText → all chunks are remove", () => {
    const out = diffLines("a\nb", "");
    expect(out.chunks).toEqual([
      { kind: "remove", text: "a" },
      { kind: "remove", text: "b" },
    ]);
  });
});

describe("diffLines — basic edit shapes", () => {
  it("pure append: existing lines context + new lines add", () => {
    const out = diffLines("a\nb", "a\nb\nc");
    expect(out.chunks).toEqual([
      { kind: "context", text: "a" },
      { kind: "context", text: "b" },
      { kind: "add", text: "c" },
    ]);
  });

  it("pure deletion of a middle line: remove chunk in place", () => {
    const out = diffLines("a\nb\nc", "a\nc");
    expect(out.chunks).toEqual([
      { kind: "context", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "context", text: "c" },
    ]);
  });

  it("replacement: remove old + add new at the same position", () => {
    // Negative-assertion: a regression that fell back to character-level
    // diff would emit multiple chunks per line; line-level keeps it to
    // one remove + one add.
    const out = diffLines("a\nold\nc", "a\nnew\nc");
    expect(out.chunks).toEqual([
      { kind: "context", text: "a" },
      { kind: "remove", text: "old" },
      { kind: "add", text: "new" },
      { kind: "context", text: "c" },
    ]);
  });

  it("interleaved adds/removes preserve relative position", () => {
    const out = diffLines("a\nb\nc\nd", "a\nx\nc\ny");
    expect(
      out.chunks.map(
        (c) => `${c.kind === "context" ? "=" : c.kind === "add" ? "+" : "-"}${c.text}`,
      ),
    ).toEqual(["=a", "-b", "+x", "=c", "-d", "+y"]);
  });
});

describe("diffLines — CRLF and unicode", () => {
  it("CRLF line endings are normalized to lines (no \\r in the output)", () => {
    const out = diffLines("a\r\nb", "a\r\nb\r\nc");
    expect(out.chunks).toEqual([
      { kind: "context", text: "a" },
      { kind: "context", text: "b" },
      { kind: "add", text: "c" },
    ]);
  });

  it("Hebrew RTL text diffs at line granularity (no character splitting)", () => {
    const out = diffLines("שלום\nעולם", "שלום\nעולם\nחדש");
    expect(out.chunks).toEqual([
      { kind: "context", text: "שלום" },
      { kind: "context", text: "עולם" },
      { kind: "add", text: "חדש" },
    ]);
  });

  it("surrogate-pair emoji preserved as a single line value", () => {
    // U+1F600 GRINNING FACE is two UTF-16 code units; a regression that
    // diffed code units instead of code points would split this line.
    const out = diffLines("hi\n😀", "hi\n😀\nbye");
    expect(out.chunks.length).toBe(3);
    expect(out.chunks[1]).toEqual({ kind: "context", text: "😀" });
  });
});

describe("diffLines — oversized fallback", () => {
  it("returns oversized:true with empty chunks when oldText exceeds MAX_DIFF_LINES", () => {
    const longLines = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `line${i}`).join("\n");
    const out = diffLines(longLines, "tiny");
    expect(out).toEqual({ chunks: [], oversized: true });
  });

  it("returns oversized:true when newText exceeds MAX_DIFF_LINES", () => {
    const longLines = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `line${i}`).join("\n");
    const out = diffLines("tiny", longLines);
    expect(out).toEqual({ chunks: [], oversized: true });
  });

  it("at exactly MAX_DIFF_LINES, diff still runs (boundary regression pin)", () => {
    // Negative-assertion: a regression that used `>=` would skip the
    // diff at the cap. Pin the strict-`>` contract.
    const atCap = Array.from({ length: MAX_DIFF_LINES }, (_, i) => `line${i}`).join("\n");
    const out = diffLines(atCap, atCap);
    expect(out.oversized).toBe(false);
    expect(out.chunks.length).toBe(MAX_DIFF_LINES);
  });
});
