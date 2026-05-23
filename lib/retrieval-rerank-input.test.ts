// lib/retrieval-rerank-input.test.ts — pure-helper coverage for the
// keyword-only synthetic representative + the rerank-output-to-synth-input
// projection.

import { describe, expect, it } from "vitest";

import { chunk, getRawSlice } from "@/lib/chunk";
import {
  KEYWORD_REPRESENTATIVE_TOKENS,
  joinRerankedToSynthInput,
  synthesizeKeywordOnlyRepresentative,
  type RerankBoundaryEntry,
} from "@/lib/retrieval-rerank-input";

// ─── synthesizeKeywordOnlyRepresentative ────────────────────────────────────

describe("synthesizeKeywordOnlyRepresentative — title + first-N-tokens via chunk.ts", () => {
  it("short body: returns title prefix + entire body (chunker yields one slice)", () => {
    const out = synthesizeKeywordOnlyRepresentative("Order Entry Howto", "Short body content.");
    expect(out).toBe("# Order Entry Howto\nShort body content.");
  });

  it("empty body: returns just the title-prefix line (no body)", () => {
    const out = synthesizeKeywordOnlyRepresentative("Empty Body Entry", "");
    expect(out).toBe("# Empty Body Entry\n");
  });

  it("normalizes NFD input to match chunker's NFC view (byte-stability floor)", () => {
    // U+00E9 (é, precomposed) vs U+0065 U+0301 (e + combining acute).
    // chunk() NFC-normalizes internally; the helper re-normalizes before
    // slicing so the rendered output is the precomposed form.
    const nfd = "Café menu";
    const nfc = "Café menu";
    const a = synthesizeKeywordOnlyRepresentative("X", nfd);
    const b = synthesizeKeywordOnlyRepresentative("X", nfc);
    expect(a).toBe(b);
    expect(a).toContain("Café");
  });

  it("delegates the slice through chunk.ts mechanics — slice == getRawSlice(chunk[0])", () => {
    // Negative-assertion: a reimplementation that did its own
    // tokenize-then-slice would silently drift from the chunker on
    // multi-byte-codepoint-split-across-BPE-tokens inputs. Pinning that
    // the helper's output equals "# title\n" + getRawSlice(chunk[0])
    // protects against future reimpls that ditch lib/chunk.ts.
    const body = "Lorem ipsum ".repeat(500); // ~3000 chars, > 500 tokens
    const slices = chunk(body.normalize("NFC"), { size: 500, overlap: 0 });
    const expected =
      "# Title\n" +
      getRawSlice(body.normalize("NFC"), slices[0]!.content_start, slices[0]!.content_end);
    const actual = synthesizeKeywordOnlyRepresentative("Title", body);
    expect(actual).toBe(expected);
  });

  it("respects custom maxTokens for tests / future tuning", () => {
    const body = "alpha beta gamma delta epsilon ".repeat(50);
    const tinier = synthesizeKeywordOnlyRepresentative("T", body, 5);
    const default500 = synthesizeKeywordOnlyRepresentative("T", body);
    expect(tinier.length).toBeLessThan(default500.length);
  });

  it("Hebrew body (multi-byte UTF-8) round-trips through normalize+slice", () => {
    const body = "הזמנת רכש — שגיאת אימות. ".repeat(20);
    const out = synthesizeKeywordOnlyRepresentative("Hebrew title", body);
    expect(out.startsWith("# Hebrew title\n")).toBe(true);
    // Output is a prefix of "# title\n" + normalized body — confirm the
    // body portion appears verbatim somewhere in the source body (slice
    // is a prefix-of-body, so the output's body portion is a prefix of
    // normalized body).
    const sliced = out.slice("# Hebrew title\n".length);
    expect(body.normalize("NFC").startsWith(sliced)).toBe(true);
  });

  it("exports the default token budget as a named constant matching ADR-0009", () => {
    expect(KEYWORD_REPRESENTATIVE_TOKENS).toBe(500);
  });

  it("rejects empty title with RangeError (caller bug — no citable representative)", () => {
    expect(() => synthesizeKeywordOnlyRepresentative("", "body")).toThrow(RangeError);
  });

  it("rejects non-integer / out-of-range maxTokens", () => {
    expect(() => synthesizeKeywordOnlyRepresentative("T", "b", 0)).toThrow(RangeError);
    expect(() => synthesizeKeywordOnlyRepresentative("T", "b", -1)).toThrow(RangeError);
    expect(() => synthesizeKeywordOnlyRepresentative("T", "b", 1.5)).toThrow(RangeError);
    expect(() => synthesizeKeywordOnlyRepresentative("T", "b", 4001)).toThrow(RangeError);
    expect(() => synthesizeKeywordOnlyRepresentative("T", "b", 99999)).toThrow(RangeError);
  });
});

// ─── joinRerankedToSynthInput ───────────────────────────────────────────────

const ID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ID_B = "bbbbbbbb-0000-4000-8000-000000000002";
const ID_C = "cccccccc-0000-4000-8000-000000000003";

const mkBoundary = (id: string, title: string, body: string): RerankBoundaryEntry => ({
  entry_id: id,
  title,
  body,
  category: "howto",
  tags: ["one", "two"],
  source_pointer: "ticket-1234",
  last_verified_at: "2026-05-22T00:00:00Z",
  sensitivity: "public",
});

