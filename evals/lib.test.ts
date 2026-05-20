// evals/lib.test.ts — Tests for the M3 eval-runner math + per-case logic.
//
// Six fixture cases per Step 7b M3 (avoiding tautological pass):
//   1. perfect-recall + perfect-precision (1.0 / 1.0)
//   2. partial recall (1 of 2 expected hit at k=5)
//   3. zero recall (none of expected in top-k)
//   4. hallucinated citation (cited an id NOT in expected)
//   5. skipped: queued case (expected_source_ids empty, never reaches adapter)
//   6. no citations emitted (cited_ids === undefined → citation_precision skipped)
//
// Per WORKFLOW.md "Negative-assertion tests": each branch must be reachable
// and distinguishable. The math fixture asserts each metric value
// individually rather than aggregate, so a regression in one branch can't
// be papered over by another branch's pass.

import { describe, it, expect } from "vitest";
import { buildSummary, citationPrecision, recallAtK, runCase, type RetrievalAdapter } from "./lib";
import type { EvalCase } from "./schema";

const UUID = {
  a: "11111111-1111-4111-8111-111111111111",
  b: "22222222-2222-4222-8222-222222222222",
  c: "33333333-3333-4333-8333-333333333333",
  d: "44444444-4444-4444-8444-444444444444",
  hallucinated: "99999999-9999-4999-8999-999999999999",
} as const;

const baseQueuedCase: EvalCase = {
  id: "en-001",
  query: "queued example",
  language: "en",
  category: "procedural",
  phase: "queued",
  expected_source_ids: [],
};

describe("recallAtK", () => {
  it("returns 1.0 on perfect recall", () => {
    expect(recallAtK([UUID.a, UUID.b], [UUID.a, UUID.b, UUID.c], 5)).toBe(1.0);
  });

  it("returns 0.5 on partial recall (1 of 2 expected hit)", () => {
    expect(recallAtK([UUID.a, UUID.b], [UUID.a, UUID.c, UUID.d], 5)).toBe(0.5);
  });

  it("returns 0.0 on zero-overlap recall", () => {
    expect(recallAtK([UUID.a, UUID.b], [UUID.c, UUID.d], 5)).toBe(0.0);
  });

  it("returns `undefined` (skipped) when expected is empty", () => {
    expect(recallAtK([], [UUID.a], 5)).toBeUndefined();
  });

  it("applies the k cutoff — hit at position 6 does NOT count for k=5", () => {
    const retrieved = [UUID.c, UUID.c, UUID.c, UUID.c, UUID.c, UUID.a];
    // Without the cutoff, expected=[a] retrieved-anywhere → recall=1.0.
    // With k=5 cutoff, the single expected `a` lives at rank 6 (0-indexed 5),
    // outside the slice — recall must be 0.0. This distinguishes "any-k"
    // from "first-k".
    expect(recallAtK([UUID.a], retrieved, 5)).toBe(0.0);
    expect(recallAtK([UUID.a], retrieved, 6)).toBe(1.0);
  });

  it("is case-insensitive on UUIDs", () => {
    expect(recallAtK([UUID.a.toUpperCase()], [UUID.a.toLowerCase()], 5)).toBe(1.0);
  });

  it("rejects non-positive k", () => {
    expect(() => recallAtK([UUID.a], [UUID.a], 0)).toThrow(RangeError);
  });
});

describe("citationPrecision", () => {
  it("returns 1.0 when every citation is in expected", () => {
    expect(citationPrecision([UUID.a, UUID.b], [UUID.a, UUID.b])).toBe(1.0);
  });

  it("returns 0.5 when half the citations are hallucinated", () => {
    expect(citationPrecision([UUID.a], [UUID.a, UUID.hallucinated])).toBe(0.5);
  });

  it("returns 0.0 when every citation is hallucinated", () => {
    expect(citationPrecision([UUID.a], [UUID.hallucinated, UUID.b])).toBe(0.0);
  });

  it("returns `undefined` (skipped) when cited is null", () => {
    expect(citationPrecision([UUID.a], null)).toBeUndefined();
  });

  it("returns `undefined` (skipped) when cited is undefined (synth skipped)", () => {
    expect(citationPrecision([UUID.a], undefined)).toBeUndefined();
  });

  it("returns `undefined` (skipped) when cited is empty (no-citation-emitted)", () => {
    expect(citationPrecision([UUID.a], [])).toBeUndefined();
  });
});

