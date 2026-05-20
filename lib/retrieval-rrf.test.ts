// lib/retrieval-rrf.test.ts — pure unit tests for ADR-0013 §2.4 RRF fusion.
// No DB, no SDK calls; iron rule #8 trivially satisfied.

import { describe, expect, it } from "vitest";

import { rrfFuse, type RrfLane } from "@/lib/retrieval";

describe("rrfFuse (ADR-0013 §2.4)", () => {
  it("hand-computed 2-lane / 3-doc fusion matches the formula exactly", () => {
    // Two lanes; entry "a" is rank-1 in both, "b" is rank-2 in both, "c" is
    // rank-3 in lane-1 only. With k=60 the per-doc scores are:
    //   a: 1/(60+1) + 1/(60+1) = 2/61 ≈ 0.0327869
    //   b: 1/(60+2) + 1/(60+2) = 2/62 ≈ 0.0322581
    //   c: 1/(60+3)            = 1/63 ≈ 0.0158730
    const lanes: RrfLane[] = [
      { name: "ann", rankedEntryIds: ["a", "b", "c"] },
      { name: "keyword", rankedEntryIds: ["a", "b"] },
    ];
    const fused = rrfFuse(lanes, 60);

    expect(fused).toHaveLength(3);
    expect(fused[0]).toEqual({ entry_id: "a", score: 2 / 61 });
    expect(fused[1]).toEqual({ entry_id: "b", score: 2 / 62 });
    expect(fused[2]).toEqual({ entry_id: "c", score: 1 / 63 });
  });

  it("entries absent from a lane contribute 0 (not 1/(k+infinity) approximation drift)", () => {
    // "x" only in lane-1; "y" only in lane-2. Both at rank-1. Equal scores
    // → tie-break by first-lane-index: lane-0 ("ann") sorts before lane-1 ("kw").
    const fused = rrfFuse(
      [
        { name: "ann", rankedEntryIds: ["x"] },
        { name: "kw", rankedEntryIds: ["y"] },
      ],
      60,
    );

    expect(fused).toHaveLength(2);
    expect(fused[0]?.entry_id).toBe("x");
    expect(fused[1]?.entry_id).toBe("y");
    expect(fused[0]?.score).toBe(1 / 61);
    expect(fused[1]?.score).toBe(1 / 61);
  });

  it("single-lane degenerate input returns lane ordering unchanged", () => {
    const fused = rrfFuse([{ name: "only", rankedEntryIds: ["p", "q", "r"] }], 60);
    expect(fused.map((e) => e.entry_id)).toEqual(["p", "q", "r"]);
    // Scores strictly decreasing (rank-1 > rank-2 > rank-3).
    expect(fused[0]!.score).toBeGreaterThan(fused[1]!.score);
    expect(fused[1]!.score).toBeGreaterThan(fused[2]!.score);
  });

  it("union smaller than limit returns union size, not padded", () => {
    const fused = rrfFuse(
      [
        { name: "a", rankedEntryIds: ["one"] },
        { name: "b", rankedEntryIds: ["two"] },
      ],
      60,
      20,
    );
    expect(fused).toHaveLength(2);
  });

  it("respects the limit when union is larger", () => {
    const lane: RrfLane = {
      name: "big",
      rankedEntryIds: Array.from({ length: 50 }, (_, i) => `e${i}`),
    };
    const fused = rrfFuse([lane], 60, 20);
    expect(fused).toHaveLength(20);
    // Top entry is e0 (rank 1).
    expect(fused[0]?.entry_id).toBe("e0");
  });

  it("k=1 is allowed (lower bound of validated range)", () => {
    const fused = rrfFuse([{ name: "x", rankedEntryIds: ["only"] }], 1);
    expect(fused[0]?.score).toBe(1 / 2);
  });

  it("k=1000 is allowed (upper bound)", () => {
    const fused = rrfFuse([{ name: "x", rankedEntryIds: ["only"] }], 1000);
    expect(fused[0]?.score).toBe(1 / 1001);
  });

  it("k out of range throws RangeError", () => {
    expect(() => rrfFuse([], 0)).toThrow(RangeError);
    expect(() => rrfFuse([], 1001)).toThrow(RangeError);
    expect(() => rrfFuse([], -1)).toThrow(RangeError);
    expect(() => rrfFuse([], 1.5)).toThrow(RangeError);
  });

  it("limit out of range throws RangeError", () => {
    expect(() => rrfFuse([], 60, 0)).toThrow(RangeError);
    expect(() => rrfFuse([], 60, 1001)).toThrow(RangeError);
  });

  it("tie-break: equal scores resolved by first-lane index, then first-lane rank", () => {
    // Two entries appear in identical positions in different single lanes.
    // Scores tie → lane-0 wins. Within a lane, position-1 beats position-2.
    const fused = rrfFuse(
      [
        { name: "lane0", rankedEntryIds: ["alpha", "beta"] },
        { name: "lane1", rankedEntryIds: ["gamma"] },
      ],
      60,
    );
    // alpha rank-1 of lane-0 → score 1/61; beta rank-2 of lane-0 → score 1/62;
    // gamma rank-1 of lane-1 → score 1/61 (TIES with alpha).
    expect(fused.map((e) => e.entry_id)).toEqual(["alpha", "gamma", "beta"]);
  });

  it("empty lanes input returns empty array", () => {
    expect(rrfFuse([], 60)).toEqual([]);
  });

  it("lane with empty rankedEntryIds contributes nothing", () => {
    const fused = rrfFuse(
      [
        { name: "empty", rankedEntryIds: [] },
        { name: "real", rankedEntryIds: ["x"] },
      ],
      60,
    );
    expect(fused).toHaveLength(1);
    expect(fused[0]?.entry_id).toBe("x");
  });
});