describe("joinRerankedToSynthInput — projects rerank output to SynthInputChunk[]", () => {
  it("maps a 3-entry ranking onto boundaries in RANKING order (not boundary order)", () => {
    const boundaries: RerankBoundaryEntry[] = [
      mkBoundary(ID_A, "A", "body of A"),
      mkBoundary(ID_B, "B", "body of B"),
      mkBoundary(ID_C, "C", "body of C"),
    ];
    // Reranker says: index 2 best, then 0, then 1.
    const ranking = [
      { index: 2, score: 0.95 },
      { index: 0, score: 0.7 },
      { index: 1, score: 0.4 },
    ];
    const out = joinRerankedToSynthInput(ranking, boundaries, 5);
    expect(out.map((c) => c.entry_id)).toEqual([ID_C, ID_A, ID_B]);
    expect(out.map((c) => c.score)).toEqual([0.95, 0.7, 0.4]);
  });

  it("respects topN cap", () => {
    const boundaries = [
      mkBoundary(ID_A, "A", "body of A"),
      mkBoundary(ID_B, "B", "body of B"),
      mkBoundary(ID_C, "C", "body of C"),
    ];
    const ranking = [
      { index: 2, score: 0.95 },
      { index: 0, score: 0.7 },
      { index: 1, score: 0.4 },
    ];
    const out = joinRerankedToSynthInput(ranking, boundaries, 2);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.entry_id)).toEqual([ID_C, ID_A]);
  });

  it("empty ranking returns empty output (degenerate but legal)", () => {
    const out = joinRerankedToSynthInput([], [mkBoundary(ID_A, "A", "a")], 5);
    expect(out).toEqual([]);
  });

  it("ranking.length < topN: returns all ranked entries (no padding)", () => {
    const boundaries = [mkBoundary(ID_A, "A", "a"), mkBoundary(ID_B, "B", "b")];
    const ranking = [{ index: 1, score: 0.9 }];
    const out = joinRerankedToSynthInput(ranking, boundaries, 5);
    expect(out).toHaveLength(1);
    expect(out[0]!.entry_id).toBe(ID_B);
  });

  it("preserves all boundary metadata into SynthInputChunk", () => {
    const boundaries = [mkBoundary(ID_A, "A", "alpha body")];
    const out = joinRerankedToSynthInput([{ index: 0, score: 0.5 }], boundaries, 5);
    expect(out[0]).toEqual({
      entry_id: ID_A,
      title: "A",
      body: "alpha body",
      category: "howto",
      tags: ["one", "two"],
      source_pointer: "ticket-1234",
      last_verified_at: "2026-05-22T00:00:00Z",
      sensitivity: "public",
      score: 0.5,
    });
  });

  it("rejects out-of-range index with RangeError naming the offending position", () => {
    const boundaries = [mkBoundary(ID_A, "A", "a")];
    expect(() => joinRerankedToSynthInput([{ index: 1, score: 0.5 }], boundaries, 5)).toThrow(
      /index=1 out of range/,
    );
    expect(() => joinRerankedToSynthInput([{ index: -1, score: 0.5 }], boundaries, 5)).toThrow(
      RangeError,
    );
  });

  it("rejects non-finite score with RangeError", () => {
    const boundaries = [mkBoundary(ID_A, "A", "a")];
    expect(() => joinRerankedToSynthInput([{ index: 0, score: NaN }], boundaries, 5)).toThrow(
      /not finite/,
    );
    expect(() => joinRerankedToSynthInput([{ index: 0, score: Infinity }], boundaries, 5)).toThrow(
      RangeError,
    );
  });

  it("rejects duplicate index across ranking (neg-assertion: would mis-count distinct synth IDs)", () => {
    // If the reranker returns the same boundary twice, two <entry> blocks
    // would render with the same entry_id and the audit row's "distinct
    // citable IDs" count would be wrong. Fail-loud rather than dedup
    // silently. Test pins both the throw AND that it names the offending
    // index for diagnostics.
    const boundaries = [mkBoundary(ID_A, "A", "a"), mkBoundary(ID_B, "B", "b")];
    expect(() =>
      joinRerankedToSynthInput(
        [
          { index: 0, score: 0.9 },
          { index: 0, score: 0.5 },
        ],
        boundaries,
        5,
      ),
    ).toThrow(/index=0 appears more than once/);
  });

  it("does NOT throw on duplicate index past topN (only the kept slice is scanned)", () => {
    // A reranker that returns extra (possibly duplicate) entries past
    // topN is fine — we never construct those SynthInputChunks. Pins
    // "the dup check is scoped to the kept ranking, not the input".
    const boundaries = [mkBoundary(ID_A, "A", "a"), mkBoundary(ID_B, "B", "b")];
    const out = joinRerankedToSynthInput(
      [
        { index: 0, score: 0.9 },
        { index: 1, score: 0.5 },
        { index: 0, score: 0.1 }, // duplicate, but past topN=2
      ],
      boundaries,
      2,
    );
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.entry_id)).toEqual([ID_A, ID_B]);
  });

  it("rejects topN outside [1, 1000]", () => {
    const boundaries = [mkBoundary(ID_A, "A", "a")];
    expect(() => joinRerankedToSynthInput([], boundaries, 0)).toThrow(RangeError);
    expect(() => joinRerankedToSynthInput([], boundaries, 1.5)).toThrow(RangeError);
    expect(() => joinRerankedToSynthInput([], boundaries, 1001)).toThrow(RangeError);
  });
});