describe("runCase", () => {
  it('returns status="skipped" for phase="queued" without invoking adapter', async () => {
    const throwingAdapter: RetrievalAdapter = {
      retrieve: async () => {
        throw new Error("adapter must not be called for queued cases");
      },
    };
    const result = await runCase(baseQueuedCase, 5, throwingAdapter);
    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/queued/);
    expect(result.recall_at_k).toBeUndefined();
    expect(result.citation_precision).toBeUndefined();
  });

  it('returns status="skipped" for phase="negative" without invoking adapter', async () => {
    const negCase: EvalCase = {
      ...baseQueuedCase,
      id: "en-016",
      category: "negative",
      phase: "negative",
    };
    const throwingAdapter: RetrievalAdapter = {
      retrieve: async () => {
        throw new Error("adapter must not be called for negative cases");
      },
    };
    const result = await runCase(negCase, 5, throwingAdapter);
    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/negative/);
  });

  it('returns status="measured" with computed metrics for phase="ready"', async () => {
    const readyCase: EvalCase = {
      ...baseQueuedCase,
      id: "en-002",
      phase: "ready",
      expected_source_ids: [UUID.a, UUID.b],
    };
    const adapter: RetrievalAdapter = {
      retrieve: async () => ({
        retrieved_ranked: [UUID.a, UUID.c, UUID.b],
        cited_ids: [UUID.a, UUID.hallucinated],
      }),
    };
    const result = await runCase(readyCase, 5, adapter);
    expect(result.status).toBe("measured");
    expect(result.recall_at_k).toBe(1.0); // a + b both in top-5
    expect(result.citation_precision).toBe(0.5); // a hits, hallucinated misses
  });

  it('returns status="shape_error" when adapter throws', async () => {
    const readyCase: EvalCase = {
      ...baseQueuedCase,
      id: "en-003",
      phase: "ready",
      expected_source_ids: [UUID.a],
    };
    const adapter: RetrievalAdapter = {
      retrieve: async () => {
        throw new Error("adapter exploded");
      },
    };
    const result = await runCase(readyCase, 5, adapter);
    expect(result.status).toBe("shape_error");
    expect(result.reason).toMatch(/adapter exploded/);
  });
});

describe("buildSummary", () => {
  it("aggregates only over `measured` cases with defined metrics", () => {
    const per_case = [
      { id: "en-001", status: "measured" as const, recall_at_k: 1.0, citation_precision: 1.0 },
      { id: "en-002", status: "measured" as const, recall_at_k: 0.5, citation_precision: 0.5 },
      {
        id: "en-003",
        status: "measured" as const,
        recall_at_k: 0.0,
        citation_precision: undefined,
      },
      { id: "en-004", status: "skipped" as const, reason: "queued" },
      { id: "en-005", status: "shape_error" as const, reason: "boom" },
    ];
    const summary = buildSummary(per_case, 5, { recall_at_k: 0.8, citation_precision: 0.9 });
    expect(summary.totals).toEqual({ cases: 5, measured: 3, skipped: 1, shape_error: 1 });
    // recall mean over the three defined values: (1.0 + 0.5 + 0.0) / 3 = 0.5
    expect(summary.aggregate.recall_at_k_mean).toBeCloseTo(0.5, 5);
    // precision mean over the two defined values (one was undefined): (1.0 + 0.5) / 2 = 0.75
    expect(summary.aggregate.citation_precision_mean).toBeCloseTo(0.75, 5);
  });

  it("aggregate is null (not 0, not NaN) when no measured cases contribute", () => {
    const per_case = [
      { id: "en-001", status: "skipped" as const, reason: "queued" },
      { id: "en-002", status: "skipped" as const, reason: "negative" },
    ];
    const summary = buildSummary(per_case, 5, { recall_at_k: 0.8, citation_precision: 0.9 });
    expect(summary.aggregate.recall_at_k_mean).toBeNull();
    expect(summary.aggregate.citation_precision_mean).toBeNull();
    // Distinguishes "we ran no measurements" from "measurements averaged to zero" —
    // a regression where mean=0 collapses to mean=null would be caught here.
  });
});
